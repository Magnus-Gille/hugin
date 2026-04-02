import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import { MuninClient, type MuninEntry } from "./munin-client.js";
import { executeSdkTask } from "./sdk-executor.js";
import { executeOllamaTask } from "./ollama-executor.js";
import { configureHosts, resolveOllamaHost, getHostStatus } from "./ollama-hosts.js";
import { resolveContextRefs } from "./context-loader.js";
import {
  buildPhaseTaskDrafts,
  buildPipelineDecompositionResult,
  compilePipelineTask,
} from "./pipeline-compiler.js";
import { pipelineIRSchema, type PipelineIR } from "./pipeline-ir.js";
import {
  buildPipelineExecutionSummary,
  getPipelinePhaseLifecycle,
  type PipelinePhaseSnapshot,
} from "./pipeline-summary.js";
import {
  buildRoutingMetadataLines,
  buildTaskResultDocument,
} from "./result-format.js";
import {
  buildPromotedTags,
  evaluateBlockedTask,
  getDependencyIds,
  type DependencyState,
} from "./task-graph.js";
import {
  buildPipelineParentCancelledTags,
  buildPipelineParentSuccessTags,
  buildTerminalStatusTags,
} from "./task-status-tags.js";
import {
  buildStructuredTaskResult,
  structuredTaskResultSchema,
  type DispatcherRuntime,
  type StructuredTaskResult,
  type TaskExecutionBodyKind,
  type TaskExecutionPipelineContext,
  type TaskExecutionRuntimeMetadata,
} from "./task-result-schema.js";

const HUGIN_HOME = path.join(process.env.HOME || "/home/magnus", ".hugin");
const LOG_DIR = path.join(HUGIN_HOME, "logs");
const HOOK_RESULT_DIR = path.join(HUGIN_HOME, "hook-results");
const CANCEL_REQUESTED_TAG = "cancel-requested";
const CANCEL_WATCH_INTERVAL_MS = 2000;

// --- Configuration ---

const config = {
  port: parseInt(process.env.HUGIN_PORT || "3032"),
  host: process.env.HUGIN_HOST || "127.0.0.1",
  muninUrl: process.env.MUNIN_URL || "http://localhost:3030",
  muninApiKey: process.env.MUNIN_API_KEY || "",
  pollIntervalMs: parseInt(process.env.HUGIN_POLL_INTERVAL_MS || "30000"),
  defaultTimeoutMs: parseInt(process.env.HUGIN_DEFAULT_TIMEOUT_MS || "300000"),
  workspace: process.env.HUGIN_WORKSPACE || "/home/magnus/workspace",
  maxOutputChars: parseInt(process.env.HUGIN_MAX_OUTPUT_CHARS || "50000"),
  claudeExecutor: (process.env.HUGIN_CLAUDE_EXECUTOR || "sdk") as "sdk" | "spawn",
  allowedSubmitters: (process.env.HUGIN_ALLOWED_SUBMITTERS || "claude-code,claude-desktop,ratatoskr,claude-web,claude-mobile,hugin")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  ollamaPiUrl: process.env.OLLAMA_PI_URL || "http://127.0.0.1:11434",
  ollamaLaptopUrl: process.env.OLLAMA_LAPTOP_URL || "",
  ollamaDefaultModel: process.env.OLLAMA_DEFAULT_MODEL || "qwen2.5:3b",
};

if (!config.muninApiKey) {
  console.error("MUNIN_API_KEY is required");
  process.exit(1);
}

// --- Worker identity ---

const LEASE_DURATION_MS = 120_000; // 2 minutes — renewed during execution
const LEASE_RENEWAL_INTERVAL_MS = 60_000; // renew every 60s

const workerId = `hugin-${os.hostname()}-${process.pid}`;

// --- State ---

let shuttingDown = false;
let currentTask: string | null = null;
let currentTaskConfig: TaskConfig | null = null;
let currentChild: ChildProcess | null = null;
let currentSdkAbort: AbortController | null = null;
let currentOllamaAbort: AbortController | null = null;
let leaseRenewalTimer: ReturnType<typeof setInterval> | null = null;
let cancelWatchTimer: ReturnType<typeof setInterval> | null = null;
let lastQueueDepth = 0;
let lastBlockedTaskCount = 0;
const startedAt = Date.now();

interface CancellationRequest {
  reason: string;
  sourceNamespace: string;
  pipelineId?: string;
}

let currentCancellation: CancellationRequest | null = null;
let cancellationCheckInFlight = false;

const munin = new MuninClient({
  baseUrl: config.muninUrl,
  apiKey: config.muninApiKey,
});

// --- Task parsing ---

interface TaskConfig {
  prompt: string;
  runtime: "claude" | "codex" | "ollama";
  workingDir: string;
  context?: string;
  timeoutMs: number;
  submittedBy: string;
  submittedAt: string;
  replyTo?: string;
  replyFormat?: string;
  group?: string;
  sequence?: number;
  model?: string;
  ollamaHost?: string;
  fallback?: "claude" | "none";
  contextRefs?: string[];
  contextBudget?: number;
  pipeline?: TaskExecutionPipelineContext;
}

type DeclaredRuntime = TaskConfig["runtime"] | "pipeline";

function parseDeclaredRuntime(content: string): DeclaredRuntime | undefined {
  return content.match(/\*\*Runtime:\*\*\s*(claude|codex|ollama|pipeline)/i)?.[1]?.toLowerCase() as
    | DeclaredRuntime
    | undefined;
}

function parseSubmittedByField(content: string): string {
  return content.match(/\*\*Submitted by:\*\*\s*(.+)/i)?.[1]?.trim() || "unknown";
}

function extractRoutingMetadataFromContent(content: string): {
  replyTo?: string;
  replyFormat?: string;
  group?: string;
  sequence?: number;
} {
  const sequenceRaw = content.match(/\*\*Sequence:\*\*\s*(\d+)/i)?.[1];
  return {
    replyTo: content.match(/\*\*Reply-to:\*\*\s*(.+)/i)?.[1]?.trim(),
    replyFormat: content.match(/\*\*Reply-format:\*\*\s*(.+)/i)?.[1]?.trim(),
    group: content.match(/\*\*Group:\*\*\s*(.+)/i)?.[1]?.trim(),
    sequence: sequenceRaw ? parseInt(sequenceRaw, 10) : undefined,
  };
}

function resolveContext(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("repo:")) {
    const name = trimmed.slice(5);
    const resolved = path.resolve(`/home/magnus/repos/${name}`);
    // Guard against traversal (e.g. repo:../../tmp)
    if (!resolved.startsWith("/home/magnus/repos/")) {
      return "/home/magnus/workspace";
    }
    return resolved;
  }
  switch (trimmed) {
    case "scratch": return "/home/magnus/scratch";
    case "files": return "/home/magnus/mimir";
    default: {
      // Only allow absolute paths under /home/magnus/; reject others
      if (trimmed.startsWith("/home/magnus/")) return trimmed;
      if (trimmed.startsWith("/")) {
        console.warn(`Context path outside /home/magnus/ rejected: ${trimmed}`);
        return "/home/magnus/workspace";
      }
      return "/home/magnus/workspace";
    }
  }
}

function parseTask(content: string): TaskConfig | null {
  const runtime = parseDeclaredRuntime(content) as
      | "claude"
      | "codex"
      | "ollama"
      | undefined;
  const workingDir = content.match(
    /\*\*Working dir:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const contextRaw = content.match(
    /\*\*Context:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const timeoutStr = content.match(/\*\*Timeout:\*\*\s*(\d+)/i)?.[1];
  const submittedBy = content.match(
    /\*\*Submitted by:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const submittedAt = content.match(
    /\*\*Submitted at:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const replyTo = content.match(
    /\*\*Reply-to:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const replyFormat = content.match(
    /\*\*Reply-format:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const group = content.match(
    /\*\*Group:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const sequenceStr = content.match(
    /\*\*Sequence:\*\*\s*(\d+)/i
  )?.[1];
  const modelRaw = content.match(
    /\*\*Model:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const ollamaHostRaw = content.match(
    /\*\*Ollama-host:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const fallbackRaw = content.match(
    /\*\*Fallback:\*\*\s*(claude|none)/i
  )?.[1]?.toLowerCase() as "claude" | "none" | undefined;
  const contextRefsRaw = content.match(
    /\*\*Context-refs:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const contextBudgetStr = content.match(
    /\*\*Context-budget:\*\*\s*(\d+)/i
  )?.[1];
  const pipelineId = content.match(
    /\*\*Pipeline:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const pipelinePhase = content.match(
    /\*\*Pipeline phase:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const pipelineSubmittedBy = content.match(
    /\*\*Pipeline submitted by:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const pipelineSensitivity = content.match(
    /\*\*Pipeline sensitivity:\*\*\s*(public|internal|private)/i
  )?.[1]?.trim()?.toLowerCase() as
    | "public"
    | "internal"
    | "private"
    | undefined;
  const pipelineAuthority = content.match(
    /\*\*Pipeline authority:\*\*\s*(autonomous|gated)/i
  )?.[1]?.trim()?.toLowerCase() as "autonomous" | "gated" | undefined;
  const pipelineDependencyTaskIdsRaw = content.match(
    /\*\*Depends on task ids:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const pipelineDependencyPhasesRaw = content.match(
    /\*\*Depends on phases:\*\*\s*(.+)/i
  )?.[1]?.trim();

  // Extract prompt from ### Prompt section
  const promptMatch = content.match(/###\s*Prompt\s*\n([\s\S]+)$/i);
  const prompt = promptMatch?.[1]?.trim();

  if (!prompt || !runtime) return null;

  // Resolution priority: Context > Working dir > config.workspace
  const resolvedDir = contextRaw
    ? resolveContext(contextRaw)
    : workingDir || config.workspace;

  return {
    prompt,
    runtime: runtime || "claude",
    workingDir: resolvedDir,
    context: contextRaw || undefined,
    timeoutMs: timeoutStr ? parseInt(timeoutStr) : config.defaultTimeoutMs,
    submittedBy: submittedBy || "unknown",
    submittedAt: submittedAt || new Date().toISOString(),
    replyTo: replyTo || undefined,
    replyFormat: replyFormat || undefined,
    group: group || undefined,
    sequence: sequenceStr ? parseInt(sequenceStr) : undefined,
    model: modelRaw || undefined,
    ollamaHost: ollamaHostRaw || undefined,
    fallback: fallbackRaw || undefined,
    contextRefs: contextRefsRaw
      ? contextRefsRaw.split(",").map((r) => r.trim()).filter(Boolean)
      : undefined,
    contextBudget: contextBudgetStr ? parseInt(contextBudgetStr) : undefined,
    pipeline:
      pipelineId && pipelinePhase
        ? {
            pipelineId,
            phase: pipelinePhase,
            dependencyTaskIds: pipelineDependencyTaskIdsRaw
              ? pipelineDependencyTaskIdsRaw
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean)
              : [],
            dependencyPhases: pipelineDependencyPhasesRaw
              ? pipelineDependencyPhasesRaw
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean)
              : [],
            submittedBy: pipelineSubmittedBy || undefined,
            sensitivity: pipelineSensitivity,
            authority: pipelineAuthority,
          }
        : undefined,
  };
}

// --- Log directory ---

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function extractTaskId(namespace: string): string {
  return namespace.replace(/^tasks\//, "");
}

function getPipelineIdFromContent(content: string): string | undefined {
  return content.match(/\*\*Pipeline:\*\*\s*(.+)/i)?.[1]?.trim();
}

function parseErrorMessageFromResult(content: string | undefined): string | undefined {
  if (!content) return undefined;
  return content.match(/\*\*Error:\*\*\s*(.+)/)?.[1]?.trim();
}

async function readStructuredTaskResult(
  taskNs: string
): Promise<StructuredTaskResult | null> {
  const entry = await munin.read(taskNs, "result-structured");
  if (!entry) return null;

  try {
    return structuredTaskResultSchema.parse(JSON.parse(entry.content));
  } catch (err) {
    console.error(`Failed to parse structured result for ${taskNs}:`, err);
    return null;
  }
}

async function writeStructuredTaskResult(
  taskNs: string,
  result: StructuredTaskResult
): Promise<void> {
  await munin.write(
    taskNs,
    "result-structured",
    JSON.stringify(buildStructuredTaskResult(result), null, 2),
    ["type:task-result", "type:task-result-structured"]
  );
}

async function refreshPipelineSummary(pipelineId: string): Promise<void> {
  try {
    const pipelineNs = `tasks/${pipelineId}`;
    const specEntry = await munin.read(pipelineNs, "spec");
    if (!specEntry) return;

    let pipeline: PipelineIR;
    try {
      pipeline = pipelineIRSchema.parse(JSON.parse(specEntry.content));
    } catch (err) {
      console.error(`Failed to parse pipeline spec for ${pipelineNs}:`, err);
      return;
    }

    const snapshots: PipelinePhaseSnapshot[] = [];
    for (const phase of pipeline.phases) {
      const statusEntry = await munin.read(phase.taskNamespace, "status");
      const structuredResult = await readStructuredTaskResult(phase.taskNamespace);
      const resultEntry = await munin.read(phase.taskNamespace, "result");

      snapshots.push({
        phase,
        lifecycle: getPipelinePhaseLifecycle(statusEntry?.tags),
        structuredResult: structuredResult || undefined,
        errorMessage:
          structuredResult?.errorMessage ||
          parseErrorMessageFromResult(resultEntry?.content),
      });
    }

    const summary = buildPipelineExecutionSummary(pipeline, snapshots);
    await munin.write(
      pipelineNs,
      "summary",
      JSON.stringify(summary, null, 2),
      ["type:pipeline", "type:pipeline-summary"]
    );
  } catch (err) {
    console.error(`Pipeline summary refresh failed for ${pipelineId}:`, err);
  }
}

async function refreshPipelineSummaryFromContent(content: string): Promise<void> {
  const pipelineId = getPipelineIdFromContent(content);
  if (!pipelineId) return;
  await refreshPipelineSummary(pipelineId);
}

function createFailureStructuredResult(
  taskNs: string,
  runtime: DispatcherRuntime,
  errorMessage: string,
  options: {
    executor: string;
    resultSource: string;
    exitCode?: number | "TIMEOUT";
    startedAt?: string;
    completedAt?: string;
    durationSeconds?: number;
    logFile?: string;
    replyTo?: string;
    replyFormat?: string;
    group?: string;
    sequence?: number;
    pipeline?: TaskExecutionPipelineContext;
    runtimeMetadata?: TaskExecutionRuntimeMetadata;
  }
): StructuredTaskResult {
  const completedAt = options.completedAt || new Date().toISOString();
  return buildStructuredTaskResult({
    schemaVersion: 1,
    taskId: extractTaskId(taskNs),
    taskNamespace: taskNs,
    lifecycle: "failed",
    outcome: options.exitCode === "TIMEOUT" ? "timed_out" : "failed",
    runtime,
    executor: options.executor,
    resultSource: options.resultSource,
    exitCode: options.exitCode || -1,
    startedAt: options.startedAt,
    completedAt,
    durationSeconds: options.durationSeconds,
    logFile: options.logFile,
    replyTo: options.replyTo,
    replyFormat: options.replyFormat,
    group: options.group,
    sequence: options.sequence,
    bodyKind: "error",
    bodyText: errorMessage,
    errorMessage,
    runtimeMetadata: options.runtimeMetadata,
    pipeline: options.pipeline,
  });
}

function getRuntimeFromTags(
  tags: string[],
  runtimeFallback = "runtime:claude"
): DispatcherRuntime | "pipeline" {
  return (tags.find((tag) => tag.startsWith("runtime:")) || runtimeFallback).replace(
    /^runtime:/,
    ""
  ) as DispatcherRuntime | "pipeline";
}

function removeTag(tags: string[], tagToRemove: string): string[] {
  return tags.filter((tag) => tag !== tagToRemove);
}

function isTerminalTaskStatus(tags: string[]): boolean {
  return (
    tags.includes("completed") ||
    tags.includes("failed") ||
    tags.includes("cancelled")
  );
}

function buildCancelledTaskResultDocument(input: {
  startedAt?: string;
  completedAt: string;
  durationSeconds?: number;
  executor: string;
  resultSource: string;
  logFile?: string;
  reason: string;
  replyTo?: string;
  replyFormat?: string;
  group?: string;
  sequence?: number;
  body?: string;
}): string {
  const lines = [
    "## Result (task cancelled)",
    "",
    "- **Exit code:** CANCELLED",
    ...(input.startedAt ? [`- **Started at:** ${input.startedAt}`] : []),
    `- **Completed at:** ${input.completedAt}`,
    ...(input.durationSeconds !== undefined
      ? [`- **Duration:** ${input.durationSeconds}s`]
      : []),
    `- **Executor:** ${input.executor}`,
    `- **Result source:** ${input.resultSource}`,
    ...(input.logFile ? [`- **Log file:** ${input.logFile}`] : []),
    `- **Reason:** ${input.reason}`,
    ...buildRoutingMetadataLines({
      replyTo: input.replyTo,
      replyFormat: input.replyFormat,
      group: input.group,
      sequence: input.sequence,
    }),
    ...(input.body ? ["", input.body] : []),
  ];

  return lines.join("\n");
}

function buildPipelineCancelledResultDocument(input: {
  pipelineId: string;
  reason: string;
  replyTo?: string;
  replyFormat?: string;
  group?: string;
  sequence?: number;
}): string {
  return [
    "## Result",
    "",
    "- **Exit code:** CANCELLED",
    "- **Pipeline action:** cancelled",
    `- **Pipeline id:** ${input.pipelineId}`,
    `- **Spec key:** tasks/${input.pipelineId}/spec`,
    `- **Summary key:** tasks/${input.pipelineId}/summary`,
    `- **Reason:** ${input.reason}`,
    ...buildRoutingMetadataLines({
      replyTo: input.replyTo,
      replyFormat: input.replyFormat,
      group: input.group,
      sequence: input.sequence,
    }),
  ].join("\n");
}

function createCancelledStructuredResult(
  taskNs: string,
  runtime: DispatcherRuntime,
  reason: string,
  options: {
    executor: string;
    resultSource: string;
    startedAt?: string;
    completedAt?: string;
    durationSeconds?: number;
    logFile?: string;
    replyTo?: string;
    replyFormat?: string;
    group?: string;
    sequence?: number;
    pipeline?: TaskExecutionPipelineContext;
    runtimeMetadata?: TaskExecutionRuntimeMetadata;
    bodyKind?: TaskExecutionBodyKind;
    bodyText?: string;
  }
): StructuredTaskResult {
  const completedAt = options.completedAt || new Date().toISOString();
  return buildStructuredTaskResult({
    schemaVersion: 1,
    taskId: extractTaskId(taskNs),
    taskNamespace: taskNs,
    lifecycle: "cancelled",
    outcome: "cancelled",
    runtime,
    executor: options.executor,
    resultSource: options.resultSource,
    exitCode: "CANCELLED",
    startedAt: options.startedAt,
    completedAt,
    durationSeconds: options.durationSeconds,
    logFile: options.logFile,
    replyTo: options.replyTo,
    replyFormat: options.replyFormat,
    group: options.group,
    sequence: options.sequence,
    bodyKind: options.bodyKind || "error",
    bodyText: options.bodyText || reason,
    errorMessage: reason,
    runtimeMetadata: options.runtimeMetadata,
    pipeline: options.pipeline,
  });
}

// --- Quota snapshot ---

interface QuotaSnapshot {
  q5: number | null;
  q7: number | null;
}

async function fetchQuota(): Promise<QuotaSnapshot> {
  try {
    const credPath = path.join(process.env.HOME || "/home/magnus", ".claude", ".credentials.json");
    const creds = JSON.parse(fs.readFileSync(credPath, "utf-8"));
    const token = creds?.claudeAiOauth?.accessToken;
    if (!token) return { q5: null, q7: null };

    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        "anthropic-beta": "oauth-2025-04-20",
        "Authorization": `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { q5: null, q7: null };
    const data = await res.json() as Record<string, Record<string, number>>;
    return {
      q5: data?.five_hour?.utilization ?? null,
      q7: data?.seven_day?.utilization ?? null,
    };
  } catch {
    return { q5: null, q7: null };
  }
}

// --- Invocation journal ---

const JOURNAL_FILE = path.join(HUGIN_HOME, "invocation-journal.jsonl");

function appendJournal(entry: Record<string, unknown>): void {
  try {
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(JOURNAL_FILE, line, { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    console.error("Journal write failed:", err);
  }
}

// --- Log rotation ---

async function rotateOldLogs(): Promise<void> {
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - thirtyDaysMs;
  try {
    const files = fs.readdirSync(LOG_DIR);
    let cleaned = 0;
    for (const file of files) {
      if (!file.endsWith(".log")) continue;
      const filePath = path.join(LOG_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // Skip files we can't stat/delete
      }
    }
    if (cleaned > 0) {
      console.log(`Log rotation: cleaned ${cleaned} log file(s) older than 30 days`);
    }
  } catch {
    // LOG_DIR might not exist yet on first run
  }
}

// --- Hook result reader ---

interface HookResult {
  task_id: string;
  task_namespace: string;
  session_id: string | null;
  last_assistant_message: string;
  completed_at: string;
}

function readHookResult(taskId: string): HookResult | null {
  const filePath = path.join(HOOK_RESULT_DIR, `${taskId}.json`);
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    fs.unlinkSync(filePath); // Clean up after reading
    return JSON.parse(data) as HookResult;
  } catch {
    return null;
  }
}

// --- Post-task git push ---

async function postTaskGitPush(workingDir: string): Promise<void> {
  // Check if the working directory is a git repo
  const isGit = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["rev-parse", "--git-dir"], {
      cwd: workingDir,
      stdio: "ignore",
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });

  if (!isGit) return;

  // Check if there are commits ahead of remote
  const isAhead = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["status", "--porcelain=v2", "--branch"], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", () => resolve(out.includes("branch.ab +") && !out.includes("branch.ab +0")));
    child.on("error", () => resolve(false));
  });

  if (!isAhead) return;

  console.log(`Post-task: unpushed commits detected in ${workingDir}, running git push`);
  await new Promise<void>((resolve) => {
    const child = spawn("git", ["push"], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => {
      if (code === 0) {
        console.log(`Post-task git push: ok (${workingDir})`);
      } else {
        console.warn(`Post-task git push failed (exit ${code}) in ${workingDir}: ${output.trim()}`);
      }
      resolve();
    });
    child.on("error", (err) => {
      console.warn(`Post-task git push error in ${workingDir}: ${(err as Error).message}`);
      resolve();
    });
  });
}

// --- Task execution ---

interface SpawnContext {
  taskNs: string;
  muninClient: MuninClient;
}

function spawnRuntime(
  task: TaskConfig,
  ctx: SpawnContext
): Promise<{ exitCode: number | "TIMEOUT"; output: string; logFile: string }> {
  return new Promise((resolve) => {
    const taskId = extractTaskId(ctx.taskNs);
    const logFile = path.join(LOG_DIR, `${taskId}.log`);
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    // Ensure working directory exists
    fs.mkdirSync(task.workingDir, { recursive: true });

    // Open log file stream
    const logStream = fs.createWriteStream(logFile, { encoding: "utf-8" });
    logStream.write(
      [
        "=== Hugin Task Log ===",
        `Task: ${ctx.taskNs}`,
        `Runtime: ${task.runtime}`,
        `Working dir: ${task.workingDir}`,
        `Timeout: ${task.timeoutMs}`,
        `Started: ${startedAt}`,
        "===\n",
      ].join("\n")
    );

    const cmd =
      task.runtime === "codex"
        ? ["codex", ["exec", "--full-auto", task.prompt]]
        : ["claude", ["-p", "--dangerously-skip-permissions", "--verbose", task.prompt]];

    const child = spawn(cmd[0] as string, cmd[1] as string[], {
      cwd: task.workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: "/home/magnus",
        HUGIN_TASK_ID: taskId,
        HUGIN_TASK_NAMESPACE: ctx.taskNs,
      },
    });

    currentChild = child;
    let timedOut = false;

    // Ring buffer for output capture (kept for Munin result)
    let output = "";
    const appendOutput = (chunk: Buffer) => {
      // Replace non-UTF8 sequences for safety
      const text = chunk.toString("utf-8");
      output += text;
      if (output.length > config.maxOutputChars * 2) {
        output = output.slice(-config.maxOutputChars);
      }
      // Stream to log file
      logStream.write(text);
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    const timer = setTimeout(async () => {
      timedOut = true;
      const elapsedS = Math.round((Date.now() - startMs) / 1000);
      console.log(
        `Task timeout (${task.timeoutMs}ms / ${elapsedS}s), sending SIGTERM to child`
      );

      // Append timeout note to log file
      logStream.write(
        `\n===\nTIMEOUT after ${elapsedS}s — sending SIGTERM\n===\n`
      );

      // Write partial result to Munin before killing
      try {
        await ctx.muninClient.write(ctx.taskNs, "result", [
          "## Result (PARTIAL — task timed out)\n",
          `- **Exit code:** TIMEOUT`,
          `- **Started at:** ${startedAt}`,
          `- **Timed out at:** ${new Date().toISOString()}`,
          `- **Duration:** ${elapsedS}s`,
          `- **Log file:** ~/.hugin/logs/${taskId}.log`,
          "",
          "### Last Output",
          "```",
          output.slice(-config.maxOutputChars) || "(no output captured)",
          "```",
        ].join("\n"));
      } catch (err) {
        console.error("Failed to write partial result on timeout:", err);
      }

      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 10000);
    }, task.timeoutMs);

    let logEnded = false;
    function endLog(footer: string): void {
      if (logEnded) return;
      logEnded = true;
      logStream.write(footer);
      logStream.end();
    }

    child.on("close", (code) => {
      clearTimeout(timer);
      currentChild = null;

      const durationS = Math.round((Date.now() - startMs) / 1000);

      endLog(
        [
          "\n===",
          `Exit code: ${timedOut ? "TIMEOUT" : (code ?? 1)}`,
          `Duration: ${durationS}s`,
          `Completed: ${new Date().toISOString()}`,
          "===\n",
        ].join("\n")
      );

      resolve({
        exitCode: timedOut ? "TIMEOUT" : (code ?? 1),
        output: output.slice(-config.maxOutputChars),
        logFile,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      currentChild = null;

      endLog(`\n=== Spawn error: ${err.message} ===\n`);

      resolve({
        exitCode: 1,
        output: `Spawn error: ${err.message}\n${output.slice(-config.maxOutputChars)}`,
        logFile,
      });
    });
  });
}

// --- Lease helpers ---

function leaseExpiry(): string {
  return new Date(Date.now() + LEASE_DURATION_MS).toISOString();
}

function parseLeaseExpiry(tags: string[]): number | null {
  const tag = tags.find((t) => t.startsWith("lease_expires:"));
  if (!tag) return null;
  const ts = new Date(tag.slice("lease_expires:".length)).getTime();
  return Number.isNaN(ts) ? null : ts;
}

function parseClaimedBy(tags: string[]): string | null {
  const tag = tags.find((t) => t.startsWith("claimed_by:"));
  return tag ? tag.slice("claimed_by:".length) : null;
}

/** Build tags preserving runtime/type tags and adding lease metadata. */
function buildClaimTags(
  baseTags: string[],
  lifecycle: string,
): string[] {
  const runtimeTag = baseTags.find((t) => t.startsWith("runtime:"));
  const typeTags = baseTags.filter((t) => t.startsWith("type:"));
  return [
    lifecycle,
    ...(runtimeTag ? [runtimeTag] : []),
    ...typeTags,
    `claimed_by:${workerId}`,
    `lease_expires:${leaseExpiry()}`,
  ];
}

/** Strip lease metadata from tags (for final status updates). */
function stripLeaseTags(tags: string[]): string[] {
  return tags.filter(
    (t) => !t.startsWith("claimed_by:") && !t.startsWith("lease_expires:")
  );
}

/** Start periodic lease renewal for the current task. */
function startLeaseRenewal(taskNs: string, entryContent: string, baseTags: string[]): void {
  stopLeaseRenewal();
  leaseRenewalTimer = setInterval(async () => {
    if (!currentTask || currentTask !== taskNs) {
      stopLeaseRenewal();
      return;
    }
    try {
      const renewedTags = buildClaimTags(baseTags, "running");
      await munin.write(taskNs, "status", entryContent, renewedTags);
      console.log(`Lease renewed for ${taskNs} (expires: ${leaseExpiry()})`);
    } catch (err) {
      console.error(`Lease renewal failed for ${taskNs}:`, err);
    }
  }, LEASE_RENEWAL_INTERVAL_MS);
}

function stopLeaseRenewal(): void {
  if (leaseRenewalTimer) {
    clearInterval(leaseRenewalTimer);
    leaseRenewalTimer = null;
  }
}

function requestCancellationForCurrentTask(request: CancellationRequest): void {
  if (currentCancellation) return;
  currentCancellation = request;
  console.log(
    `Cancellation requested for ${currentTask} (source: ${request.sourceNamespace}, reason: ${request.reason})`
  );

  if (currentSdkAbort && !currentSdkAbort.signal.aborted) {
    currentSdkAbort.abort(request.reason);
  }
  if (currentOllamaAbort && !currentOllamaAbort.signal.aborted) {
    currentOllamaAbort.abort(request.reason);
  }
  if (currentChild && !currentChild.killed) {
    currentChild.kill("SIGTERM");
  }
}

async function checkCurrentTaskCancellation(): Promise<void> {
  if (cancellationCheckInFlight || !currentTask) return;
  cancellationCheckInFlight = true;

  try {
    const currentEntry = await munin.read(currentTask, "status");
    if (currentEntry?.tags.includes(CANCEL_REQUESTED_TAG)) {
      requestCancellationForCurrentTask({
        reason: `Task ${extractTaskId(currentTask)} cancelled by operator`,
        sourceNamespace: currentTask,
      });
      return;
    }

    const pipelineId = currentTaskConfig?.pipeline?.pipelineId;
    if (!pipelineId) return;

    const pipelineNs = `tasks/${pipelineId}`;
    const pipelineEntry = await munin.read(pipelineNs, "status");
    if (!pipelineEntry?.tags.includes(CANCEL_REQUESTED_TAG)) return;

    requestCancellationForCurrentTask({
      reason: `Pipeline ${pipelineId} cancelled by operator`,
      sourceNamespace: pipelineNs,
      pipelineId,
    });
  } catch (err) {
    console.error(`Cancellation watch failed for ${currentTask}:`, err);
  } finally {
    cancellationCheckInFlight = false;
  }
}

function startCancellationWatch(): void {
  stopCancellationWatch();
  cancelWatchTimer = setInterval(() => {
    void checkCurrentTaskCancellation();
  }, CANCEL_WATCH_INTERVAL_MS);
}

function stopCancellationWatch(): void {
  if (cancelWatchTimer) {
    clearInterval(cancelWatchTimer);
    cancelWatchTimer = null;
  }
}

// --- Stale task recovery ---
// Recover tasks whose lease has expired. Tasks claimed by this worker are always
// recovered (we just restarted, so they're orphaned). Tasks claimed by other
// workers are only recovered if their lease has expired.

async function recoverStaleTasks(): Promise<void> {
  try {
    const { results } = await munin.query({
      query: "task",
      tags: ["running"],
      namespace: "tasks/",
      entry_type: "state",
      limit: 20,
    });

    for (const result of results) {
      if (!result.key || result.key !== "status") continue;

      const entry = await munin.read(result.namespace, "status");
      if (!entry) continue;

      const claimedBy = parseClaimedBy(entry.tags);
      const leaseExpires = parseLeaseExpiry(entry.tags);
      const now = Date.now();

      // Decide whether to recover this task:
      // - Our own tasks: always recover (we just restarted)
      // - Other worker's tasks: only if lease expired
      // - No lease metadata (legacy): recover if older than default timeout
      const isOurs = claimedBy === workerId || claimedBy === null;
      const leaseExpired = leaseExpires !== null && now > leaseExpires;
      const legacyStale = leaseExpires === null &&
        (now - new Date(entry.updated_at).getTime()) > config.defaultTimeoutMs;

      if (!isOurs && !leaseExpired) {
        if (leaseExpires !== null) {
          console.log(
            `Skipping task ${result.namespace} — claimed by ${claimedBy}, lease expires in ${Math.round((leaseExpires - now) / 1000)}s`
          );
        }
        continue;
      }

      if (!isOurs && !leaseExpired && !legacyStale) continue;

      const elapsed = Math.round((now - new Date(entry.updated_at).getTime()) / 1000);
      const reason = isOurs || claimedBy === null
        ? "dispatcher restart"
        : "lease expired";

      console.log(
        `Recovering task ${result.namespace} (${reason}, claimed_by: ${claimedBy || "none"}, elapsed: ${elapsed}s)`
      );

      const runtimeTag = entry.tags.find((t) => t.startsWith("runtime:"));
      await munin.write(
        result.namespace,
        "status",
        entry.content,
        buildTerminalStatusTags("failed", entry.tags),
        entry.updated_at
      );
      await munin.write(
        result.namespace,
        "result",
        `## Result\n\n- **Exit code:** -1\n- **Error:** Task recovered (${reason}, worker: ${claimedBy || "unknown"}, elapsed: ${elapsed}s)\n`
      );
      const runtime = (runtimeTag || "runtime:claude").replace(
        /^runtime:/,
        ""
      ) as DispatcherRuntime;
      await writeStructuredTaskResult(
        result.namespace,
        createFailureStructuredResult(
          result.namespace,
          runtime,
          `Task recovered (${reason}, worker: ${claimedBy || "unknown"}, elapsed: ${elapsed}s)`,
          {
            executor: "dispatcher",
            resultSource: "recovery",
          }
        )
      );
      await munin.log(
        result.namespace,
        `Task recovered as failed (${reason}, worker: ${claimedBy || "unknown"}, elapsed: ${elapsed}s)`
      );
      await promoteDependents(extractTaskId(result.namespace));
      await refreshPipelineSummaryFromContent(entry.content);
    }
  } catch (err) {
    console.error("Failed to recover stale tasks:", err);
  }
}

// --- Dependency joins ---

function dependencyStateFromEntry(entry: (MuninEntry & { found: true }) | null): DependencyState {
  if (!entry) return "missing";
  if (entry.tags.includes("completed")) return "completed";
  if (entry.tags.includes("cancelled")) return "failed";
  if (entry.tags.includes("failed")) return "failed";
  return "pending";
}

async function readDependencyStates(dependencyIds: string[]): Promise<Record<string, DependencyState>> {
  const entries = await Promise.all(
    dependencyIds.map((dependencyId) => munin.read(`tasks/${dependencyId}`, "status"))
  );

  const states: Record<string, DependencyState> = {};
  dependencyIds.forEach((dependencyId, index) => {
    states[dependencyId] = dependencyStateFromEntry(entries[index]);
  });
  return states;
}

async function failBlockedTask(
  taskNs: string,
  entry: MuninEntry & { found: true },
  errorMessage: string
): Promise<void> {
  await munin.write(
    taskNs,
    "status",
    entry.content,
    buildTerminalStatusTags("failed", entry.tags),
    entry.updated_at
  );
  await munin.write(
    taskNs,
    "result",
    `## Result\n\n- **Exit code:** -1\n- **Error:** ${errorMessage}\n`
  );
  const task = parseTask(entry.content);
  const runtime = (
    entry.tags.find((tag) => tag.startsWith("runtime:")) || "runtime:claude"
  ).replace(/^runtime:/, "") as DispatcherRuntime;
  await writeStructuredTaskResult(
    taskNs,
    createFailureStructuredResult(taskNs, runtime, errorMessage, {
      executor: "dispatcher",
      resultSource: "dependency",
      replyTo: task?.replyTo,
      replyFormat: task?.replyFormat,
      group: task?.group,
      sequence: task?.sequence,
      pipeline: task?.pipeline,
    })
  );
  await munin.log(taskNs, `Failed due to dependency state: ${errorMessage}`);
  await refreshPipelineSummaryFromContent(entry.content);
}

async function evaluateBlockedTaskState(taskNs: string): Promise<"promoted" | "failed" | "waiting"> {
  const entry = await munin.read(taskNs, "status");
  if (!entry || !entry.tags.includes("blocked")) return "waiting";

  const dependencyIds = getDependencyIds(entry.tags);
  const dependencyStates = await readDependencyStates(dependencyIds);
  const evaluation = evaluateBlockedTask(entry.tags, dependencyStates);

  if (evaluation.shouldFail) {
    const errorMessage = evaluation.failureReason || "Dependency failure";
    await failBlockedTask(taskNs, entry, errorMessage);
    console.log(`Blocked task ${taskNs} failed (${errorMessage})`);
    return "failed";
  }

  if (evaluation.shouldPromote) {
    const promotedTags = buildPromotedTags(entry.tags);
    await munin.write(taskNs, "status", entry.content, promotedTags, entry.updated_at);
    const statusReason = evaluation.failedIds.length > 0
      ? `Promoted from blocked -> pending (all ${evaluation.dependencyIds.length} dependencies reached terminal state; continuing after failures)`
      : `Promoted from blocked -> pending (all ${evaluation.dependencyIds.length} dependencies met)`;
    await munin.log(taskNs, statusReason);
    console.log(`Promoted ${taskNs} -> pending (deps checked: ${evaluation.dependencyIds.length})`);
    await refreshPipelineSummaryFromContent(entry.content);
    return "promoted";
  }

  return "waiting";
}

async function promoteDependents(completedTaskId: string): Promise<void> {
  try {
    const { results, total } = await munin.query({
      query: "task",
      tags: ["blocked", `depends-on:${completedTaskId}`],
      namespace: "tasks/",
      entry_type: "state",
      limit: 100,
    });

    let promoted = 0;
    let failed = 0;
    for (const result of results) {
      if (result.key !== "status") continue;
      try {
        const outcome = await evaluateBlockedTaskState(result.namespace);
        if (outcome === "promoted") promoted++;
        if (outcome === "failed") failed++;
      } catch (err) {
        console.error(`Failed to evaluate blocked task ${result.namespace}:`, err);
      }
    }

    if (promoted > 0 || failed > 0 || total > results.length) {
      console.log(
        `Dependency scan for ${completedTaskId}: promoted=${promoted}, failed=${failed}, scanned=${results.length}, total_matches=${total}`
      );
    }
  } catch (err) {
    console.error(`Failed to promote dependents for ${completedTaskId}:`, err);
  }
}

async function reconcileBlockedTasks(): Promise<void> {
  try {
    const { results, total } = await munin.query({
      query: "task",
      tags: ["blocked"],
      namespace: "tasks/",
      entry_type: "state",
      limit: 100,
    });

    let promoted = 0;
    let failed = 0;
    for (const result of results) {
      if (result.key !== "status") continue;
      try {
        const outcome = await evaluateBlockedTaskState(result.namespace);
        if (outcome === "promoted") promoted++;
        if (outcome === "failed") failed++;
      } catch (err) {
        console.error(`Blocked-task reconciliation failed for ${result.namespace}:`, err);
      }
    }

    if (promoted > 0 || failed > 0 || total > results.length) {
      console.log(
        `Blocked-task reconciliation: promoted=${promoted}, failed=${failed}, scanned=${results.length}, total_blocked=${total}`
      );
    }
  } catch (err) {
    console.error("Blocked-task reconciliation failed:", err);
  }
}

async function countTasksWithLifecycle(lifecycleTag: string): Promise<number> {
  const { total } = await munin.query({
    query: "task",
    tags: [lifecycleTag],
    namespace: "tasks/",
    entry_type: "state",
    limit: 1,
  });
  return total;
}

async function clearCancellationRequest(
  taskNs: string,
  entry: MuninEntry & { found: true },
  logMessage?: string
): Promise<void> {
  const updatedTags = removeTag(entry.tags, CANCEL_REQUESTED_TAG);
  if (updatedTags.length === entry.tags.length) return;
  await munin.write(taskNs, "status", entry.content, updatedTags, entry.updated_at);
  if (logMessage) {
    await munin.log(taskNs, logMessage);
  }
}

async function markTaskCancelled(
  taskNs: string,
  entry: MuninEntry & { found: true },
  reason: string,
  options: {
    executor: string;
    resultSource: string;
    startedAt?: string;
    completedAt?: string;
    durationSeconds?: number;
    body?: string;
    bodyKind?: TaskExecutionBodyKind;
    bodyText?: string;
    logFile?: string;
    runtimeMetadata?: TaskExecutionRuntimeMetadata;
  }
): Promise<void> {
  const task = parseTask(entry.content);
  const completedAt = options.completedAt || new Date().toISOString();
  const runtime = getRuntimeFromTags(entry.tags);

  await munin.write(
    taskNs,
    "status",
    entry.content,
    buildTerminalStatusTags("cancelled", entry.tags),
    entry.updated_at
  );
  await munin.write(
    taskNs,
    "result",
    buildCancelledTaskResultDocument({
      startedAt: options.startedAt,
      completedAt,
      durationSeconds: options.durationSeconds,
      executor: options.executor,
      resultSource: options.resultSource,
      logFile: options.logFile,
      reason,
      replyTo: task?.replyTo,
      replyFormat: task?.replyFormat,
      group: task?.group,
      sequence: task?.sequence,
      body: options.body,
    })
  );

  if (runtime !== "pipeline") {
    await writeStructuredTaskResult(
      taskNs,
      createCancelledStructuredResult(taskNs, runtime, reason, {
        executor: options.executor,
        resultSource: options.resultSource,
        startedAt: options.startedAt,
        completedAt,
        durationSeconds: options.durationSeconds,
        logFile: options.logFile,
        replyTo: task?.replyTo,
        replyFormat: task?.replyFormat,
        group: task?.group,
        sequence: task?.sequence,
        pipeline: task?.pipeline,
        runtimeMetadata: options.runtimeMetadata,
        bodyKind: options.bodyKind,
        bodyText: options.bodyText,
      })
    );
  }

  await munin.log(taskNs, `Task cancelled: ${reason}`);
  if (task?.pipeline?.pipelineId) {
    await refreshPipelineSummary(task.pipeline.pipelineId);
  }
}

async function finalizePipelineCancellationIfReady(
  pipelineId: string,
  reason: string
): Promise<boolean> {
  const pipelineNs = `tasks/${pipelineId}`;
  const [pipelineEntry, specEntry] = await Promise.all([
    munin.read(pipelineNs, "status"),
    munin.read(pipelineNs, "spec"),
  ]);
  if (!pipelineEntry || !specEntry || !pipelineEntry.tags.includes(CANCEL_REQUESTED_TAG)) {
    return false;
  }

  let pipeline: PipelineIR;
  try {
    pipeline = pipelineIRSchema.parse(JSON.parse(specEntry.content));
  } catch (err) {
    console.error(`Failed to parse pipeline spec while finalizing cancellation for ${pipelineNs}:`, err);
    return false;
  }

  for (const phase of pipeline.phases) {
    const phaseEntry = await munin.read(phase.taskNamespace, "status");
    if (phaseEntry && !isTerminalTaskStatus(phaseEntry.tags)) {
      return false;
    }
  }

  const refreshedEntry = await munin.read(pipelineNs, "status");
  if (!refreshedEntry || !refreshedEntry.tags.includes(CANCEL_REQUESTED_TAG)) {
    return false;
  }

  await munin.write(
    pipelineNs,
    "status",
    refreshedEntry.content,
    buildPipelineParentCancelledTags(refreshedEntry.tags),
    refreshedEntry.updated_at
  );
  await munin.write(
    pipelineNs,
    "result",
    buildPipelineCancelledResultDocument({
      pipelineId,
      reason,
      replyTo: pipeline.replyTo,
      replyFormat: pipeline.replyFormat,
      group: pipeline.group,
      sequence: pipeline.sequence,
    })
  );
  await munin.log(pipelineNs, `Pipeline cancelled: ${reason}`);
  await refreshPipelineSummary(pipelineId);
  return true;
}

async function processPipelineCancellationRequest(
  entry: MuninEntry & { found: true }
): Promise<boolean> {
  const pipelineId = extractTaskId(entry.namespace);
  const specEntry = await munin.read(entry.namespace, "spec");
  const reason = `Pipeline ${pipelineId} cancelled by operator`;

  if (!specEntry) {
    const routing = extractRoutingMetadataFromContent(entry.content);
    await munin.write(
      entry.namespace,
      "status",
      entry.content,
      buildPipelineParentCancelledTags(entry.tags),
      entry.updated_at
    );
    await munin.write(
      entry.namespace,
      "result",
      buildPipelineCancelledResultDocument({
        pipelineId,
        reason,
        ...routing,
      })
    );
    await munin.log(entry.namespace, `Pipeline cancelled before decomposition: ${reason}`);
    return true;
  }

  let pipeline: PipelineIR;
  try {
    pipeline = pipelineIRSchema.parse(JSON.parse(specEntry.content));
  } catch (err) {
    console.error(`Failed to parse pipeline spec for cancellation request ${entry.namespace}:`, err);
    return false;
  }

  let activeRunningPhase = false;
  let cancelledAny = false;

  for (const phase of pipeline.phases) {
    const phaseEntry = await munin.read(phase.taskNamespace, "status");
    if (!phaseEntry || isTerminalTaskStatus(phaseEntry.tags)) {
      if (phaseEntry?.tags.includes("cancelled")) cancelledAny = true;
      continue;
    }

    if (phaseEntry.tags.includes("running")) {
      activeRunningPhase = true;
      if (phase.taskNamespace === currentTask) {
        requestCancellationForCurrentTask({
          reason,
          sourceNamespace: entry.namespace,
          pipelineId,
        });
      }
      continue;
    }

    cancelledAny = true;
    await markTaskCancelled(phase.taskNamespace, phaseEntry, reason, {
      executor: "dispatcher",
      resultSource: "cancellation",
    });
  }

  if (!activeRunningPhase && !cancelledAny) {
    await clearCancellationRequest(
      entry.namespace,
      entry,
      `Pipeline cancellation ignored; pipeline already terminal`
    );
    return false;
  }

  await refreshPipelineSummary(pipelineId);

  if (activeRunningPhase) {
    return true;
  }

  return finalizePipelineCancellationIfReady(pipelineId, reason);
}

async function processCancellationRequests(): Promise<boolean> {
  const { results } = await munin.query({
    query: "task",
    tags: [CANCEL_REQUESTED_TAG],
    namespace: "tasks/",
    entry_type: "state",
    limit: 50,
  });

  let processed = false;
  for (const result of results) {
    if (result.key !== "status") continue;
    const entry = await munin.read(result.namespace, "status");
    if (!entry || !entry.tags.includes(CANCEL_REQUESTED_TAG)) continue;

    const declaredRuntime = parseDeclaredRuntime(entry.content);
    if (declaredRuntime === "pipeline" || entry.tags.includes("runtime:pipeline")) {
      processed = (await processPipelineCancellationRequest(entry)) || processed;
      continue;
    }

    if (isTerminalTaskStatus(entry.tags)) {
      await clearCancellationRequest(
        entry.namespace,
        entry,
        `Cancellation ignored; task already terminal`
      );
      continue;
    }

    await markTaskCancelled(
      entry.namespace,
      entry,
      `Task ${extractTaskId(entry.namespace)} cancelled by operator`,
      {
        executor: "dispatcher",
        resultSource: "cancellation",
      }
    );
    processed = true;
  }

  return processed;
}

async function failTaskWithMessage(
  taskNs: string,
  entry: MuninEntry & { found: true },
  errorMessage: string,
  runtimeTagOverride?: string,
): Promise<void> {
  const runtime = (
    runtimeTagOverride ||
    entry.tags.find((tag) => tag.startsWith("runtime:")) ||
    "runtime:claude"
  ).replace(/^runtime:/, "") as DispatcherRuntime | "pipeline";
  await munin.write(
    taskNs,
    "status",
    entry.content,
    buildTerminalStatusTags("failed", entry.tags, runtimeTagOverride),
    entry.updated_at
  );
  await munin.write(
    taskNs,
    "result",
    `## Result\n\n- **Exit code:** -1\n- **Error:** ${errorMessage}\n`
  );
  if (runtime !== "pipeline") {
    await writeStructuredTaskResult(
      taskNs,
      createFailureStructuredResult(taskNs, runtime, errorMessage, {
        executor: "dispatcher",
        resultSource: "dispatcher",
      })
    );
  }
}

async function handlePipelineTask(
  taskNs: string,
  entry: MuninEntry & { found: true },
  queueDepth: number
): Promise<{ hadTask: boolean; queueDepth: number }> {
  const pipelineId = extractTaskId(taskNs);
  let pipeline: PipelineIR;

  try {
    pipeline = compilePipelineTask(pipelineId, taskNs, entry.content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failTaskWithMessage(taskNs, entry, `Pipeline compile failed: ${message}`, "runtime:pipeline");
    await munin.log(taskNs, `Pipeline compile failed: ${message}`);
    await promoteDependents(pipelineId);
    return { hadTask: true, queueDepth };
  }

  const phaseDrafts = buildPhaseTaskDrafts(pipeline);

  try {
    const existingChildren = await Promise.all(
      phaseDrafts.map((draft) => munin.read(draft.namespace, "status"))
    );
    const existingChild = existingChildren.find((child) => child !== null);
    if (existingChild) {
      throw new Error(`Child task namespace already exists: ${existingChild.namespace}`);
    }

    await munin.write(taskNs, "spec", JSON.stringify(pipeline, null, 2), ["type:pipeline", "type:pipeline-spec"]);

    for (const draft of phaseDrafts) {
      await munin.write(draft.namespace, "status", draft.content, draft.tags);
    }

    await munin.write(
      taskNs,
      "status",
      entry.content,
      buildPipelineParentSuccessTags(entry.tags),
      entry.updated_at
    );
    await munin.write(taskNs, "result", buildPipelineDecompositionResult(pipeline));
    await refreshPipelineSummary(pipelineId);
    await munin.log(taskNs, `Pipeline compiled and decomposed into ${phaseDrafts.length} phase task(s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failTaskWithMessage(taskNs, entry, `Pipeline decomposition failed: ${message}`, "runtime:pipeline");
    await munin.log(taskNs, `Pipeline decomposition failed: ${message}`);
  }

  await promoteDependents(pipelineId);

  return { hadTask: true, queueDepth };
}

// --- Heartbeat ---

async function emitHeartbeat(queueDepth: number, blockedTasks: number): Promise<void> {
  try {
    const heartbeat: Record<string, unknown> = {
      worker_id: workerId,
      polled_at: new Date().toISOString(),
      queue_depth: queueDepth,
      blocked_tasks: blockedTasks,
      current_task: currentTask,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
    };
    if (currentTaskConfig?.group) heartbeat.group = currentTaskConfig.group;
    if (currentTaskConfig?.sequence !== undefined) heartbeat.sequence = currentTaskConfig.sequence;
    await munin.write("tasks/_heartbeat", "status", JSON.stringify(heartbeat), ["heartbeat"]);
  } catch (err) {
    console.error("Heartbeat write failed:", err);
  }
}

// --- Poll loop ---

async function pollOnce(): Promise<{ hadTask: boolean; queueDepth: number }> {
  const { results, total } = await munin.query({
    query: "task",
    tags: ["pending"],
    namespace: "tasks/",
    entry_type: "state",
    limit: 1,
  });

  // Find the first result that has key "status"
  const taskResult = results.find((r) => r.key === "status");
  if (!taskResult) return { hadTask: false, queueDepth: 0 };

  const taskNs = taskResult.namespace;
  const queueDepth = total;
  const entry = await munin.read(taskNs, "status");
  if (!entry) return { hadTask: false, queueDepth };

  // Verify it's still pending (another dispatcher might have claimed it)
  if (!entry.tags.includes("pending")) {
    console.log(`Task ${taskNs} no longer pending, skipping`);
    return { hadTask: false, queueDepth };
  }

  if (entry.tags.includes(CANCEL_REQUESTED_TAG)) {
    if (parseDeclaredRuntime(entry.content) === "pipeline" || entry.tags.includes("runtime:pipeline")) {
      await processPipelineCancellationRequest(entry);
    } else {
      await markTaskCancelled(
        taskNs,
        entry,
        `Task ${extractTaskId(taskNs)} cancelled by operator`,
        {
          executor: "dispatcher",
          resultSource: "cancellation",
        }
      );
    }
    return { hadTask: true, queueDepth };
  }

  const declaredRuntime = parseDeclaredRuntime(entry.content);
  if (!declaredRuntime) {
    console.error(`Failed to parse task ${taskNs}, marking as failed`);
    await failTaskWithMessage(
      taskNs,
      entry,
      "Failed to parse task (missing prompt or runtime)",
    );
    await promoteDependents(extractTaskId(taskNs));
    await refreshPipelineSummaryFromContent(entry.content);
    return { hadTask: true, queueDepth };
  }

  // Validate submitter against allowlist
  const submittedBy = parseSubmittedByField(entry.content);
  if (
    !config.allowedSubmitters.includes("*") &&
    !config.allowedSubmitters.includes(submittedBy)
  ) {
    console.warn(
      `Rejecting task ${taskNs}: submitter "${submittedBy}" not in allowed list [${config.allowedSubmitters.join(", ")}]`
    );
    await failTaskWithMessage(
      taskNs,
      entry,
      `Unauthorized submitter "${submittedBy}". Allowed: [${config.allowedSubmitters.join(", ")}]`,
      declaredRuntime === "pipeline" ? "runtime:pipeline" : undefined,
    );
    await munin.log(
      taskNs,
      `Task rejected: submitter "${submittedBy}" not authorized`
    );
    await promoteDependents(extractTaskId(taskNs));
    await refreshPipelineSummaryFromContent(entry.content);
    return { hadTask: true, queueDepth };
  }

  console.log(
    `Claiming task ${taskNs} (runtime: ${declaredRuntime}, submitter: ${submittedBy}, worker: ${workerId})`
  );

  // Claim the task with compare-and-swap, attaching worker identity and lease
  const claimTags = buildClaimTags(entry.tags, "running");
  try {
    await munin.write(
      taskNs,
      "status",
      entry.content,
      claimTags,
      entry.updated_at
    );
  } catch (err) {
    console.log(`Failed to claim ${taskNs} (concurrent claim?):`, err);
    return { hadTask: false, queueDepth };
  }

  currentTask = taskNs;
  currentCancellation = null;
  const startedAt = new Date().toISOString();
  const taskId = extractTaskId(taskNs);
  console.log(`Executing task ${taskNs}...`);

  // Start periodic lease renewal
  startLeaseRenewal(taskNs, entry.content, entry.tags);

  if (declaredRuntime === "pipeline") {
    currentTaskConfig = null;
    const pipelineResult = await handlePipelineTask(taskNs, entry, queueDepth);
    stopLeaseRenewal();
    stopCancellationWatch();
    currentTask = null;
    currentTaskConfig = null;
    return pipelineResult;
  }

  const task = parseTask(entry.content);
  if (!task) {
    stopLeaseRenewal();
    stopCancellationWatch();
    await failTaskWithMessage(
      taskNs,
      entry,
      "Failed to parse task (missing prompt or runtime)",
    );
    await promoteDependents(taskId);
    await refreshPipelineSummaryFromContent(entry.content);
    currentTask = null;
    currentTaskConfig = null;
    return { hadTask: true, queueDepth };
  }

  currentTaskConfig = task;
  if (task.pipeline?.pipelineId) {
    await refreshPipelineSummary(task.pipeline.pipelineId);
  }
  startCancellationWatch();

  const isOllama = task.runtime === "ollama";
  const useSdk = task.runtime === "claude" && config.claudeExecutor === "sdk";
  const executorLabel = isOllama ? "ollama" : useSdk ? "agent-sdk" : "spawn";

  // Capture quota before task execution (skip for ollama — it's Claude-specific)
  const quotaBefore = isOllama ? { q5: null, q7: null } : await fetchQuota();

  await munin.log(
    taskNs,
    `Task started by Hugin (runtime: ${task.runtime}, executor: ${executorLabel}, model: ${task.model || "default"}, worker: ${workerId}, timeout: ${task.timeoutMs}ms)`
  );

  const startMs = Date.now();

  // --- Execute via ollama, SDK, or spawn ---
  let exitCode: number | "TIMEOUT";
  let output: string;
  let logFile: string;
  let resultText: string | null = null;
  let costUsd: number | null = null;
  let ollamaJournalExtras: Record<string, unknown> = {};
  let effectiveExecutor = executorLabel;
  let fallbackTriggered = false;
  let fallbackReason: string | null = null;

  if (isOllama) {
    // --- Ollama execution path ---
    const ollamaModel = task.model || config.ollamaDefaultModel;
    const freeMemBeforeMb = Math.round(os.freemem() / 1024 / 1024);
    const ollamaAbort = new AbortController();
    currentOllamaAbort = ollamaAbort;

    // Resolve host
    const host = await resolveOllamaHost(ollamaModel, task.ollamaHost);

    // Resolve context refs if specified
    let contextResolution = null;
    if (task.contextRefs && task.contextRefs.length > 0) {
      contextResolution = await resolveContextRefs(
        task.contextRefs,
        task.contextBudget,
        munin,
      );
    }

    if (!host) {
      // No host available — check fallback
      const reason = `No ollama host available for model "${ollamaModel}"`;
      console.warn(`${reason} — task ${taskNs}`);

      if (task.fallback === "claude") {
        console.log(`Falling back to Claude for task ${taskNs} (reason: host_unreachable)`);
        fallbackTriggered = true;
        fallbackReason = "host_unreachable";
        effectiveExecutor = "ollama→claude";

        // Execute via Claude SDK with fallback
        const sdkAbort = new AbortController();
        currentSdkAbort = sdkAbort;
        const sdkResult = await executeSdkTask(
          {
            prompt: task.prompt,
            workingDir: task.workingDir,
            timeoutMs: task.timeoutMs,
            muninUrl: config.muninUrl,
            muninApiKey: config.muninApiKey,
            maxOutputChars: config.maxOutputChars,
          },
          taskId,
          LOG_DIR,
          { abortController: sdkAbort },
        );
        currentSdkAbort = null;
        exitCode = sdkResult.exitCode;
        output = sdkResult.output;
        logFile = sdkResult.logFile;
        resultText = sdkResult.resultText;
        costUsd = sdkResult.costUsd;
      } else {
        exitCode = 1;
        output = reason;
        logFile = path.join(LOG_DIR, `${taskId}.log`);
        fs.writeFileSync(logFile, `=== Hugin Task Log (ollama) ===\n${reason}\n`);
      }
    } else {
      // Host available — execute via ollama
      console.log(`Using ollama executor for task ${taskNs} (host: ${host.name}, model: ${ollamaModel})`);
      const ollamaResult = await executeOllamaTask(
        {
          prompt: task.prompt,
          model: ollamaModel,
          ollamaBaseUrl: host.baseUrl,
          timeoutMs: task.timeoutMs,
          maxOutputChars: config.maxOutputChars,
          injectedContext: contextResolution?.content || undefined,
        },
        taskId,
        LOG_DIR,
        { abortController: ollamaAbort }
      );

      // Check for infra-level failure that should trigger fallback
      const isInfraFailure = ollamaResult.exitCode === 1 &&
        ollamaResult.output.match(/\[Ollama (HTTP|error:)/);

      if (isInfraFailure && task.fallback === "claude") {
        console.log(`Ollama infra failure, falling back to Claude for task ${taskNs}`);
        fallbackTriggered = true;
        fallbackReason = "ollama_error";
        effectiveExecutor = "ollama→claude";

        const sdkAbort = new AbortController();
        currentSdkAbort = sdkAbort;
        const sdkResult = await executeSdkTask(
          {
            prompt: task.prompt,
            workingDir: task.workingDir,
            timeoutMs: task.timeoutMs,
            muninUrl: config.muninUrl,
            muninApiKey: config.muninApiKey,
            maxOutputChars: config.maxOutputChars,
          },
          taskId,
          LOG_DIR,
          { abortController: sdkAbort },
        );
        currentSdkAbort = null;
        exitCode = sdkResult.exitCode;
        output = sdkResult.output;
        logFile = sdkResult.logFile;
        resultText = sdkResult.resultText;
        costUsd = sdkResult.costUsd;
      } else {
        exitCode = ollamaResult.exitCode;
        output = ollamaResult.output;
        logFile = ollamaResult.logFile;
        resultText = ollamaResult.resultText;
      }

      // Collect ollama-specific journal data
      ollamaJournalExtras = {
        runtime_requested: "ollama",
        runtime_effective: fallbackTriggered ? "claude" : "ollama",
        host_requested: task.ollamaHost || "auto",
        host_effective: fallbackTriggered ? "claude-sdk" : host.name,
        model_effective: fallbackTriggered ? "default" : ollamaModel,
        fallback_triggered: fallbackTriggered,
        fallback_reason: fallbackReason,
        prompt_tokens: ollamaResult.promptTokens,
        completion_tokens: ollamaResult.completionTokens,
        total_tokens: ollamaResult.totalTokens,
        inference_ms: ollamaResult.inferenceMs,
        load_ms: ollamaResult.loadMs,
        prompt_chars: ollamaResult.promptChars,
        output_chars: ollamaResult.outputChars,
        free_mem_before_mb: ollamaResult.freeMemBeforeMb,
        free_mem_after_mb: ollamaResult.freeMemAfterMb,
        context_refs_requested: contextResolution?.refsRequested || [],
        context_refs_resolved: contextResolution?.refsResolved || [],
        context_refs_missing: contextResolution?.refsMissing || [],
        context_chars_total: contextResolution?.totalChars || 0,
        context_truncated: contextResolution?.truncated || false,
      };
    }

    // For no-host case without fallback, still populate journal extras
    if (!host && !fallbackTriggered) {
      ollamaJournalExtras = {
        runtime_requested: "ollama",
        runtime_effective: "none",
        host_requested: task.ollamaHost || "auto",
        host_effective: "none",
        model_effective: ollamaModel,
        fallback_triggered: false,
        fallback_reason: "host_unreachable",
        free_mem_before_mb: freeMemBeforeMb,
        free_mem_after_mb: Math.round(os.freemem() / 1024 / 1024),
        context_refs_requested: contextResolution?.refsRequested || [],
        context_refs_resolved: contextResolution?.refsResolved || [],
        context_refs_missing: contextResolution?.refsMissing || [],
        context_chars_total: contextResolution?.totalChars || 0,
        context_truncated: contextResolution?.truncated || false,
      };
    }
    currentOllamaAbort = null;
  } else if (useSdk) {
    console.log(`Using Agent SDK executor for task ${taskNs}`);
    const sdkAbort = new AbortController();
    currentSdkAbort = sdkAbort;
    const sdkResult = await executeSdkTask(
      {
        prompt: task.prompt,
        workingDir: task.workingDir,
        timeoutMs: task.timeoutMs,
        muninUrl: config.muninUrl,
        muninApiKey: config.muninApiKey,
        maxOutputChars: config.maxOutputChars,
        model: task.model,
      },
      taskId,
      LOG_DIR,
      {
        abortController: sdkAbort,
        onTimeout: async (partialOutput) => {
          // Write partial result on timeout
          try {
            await munin.write(taskNs, "result", [
              "## Result (PARTIAL — task timed out)\n",
              `- **Exit code:** TIMEOUT`,
              `- **Started at:** ${startedAt}`,
              `- **Timed out at:** ${new Date().toISOString()}`,
              `- **Duration:** ${Math.round((Date.now() - startMs) / 1000)}s`,
              `- **Executor:** agent-sdk`,
              `- **Log file:** ~/.hugin/logs/${taskId}.log`,
              "",
              "### Last Output",
              "```",
              partialOutput || "(no output captured)",
              "```",
            ].join("\n"));
          } catch (err) {
            console.error("Failed to write partial result on timeout:", err);
          }
        },
      },
    );
    currentSdkAbort = null;
    exitCode = sdkResult.exitCode;
    output = sdkResult.output;
    logFile = sdkResult.logFile;
    resultText = sdkResult.resultText;
    costUsd = sdkResult.costUsd;
  } else {
    const spawnResult = await spawnRuntime(task, { taskNs, muninClient: munin });
    exitCode = spawnResult.exitCode;
    output = spawnResult.output;
    logFile = spawnResult.logFile;
  }

  // Stop lease renewal — task is done
  stopLeaseRenewal();
  stopCancellationWatch();
  currentSdkAbort = null;
  currentOllamaAbort = null;

  const durationMs = Date.now() - startMs;
  const completedAt = new Date().toISOString();
  let cancellation: CancellationRequest | null = currentCancellation;
  if (!cancellation) {
    const currentEntry = await munin.read(taskNs, "status");
    if (currentEntry?.tags.includes(CANCEL_REQUESTED_TAG)) {
      cancellation = {
        reason: `Task ${taskId} cancelled by operator`,
        sourceNamespace: taskNs,
      };
    } else if (task.pipeline?.pipelineId) {
      const pipelineNs = `tasks/${task.pipeline.pipelineId}`;
      const pipelineEntry = await munin.read(pipelineNs, "status");
      if (pipelineEntry?.tags.includes(CANCEL_REQUESTED_TAG)) {
        cancellation = {
          reason: `Pipeline ${task.pipeline.pipelineId} cancelled by operator`,
          sourceNamespace: pipelineNs,
          pipelineId: task.pipeline.pipelineId,
        };
      }
    }
  }
  currentCancellation = null;
  const isTimeout = exitCode === "TIMEOUT";
  const ok = exitCode === 0;
  const isCancelled = cancellation !== null;

  // Safety net: push any commits the task left unpushed
  if (ok && !isCancelled) {
    await postTaskGitPush(task.workingDir);
  }

  console.log(
    `Task ${taskNs} ${isCancelled ? "cancelled" : ok ? "completed" : isTimeout ? "timed out" : "failed"} (exit: ${isCancelled ? "CANCELLED" : exitCode}, executor: ${executorLabel}, duration: ${Math.round(durationMs / 1000)}s)`
  );

  // For SDK/ollama executor, use resultText directly
  // For spawn executor, check for hook result, then fall back to stdout
  let resultBody: string;
  let resultSource: string;

  if ((useSdk || isOllama) && resultText) {
    resultSource = effectiveExecutor;
    resultBody = `### Response\n\n${resultText}`;
  } else if (!useSdk && !isOllama) {
    const hookResult = readHookResult(taskId);
    if (hookResult) {
      resultSource = "hook";
      resultBody = `### Response\n\n${hookResult.last_assistant_message}`;
      console.log(`Using Stop hook result for task ${taskNs}`);
    } else {
      resultSource = "stdout";
      resultBody = `### Output\n\`\`\`\n${output || "(no output)"}\n\`\`\``;
    }
  } else {
    resultSource = effectiveExecutor;
    resultBody = `### Output\n\`\`\`\n${output || "(no output)"}\n\`\`\``;
  }

  // Write result to Munin (skip if timeout already wrote partial result via SDK)
  if (!(isTimeout && useSdk)) {
    await munin.write(
      taskNs,
      "result",
      buildTaskResultDocument({
        timedOut: isTimeout,
        exitCode,
        startedAt,
        completedAt,
        durationSeconds: Math.round(durationMs / 1000),
        executor: effectiveExecutor,
        resultSource,
        logFile: `~/.hugin/logs/${taskId}.log`,
        costUsd,
        replyTo: task.replyTo,
        replyFormat: task.replyFormat,
        group: task.group,
        sequence: task.sequence,
        body: resultBody,
      })
    );
  }

  const structuredBodyKind: TaskExecutionBodyKind =
    resultSource === "stdout" ? "output" : "response";
  const structuredBodyText =
    resultSource === "stdout"
      ? output || "(no output)"
      : resultText || output || "(no output)";
  const runtimeMetadata: TaskExecutionRuntimeMetadata | undefined =
    isOllama
      ? {
          requestedModel: task.model || config.ollamaDefaultModel,
          effectiveModel:
            typeof ollamaJournalExtras.model_effective === "string"
              ? ollamaJournalExtras.model_effective
              : undefined,
          requestedHost: task.ollamaHost || "auto",
          effectiveHost:
            typeof ollamaJournalExtras.host_effective === "string"
              ? ollamaJournalExtras.host_effective
              : undefined,
          fallbackTriggered:
            typeof ollamaJournalExtras.fallback_triggered === "boolean"
              ? ollamaJournalExtras.fallback_triggered
              : undefined,
          fallbackReason:
            typeof ollamaJournalExtras.fallback_reason === "string"
              ? ollamaJournalExtras.fallback_reason
              : undefined,
        }
      : task.model
        ? {
            requestedModel: task.model,
            effectiveModel: task.model,
          }
        : undefined;

  if (isCancelled && cancellation) {
    await munin.write(
      taskNs,
      "result",
      buildCancelledTaskResultDocument({
        startedAt,
        completedAt,
        durationSeconds: Math.round(durationMs / 1000),
        executor: effectiveExecutor,
        resultSource,
        logFile: `~/.hugin/logs/${taskId}.log`,
        reason: cancellation.reason,
        replyTo: task.replyTo,
        replyFormat: task.replyFormat,
        group: task.group,
        sequence: task.sequence,
        body: resultBody,
      })
    );
    await writeStructuredTaskResult(
      taskNs,
      createCancelledStructuredResult(taskNs, task.runtime, cancellation.reason, {
        executor: effectiveExecutor,
        resultSource,
        startedAt,
        completedAt,
        durationSeconds: Math.round(durationMs / 1000),
        logFile: `~/.hugin/logs/${taskId}.log`,
        replyTo: task.replyTo,
        replyFormat: task.replyFormat,
        group: task.group,
        sequence: task.sequence,
        pipeline: task.pipeline,
        runtimeMetadata,
        bodyKind: structuredBodyKind,
        bodyText: structuredBodyText,
      })
    );
    await munin.write(
      taskNs,
      "status",
      entry.content,
      buildTerminalStatusTags("cancelled", entry.tags, `runtime:${task.runtime}`)
    );
    await munin.log(
      taskNs,
      `Task cancelled in ${Math.round(durationMs / 1000)}s (reason: ${cancellation.reason}, executor: ${executorLabel})`
    );
  } else {
    await writeStructuredTaskResult(
      taskNs,
      buildStructuredTaskResult({
        schemaVersion: 1,
        taskId,
        taskNamespace: taskNs,
        lifecycle: ok ? "completed" : "failed",
        outcome: ok ? "completed" : isTimeout ? "timed_out" : "failed",
        runtime: task.runtime,
        executor: effectiveExecutor,
        resultSource,
        exitCode,
        startedAt,
        completedAt,
        durationSeconds: Math.round(durationMs / 1000),
        logFile: `~/.hugin/logs/${taskId}.log`,
        replyTo: task.replyTo,
        replyFormat: task.replyFormat,
        group: task.group,
        sequence: task.sequence,
        costUsd: costUsd ?? undefined,
        bodyKind: structuredBodyKind,
        bodyText: structuredBodyText,
        errorMessage: ok ? undefined : structuredBodyText,
        runtimeMetadata,
        pipeline: task.pipeline,
      })
    );

    await munin.write(
      taskNs,
      "status",
      entry.content,
      buildTerminalStatusTags(ok ? "completed" : "failed", entry.tags, `runtime:${task.runtime}`)
    );

    await munin.log(
      taskNs,
      `Task ${ok ? "completed" : isTimeout ? "timed out" : "failed"} in ${Math.round(durationMs / 1000)}s (exit ${exitCode}, executor: ${executorLabel}${costUsd !== null ? `, cost: $${costUsd.toFixed(4)}` : ""})`
    );
  }

  const shouldPromoteDependents =
    !isCancelled || cancellation?.pipelineId !== task.pipeline?.pipelineId;
  if (shouldPromoteDependents) {
    await promoteDependents(taskId);
  }
  if (task.pipeline?.pipelineId) {
    await refreshPipelineSummary(task.pipeline.pipelineId);
    if (isCancelled && cancellation?.pipelineId === task.pipeline.pipelineId) {
      await finalizePipelineCancellationIfReady(
        task.pipeline.pipelineId,
        cancellation.reason
      );
    }
  }

  // Capture quota after task execution (run for claude tasks or ollama fallback to claude)
  const quotaAfter = (!isOllama || fallbackTriggered) ? await fetchQuota() : { q5: null, q7: null };

  // Append to invocation journal for usage analysis
  appendJournal({
    ts: completedAt,
    task_id: taskId,
    repo: task.context || path.basename(task.workingDir),
    runtime: task.runtime,
    executor: effectiveExecutor,
    model_requested: task.model || "default",
    exit_code: isCancelled ? "CANCELLED" : exitCode,
    duration_s: Math.round(durationMs / 1000),
    timeout_ms: task.timeoutMs,
    cost_usd: costUsd,
    group: task.group || null,
    quota_before: quotaBefore,
    quota_after: quotaAfter,
    cancellation_reason: cancellation?.reason || null,
    cancellation_source: cancellation?.sourceNamespace || null,
    // Ollama-specific fields (null/absent for non-ollama tasks)
    ...ollamaJournalExtras,
  });

  currentTask = null;
  currentTaskConfig = null;
  return { hadTask: true, queueDepth };
}

async function pollLoop(): Promise<void> {
  console.log(
    `Hugin dispatcher started (poll interval: ${config.pollIntervalMs}ms)`
  );

  // Recover any tasks left running from a previous crash
  await recoverStaleTasks();
  await reconcileBlockedTasks();

  // Clean up old log files
  await rotateOldLogs();

  let pollCount = 0;
  while (!shuttingDown) {
    let queueDepth = 0;
    try {
      pollCount++;
      const processedCancellation = await processCancellationRequests();
      const poll = await pollOnce();
      queueDepth = poll.queueDepth;
      lastQueueDepth = queueDepth;
      if (pollCount % 5 === 0) {
        await reconcileBlockedTasks();
      }
      lastBlockedTaskCount = await countTasksWithLifecycle("blocked");
      // Fire-and-forget heartbeat
      emitHeartbeat(queueDepth, lastBlockedTaskCount);
      if ((processedCancellation || poll.hadTask) && !shuttingDown) continue; // Check for more immediately
    } catch (err) {
      console.error("Poll error:", err);
      // Still emit heartbeat on error
      emitHeartbeat(queueDepth, lastBlockedTaskCount);
    }

    // Wait for next poll
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.pollIntervalMs);
      // Allow early wakeup on shutdown
      if (shuttingDown) {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  console.log("Poll loop exited");
}

// --- Health endpoint ---

const app = express();

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "hugin",
    worker_id: workerId,
    current_task: currentTask,
    polling: !shuttingDown,
    queue_depth: lastQueueDepth,
    blocked_tasks: lastBlockedTaskCount,
    ollama_hosts: getHostStatus(),
  });
});

// --- Graceful shutdown ---

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  console.log(`Received ${signal}, shutting down (worker: ${workerId})...`);
  shuttingDown = true;
  stopLeaseRenewal();
  stopCancellationWatch();

  // Mark the current task as failed before killing the process
  if (currentTask) {
    console.log(`Marking current task ${currentTask} as failed (shutdown)...`);
    try {
      const entry = await munin.read(currentTask, "status");
      if (entry) {
        const runtimeTag = entry.tags.find((t) => t.startsWith("runtime:"));
        await munin.write(
          currentTask,
          "status",
          entry.content,
          buildTerminalStatusTags("failed", entry.tags),
          entry.updated_at
        );
        await munin.write(
          currentTask,
          "result",
          `## Result\n\n- **Exit code:** -1\n- **Error:** Task interrupted by dispatcher shutdown (${signal}, worker: ${workerId})\n`
        );
        const task = parseTask(entry.content);
        const runtime = (runtimeTag || "runtime:claude").replace(
          /^runtime:/,
          ""
        ) as DispatcherRuntime;
        await writeStructuredTaskResult(
          currentTask,
          createFailureStructuredResult(
            currentTask,
            runtime,
            `Task interrupted by dispatcher shutdown (${signal}, worker: ${workerId})`,
            {
              executor: "dispatcher",
              resultSource: "shutdown",
              replyTo: task?.replyTo,
              replyFormat: task?.replyFormat,
              group: task?.group,
              sequence: task?.sequence,
              pipeline: task?.pipeline,
            }
          )
        );
        await munin.log(
          currentTask,
          `Task interrupted by dispatcher shutdown (${signal}, worker: ${workerId})`
        );
        await promoteDependents(extractTaskId(currentTask));
        await refreshPipelineSummaryFromContent(entry.content);
      }
    } catch (err) {
      console.error("Failed to mark task as failed during shutdown:", err);
    }
  }

  if (currentSdkAbort) {
    console.log("Aborting running SDK task...");
    currentSdkAbort.abort();
  }

  if (currentOllamaAbort) {
    console.log("Aborting running ollama task...");
    currentOllamaAbort.abort();
  }

  if (currentChild) {
    console.log("Forwarding signal to running task...");
    currentChild.kill("SIGTERM");
    // Give the child 30s to finish
    setTimeout(() => {
      if (currentChild && !currentChild.killed) {
        console.log("Force killing child process");
        currentChild.kill("SIGKILL");
      }
    }, 30000);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// --- Start ---

// Ensure log directory exists
ensureLogDir();
console.log(`Worker ID: ${workerId}`);
console.log(`Log directory: ${LOG_DIR}`);

// Configure ollama hosts
configureHosts({
  piUrl: config.ollamaPiUrl,
  laptopUrl: config.ollamaLaptopUrl,
});
if (config.ollamaPiUrl) {
  console.log(`Ollama Pi: ${config.ollamaPiUrl}`);
}
if (config.ollamaLaptopUrl) {
  console.log(`Ollama Laptop: ${config.ollamaLaptopUrl}`);
}
console.log(`Ollama default model: ${config.ollamaDefaultModel}`);

const server = app.listen(config.port, config.host, () => {
  console.log(`Hugin health endpoint: http://${config.host}:${config.port}/health`);
  console.log(`Munin: ${config.muninUrl}`);
  console.log(`Workspace: ${config.workspace}`);
  console.log(`Claude executor: ${config.claudeExecutor} (set HUGIN_CLAUDE_EXECUTOR=spawn to use legacy)`);
  console.log(`Allowed submitters: ${config.allowedSubmitters.includes("*") ? "* (all)" : config.allowedSubmitters.join(", ")}`);
});

// Check Munin is reachable before starting poll loop
munin.health().then((ok) => {
  if (!ok) {
    console.warn("WARNING: Munin health check failed — will retry on first poll");
  } else {
    console.log("Munin health check: ok");
  }
  pollLoop().then(() => {
    server.close();
    process.exit(0);
  });
});
