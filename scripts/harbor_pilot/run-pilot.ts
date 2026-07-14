#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  type M5CodeLoopResult,
} from "../../src/learning/m5-code-loop-adapter.js";
import {
  runCodeLoopOnce,
  type HarborCodeLoopOnceInput,
} from "./m5-code-loop-once.js";
import {
  HARBOR_PILOT_CAMPAIGN_ID,
  HARBOR_PILOT_DEFAULT_BASE_IMAGE,
  HARBOR_PILOT_HOLDOUT_IDS,
  HARBOR_PILOT_TASK_IDS,
  HARBOR_PILOT_VERSION,
  prepareGateDHarborPilot,
  type PreparedHarborPilot,
} from "./prepare-gate-d.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const MODEL = "qwen3-coder-next-80b";
const HARNESS_VERSION = "code-loop-pi-2026-07-14-v6";
const CAPS = { wall_s: 600, turns: 13, completion_tokens: 60_000 } as const;
const EXPECTED_CAPABILITIES = {
  startIdempotency: "client-run-id-v1",
  agentChecks: "pi-bash-events-v3",
} as const;

const controlSchema = z.object({
  task_id: z.string().min(1),
  holdout: z.boolean(),
  protected: z.array(z.string().min(1)),
  client_run_ids: z.object({
    baseline: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    live: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  }).strict(),
}).passthrough();
const gitCommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

const declarationSchema = z.object({
  schema_version: z.literal(1),
  status: z.literal("declared-not-run"),
  campaign_id: z.string().min(1),
  pilot_version: z.string().min(1),
  harbor_version: z.literal("0.18.0"),
  source_commit: gitCommitSchema,
  task_ids: z.array(z.string().min(1)),
  holdout_ids: z.array(z.string().min(1)),
  holdout_revision: z.string().min(1),
  corpus_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  verifier_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  harbor_verifier_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string().min(1),
  harness_version: z.string().min(1),
  caps: z.object({
    wall_s: z.number().int().positive(),
    turns: z.number().int().positive(),
    completion_tokens: z.number().int().positive(),
  }).strict(),
  required_capabilities: z.object({
    start_idempotency: z.literal("client-run-id-v1"),
    agent_checks: z.literal("pi-bash-events-v3"),
  }).strict(),
  network_mode: z.literal("no-network"),
  base_image: z.string().min(1),
  harbor_concurrency: z.literal(1),
  attempts_per_task: z.literal(1),
  model_calls_at_declaration: z.literal(0),
}).passthrough();

interface BaselineResult {
  taskId: string;
  passed: boolean;
  holdout: boolean;
  applyReturnCode: number | null;
  checkReturnCode: number | null;
  checkDurationMs: number;
  failureKind: "empty-diff" | "apply-failed" | "check-failed" | null;
  workId: string;
  clientRunId: string;
  requestFingerprint: string;
  recovered: boolean;
  startCapabilities: Record<string, string>;
  status: string;
  usage: M5CodeLoopResult["usage"];
  execution: M5CodeLoopResult["execution"];
  telemetry: M5CodeLoopResult["telemetry"];
  agentChecks: M5CodeLoopResult["agent_checks"];
  diffSha256: string;
  diffBytes: number;
}

export interface HarborTrialSummary {
  taskId: string;
  reward: number | null;
  rewards: Record<string, number> | null;
  exceptionType: string | null;
  metadata: Record<string, unknown> | null;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") throw new Error(`missing required environment variable ${name}`);
  return value;
}

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function csvAfter(flag: string): string[] | undefined {
  const value = valueAfter(flag);
  if (value === undefined) return undefined;
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error(`${flag} requires a comma-separated value`);
  return entries;
}

function filesUnder(rootInput: string): Array<{ path: string; content: string }> {
  const root = resolve(rootInput);
  const files: Array<{ path: string; content: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Gate D seed contains symlink: ${path}`);
      if (stat.isDirectory()) {
        walk(path);
      } else if (stat.isFile()) {
        files.push({ path: relative(root, path), content: readFileSync(path, "utf8") });
      }
    }
  };
  walk(root);
  return files;
}

function runChecked(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

export function bindDeclaration(input: {
  path: string;
  prepared: PreparedHarborPilot;
  networkMode: "no-network" | "public";
}): string {
  const bytes = readFileSync(input.path);
  const declaration = declarationSchema.parse(JSON.parse(bytes.toString("utf8")));
  const expected = {
    campaign_id: input.prepared.campaignId,
    pilot_version: HARBOR_PILOT_VERSION,
    source_commit: input.prepared.sourceCommit,
    task_ids: input.prepared.taskIds,
    holdout_ids: input.prepared.holdoutIds,
    holdout_revision: input.prepared.holdoutRevision,
    corpus_sha256: input.prepared.corpusSha256,
    verifier_sha256: input.prepared.verifierSha256,
    harbor_verifier_sha256: input.prepared.harborVerifierSha256,
    model: MODEL,
    harness_version: HARNESS_VERSION,
    caps: CAPS,
    network_mode: input.networkMode,
    base_image: input.prepared.baseImage,
  };
  const actual = {
    campaign_id: declaration.campaign_id,
    pilot_version: declaration.pilot_version,
    source_commit: declaration.source_commit,
    task_ids: declaration.task_ids,
    holdout_ids: declaration.holdout_ids,
    holdout_revision: declaration.holdout_revision,
    corpus_sha256: declaration.corpus_sha256,
    verifier_sha256: declaration.verifier_sha256,
    harbor_verifier_sha256: declaration.harbor_verifier_sha256,
    model: declaration.model,
    harness_version: declaration.harness_version,
    caps: declaration.caps,
    network_mode: declaration.network_mode,
    base_image: declaration.base_image,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("generated Harbor campaign does not match the pre-inference declaration");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export function customBasePreflightScript(): string {
  return [
    "command -v node",
    "command -v python3",
    "command -v bash",
    "command -v diff",
    "command -v grep",
    "command -v tsc",
    "command -v tsx",
    "test -f /opt/gate-d/node_modules/@types/node/package.json",
  ].join(" && ");
}

export function sourceBaselinePreflightScript(): string {
  return [
    "test -x ./node_modules/.bin/tsx",
    "test -x ./node_modules/.bin/tsc",
    "node -e \"require('esbuild').transformSync('const x: number = 1', { loader: 'ts' })\"",
    "./node_modules/.bin/tsc --version",
  ].join(" && ");
}

function preflightSourceBaseline(sourceRepo: string): void {
  try {
    runChecked("bash", ["-c", sourceBaselinePreflightScript()], sourceRepo);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      "Gate D source dependencies are missing or incompatible with this Harbor worker. " +
      `Run npm ci in ${sourceRepo} on the worker before starting the pilot. ${detail}`,
    );
  }
}

function preflightCustomBaseImage(baseImage: string | undefined): void {
  if (!baseImage || baseImage === HARBOR_PILOT_DEFAULT_BASE_IMAGE) return;
  runChecked("docker", [
    "run",
    "--rm",
    baseImage,
    "sh",
    "-lc",
    customBasePreflightScript(),
  ], REPO_ROOT);
}

function verifyBaseline(input: {
  result: M5CodeLoopResult;
  sourceRepo: string;
  taskId: string;
}): Pick<
  BaselineResult,
  "passed" | "applyReturnCode" | "checkReturnCode" | "checkDurationMs" | "failureKind"
> {
  const taskDir = join(input.sourceRepo, "gate-d", "tasks", input.taskId);
  const root = mkdtempSync(join(tmpdir(), `hugin-harbor-baseline-${input.taskId}-`));
  const work = join(root, "repo");
  try {
    cpSync(join(taskDir, "repo"), work, { recursive: true });
    symlinkSync(join(input.sourceRepo, "node_modules"), join(work, "node_modules"), "dir");
    const applied = input.result.diff
      ? spawnSync("git", ["apply", "--whitespace=nowarn", "-"], {
          cwd: work,
          input: input.result.diff,
          encoding: "utf8",
          timeout: 60_000,
        })
      : null;
    if (!applied || applied.status !== 0) {
      return {
        passed: false,
        applyReturnCode: applied?.status ?? null,
        checkReturnCode: null,
        checkDurationMs: 0,
        failureKind: applied ? "apply-failed" : "empty-diff",
      };
    }
    const checkStarted = Date.now();
    const checked = spawnSync(
      "bash",
      [join(input.sourceRepo, "gate-d", "check.sh"), taskDir, work],
      { encoding: "utf8", timeout: 300_000 },
    );
    return {
      passed: checked.status === 0,
      applyReturnCode: applied.status,
      checkReturnCode: checked.status,
      checkDurationMs: Date.now() - checkStarted,
      failureKind: checked.status === 0 ? null : "check-failed",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runBaseline(input: {
  sourceRepo: string;
  outputDir: string;
  taskIds: string[];
}): Promise<BaselineResult[]> {
  const replayDir = join(input.outputDir, "replays");
  mkdirSync(replayDir);
  const baselines: BaselineResult[] = [];
  for (const taskId of input.taskIds) {
    const taskDir = join(input.sourceRepo, "gate-d", "tasks", taskId);
    const control = controlSchema.parse(JSON.parse(
      readFileSync(join(input.outputDir, "tasks", taskId, "environment", "control.json"), "utf8"),
    ));
    const request: HarborCodeLoopOnceInput["request"] = {
      client_run_id: control.client_run_ids.baseline,
      instruction: readFileSync(join(taskDir, "INSTRUCTION.md"), "utf8"),
      files: filesUnder(join(taskDir, "repo")),
      protected: control.protected,
      task_type: "code-edit",
      caps: CAPS,
    };
    const once: HarborCodeLoopOnceInput = {
      request,
      expected: {
        model: MODEL,
        harnessVersion: HARNESS_VERSION,
        caps: CAPS,
        capabilities: EXPECTED_CAPABILITIES,
      },
      pollMs: 5_000,
      resultDeadlineS: 900,
    };
    process.stdout.write(`[baseline/${taskId}] starting M5 code_loop\n`);
    const output = await runCodeLoopOnce(once);
    const { result, start } = output;
    if (!start || !start.request_fingerprint || start.client_run_id !== control.client_run_ids.baseline) {
      throw new Error(`[baseline/${taskId}] missing durable M5 start evidence`);
    }
    writeFileSync(join(replayDir, `${taskId}.json`), `${JSON.stringify(result)}\n`, { mode: 0o600 });
    const verified = verifyBaseline({ result, sourceRepo: input.sourceRepo, taskId });
    const diffBytes = Buffer.byteLength(result.diff);
    const baseline: BaselineResult = {
      taskId,
      holdout: control.holdout,
      ...verified,
      workId: result.work_id,
      clientRunId: control.client_run_ids.baseline,
      requestFingerprint: start.request_fingerprint,
      recovered: start.recovered,
      startCapabilities: start.capabilities,
      status: result.status,
      usage: result.usage,
      execution: result.execution,
      telemetry: result.telemetry,
      agentChecks: result.agent_checks,
      diffSha256: createHash("sha256").update(result.diff).digest("hex"),
      diffBytes,
    };
    baselines.push(baseline);
    process.stdout.write(
      `[baseline/${taskId}] ${baseline.passed ? "PASS" : "FAIL"}; ` +
      `loop=${baseline.status}; work=${baseline.workId}\n`,
    );
  }
  writeFileSync(join(input.outputDir, "baseline.json"), `${JSON.stringify(baselines, null, 2)}\n`);
  return baselines;
}

function runHarbor(input: {
  harborBin: string;
  outputDir: string;
  mode: "replay" | "live";
  taskCount: number;
}): Promise<void> {
  const jobsDir = join(input.outputDir, "jobs");
  mkdirSync(jobsDir, { recursive: true });
  const args = [
    "run",
    "--path", join(input.outputDir, "tasks"),
    "--agent", "scripts.harbor_pilot.m5_code_loop_agent:M5CodeLoopAgent",
    "--model", MODEL,
    "--agent-kwarg", `expected_harness_version=${HARNESS_VERSION}`,
    "--agent-kwarg", `wall_s=${CAPS.wall_s}`,
    "--agent-kwarg", `turns=${CAPS.turns}`,
    "--agent-kwarg", `completion_tokens=${CAPS.completion_tokens}`,
    "--agent-kwarg", "poll_ms=5000",
    "--agent-kwarg", "result_deadline_s=900",
    "--env", "docker",
    "--n-concurrent", "1",
    "--n-attempts", "1",
    "--max-retries", "0",
    "--jobs-dir", jobsDir,
    "--job-name", input.mode,
    "--yes",
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARBOR_TELEMETRY: "off",
    PYTHONPATH: [REPO_ROOT, process.env.PYTHONPATH].filter(Boolean).join(":"),
  };
  if (input.mode === "replay") {
    env.HUGIN_HARBOR_REPLAY_DIR = join(input.outputDir, "replays");
  } else {
    delete env.HUGIN_HARBOR_REPLAY_DIR;
  }
  process.stdout.write(`[harbor/${input.mode}] starting sequential ${input.taskCount}-task job\n`);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(input.harborBin, args, {
      cwd: REPO_ROOT,
      env,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`Harbor ${input.mode} job exited ${code ?? "without status"}`));
    });
  });
}

function filesNamed(root: string, name: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name === name) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

export function summarizeHarborJob(jobDir: string): HarborTrialSummary[] {
  return filesNamed(jobDir, "result.json").flatMap((path) => {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof raw.task_name !== "string") return [];
    const verifier = raw.verifier_result as { rewards?: Record<string, number> } | null;
    const exception = raw.exception_info as { exception_type?: unknown } | null;
    const agentResult = raw.agent_result as { metadata?: Record<string, unknown> } | null;
    const rewards = verifier?.rewards ?? null;
    return [{
      taskId: String(raw.task_name),
      reward: typeof rewards?.reward === "number" ? rewards.reward : null,
      rewards,
      exceptionType: typeof exception?.exception_type === "string" ? exception.exception_type : null,
      metadata: agentResult?.metadata ?? null,
    }];
  }).sort((a, b) => a.taskId.localeCompare(b.taskId));
}

function assertExpectedTrials(
  label: string,
  trials: HarborTrialSummary[],
  expectedTaskIds: string[],
): void {
  const ids = trials.map((trial) => trial.taskId);
  if (JSON.stringify(ids) !== JSON.stringify([...expectedTaskIds].sort())) {
    throw new Error(`${label} produced unexpected trial set: ${ids.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const runnerDirty = runChecked("git", ["status", "--short"], REPO_ROOT);
  if (runnerDirty) throw new Error("Hugin runner repository must be clean before the pilot");
  const runnerCommit = runChecked("git", ["rev-parse", "HEAD"], REPO_ROOT);
  const sourceRepo = resolve(valueAfter("--source-repo") ?? join(REPO_ROOT, "../gille-inference"));
  const harborBin = resolve(valueAfter("--harbor-bin") ?? requiredEnv("HARBOR_BIN"));
  const taskIds = csvAfter("--task-ids") ?? [...HARBOR_PILOT_TASK_IDS];
  const holdoutIds = csvAfter("--holdout-ids") ?? [...HARBOR_PILOT_HOLDOUT_IDS];
  const campaignId = valueAfter("--campaign-id") ?? HARBOR_PILOT_CAMPAIGN_ID;
  const declarationArg = valueAfter("--declaration");
  if (!declarationArg) {
    throw new Error("--declaration is required; the consumed Gate D v2 declaration must not be reused");
  }
  const declarationPath = resolve(declarationArg);
  if (taskIds.length < 4) throw new Error("the larger-corpus pilot requires at least four tasks");
  if (holdoutIds.length < 2) throw new Error("the larger-corpus pilot requires at least two predeclared holdouts");
  const networkModeArg = valueAfter("--network-mode") ?? (process.platform === "darwin" ? "public" : "no-network");
  if (networkModeArg !== "no-network" && networkModeArg !== "public") {
    throw new Error("--network-mode must be no-network or public");
  }
  const networkMode: "no-network" | "public" = networkModeArg;
  const baseImage = valueAfter("--base-image");
  preflightSourceBaseline(sourceRepo);
  const explicitOut = valueAfter("--out");
  const outputDir = explicitOut
    ? resolve(explicitOut)
    : join(tmpdir(), `hugin-harbor-pilot-${process.pid}-${Date.now()}`);
  if (explicitOut) mkdirSync(outputDir, { recursive: false });

  requiredEnv("M5_API_KEY");
  if (!process.env.M5_MCP_URL) requiredEnv("M5_BASE_URL");
  const harborVersion = runChecked(harborBin, ["--version"], REPO_ROOT);
  if (harborVersion !== "0.18.0") {
    throw new Error(`Harbor version drift: expected 0.18.0, got ${harborVersion}`);
  }
  runChecked("docker", ["info", "--format", "{{.ServerVersion}}"], REPO_ROOT);

  const preparedDir = explicitOut ? join(outputDir, "prepared") : outputDir;
  const prepared = prepareGateDHarborPilot({
    sourceRepo,
    outputDir: preparedDir,
    taskIds,
    holdoutIds,
    campaignId,
    networkMode,
    baseImage,
  });
  const declarationSha256 = bindDeclaration({
    path: declarationPath,
    prepared,
    networkMode,
  });
  preflightCustomBaseImage(prepared.baseImage);
  process.stdout.write(
    `prepared ${prepared.taskIds.length} tasks from ${prepared.sourceCommit.slice(0, 12)} ` +
    `under ${prepared.outputDir}\n`,
  );

  const baselines = await runBaseline({
    sourceRepo,
    outputDir: prepared.outputDir,
    taskIds: prepared.taskIds,
  });
  await runHarbor({
    harborBin,
    outputDir: prepared.outputDir,
    mode: "replay",
    taskCount: prepared.taskIds.length,
  });
  await runHarbor({
    harborBin,
    outputDir: prepared.outputDir,
    mode: "live",
    taskCount: prepared.taskIds.length,
  });

  const replay = summarizeHarborJob(join(prepared.outputDir, "jobs", "replay"));
  const live = summarizeHarborJob(join(prepared.outputDir, "jobs", "live"));
  assertExpectedTrials("Harbor replay", replay, prepared.taskIds);
  assertExpectedTrials("Harbor live", live, prepared.taskIds);

  const replayParity = replay.map((trial) => {
    const baseline = baselines.find((item) => item.taskId === trial.taskId)!;
    const metadata = trial.metadata ?? {};
    return {
      taskId: trial.taskId,
      holdout: baseline.holdout,
      baselinePassed: baseline.passed,
      harborPassed: trial.reward === 1,
      rewardMeasured: trial.reward === 0 || trial.reward === 1,
      rewardParity: baseline.passed === (trial.reward === 1),
      diffParity: metadata.diff_sha256 === baseline.diffSha256,
      workParity: metadata.work_id === baseline.workId,
      clientRunParity: metadata.client_run_id === baseline.clientRunId,
      applyReturnCode: metadata.apply_return_code ?? null,
      exceptionType: trial.exceptionType,
    };
  });
  const liveAdapter = live.map((trial) => ({
    taskId: trial.taskId,
    holdout: trial.metadata?.holdout ?? null,
    passed: trial.reward === 1,
    reward: trial.reward,
    status: trial.metadata?.status ?? null,
    workId: trial.metadata?.work_id ?? null,
    clientRunId: trial.metadata?.client_run_id ?? null,
    requestFingerprint: trial.metadata?.request_fingerprint ?? null,
    recovered: trial.metadata?.recovered ?? null,
    startCapabilities: trial.metadata?.start_capabilities ?? null,
    execution: trial.metadata?.execution ?? null,
    agentChecks: trial.metadata?.agent_checks ?? null,
    applyReturnCode: trial.metadata?.apply_return_code ?? null,
    diffBytes: trial.metadata?.diff_bytes ?? null,
    exceptionType: trial.exceptionType,
  }));
  const exactReplayParity = replayParity.every((row) =>
    row.rewardMeasured &&
    row.rewardParity &&
    row.diffParity &&
    row.workParity &&
    row.clientRunParity &&
    row.exceptionType === null &&
    row.applyReturnCode === 0
  );
  const baselineDecisionsVerified = baselines.every((row) =>
    row.applyReturnCode === 0 &&
    row.checkReturnCode !== null &&
    row.passed === (row.checkReturnCode === 0)
  );
  const liveAdapterCompleted = liveAdapter.every((row) => {
    const execution = row.execution as Record<string, unknown> | null;
    const effectiveCaps = execution?.effective_caps as Record<string, unknown> | undefined;
    const executionCapabilities = execution?.capabilities as Record<string, unknown> | undefined;
    const startCapabilities = row.startCapabilities as Record<string, unknown> | null;
    const agentChecks = row.agentChecks as Record<string, unknown> | null;
    return row.exceptionType === null &&
      (row.reward === 0 || row.reward === 1) &&
      typeof row.workId === "string" &&
      row.clientRunId === `harbor:${prepared.campaignId}:${row.taskId}:live` &&
      typeof row.requestFingerprint === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(row.requestFingerprint) &&
      row.holdout === prepared.holdoutIds.includes(row.taskId) &&
      startCapabilities?.start_idempotency === "client-run-id-v1" &&
      startCapabilities.agent_checks === "pi-bash-events-v3" &&
      execution?.model === MODEL &&
      execution.harness_version === HARNESS_VERSION &&
      effectiveCaps?.wall_s === CAPS.wall_s &&
      effectiveCaps.turns === CAPS.turns &&
      effectiveCaps.completion_tokens === CAPS.completion_tokens &&
      executionCapabilities?.start_idempotency === "client-run-id-v1" &&
      executionCapabilities.agent_checks === "pi-bash-events-v3" &&
      agentChecks?.schema_version === 3 &&
      agentChecks?.source === "pi-bash-events" &&
      typeof agentChecks.coverage_loss_events === "number" &&
      agentChecks.work_id === row.workId;
  });
  const environmentConditionsMet =
    networkMode === "no-network" && prepared.baseImage === HARBOR_PILOT_DEFAULT_BASE_IMAGE;
  const recommendation = baselineDecisionsVerified && exactReplayParity && liveAdapterCompleted
    ? environmentConditionsMet ? "go" : "conditional-go"
    : "no-go";
  const report = {
    schema_version: 2,
    pilot_version: HARBOR_PILOT_VERSION,
    campaign_id: prepared.campaignId,
    harbor_version: harborVersion,
    runner_commit: runnerCommit,
    declaration_sha256: declarationSha256,
    source_commit: prepared.sourceCommit,
    task_ids: prepared.taskIds,
    holdout_ids: prepared.holdoutIds,
    holdout_revision: prepared.holdoutRevision,
    corpus_sha256: prepared.corpusSha256,
    verifier_sha256: prepared.verifierSha256,
    harbor_verifier_sha256: prepared.harborVerifierSha256,
    caps: CAPS,
    model: MODEL,
    harness_version: HARNESS_VERSION,
    network_mode: networkMode,
    network_isolation_met: networkMode === "no-network",
    base_image: prepared.baseImage,
    standard_base_image_met: prepared.baseImage === HARBOR_PILOT_DEFAULT_BASE_IMAGE,
    exact_replay_parity: exactReplayParity,
    baseline_decisions_verified: baselineDecisionsVerified,
    live_adapter_completed: liveAdapterCompleted,
    recommendation,
    baseline: baselines,
    replay_parity: replayParity,
    live_adapter: liveAdapter,
    output_dir: prepared.outputDir,
  };
  writeFileSync(join(prepared.outputDir, "pilot-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (recommendation === "no-go") process.exitCode = 2;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
