#!/usr/bin/env tsx

/**
 * Review gate between a local Harbor report and Hugin's content-blind learning
 * ledger. The default is a dry run. `--commit` is the only mutating mode and
 * never promotes a configuration.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { BrokerClient, BrokerHttpError } from "../../src/mcp/broker-client.js";
import { observeDurably } from "../../src/learning/durable-observation.js";
import {
  computeConfigurationFingerprint,
  learningAgentChecksSchema,
  learningExperimentCreateSchema,
  learningExperimentStateSchema,
  learningObservationSchema,
  type LearningConfiguration,
  type LearningExperimentCreate,
  type LearningObservationInput,
  type RecordedLearningObservation,
} from "../../src/learning/experiment-schema.js";
import { codeLoopPromptSha256 } from "../../src/learning/m5-code-loop-prompt.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const gitCommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const baselineSchema = z.object({
  taskId: z.string().min(1),
  holdout: z.boolean(),
  passed: z.boolean(),
  applyReturnCode: z.number().int().nullable(),
  checkReturnCode: z.number().int().nullable(),
  failureKind: z.enum(["empty-diff", "apply-failed", "check-failed"]).nullable(),
  workId: z.string().min(1),
  status: z.string().min(1),
  diffBytes: z.number().int().nonnegative(),
}).passthrough();
const replaySchema = z.object({
  taskId: z.string().min(1),
  holdout: z.boolean(),
  baselinePassed: z.boolean(),
  harborPassed: z.boolean(),
  rewardMeasured: z.literal(true),
  rewardParity: z.literal(true),
  diffParity: z.literal(true),
  workParity: z.literal(true),
  clientRunParity: z.literal(true),
  applyReturnCode: z.literal(0),
  exceptionType: z.null(),
}).passthrough();
const liveSchema = z.object({
  taskId: z.string().min(1),
  holdout: z.boolean(),
  reward: z.union([z.literal(0), z.literal(1)]),
  workId: z.string().min(1),
  clientRunId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  requestFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  startCapabilities: z.object({
    start_idempotency: z.literal("client-run-id-v1"),
    agent_checks: z.literal("pi-bash-events-v3"),
  }).passthrough(),
  execution: z.object({
    model: z.string().min(1),
    harness_version: z.literal("code-loop-pi-2026-07-14-v6"),
    effective_caps: z.object({
      wall_s: z.number().int().positive(),
      turns: z.number().int().positive(),
      completion_tokens: z.number().int().positive(),
    }).passthrough(),
    capabilities: z.object({
      start_idempotency: z.literal("client-run-id-v1"),
      agent_checks: z.literal("pi-bash-events-v3"),
    }).passthrough(),
  }).passthrough(),
  agentChecks: learningAgentChecksSchema,
  exceptionType: z.null(),
}).passthrough();
const reportSchema = z.object({
  schema_version: z.literal(2),
  pilot_version: z.literal("harbor-0.18.0-gate-d-v2"),
  campaign_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/),
  harbor_version: z.literal("0.18.0"),
  runner_commit: gitCommitSchema,
  declaration_sha256: hashSchema,
  source_commit: gitCommitSchema,
  task_ids: z.array(z.string().min(1)).min(4).max(100),
  holdout_ids: z.array(z.string().min(1)).min(2).max(100),
  holdout_revision: z.string().min(1).max(120),
  corpus_sha256: hashSchema,
  verifier_sha256: hashSchema,
  harbor_verifier_sha256: hashSchema,
  caps: z.object({
    wall_s: z.number().int().positive(),
    turns: z.number().int().positive(),
    completion_tokens: z.number().int().positive(),
  }).strict(),
  model: z.string().min(1).max(120),
  harness_version: z.literal("code-loop-pi-2026-07-14-v6"),
  network_mode: z.literal("no-network"),
  network_isolation_met: z.literal(true),
  base_image: z.literal("node:22.17.0-bookworm-slim@sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0"),
  standard_base_image_met: z.literal(true),
  exact_replay_parity: z.literal(true),
  baseline_decisions_verified: z.literal(true),
  live_adapter_completed: z.literal(true),
  recommendation: z.literal("go"),
  baseline: z.array(baselineSchema).min(4).max(100),
  replay_parity: z.array(replaySchema).min(4).max(100),
  live_adapter: z.array(liveSchema).min(4).max(100),
}).passthrough().superRefine((report, ctx) => {
  const expected = [...report.task_ids].sort();
  const baseline = report.baseline.map((row) => row.taskId).sort();
  const replay = report.replay_parity.map((row) => row.taskId).sort();
  const live = report.live_adapter.map((row) => row.taskId).sort();
  if (new Set(expected).size !== expected.length) {
    ctx.addIssue({ code: "custom", path: ["task_ids"], message: "duplicate task id" });
  }
  if (JSON.stringify(baseline) !== JSON.stringify(expected)) {
    ctx.addIssue({ code: "custom", path: ["baseline"], message: "baseline task set mismatch" });
  }
  if (JSON.stringify(replay) !== JSON.stringify(expected)) {
    ctx.addIssue({ code: "custom", path: ["replay_parity"], message: "replay task set mismatch" });
  }
  if (JSON.stringify(live) !== JSON.stringify(expected)) {
    ctx.addIssue({ code: "custom", path: ["live_adapter"], message: "live task set mismatch" });
  }
  const holdouts = new Set(report.holdout_ids);
  if (holdouts.size !== report.holdout_ids.length || [...holdouts].some((id) => !expected.includes(id))) {
    ctx.addIssue({ code: "custom", path: ["holdout_ids"], message: "invalid holdout set" });
  }
  for (const row of report.baseline) {
    if (row.holdout !== holdouts.has(row.taskId)) {
      ctx.addIssue({ code: "custom", path: ["baseline"], message: `holdout mismatch for ${row.taskId}` });
    }
    if (row.applyReturnCode !== 0 || row.checkReturnCode === null || row.passed !== (row.checkReturnCode === 0)) {
      ctx.addIssue({ code: "custom", path: ["baseline"], message: `unverified host decision for ${row.taskId}` });
    }
  }
  const baselineByTask = new Map(report.baseline.map((row) => [row.taskId, row]));
  for (const row of report.replay_parity) {
    if (
      row.holdout !== holdouts.has(row.taskId) ||
      row.baselinePassed !== row.harborPassed ||
      baselineByTask.get(row.taskId)?.passed !== row.baselinePassed
    ) {
      ctx.addIssue({ code: "custom", path: ["replay_parity"], message: `parity mismatch for ${row.taskId}` });
    }
  }
  for (const row of report.live_adapter) {
    if (
      row.holdout !== holdouts.has(row.taskId) ||
      row.clientRunId !== `harbor:${report.campaign_id}:${row.taskId}:live` ||
      row.execution.model !== report.model ||
      row.execution.effective_caps.wall_s !== report.caps.wall_s ||
      row.execution.effective_caps.turns !== report.caps.turns ||
      row.execution.effective_caps.completion_tokens !== report.caps.completion_tokens ||
      row.agentChecks.work_id !== row.workId
    ) {
      ctx.addIssue({ code: "custom", path: ["live_adapter"], message: `live binding mismatch for ${row.taskId}` });
    }
  }
});

type HarborReport = z.infer<typeof reportSchema>;

function sha256(value: unknown): string {
  return createHash("sha256").update(
    typeof value === "string" ? value : JSON.stringify(value),
  ).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameObservation(
  recorded: RecordedLearningObservation,
  expected: LearningObservationInput,
): boolean {
  const {
    recorded_at: _recordedAt,
    recorded_by: _recordedBy,
    product_rated_at: _productRatedAt,
    product_rated_by: _productRatedBy,
    ...evidence
  } = recorded;
  const canonicalExpected = learningObservationSchema.parse(
    JSON.parse(JSON.stringify(expected)),
  );
  return stable(evidence) === stable(canonicalExpected);
}

function configuration(
  report: HarborReport,
  kind: "host" | "harbor",
  evidenceDigest: string,
): LearningConfiguration {
  const payload = {
    prompt: {
      id: "gate-d-instruction-passthrough",
      version: "1",
      sha256: codeLoopPromptSha256(undefined),
    },
    harness: {
      id: "pi-code-loop",
      version: report.harness_version,
      configSha256: sha256({ caps: report.caps, capabilities: ["client-run-id-v1", "pi-bash-events-v3"] }),
      maxTurns: report.caps.turns,
      timeoutMs: report.caps.wall_s * 1_000,
      contextStrategy: "inline-seed-v1",
      toolPolicyVersion: "pi-pinned-ndjson-v1",
    },
    model: {
      id: report.model,
      provider: "m5",
      runtime: "pi-llama-swap",
      config: {
        contextWindow: 131_072,
        maxOutputTokens: report.caps.completion_tokens,
        templateVersion: "m5-live-2026-07-14",
        extraConfigSha256: sha256("client-run-id-v1+pi-bash-events-v3"),
      },
    },
    logging: {
      schemaVersion: "code-loop-result-v6",
      requiredFieldsSha256: sha256("execution+telemetry+agent_checks+durable-start"),
    },
    testHarness: kind === "host"
      ? {
          id: "gate-d-host",
          version: `gille-${report.source_commit.slice(0, 12)}`,
          corpusSha256: report.corpus_sha256,
          oracleVersion: `sha256-${report.verifier_sha256.slice(0, 16)}`,
          holdoutRevision: report.holdout_revision,
        }
      : {
          id: "gate-d-harbor",
          version: report.pilot_version,
          corpusSha256: report.corpus_sha256,
          oracleVersion: `sha256-${report.harbor_verifier_sha256.slice(0, 16)}`,
          holdoutRevision: report.holdout_revision,
        },
    routing: {
      policyId: "harbor-parity-pilot",
      version: "1",
      configSha256: sha256({
        campaign: report.campaign_id,
        replay: "same-diff-v1",
        evidence_digest: evidenceDigest,
      }),
    },
  };
  return {
    ...payload,
    fingerprint: computeConfigurationFingerprint(payload),
  };
}

export interface HarborLearningImport {
  experiment: LearningExperimentCreate;
  observations: LearningObservationInput[];
}

export function harborLearningImportFromReport(raw: unknown): HarborLearningImport {
  const report = reportSchema.parse(raw);
  const experimentId = `harbor-${report.campaign_id}`;
  const evidenceDigest = sha256({
    source_commit: report.source_commit,
    runner_commit: report.runner_commit,
    declaration_sha256: report.declaration_sha256,
    corpus_sha256: report.corpus_sha256,
    verifier_sha256: report.verifier_sha256,
    harbor_verifier_sha256: report.harbor_verifier_sha256,
    baseline: [...report.baseline].sort((a, b) => a.taskId.localeCompare(b.taskId)).map((row) => ({
      task_id: row.taskId,
      holdout: row.holdout,
      passed: row.passed,
      work_id: row.workId,
      diff_bytes: row.diffBytes,
    })),
    replay: [...report.replay_parity].sort((a, b) => a.taskId.localeCompare(b.taskId)).map((row) => ({
      task_id: row.taskId,
      passed: row.harborPassed,
      reward_parity: row.rewardParity,
      diff_parity: row.diffParity,
    })),
    live: [...report.live_adapter].sort((a, b) => a.taskId.localeCompare(b.taskId)).map((row) => ({
      task_id: row.taskId,
      work_id: row.workId,
      reward: row.reward,
      request_fingerprint: row.requestFingerprint,
    })),
  });
  const champion = configuration(report, "host", evidenceDigest);
  const challenger = configuration(report, "harbor", evidenceDigest);
  const experiment = learningExperimentCreateSchema.parse({
    experiment_id: experimentId,
    scope: "m5-code-edit-harbor-pilot",
    task_type: "code-edit",
    hypothesis:
      "Harbor 0.18's isolated Gate D verifier reproduces the host Gate D decision and diff identity on a predeclared fresh corpus.",
    change_axis: "test-harness",
    champion,
    challenger,
    gates: {
      minMatchedPairs: report.task_ids.length,
      minHoldoutPairs: report.holdout_ids.length,
      minVerifiedCoverage: 1,
      minRatedCoverage: 0,
      maxQualityRegression: 0,
      maxUsefulRegression: 0,
      maxRescueRateIncrease: 0,
      maxInfraRateIncrease: 0,
      maxLatencyRatio: null,
      maxCostRatio: null,
      primaryMetric: "verifier-score",
      minPrimaryImprovement: 0,
    },
  });
  const baselineByTask = new Map(report.baseline.map((row) => [row.taskId, row]));
  const replayByTask = new Map(report.replay_parity.map((row) => [row.taskId, row]));
  const observations = report.task_ids.flatMap((taskId) => {
    const baseline = baselineByTask.get(taskId)!;
    const replay = replayByTask.get(taskId)!;
    const common = {
      experiment_id: experimentId,
      sample_id: taskId,
      holdout: baseline.holdout,
      product_outcome: "unrated" as const,
      edited: baseline.diffBytes > 0,
      tests_run: true,
      task_id: taskId,
      ledger_id: `harbor-report:${evidenceDigest}`,
      work_id: baseline.workId,
    };
    return [
      learningObservationSchema.parse({
        ...common,
        run_id: `${experimentId}:${taskId}:host`,
        arm: "champion",
        configuration_fingerprint: champion.fingerprint,
        quality_outcome: baseline.passed ? "pass" : "fail",
        verifier: {
          kind: "mechanical",
          independent: true,
          id: "gate-d-host",
          version: `sha256-${report.verifier_sha256.slice(0, 16)}`,
        },
        verifier_score: baseline.passed ? 1 : 0,
        tests_passed: baseline.passed,
        failure_kind: baseline.failureKind ?? undefined,
      }),
      learningObservationSchema.parse({
        ...common,
        run_id: `${experimentId}:${taskId}:harbor`,
        arm: "challenger",
        configuration_fingerprint: challenger.fingerprint,
        quality_outcome: replay.harborPassed ? "pass" : "fail",
        verifier: {
          kind: "mechanical",
          independent: true,
          id: "gate-d-harbor",
          version: `sha256-${report.harbor_verifier_sha256.slice(0, 16)}`,
        },
        verifier_score: replay.harborPassed ? 1 : 0,
        tests_passed: replay.harborPassed,
        failure_kind: replay.harborPassed ? undefined : "gate-d-check-failed",
      }),
    ];
  });
  return { experiment, observations };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") throw new Error(`missing required environment variable ${name}`);
  return value;
}

async function commitImport(payload: HarborLearningImport): Promise<void> {
  const broker = new BrokerClient({
    baseUrl: requiredEnv("HUGIN_BROKER_URL"),
    bearerToken: requiredEnv("HUGIN_BROKER_TOKEN"),
  });
  let state;
  try {
    const response = await broker.experimentStatus({
      experiment_id: payload.experiment.experiment_id,
    }) as { state: unknown };
    state = learningExperimentStateSchema.parse(response.state);
  } catch (err) {
    if (!(err instanceof BrokerHttpError) || err.httpStatus !== 404) throw err;
    const response = await broker.experimentCreate(payload.experiment) as { state: unknown };
    state = learningExperimentStateSchema.parse(response.state);
  }
  if (
    state.champion.fingerprint !== payload.experiment.champion.fingerprint ||
    state.challenger.fingerprint !== payload.experiment.challenger.fingerprint
  ) {
    throw new Error("existing Harbor experiment has a different immutable configuration");
  }
  if (state.status !== "running") {
    const complete = payload.observations.every((observation) => {
      const recorded = state.observations.find((row) => row.run_id === observation.run_id);
      return recorded !== undefined && sameObservation(recorded, observation);
    });
    if (!complete) {
      throw new Error(`terminal Harbor experiment ${state.status} is missing declared evidence`);
    }
  } else {
    for (const observation of payload.observations) {
      await observeDurably(broker, observation);
    }
  }
  const finalResponse = await broker.experimentStatus({
    experiment_id: payload.experiment.experiment_id,
  }) as { state: unknown };
  const finalState = learningExperimentStateSchema.parse(finalResponse.state);
  process.stdout.write(`${JSON.stringify({
    experiment_id: finalState.experimentId,
    status: finalState.status,
    matched_pairs: finalState.evaluation.matchedPairs,
    holdout_pairs: finalState.evaluation.holdoutPairs,
    decision: finalState.evaluation.decision,
    reason: finalState.evaluation.reason,
    next_action: finalState.evaluation.nextAction,
    promotion_attempted: false,
  }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const reportArg = process.argv[2];
  if (!reportArg) {
    throw new Error("usage: import-learning-report.ts <pilot-report.json> [--commit]");
  }
  const raw = JSON.parse(readFileSync(resolve(reportArg), "utf8"));
  const payload = harborLearningImportFromReport(raw);
  if (!process.argv.includes("--commit")) {
    process.stdout.write(`${JSON.stringify({
      mode: "dry-run",
      experiment: payload.experiment,
      observations: payload.observations,
      promotion_attempted: false,
    }, null, 2)}\n`);
    return;
  }
  await commitImport(payload);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
