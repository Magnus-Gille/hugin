/**
 * Durable champion/challenger experiment contract for the Hugin/M5 learning loop.
 *
 * The contract is deliberately content-blind. Prompts, test fixtures, and
 * arbitrary model configuration blobs stay in their owning repositories; Hugin
 * records immutable versions and SHA-256 fingerprints so a run can be reproduced
 * without copying potentially sensitive task content into the experiment ledger.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { taskTypeSchema } from "../broker/types.js";

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const prefixedSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const clientRunIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const versionSchema = z.string().min(1).max(120);
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/);

export const learningChangeAxisSchema = z.enum([
  "logging",
  "test-harness",
  "agent-prompt",
  "agent-harness",
  "model",
  "model-config",
  "routing",
]);
export type LearningChangeAxis = z.infer<typeof learningChangeAxisSchema>;

export const promptRefSchema = z.object({
  id: slugSchema,
  version: versionSchema,
  sha256: sha256Schema,
}).strict();

export const harnessRefSchema = z.object({
  id: slugSchema,
  version: versionSchema,
  configSha256: sha256Schema,
  maxTurns: z.number().int().positive().max(1_000).optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  editDeadlineTurn: z.number().int().positive().max(1_000).optional(),
  contextStrategy: versionSchema.optional(),
  toolPolicyVersion: versionSchema.optional(),
}).strict();

export const modelConfigSchema = z.object({
  quantization: versionSchema.optional(),
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().nonnegative().optional(),
  seed: z.number().int().optional(),
  reasoning: z.enum(["off", "low", "medium", "high"]).optional(),
  templateVersion: versionSchema.optional(),
  extraConfigSha256: sha256Schema.optional(),
}).strict();

export const modelRefSchema = z.object({
  id: versionSchema,
  provider: versionSchema,
  runtime: versionSchema,
  config: modelConfigSchema,
}).strict();

export const loggingRefSchema = z.object({
  schemaVersion: versionSchema,
  requiredFieldsSha256: sha256Schema,
}).strict();

export const testHarnessRefSchema = z.object({
  id: slugSchema,
  version: versionSchema,
  corpusSha256: sha256Schema,
  oracleVersion: versionSchema,
  holdoutRevision: versionSchema,
}).strict();

export const routingRefSchema = z.object({
  policyId: slugSchema,
  version: versionSchema,
  configSha256: sha256Schema,
}).strict();

const learningConfigurationPayloadSchema = z.object({
  prompt: promptRefSchema,
  harness: harnessRefSchema,
  model: modelRefSchema,
  logging: loggingRefSchema,
  testHarness: testHarnessRefSchema,
  routing: routingRefSchema,
}).strict();
export const learningConfigurationSchema = learningConfigurationPayloadSchema.extend({
  fingerprint: sha256Schema,
}).strict().superRefine((value, ctx) => {
  const expected = computeConfigurationFingerprint(value);
  if (value.fingerprint !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["fingerprint"],
      message: `configuration fingerprint mismatch; expected ${expected}`,
    });
  }
});
export type LearningConfiguration = z.infer<typeof learningConfigurationSchema>;

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

export function computeConfigurationFingerprint(
  configuration: Omit<LearningConfiguration, "fingerprint"> | LearningConfiguration,
): string {
  const { fingerprint: _fingerprint, ...payload } = configuration as LearningConfiguration;
  return createHash("sha256").update(stable(payload)).digest("hex");
}

/** Return the semantic axes that differ between two versioned configurations. */
export function configurationChangedAxes(
  champion: LearningConfiguration,
  challenger: LearningConfiguration,
): LearningChangeAxis[] {
  const changed: LearningChangeAxis[] = [];
  if (stable(champion.logging) !== stable(challenger.logging)) changed.push("logging");
  if (stable(champion.testHarness) !== stable(challenger.testHarness)) changed.push("test-harness");
  if (stable(champion.prompt) !== stable(challenger.prompt)) changed.push("agent-prompt");
  if (stable(champion.harness) !== stable(challenger.harness)) changed.push("agent-harness");
  const championModelIdentity = {
    id: champion.model.id,
    provider: champion.model.provider,
    runtime: champion.model.runtime,
  };
  const challengerModelIdentity = {
    id: challenger.model.id,
    provider: challenger.model.provider,
    runtime: challenger.model.runtime,
  };
  if (stable(championModelIdentity) !== stable(challengerModelIdentity)) changed.push("model");
  if (stable(champion.model.config) !== stable(challenger.model.config)) changed.push("model-config");
  if (stable(champion.routing) !== stable(challenger.routing)) changed.push("routing");
  return changed;
}

export const learningPrimaryMetricSchema = z.enum([
  "quality-rate",
  "useful-rate",
  "rescue-rate",
  "latency-ms",
  "cost-usd",
  "human-review-seconds",
  "edit-start-ms",
  "observability-coverage",
  "verifier-score",
]);
export type LearningPrimaryMetric = z.infer<typeof learningPrimaryMetricSchema>;

export const learningExperimentGatesSchema = z.object({
  minMatchedPairs: z.number().int().min(2).max(200).default(6),
  minHoldoutPairs: z.number().int().min(1).max(100).default(2),
  minVerifiedCoverage: z.number().min(0).max(1).default(0.8),
  minRatedCoverage: z.number().min(0).max(1).default(0.5),
  /** Optional fail-closed attribution gate for genuine, fully observed agent-side checks. */
  minChallengerAgentCheckCoverage: z.number().min(0).max(1).default(0),
  maxQualityRegression: z.number().min(0).max(1).default(0),
  maxUsefulRegression: z.number().min(0).max(1).default(0),
  maxRescueRateIncrease: z.number().min(0).max(1).default(0),
  maxInfraRateIncrease: z.number().min(0).max(1).default(0.05),
  maxLatencyRatio: z.number().min(1).max(100).nullable().default(1.25),
  maxCostRatio: z.number().min(1).max(100).nullable().default(1.25),
  primaryMetric: learningPrimaryMetricSchema,
  /** Absolute delta for rates; relative reduction for lower-is-better scalar metrics. */
  minPrimaryImprovement: z.number().min(0).max(1).default(0.05),
}).strict();
export type LearningExperimentGates = z.infer<typeof learningExperimentGatesSchema>;

export const learningExperimentCreateInputShape = {
  experiment_id: slugSchema,
  scope: slugSchema,
  task_type: taskTypeSchema,
  hypothesis: z.string().min(1).max(2_000),
  change_axis: learningChangeAxisSchema,
  champion: learningConfigurationSchema,
  challenger: learningConfigurationSchema,
  gates: learningExperimentGatesSchema,
};

export const learningExperimentCreateSchema = z.object(
  learningExperimentCreateInputShape,
).strict().superRefine((value, ctx) => {
  if (value.champion.fingerprint === value.challenger.fingerprint) {
    ctx.addIssue({
      code: "custom",
      path: ["challenger", "fingerprint"],
      message: "challenger fingerprint must differ from champion",
    });
  }
  const changed = configurationChangedAxes(value.champion, value.challenger);
  if (changed.length !== 1 || changed[0] !== value.change_axis) {
    ctx.addIssue({
      code: "custom",
      path: ["change_axis"],
      message:
        `exactly one declared axis may change; declared ${value.change_axis}, ` +
        `observed ${changed.length > 0 ? changed.join(", ") : "none"}`,
    });
  }
});
export type LearningExperimentCreate = z.infer<typeof learningExperimentCreateSchema>;

export const learningQualityOutcomeSchema = z.enum([
  "pass",
  "fail",
  "unverified",
  "infra-error",
]);

export const learningProductOutcomeSchema = z.enum([
  "accepted-unchanged",
  "minor-edit",
  "major-rewrite",
  "discarded",
  "unrated",
]);

export const learningVerifierSchema = z.object({
  kind: z.enum(["mechanical", "human", "judge", "none"]),
  independent: z.boolean(),
  id: versionSchema.optional(),
  version: versionSchema.optional(),
}).strict();

export const learningAgentCheckAttemptSchema = z.object({
  order: z.number().int().positive(),
  kind: z.enum(["typescript", "test", "lint", "build", "validation"]),
  command_fingerprint: prefixedSha256Schema,
  started_ms: z.number().int().nonnegative(),
  ended_ms: z.number().int().nonnegative(),
  status: z.enum(["passed", "failed", "execution-error"]),
  exit_code: z.number().int().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.ended_ms < value.started_ms) {
    ctx.addIssue({ code: "custom", path: ["ended_ms"], message: "check ended before it started" });
  }
  if (value.status === "failed" && (value.exit_code === null || value.exit_code <= 0)) {
    ctx.addIssue({ code: "custom", path: ["exit_code"], message: "failed checks require a positive exit code" });
  }
  if (value.status !== "failed" && value.exit_code !== null) {
    ctx.addIssue({ code: "custom", path: ["exit_code"], message: "only failed checks carry a numeric exit code" });
  }
});

export const learningAgentChecksSchema = z.object({
  schema_version: z.literal(3),
  source: z.literal("pi-bash-events"),
  state: z.enum(["none", "attempted", "unobservable", "partial"]),
  unparseable_lines: z.number().int().nonnegative(),
  coverage_loss_events: z.number().int().nonnegative(),
  work_id: z.string().min(1).max(200),
  attempts: z.array(learningAgentCheckAttemptSchema).max(1_000),
}).strict().superRefine((value, ctx) => {
  const hasAttempts = value.attempts.length > 0;
  if ((value.state === "attempted" || value.state === "partial") !== hasAttempts) {
    ctx.addIssue({ code: "custom", path: ["attempts"], message: "agent-check state disagrees with attempts" });
  }
  const hasCoverageLoss = value.unparseable_lines > 0 || value.coverage_loss_events > 0;
  if ((value.state === "unobservable" || value.state === "partial") !== hasCoverageLoss) {
    ctx.addIssue({ code: "custom", path: ["state"], message: "agent-check state disagrees with event coverage" });
  }
  for (let index = 0; index < value.attempts.length; index += 1) {
    if (value.attempts[index]?.order !== index + 1) {
      ctx.addIssue({ code: "custom", path: ["attempts", index, "order"], message: "check order must be contiguous" });
    }
  }
});

export const learningObservationInputShape = {
  experiment_id: slugSchema,
  run_id: z.string().min(1).max(200),
  sample_id: z.string().min(1).max(200),
  arm: z.enum(["champion", "challenger"]),
  holdout: z.boolean(),
  configuration_fingerprint: sha256Schema,
  quality_outcome: learningQualityOutcomeSchema,
  product_outcome: learningProductOutcomeSchema.default("unrated"),
  verifier: learningVerifierSchema,
  latency_ms: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  human_review_seconds: z.number().nonnegative().optional(),
  edit_start_ms: z.number().int().nonnegative().optional(),
  observability_coverage: z.number().min(0).max(1).optional(),
  verifier_score: z.number().min(0).max(1).optional(),
  edited: z.boolean().optional(),
  tests_run: z.boolean().optional(),
  tests_passed: z.boolean().optional(),
  phase_ms: z.object({
    inspect: z.number().int().nonnegative().optional(),
    edit: z.number().int().nonnegative().optional(),
    check: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  failure_kind: z.string().min(1).max(120).optional(),
  task_id: z.string().min(1).max(200).optional(),
  ledger_id: z.string().min(1).max(200).optional(),
  work_id: z.string().min(1).max(200).optional(),
  client_run_id: clientRunIdSchema.optional(),
  request_fingerprint: prefixedSha256Schema.optional(),
  agent_checks: learningAgentChecksSchema.optional(),
};

function validateObservationBindings(
  value: {
    work_id?: string;
    client_run_id?: string;
    request_fingerprint?: string;
    agent_checks?: z.infer<typeof learningAgentChecksSchema>;
  },
  ctx: z.RefinementCtx,
): void {
  if ((value.client_run_id === undefined) !== (value.request_fingerprint === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: [value.client_run_id === undefined ? "client_run_id" : "request_fingerprint"],
      message: "durable observations require both client run id and request fingerprint",
    });
  }
  if (value.agent_checks && value.agent_checks.work_id !== value.work_id) {
    ctx.addIssue({
      code: "custom",
      path: ["agent_checks", "work_id"],
      message: "agent-check evidence must match the observation work id",
    });
  }
}

export const learningObservationSchema = z.object(learningObservationInputShape)
  .strict()
  .superRefine(validateObservationBindings);
export type LearningObservationInput = z.infer<typeof learningObservationSchema>;

export const recordedLearningObservationSchema = z.object({
  ...learningObservationInputShape,
  recorded_at: z.string().min(1),
  recorded_by: z.string().min(1),
  product_rated_at: z.string().min(1).optional(),
  product_rated_by: z.string().min(1).optional(),
}).strict().superRefine(validateObservationBindings);
export type RecordedLearningObservation = z.infer<typeof recordedLearningObservationSchema>;

const ratedProductOutcomeSchema = z.enum([
  "accepted-unchanged",
  "minor-edit",
  "major-rewrite",
  "discarded",
]);

/**
 * Product usefulness is intentionally enriched after mechanical collection.
 * Automated runners can record `unrated` immediately; a later human/downstream
 * review may move that observation to exactly one terminal product outcome.
 */
export const learningExperimentRateInputShape = {
  experiment_id: slugSchema,
  run_id: z.string().min(1).max(200),
  product_outcome: ratedProductOutcomeSchema,
  human_review_seconds: z.number().nonnegative().optional(),
};
export const learningExperimentRateSchema = z.object(
  learningExperimentRateInputShape,
).strict();
export type LearningExperimentRate = z.infer<typeof learningExperimentRateSchema>;

export const failureSignalSchema = z.object({
  signal: z.string().min(1),
  count: z.number().int().nonnegative(),
}).strict();

export const learningArmSummarySchema = z.object({
  samples: z.number().int().nonnegative(),
  verifiedSamples: z.number().int().nonnegative(),
  verifiedCoverage: z.number().min(0).max(1),
  qualityRate: z.number().min(0).max(1).nullable(),
  ratedSamples: z.number().int().nonnegative(),
  ratedCoverage: z.number().min(0).max(1),
  usefulRate: z.number().min(0).max(1).nullable(),
  rescueRate: z.number().min(0).max(1).nullable(),
  infraRate: z.number().min(0).max(1),
  latencyMeanMs: z.number().nonnegative().nullable(),
  costMeanUsd: z.number().nonnegative().nullable(),
  humanReviewMeanSeconds: z.number().nonnegative().nullable(),
  editStartMeanMs: z.number().nonnegative().nullable(),
  observabilityCoverageMean: z.number().min(0).max(1).nullable(),
  verifierScoreMean: z.number().min(0).max(1).nullable(),
  agentCheckSamples: z.number().int().nonnegative().default(0),
  agentCheckCoverage: z.number().min(0).max(1).default(0),
}).strict();
export type LearningArmSummary = z.infer<typeof learningArmSummarySchema>;

export const learningExperimentEvaluationSchema = z.object({
  decision: z.enum(["gathering", "promotion-ready", "reject"]),
  reason: z.string().min(1),
  evaluatedAt: z.string().min(1),
  matchedPairs: z.number().int().nonnegative(),
  holdoutPairs: z.number().int().nonnegative(),
  unmatchedObservations: z.number().int().nonnegative(),
  champion: learningArmSummarySchema,
  challenger: learningArmSummarySchema,
  primaryMetric: learningPrimaryMetricSchema,
  primaryChampion: z.number().nullable(),
  primaryChallenger: z.number().nullable(),
  primaryImprovement: z.number().nullable(),
  guardFailures: z.array(z.string()),
  missingRequirements: z.array(z.string()),
  failureSignals: z.array(failureSignalSchema),
  nextAction: z.string().min(1),
}).strict();
export type LearningExperimentEvaluation = z.infer<
  typeof learningExperimentEvaluationSchema
>;

export const learningExperimentStateSchema = z.object({
  schemaVersion: z.literal(1),
  experimentId: slugSchema,
  scope: slugSchema,
  taskType: taskTypeSchema,
  ownerPrincipal: z.string().min(1),
  hypothesis: z.string().min(1).max(2_000),
  changeAxis: learningChangeAxisSchema,
  champion: learningConfigurationSchema,
  challenger: learningConfigurationSchema,
  gates: learningExperimentGatesSchema,
  status: z.enum(["running", "promotion-ready", "rejected", "promoted"]),
  revision: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  observations: z.array(recordedLearningObservationSchema).max(400),
  evaluation: learningExperimentEvaluationSchema,
  promotion: z.object({
    appliedRef: z.string().min(1).max(500),
    promotedAt: z.string().min(1),
    promotedBy: z.string().min(1),
  }).strict().optional(),
}).strict();
export type LearningExperimentState = z.infer<typeof learningExperimentStateSchema>;

export const learningExperimentStatusInputShape = {
  experiment_id: slugSchema,
};
export const learningExperimentStatusSchema = z.object(
  learningExperimentStatusInputShape,
).strict();

export const learningExperimentPromoteInputShape = {
  experiment_id: slugSchema,
  configuration_fingerprint: sha256Schema,
  applied_ref: z.string().regex(/^[A-Za-z0-9._/-]+@[A-Za-z0-9._-]{1,120}$/),
};
export const learningExperimentPromoteSchema = z.object(
  learningExperimentPromoteInputShape,
).strict();
export type LearningExperimentPromote = z.infer<typeof learningExperimentPromoteSchema>;

export const learningChampionStateSchema = z.object({
  schemaVersion: z.literal(1),
  scope: slugSchema,
  ownerPrincipal: z.string().min(1),
  configuration: learningConfigurationSchema,
  sourceExperimentId: slugSchema.nullable(),
  appliedRef: z.string().min(1).max(500),
  promotedAt: z.string().min(1),
  promotedBy: z.string().min(1),
}).strict();
export type LearningChampionState = z.infer<typeof learningChampionStateSchema>;
