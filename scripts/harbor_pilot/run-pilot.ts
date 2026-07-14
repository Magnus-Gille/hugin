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
  HARBOR_PILOT_DEFAULT_BASE_IMAGE,
  HARBOR_PILOT_TASK_IDS,
  HARBOR_PILOT_VERSION,
  prepareGateDHarborPilot,
} from "./prepare-gate-d.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const MODEL = "qwen3-coder-next-80b";
const HARNESS_VERSION = "code-loop-pi-2026-07-13-v2";
const CAPS = { wall_s: 600, turns: 13, completion_tokens: 60_000 } as const;

const controlSchema = z.object({
  task_id: z.string().min(1),
  protected: z.array(z.string().min(1)),
}).passthrough();

interface BaselineResult {
  taskId: string;
  passed: boolean;
  applyReturnCode: number | null;
  checkReturnCode: number | null;
  checkTail: string;
  workId: string;
  status: string;
  usage: M5CodeLoopResult["usage"];
  execution: M5CodeLoopResult["execution"];
  telemetry: M5CodeLoopResult["telemetry"];
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
}): Pick<BaselineResult, "passed" | "applyReturnCode" | "checkReturnCode" | "checkTail"> {
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
        checkTail: applied?.stderr?.slice(-1_000) ?? "empty diff",
      };
    }
    const checked = spawnSync(
      "bash",
      [join(input.sourceRepo, "gate-d", "check.sh"), taskDir, work],
      { encoding: "utf8", timeout: 300_000 },
    );
    const output = `${checked.stdout ?? ""}${checked.stderr ?? ""}`;
    return {
      passed: checked.status === 0,
      applyReturnCode: applied.status,
      checkReturnCode: checked.status,
      checkTail: output.slice(-1_000),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runBaseline(input: {
  sourceRepo: string;
  outputDir: string;
}): Promise<BaselineResult[]> {
  const replayDir = join(input.outputDir, "replays");
  mkdirSync(replayDir);
  const baselines: BaselineResult[] = [];
  for (const taskId of HARBOR_PILOT_TASK_IDS) {
    const taskDir = join(input.sourceRepo, "gate-d", "tasks", taskId);
    const control = controlSchema.parse(JSON.parse(
      readFileSync(join(input.outputDir, "tasks", taskId, "environment", "control.json"), "utf8"),
    ));
    const request: HarborCodeLoopOnceInput["request"] = {
      instruction: readFileSync(join(taskDir, "INSTRUCTION.md"), "utf8"),
      files: filesUnder(join(taskDir, "repo")),
      protected: control.protected,
      task_type: "code-edit",
      caps: CAPS,
    };
    const once: HarborCodeLoopOnceInput = {
      request,
      expected: { model: MODEL, harnessVersion: HARNESS_VERSION, caps: CAPS },
      pollMs: 5_000,
      resultDeadlineS: 900,
    };
    process.stdout.write(`[baseline/${taskId}] starting M5 code_loop\n`);
    const result = await runCodeLoopOnce(once);
    writeFileSync(join(replayDir, `${taskId}.json`), `${JSON.stringify(result)}\n`, { mode: 0o600 });
    const verified = verifyBaseline({ result, sourceRepo: input.sourceRepo, taskId });
    const diffBytes = Buffer.byteLength(result.diff);
    const baseline: BaselineResult = {
      taskId,
      ...verified,
      workId: result.work_id,
      status: result.status,
      usage: result.usage,
      execution: result.execution,
      telemetry: result.telemetry,
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
  process.stdout.write(`[harbor/${input.mode}] starting sequential two-task job\n`);
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

function assertExpectedTrials(label: string, trials: HarborTrialSummary[]): void {
  const ids = trials.map((trial) => trial.taskId);
  if (JSON.stringify(ids) !== JSON.stringify([...HARBOR_PILOT_TASK_IDS])) {
    throw new Error(`${label} produced unexpected trial set: ${ids.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const sourceRepo = resolve(valueAfter("--source-repo") ?? join(REPO_ROOT, "../gille-inference"));
  const harborBin = resolve(valueAfter("--harbor-bin") ?? requiredEnv("HARBOR_BIN"));
  const networkModeArg = valueAfter("--network-mode") ?? (process.platform === "darwin" ? "public" : "no-network");
  if (networkModeArg !== "no-network" && networkModeArg !== "public") {
    throw new Error("--network-mode must be no-network or public");
  }
  const networkMode: "no-network" | "public" = networkModeArg;
  const baseImage = valueAfter("--base-image");
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
    networkMode,
    baseImage,
  });
  preflightCustomBaseImage(prepared.baseImage);
  process.stdout.write(
    `prepared ${prepared.taskIds.length} tasks from ${prepared.sourceCommit.slice(0, 12)} ` +
    `under ${prepared.outputDir}\n`,
  );

  const baselines = await runBaseline({ sourceRepo, outputDir: prepared.outputDir });
  await runHarbor({ harborBin, outputDir: prepared.outputDir, mode: "replay" });
  await runHarbor({ harborBin, outputDir: prepared.outputDir, mode: "live" });

  const replay = summarizeHarborJob(join(prepared.outputDir, "jobs", "replay"));
  const live = summarizeHarborJob(join(prepared.outputDir, "jobs", "live"));
  assertExpectedTrials("Harbor replay", replay);
  assertExpectedTrials("Harbor live", live);

  const replayParity = replay.map((trial) => {
    const baseline = baselines.find((item) => item.taskId === trial.taskId)!;
    const metadata = trial.metadata ?? {};
    return {
      taskId: trial.taskId,
      baselinePassed: baseline.passed,
      harborPassed: trial.reward === 1,
      rewardParity: baseline.passed === (trial.reward === 1),
      diffParity: metadata.diff_sha256 === baseline.diffSha256,
      applyReturnCode: metadata.apply_return_code ?? null,
      exceptionType: trial.exceptionType,
    };
  });
  const liveAdapter = live.map((trial) => ({
    taskId: trial.taskId,
    passed: trial.reward === 1,
    reward: trial.reward,
    status: trial.metadata?.status ?? null,
    workId: trial.metadata?.work_id ?? null,
    execution: trial.metadata?.execution ?? null,
    applyReturnCode: trial.metadata?.apply_return_code ?? null,
    diffBytes: trial.metadata?.diff_bytes ?? null,
    exceptionType: trial.exceptionType,
  }));
  const exactReplayParity = replayParity.every((row) =>
    row.rewardParity && row.diffParity && row.exceptionType === null && row.applyReturnCode === 0
  );
  const liveAdapterCompleted = liveAdapter.every((row) =>
    row.exceptionType === null && typeof row.workId === "string" && row.execution !== null
  );
  const environmentConditionsMet =
    networkMode === "no-network" && prepared.baseImage === HARBOR_PILOT_DEFAULT_BASE_IMAGE;
  const recommendation = exactReplayParity && liveAdapterCompleted
    ? environmentConditionsMet ? "go" : "conditional-go"
    : "no-go";
  const report = {
    schema_version: 1,
    pilot_version: HARBOR_PILOT_VERSION,
    harbor_version: harborVersion,
    source_commit: prepared.sourceCommit,
    task_ids: prepared.taskIds,
    caps: CAPS,
    model: MODEL,
    harness_version: HARNESS_VERSION,
    network_mode: networkMode,
    network_isolation_met: networkMode === "no-network",
    base_image: prepared.baseImage,
    standard_base_image_met: prepared.baseImage === HARBOR_PILOT_DEFAULT_BASE_IMAGE,
    exact_replay_parity: exactReplayParity,
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
