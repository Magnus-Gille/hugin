import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import {
  buildDefaultEgressHosts,
  installFetchEgressPolicy,
} from "./egress-policy.js";
import {
  MuninClient,
  type MuninEntry,
  type MuninClientConfig,
  type MuninReadResult,
} from "./munin-client.js";
import { getFoundBatchEntry, extractTaskId, pickEarliestTask, selectNextTask, checkoutTaskBranch, finalizeTaskBranch, shouldReapExpiredLease } from "./task-helpers.js";
import { executeSdkTask } from "./sdk-executor.js";
import { executeOllamaTask } from "./ollama-executor.js";
import { configureHosts, resolveOllamaHost, getHostStatus, probeAllHosts, warmModel, getLoadedModels } from "./ollama-hosts.js";
import { resolveContextRefs } from "./context-loader.js";
import {
  pipelineSideEffectIdSchema,
  type PipelineSideEffectId,
} from "./pipeline-ir.js";
import {
  buildPhaseApprovalRequestContent,
  buildPhaseOperationKey,
  buildPromptPreview,
  parsePhaseApprovalDecision,
  parsePhaseApprovalRequest,
} from "./pipeline-gates.js";
import {
  processPipelineCancellationRequest as handlePipelineCancellationEntry,
  processPipelineResumeRequest as handlePipelineResumeEntry,
} from "./pipeline-control.js";
import { handlePipelineTask as dispatchPipelineTask } from "./pipeline-dispatch.js";
import {
  parsePipelineExecutionSummary,
  pipelineSummaryNeedsReconciliation,
} from "./pipeline-summary.js";
import { PipelineSummaryManager } from "./pipeline-summary-manager.js";
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
  buildAwaitingApprovalTags,
  buildTerminalStatusTags,
} from "./task-status-tags.js";
import {
  buildStructuredTaskResult,
  type DispatcherRuntime,
  type StructuredTaskResult,
  type TaskExecutionApprovalMetadata,
  type TaskExecutionBodyKind,
  type TaskExecutionPipelineContext,
  type TaskExecutionRuntimeMetadata,
  type TaskExecutionSensitivity,
} from "./task-result-schema.js";
import {
  buildSensitivityAssessment,
  buildSensitivityPolicyError,
  classifyContextSensitivity,
  classifyPromptSensitivity,
  compareSensitivity,
  detectPromptSensitivity,
  getDispatcherRuntimeMaxSensitivity,
  maxSensitivity,
  namespaceFallbackSensitivity,
  parseSensitivity,
  sensitivitySchema,
  sensitivityToMuninClassification,
  sensitivityToTag,
  type Sensitivity,
  type SensitivityAssessment,
} from "./sensitivity.js";
import { routeTask, type RouterDecision } from "./router.js";
import {
  buildRuntimeCandidates,
  type RuntimeCapability,
} from "./runtime-registry.js";

const HUGIN_HOME = path.join(process.env.HOME || "/home/magnus", ".hugin");
const LOG_DIR = path.join(HUGIN_HOME, "logs");
const HOOK_RESULT_DIR = path.join(HUGIN_HOME, "hook-results");
const CANCEL_REQUESTED_TAG = "cancel-requested";
const RESUME_REQUESTED_TAG = "resume-requested";
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
  allowedSubmitters: (process.env.HUGIN_ALLOWED_SUBMITTERS || "Codex,Codex-desktop,ratatoskr,Codex-web,Codex-mobile,claude-code,claude-desktop,claude-web,claude-mobile,hugin")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Submitters allowed to override a detector-raised sensitivity with an
  // explicit `declared` value on the task front-matter. Narrower than
  // `allowedSubmitters` on purpose: agent principals (hugin, ratatoskr) are
  // excluded so that a prompt-injected or misbehaving agent cannot self-
  // escalate its own classifier by submitting a task with `Sensitivity:
  // internal`. Only human-driven clients — Claude Code/Desktop/Web/Mobile
  // and the various Codex CLIs — are trusted to set declared sensitivity,
  // on the assumption that the owner is operating them directly.
  //
  // If ratatoskr or hugin start failing often enough that auto-override is
  // worth the risk, add them to HUGIN_OWNER_SUBMITTERS explicitly.
  ownerSubmitters: (
    process.env.HUGIN_OWNER_SUBMITTERS ??
    "Codex,Codex-desktop,Codex-web,Codex-mobile,claude-code,claude-desktop,claude-web,claude-mobile"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  ollamaPiUrl: process.env.OLLAMA_PI_URL || "http://127.0.0.1:11434",
  ollamaLaptopUrl: process.env.OLLAMA_LAPTOP_URL || "",
  ollamaDefaultModel: process.env.OLLAMA_DEFAULT_MODEL || "qwen2.5:3b",
  extraAllowedEgressHosts: (process.env.HUGIN_ALLOWED_EGRESS_HOSTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
};

const legacyClaudeExecutor = process.env.HUGIN_CLAUDE_EXECUTOR?.trim().toLowerCase();
if (legacyClaudeExecutor && legacyClaudeExecutor !== "sdk") {
  console.error(
    `HUGIN_CLAUDE_EXECUTOR=${legacyClaudeExecutor} is no longer supported; Claude tasks now always use the Agent SDK`,
  );
  process.exit(1);
}

if (!config.muninApiKey) {
  console.error("MUNIN_API_KEY is required");
  process.exit(1);
}

// --- Worker identity ---

const LEASE_DURATION_MS = 120_000; // 2 minutes — renewed during execution
const LEASE_RENEWAL_INTERVAL_MS = 60_000; // renew every 60s

const workerId = `hugin-${os.hostname()}-${process.pid}`;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- State ---

let shuttingDown = false;
let currentTask: string | null = null;
let currentTaskConfig: TaskConfig | null = null;
let currentChild: ChildProcess | null = null;
let currentSdkAbort: AbortController | null = null;
let currentOllamaAbort: AbortController | null = null;
let server: Server;
let leaseRenewalTimer: ReturnType<typeof setInterval> | null = null;
let cancelWatchTimer: ReturnType<typeof setInterval> | null = null;
let lastQueueDepth = 0;
let lastBlockedTaskCount = 0;
const startedAt = Date.now();
const pipelineSummaryManager = new PipelineSummaryManager();

interface CancellationRequest {
  reason: string;
  sourceNamespace: string;
  pipelineId?: string;
}

let currentCancellation: CancellationRequest | null = null;
let cancellationCheckInFlight = false;

function createMuninClient(
  overrides: Partial<MuninClientConfig> = {}
): MuninClient {
  return new MuninClient({
    baseUrl: config.muninUrl,
    apiKey: config.muninApiKey,
    ...overrides,
  });
}

const egressPolicy = installFetchEgressPolicy(
  buildDefaultEgressHosts({
    muninUrl: config.muninUrl,
    ollamaPiUrl: config.ollamaPiUrl,
    ollamaLaptopUrl: config.ollamaLaptopUrl,
    extraHosts: config.extraAllowedEgressHosts,
  }),
);

const munin = createMuninClient();
// Keep lease renewal and active-task cancellation polling off the main request
// slot so a long Retry-After on background work cannot delay them past expiry.
const leaseMunin = createMuninClient();
const cancelWatchMunin = createMuninClient();

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
  reasoning?: boolean;
  fallback?: "claude" | "none";
  contextRefs?: string[];
  contextBudget?: number;
  declaredSensitivity?: Sensitivity;
  effectiveSensitivity?: Sensitivity;
  sensitivityAssessment?: SensitivityAssessment;
  contextResolution?: Awaited<ReturnType<typeof resolveContextRefs>>;
  pipeline?: TaskExecutionPipelineContext;
  capabilities?: RuntimeCapability[];
  autoRouted?: boolean;
  routingDecision?: RouterDecision;
}

type DeclaredRuntime = TaskConfig["runtime"] | "pipeline" | "auto";

function parseDeclaredRuntime(content: string): DeclaredRuntime | undefined {
  return content.match(/\*\*Runtime:\*\*\s*(claude|codex|ollama|pipeline|auto)/i)?.[1]?.toLowerCase() as
    | DeclaredRuntime
    | undefined;
}

function parseSubmittedByField(content: string): string {
  return content.match(/\*\*Submitted by:\*\*\s*(.+)/i)?.[1]?.trim() || "unknown";
}

// Accepts an allowlist entry as a match if the submitter equals it
// (case-insensitive) or extends it with a `-<host>` suffix — e.g.
// `Claude-Code-laptop` matches `claude-code`. Hosts like `laptop` and `pi`
// are informational; the trust decision belongs to the base identity.
function isSubmitterAllowed(
  submittedBy: string,
  allowedSubmitters: readonly string[],
): boolean {
  if (allowedSubmitters.includes("*")) return true;
  const normalized = submittedBy.trim().toLowerCase();
  if (!normalized) return false;
  return allowedSubmitters.some((entry) => {
    const entryLower = entry.trim().toLowerCase();
    if (!entryLower) return false;
    return (
      normalized === entryLower ||
      normalized.startsWith(`${entryLower}-`)
    );
  });
}

function parsePipelineSideEffectsField(content: string): PipelineSideEffectId[] {
  const raw = content.match(/\*\*Pipeline side-effects:\*\*\s*(.+)/i)?.[1]?.trim();
  if (!raw) return [];

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => pipelineSideEffectIdSchema.safeParse(value))
    .filter((parsed): parsed is { success: true; data: PipelineSideEffectId } => parsed.success)
    .map((parsed) => parsed.data);
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
  const declaredRuntimeRaw = parseDeclaredRuntime(content);
  const isAutoRoute = declaredRuntimeRaw === "auto";
  const runtime = (isAutoRoute ? undefined : declaredRuntimeRaw) as
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
  const reasoningRaw = content.match(
    /\*\*Reasoning:\*\*\s*(true|false)/i
  )?.[1]?.toLowerCase();
  const fallbackRaw = content.match(
    /\*\*Fallback:\*\*\s*(claude|none)/i
  )?.[1]?.toLowerCase() as "claude" | "none" | undefined;
  const contextRefsRaw = content.match(
    /\*\*Context-refs:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const contextBudgetStr = content.match(
    /\*\*Context-budget:\*\*\s*(\d+)/i
  )?.[1];
  const declaredSensitivityRaw = content.match(
    /\*\*Sensitivity:\*\*\s*(public|internal|private)/i
  )?.[1]?.trim()?.toLowerCase();
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

  const capabilitiesRaw = content.match(
    /\*\*Capabilities:\*\*\s*(.+)/i
  )?.[1]?.trim();

  // Extract prompt from ### Prompt section
  const promptMatch = content.match(/###\s*Prompt\s*\n([\s\S]+)$/i);
  const prompt = promptMatch?.[1]?.trim();

  if (!prompt || (!runtime && !isAutoRoute)) return null;

  // Resolution priority: Context > Working dir > config.workspace
  const resolvedDir = contextRaw
    ? resolveContext(contextRaw)
    : workingDir || config.workspace;

  const validCapabilities: RuntimeCapability[] = [];
  if (capabilitiesRaw) {
    for (const cap of capabilitiesRaw.split(",").map((c) => c.trim()).filter(Boolean)) {
      if (cap === "tools" || cap === "code" || cap === "structured-output") {
        validCapabilities.push(cap);
      }
    }
  }

  return {
    prompt,
    runtime: runtime || "claude",  // temporary for auto — overwritten by router
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
    reasoning:
      reasoningRaw === "true" ? true : reasoningRaw === "false" ? false : undefined,
    fallback: fallbackRaw || undefined,
    contextRefs: contextRefsRaw
      ? contextRefsRaw.split(",").map((r) => r.trim()).filter(Boolean)
      : undefined,
    contextBudget: contextBudgetStr ? parseInt(contextBudgetStr) : undefined,
    declaredSensitivity: declaredSensitivityRaw
      ? sensitivitySchema.parse(declaredSensitivityRaw)
      : undefined,
    capabilities: validCapabilities.length > 0 ? validCapabilities : undefined,
    autoRouted: isAutoRoute || undefined,
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
            sideEffects: parsePipelineSideEffectsField(content),
          }
        : undefined,
  };
}

function buildTaskSensitivitySnapshot(
  assessment: SensitivityAssessment | undefined,
): TaskExecutionSensitivity | undefined {
  if (!assessment) return undefined;
  return {
    declared: assessment.declared,
    effective: assessment.effective,
    mismatch: assessment.mismatch,
  };
}

function getDeclaredSensitivityFromContent(
  content: string,
): Sensitivity | undefined {
  return parseSensitivity(
    content.match(/\*\*Sensitivity:\*\*\s*(public|internal|private)/i)?.[1],
  );
}

function getTaskArtifactClassification(
  task: Pick<TaskConfig, "effectiveSensitivity" | "declaredSensitivity" | "pipeline"> | undefined,
  content?: string,
): string | undefined {
  const sensitivity =
    task?.effectiveSensitivity ||
    task?.pipeline?.sensitivity ||
    task?.declaredSensitivity ||
    (content ? getDeclaredSensitivityFromContent(content) : undefined);
  if (!sensitivity) return undefined;
  // Clamp up to the tasks/* namespace floor. Owner-overridden tasks can
  // legitimately carry effective sensitivity `public`, but Munin rejects
  // writes below a namespace's floor — and task artifacts always land in
  // `tasks/*`, whose floor is `internal`. Without clamping, the write is
  // rejected and (prior to the write-ok check) silently dropped.
  const clamped = maxSensitivity(sensitivity, namespaceFallbackSensitivity("tasks/"));
  return sensitivityToMuninClassification(clamped);
}

function isOwnerSubmitter(submittedBy: string | undefined): boolean {
  if (!submittedBy) return false;
  return isSubmitterAllowed(submittedBy, config.ownerSubmitters);
}

function getTaskSensitivityAssessment(task: TaskConfig): SensitivityAssessment {
  const declared = task.declaredSensitivity;
  const baseline = task.pipeline?.sensitivity || "internal";
  const contextSensitivity = classifyContextSensitivity(task.context, task.workingDir);
  const promptDetection = detectPromptSensitivity(task.prompt);
  const refsSensitivity = task.contextResolution?.maxSensitivity;
  return buildSensitivityAssessment({
    declared,
    baseline,
    context: contextSensitivity,
    prompt: promptDetection.sensitivity,
    refs: refsSensitivity,
    hardPrivate: promptDetection.hardPrivate,
    allowOwnerOverride: isOwnerSubmitter(task.submittedBy),
  });
}

function getTaskRuntimeLabel(task: TaskConfig): string {
  if (task.runtime !== "ollama") return task.runtime;
  return task.ollamaHost ? `ollama:${task.ollamaHost}` : "ollama";
}

async function assessTaskSecurity(task: TaskConfig): Promise<SensitivityAssessment> {
  if (task.contextRefs?.length) {
    task.contextResolution = await resolveContextRefs(
      task.contextRefs,
      task.contextBudget,
      munin,
    );
  }

  const assessment = getTaskSensitivityAssessment(task);
  task.effectiveSensitivity = assessment.effective;
  task.sensitivityAssessment = assessment;

  if (assessment.override?.applied) {
    // Owner override is visible in logs so we can mine false positives and
    // tune the classifier. Never silent.
    console.warn(
      `[sensitivity] owner override: submitter="${task.submittedBy}" declared=${assessment.declared} detector=${assessment.override.detectorMax} -> effective=${assessment.effective} reasons=[${assessment.reasons.join(", ")}]`,
    );
  }

  return assessment;
}

function getSecurityViolationForTask(
  task: TaskConfig,
  assessment: SensitivityAssessment,
): string | null {
  const runtimeMax = getDispatcherRuntimeMaxSensitivity(task.runtime);
  if (compareSensitivity(assessment.effective, runtimeMax) > 0) {
    const deniedRef =
      task.contextResolution?.refs.find(
        (ref) => compareSensitivity(ref.sensitivity, runtimeMax) > 0,
      );
    return buildSensitivityPolicyError({
      runtimeLabel: getTaskRuntimeLabel(task),
      runtimeMax,
      effective: assessment.effective,
      deniedRef: deniedRef?.ref,
      deniedClassification: deniedRef?.classification,
    });
  }
  return null;
}

function getInjectionViolationForTask(task: TaskConfig): string | null {
  const resolution = task.contextResolution;
  if (!resolution || !resolution.injectionBlocked) return null;
  const flagged = resolution.refs.find((ref) => ref.quarantined);
  if (!flagged) return null;
  const patterns = flagged.injection?.matches.map((m) => m.pattern).join(", ") || "unknown";
  const severity = flagged.injection?.severity || "high";
  return (
    `Task rejected by HUGIN_INJECTION_POLICY=fail: context-ref "${flagged.ref}" ` +
    `matched ${severity}-severity prompt-injection patterns [${patterns}]`
  );
}

// --- Log directory ---

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

async function writeStructuredTaskResult(
  taskNs: string,
  result: StructuredTaskResult,
  classification?: string,
): Promise<void> {
  await munin.write(
    taskNs,
    "result-structured",
    JSON.stringify(buildStructuredTaskResult(result), null, 2),
    ["type:task-result", "type:task-result-structured"],
    undefined,
    classification,
  );
}

async function refreshPipelineSummary(pipelineId: string): Promise<void> {
  await pipelineSummaryManager.refresh(munin, pipelineId, console);
}

async function refreshPipelineSummaryFromContent(content: string): Promise<void> {
  await pipelineSummaryManager.refreshFromContent(munin, content, console);
}

async function primeTrackedPipelineSummaries(): Promise<void> {
  try {
    const { results, total } = await munin.query({
      query: "task",
      tags: ["runtime:pipeline"],
      namespace: "tasks/",
      entry_type: "state",
      limit: 100,
    });

    const pipelineParents = results.filter((result) => result.key === "status");
    const summaryEntries = pipelineParents.length
      ? await munin.readBatch(
          pipelineParents.map((result) => ({
            namespace: result.namespace,
            key: "summary",
          }))
        )
      : [];
    let tracked = 0;
    for (const [index, result] of pipelineParents.entries()) {
      const summaryEntry = getFoundBatchEntry(summaryEntries[index]);
      if (!summaryEntry) continue;

      const summary = parsePipelineExecutionSummary(summaryEntry.content);
      if (!summary) {
        console.error(`Failed to parse pipeline summary for ${result.namespace}`);
        continue;
      }
      pipelineSummaryManager.cacheSummaryFingerprint(summary);

      if (pipelineSummaryNeedsReconciliation(summary)) {
        pipelineSummaryManager.track(extractTaskId(result.namespace));
        tracked++;
      }
    }

    if (tracked > 0 || total > results.length) {
      console.log(
        `Pipeline summary watchlist primed: tracked=${tracked}, scanned=${results.length}, total_pipeline_parents=${total}`
      );
    }
  } catch (err) {
    console.error("Failed to prime pipeline summary watchlist:", err);
  }
}

async function reconcileTrackedPipelineSummaries(): Promise<void> {
  await pipelineSummaryManager.reconcile(munin, console);
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
    approval?: TaskExecutionApprovalMetadata;
    sensitivity?: TaskExecutionSensitivity;
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
    approval: options.approval,
    sensitivity: options.sensitivity,
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

function buildApprovalRejectedTaskResultDocument(input: {
  taskId: string;
  pipelineId: string;
  phaseName: string;
  sideEffects: string[];
  reason: string;
  replyTo?: string;
  replyFormat?: string;
  group?: string;
  sequence?: number;
  decidedAt?: string;
  decisionSource?: string;
  decidedBy?: string;
}): string {
  return [
    "## Result",
    "",
    "- **Exit code:** -1",
    "- **Error:** Approval rejected for gated phase",
    `- **Task id:** ${input.taskId}`,
    `- **Pipeline id:** ${input.pipelineId}`,
    `- **Pipeline phase:** ${input.phaseName}`,
    `- **Authority:** gated`,
    ...(input.sideEffects.length > 0
      ? [`- **Side-effects:** ${input.sideEffects.join(", ")}`]
      : []),
    `- **Approval status:** rejected`,
    ...(input.decidedAt ? [`- **Approval decided at:** ${input.decidedAt}`] : []),
    ...(input.decisionSource
      ? [`- **Approval source:** ${input.decisionSource}`]
      : []),
    ...(input.decidedBy ? [`- **Approval decided by:** ${input.decidedBy}`] : []),
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
    approval?: TaskExecutionApprovalMetadata;
    sensitivity?: TaskExecutionSensitivity;
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
    approval: options.approval,
    sensitivity: options.sensitivity,
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

// checkoutTaskBranch, finalizeTaskBranch, and task selection helpers are in task-helpers.ts

// --- Task execution ---

interface SpawnContext {
  taskNs: string;
  muninClient: MuninClient;
}

function spawnRuntime(
  task: TaskConfig,
  ctx: SpawnContext
): Promise<{ exitCode: number | "TIMEOUT"; output: string; logFile: string }> {
  if (task.runtime !== "codex") {
    throw new Error(`Spawn executor no longer supports runtime "${task.runtime}"`);
  }
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

    const cmd = ["codex", ["exec", "--full-auto", task.prompt]];

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
  return String(Date.now() + LEASE_DURATION_MS);
}

function parseLeaseExpiry(tags: string[]): number | null {
  const tag = tags.find((t) => t.startsWith("lease_expires:"));
  if (!tag) return null;
  const raw = tag.slice("lease_expires:".length);
  // Support both epoch-millis (new) and ISO 8601 (legacy)
  const ts = /^\d+$/.test(raw) ? Number(raw) : new Date(raw).getTime();
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
  const authorityTags = baseTags.filter((t) => t.startsWith("authority:"));
  const sensitivityTags = baseTags.filter((t) => t.startsWith("sensitivity:"));
  const routingTags = baseTags.filter((t) => t.startsWith("routing:"));
  return [
    lifecycle,
    ...(runtimeTag ? [runtimeTag] : []),
    ...typeTags,
    ...authorityTags,
    ...sensitivityTags,
    ...routingTags,
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
      await leaseMunin.write(taskNs, "status", entryContent, renewedTags);
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
    const currentEntry = await cancelWatchMunin.read(currentTask, "status");
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
    const pipelineEntry = await cancelWatchMunin.read(pipelineNs, "status");
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

// --- Orphan dispatcher cleanup ---
// Tasks running in the hugin repo (e.g. npm test, npm run dev) can leave behind
// node processes that act as rogue dispatchers, racing the real one for tasks.
// Kill any node dist/index.js processes in our working directory except ourselves.

async function killOrphanDispatchers(): Promise<void> {
  if (os.platform() !== "linux") return; // Only relevant on the Pi

  try {
    const myPid = process.pid;
    const cwd = process.cwd();
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("pgrep", ["-f", "node dist/index.js"], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", () => resolve({ stdout, stderr }));
      child.on("error", reject);
    });

    const pids = stdout.trim().split("\n").filter(Boolean).map(Number).filter((p) => p !== myPid && !isNaN(p));
    for (const pid of pids) {
      try {
        const pidCwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (pidCwd === cwd) {
          console.log(`Killing orphan Hugin process PID ${pid}`);
          process.kill(pid, "SIGTERM");
        }
      } catch {
        // Process may have exited between pgrep and readlink
      }
    }
  } catch {
    // pgrep not available or no matches — fine
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
      ) as DispatcherRuntime | "pipeline";
      if (runtime !== "pipeline") {
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
      }
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

// --- Lease reaping (runs mid-poll) ---
// `recoverStaleTasks` only runs at startup. While the dispatcher is alive,
// a crashed runtime or OOM kill can leave a task stuck with the `running` tag
// past its lease. This reaper scans for such tasks on each poll and fails
// them with a `lease-expired` reason. Fail-fast: no auto-retry to pending.

async function reapExpiredLeases(): Promise<void> {
  try {
    const { results } = await munin.query({
      query: "task",
      tags: ["running"],
      namespace: "tasks/",
      entry_type: "state",
      limit: 20,
    });

    const now = Date.now();

    for (const result of results) {
      if (!result.key || result.key !== "status") continue;

      // Use query-result tags for the cheap filter to avoid a read per task.
      const preDecision = shouldReapExpiredLease({
        tags: result.tags,
        namespace: result.namespace,
        currentTask,
        now,
      });
      if (!preDecision.reap) continue;

      const entry = await munin.read(result.namespace, "status");
      if (!entry) continue;

      // Re-check with authoritative tags (lease may have just been renewed).
      const decision = shouldReapExpiredLease({
        tags: entry.tags,
        namespace: result.namespace,
        currentTask,
        now: Date.now(),
      });
      if (!decision.reap) continue;

      const expiredForS = Math.round(decision.expiredByMs / 1000);
      const errorMessage = `Lease expired ${expiredForS}s ago (worker: ${decision.claimedBy || "unknown"})`;

      console.log(`Reaping ${result.namespace} — ${errorMessage}`);

      const task = parseTask(entry.content);
      if (task && !task.sensitivityAssessment) {
        task.sensitivityAssessment = getTaskSensitivityAssessment(task);
        task.effectiveSensitivity = task.sensitivityAssessment.effective;
      }
      const classification = getTaskArtifactClassification(task || undefined, entry.content);
      const runtime = getRuntimeFromTags(entry.tags);

      try {
        await munin.write(
          result.namespace,
          "status",
          entry.content,
          buildTerminalStatusTags("failed", entry.tags),
          entry.updated_at,
          classification,
        );
      } catch (err) {
        // Compare-and-swap may fail if the task was just renewed/finished.
        console.log(
          `Reap of ${result.namespace} aborted (lost CAS race): ${(err as Error).message}`,
        );
        continue;
      }

      await munin.write(
        result.namespace,
        "result",
        `## Result\n\n- **Exit code:** -1\n- **Error:** ${errorMessage}\n`,
        undefined,
        undefined,
        classification,
      );
      if (runtime !== "pipeline") {
        await writeStructuredTaskResult(
          result.namespace,
          createFailureStructuredResult(result.namespace, runtime, errorMessage, {
            executor: "dispatcher",
            resultSource: "lease-reaper",
            replyTo: task?.replyTo,
            replyFormat: task?.replyFormat,
            group: task?.group,
            sequence: task?.sequence,
            pipeline: task?.pipeline,
            sensitivity: buildTaskSensitivitySnapshot(task?.sensitivityAssessment),
          }),
          classification,
        );
      }
      await munin.log(result.namespace, `Lease reaped: ${errorMessage}`);
      await promoteDependents(extractTaskId(result.namespace));
      await refreshPipelineSummaryFromContent(entry.content);
    }
  } catch (err) {
    console.error("Failed to reap expired leases:", err);
  }
}

// --- Dependency joins ---

function dependencyStateFromEntry(entry: MuninReadResult | null | undefined): DependencyState {
  if (!entry || !entry.found) return "missing";
  if (entry.tags.includes("completed")) return "completed";
  if (entry.tags.includes("cancelled")) return "failed";
  if (entry.tags.includes("failed")) return "failed";
  return "pending";
}

async function readDependencyStates(dependencyIds: string[]): Promise<Record<string, DependencyState>> {
  const entries = await munin.readBatch(
    dependencyIds.map((dependencyId) => ({
      namespace: `tasks/${dependencyId}`,
      key: "status",
    }))
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
  const task = parseTask(entry.content);
  if (task && !task.sensitivityAssessment) {
    task.sensitivityAssessment = getTaskSensitivityAssessment(task);
    task.effectiveSensitivity = task.sensitivityAssessment.effective;
  }
  const classification = getTaskArtifactClassification(task || undefined, entry.content);
  await munin.write(
    taskNs,
    "status",
    entry.content,
    buildTerminalStatusTags("failed", entry.tags),
    entry.updated_at,
    classification
  );
  await munin.write(
    taskNs,
    "result",
    `## Result\n\n- **Exit code:** -1\n- **Error:** ${errorMessage}\n`,
    undefined,
    undefined,
    classification
  );
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
      sensitivity: buildTaskSensitivitySnapshot(task?.sensitivityAssessment),
    }),
    classification,
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

async function clearResumeRequest(
  taskNs: string,
  entry: MuninEntry & { found: true },
  logMessage?: string
): Promise<void> {
  const updatedTags = removeTag(entry.tags, RESUME_REQUESTED_TAG);
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
  if (task && !task.sensitivityAssessment) {
    task.sensitivityAssessment = getTaskSensitivityAssessment(task);
    task.effectiveSensitivity = task.sensitivityAssessment.effective;
  }
  const classification = getTaskArtifactClassification(task || undefined, entry.content);
  const completedAt = options.completedAt || new Date().toISOString();
  const runtime = getRuntimeFromTags(entry.tags);
  let approvalMetadata: TaskExecutionApprovalMetadata | undefined;
  if (task?.pipeline?.authority === "gated") {
    const [approvalRequestEntry, approvalDecisionEntry] = await Promise.all([
      munin.read(taskNs, "approval-request"),
      munin.read(taskNs, "approval-decision"),
    ]);
    const approvalRequest = approvalRequestEntry
      ? parsePhaseApprovalRequest(approvalRequestEntry.content)
      : null;
    const approvalDecision = approvalDecisionEntry
      ? parsePhaseApprovalDecision(approvalDecisionEntry.content)
      : null;
    approvalMetadata = {
      status: approvalDecision?.decision || "pending",
      requestedAt: approvalRequest?.requestedAt,
      decidedAt: approvalDecision?.decidedAt,
      decisionSource: approvalDecision?.source,
      operationKey:
        approvalRequest?.operationKey ||
        (task?.pipeline
          ? buildPhaseOperationKey(task.pipeline.pipelineId, extractTaskId(taskNs))
          : undefined),
    };
  }
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
    }),
    undefined,
    undefined,
    classification
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
        approval: approvalMetadata,
        bodyKind: options.bodyKind,
        bodyText: options.bodyText,
        sensitivity: buildTaskSensitivitySnapshot(task?.sensitivityAssessment),
      }),
      classification,
    );
  }

  await munin.write(
    taskNs,
    "status",
    entry.content,
    buildTerminalStatusTags("cancelled", entry.tags),
    entry.updated_at,
    classification
  );
  await munin.log(taskNs, `Task cancelled: ${reason}`);
  if (task?.pipeline?.pipelineId) {
    await refreshPipelineSummary(task.pipeline.pipelineId);
  }
}

function buildPendingFromAwaitingApprovalTags(tags: string[]): string[] {
  const nextTags = tags.filter((tag) => tag !== "awaiting-approval" && tag !== "pending");
  nextTags.push("pending");
  return nextTags;
}

async function gatePendingTaskForApproval(
  taskNs: string,
  entry: MuninEntry & { found: true },
  task: TaskConfig
): Promise<boolean> {
  if (task.pipeline?.authority !== "gated") {
    return false;
  }

  const approvalDecisionEntry = await munin.read(taskNs, "approval-decision");
  const approvalDecision = approvalDecisionEntry
    ? parsePhaseApprovalDecision(approvalDecisionEntry.content)
    : null;

  if (approvalDecision?.decision === "approved") {
    return false;
  }

  if (approvalDecision?.decision === "rejected") {
    const rejectionReason = approvalDecision.comment?.trim() || "Rejected by operator";
    await munin.write(
      taskNs,
      "result",
      buildApprovalRejectedTaskResultDocument({
        taskId: extractTaskId(taskNs),
        pipelineId: task.pipeline.pipelineId,
        phaseName: task.pipeline.phase,
        sideEffects: task.pipeline.sideEffects,
        reason: rejectionReason,
        replyTo: task.replyTo,
        replyFormat: task.replyFormat,
        group: task.group,
        sequence: task.sequence,
        decidedAt: approvalDecision.decidedAt,
        decisionSource: approvalDecision.source,
        decidedBy: approvalDecision.decidedBy,
      })
    );
    await writeStructuredTaskResult(
      taskNs,
      createFailureStructuredResult(taskNs, task.runtime, rejectionReason, {
        executor: "dispatcher",
        resultSource: "approval",
        replyTo: task.replyTo,
        replyFormat: task.replyFormat,
        group: task.group,
        sequence: task.sequence,
        pipeline: task.pipeline,
        approval: {
          status: "rejected",
          decidedAt: approvalDecision.decidedAt,
          decisionSource: approvalDecision.source,
          operationKey: buildPhaseOperationKey(
            task.pipeline.pipelineId,
            extractTaskId(taskNs)
          ),
        },
      })
    );
    await munin.write(
      taskNs,
      "status",
      entry.content,
      buildTerminalStatusTags("failed", entry.tags, `runtime:${task.runtime}`),
      entry.updated_at
    );
    await munin.log(
      taskNs,
      `Gated phase rejected before execution (${approvalDecision.source || "unknown source"}): ${rejectionReason}`
    );
    await promoteDependents(extractTaskId(taskNs));
    await refreshPipelineSummary(task.pipeline.pipelineId);
    return true;
  }

  const approvalRequestEntry = await munin.read(taskNs, "approval-request");
  if (!approvalRequestEntry) {
    await munin.write(
      taskNs,
      "approval-request",
      buildPhaseApprovalRequestContent({
        pipelineId: task.pipeline.pipelineId,
        phaseName: task.pipeline.phase,
        phaseTaskId: extractTaskId(taskNs),
        authority: "gated",
        sideEffects: task.pipeline.sideEffects,
        status: "pending",
        requestedAt: new Date().toISOString(),
        requestedByWorker: workerId,
        replyTo: task.replyTo,
        replyFormat: task.replyFormat,
        operationKey: buildPhaseOperationKey(
          task.pipeline.pipelineId,
          extractTaskId(taskNs)
        ),
        summary: {
          runtime: task.runtime,
          context: task.context,
          promptPreview: buildPromptPreview(task.prompt),
          dependencyTaskIds: task.pipeline.dependencyTaskIds,
        },
      }),
      ["type:approval-request", "type:pipeline-approval-request"]
    );
    await munin.log(
      taskNs,
      `Approval requested for gated phase ${task.pipeline.phase} (${task.pipeline.sideEffects.join(", ") || "side effects unspecified"})`
    );
  }

  await munin.write(
    taskNs,
    "status",
    entry.content,
    buildAwaitingApprovalTags(entry.tags, `runtime:${task.runtime}`),
    entry.updated_at
  );
  await refreshPipelineSummary(task.pipeline.pipelineId);
  return true;
}

async function processApprovalDecisions(): Promise<boolean> {
  const { results } = await munin.query({
    query: "task",
    tags: ["awaiting-approval"],
    namespace: "tasks/",
    entry_type: "state",
    limit: 50,
  });

  let processed = false;
  for (const result of results) {
    if (result.key !== "status") continue;
    const entry = await munin.read(result.namespace, "status");
    if (!entry || !entry.tags.includes("awaiting-approval")) continue;

    const task = parseTask(entry.content);
    if (!task?.pipeline || task.pipeline.authority !== "gated") {
      continue;
    }

    const approvalDecisionEntry = await munin.read(result.namespace, "approval-decision");
    if (!approvalDecisionEntry) continue;

    const approvalDecision = parsePhaseApprovalDecision(approvalDecisionEntry.content);
    if (!approvalDecision) {
      await munin.log(
        result.namespace,
        "Ignoring invalid approval-decision artifact"
      );
      continue;
    }

    if (
      approvalDecision.phaseTaskId !== extractTaskId(result.namespace) ||
      approvalDecision.pipelineId !== task.pipeline.pipelineId
    ) {
      await munin.log(
        result.namespace,
        "Ignoring mismatched approval-decision artifact"
      );
      continue;
    }

    const approvalRequestEntry = await munin.read(result.namespace, "approval-request");
    const approvalRequest = approvalRequestEntry
      ? parsePhaseApprovalRequest(approvalRequestEntry.content)
      : null;
    const operationKey =
      approvalRequest?.operationKey ||
      buildPhaseOperationKey(task.pipeline.pipelineId, extractTaskId(result.namespace));

    if (approvalDecision.decision === "approved") {
      await munin.write(
        result.namespace,
        "status",
        entry.content,
        buildPendingFromAwaitingApprovalTags(entry.tags),
        entry.updated_at
      );
      await munin.log(
        result.namespace,
        `Approval granted for gated phase ${task.pipeline.phase} (${approvalDecision.source || "unknown source"})`
      );
      await refreshPipelineSummary(task.pipeline.pipelineId);
      processed = true;
      continue;
    }

    const rejectionReason = approvalDecision.comment?.trim() || "Rejected by operator";
    await munin.write(
      result.namespace,
      "result",
      buildApprovalRejectedTaskResultDocument({
        taskId: extractTaskId(result.namespace),
        pipelineId: task.pipeline.pipelineId,
        phaseName: task.pipeline.phase,
        sideEffects: task.pipeline.sideEffects,
        reason: rejectionReason,
        replyTo: task.replyTo,
        replyFormat: task.replyFormat,
        group: task.group,
        sequence: task.sequence,
        decidedAt: approvalDecision.decidedAt,
        decisionSource: approvalDecision.source,
        decidedBy: approvalDecision.decidedBy,
      })
    );
    await writeStructuredTaskResult(
      result.namespace,
      createFailureStructuredResult(result.namespace, task.runtime, rejectionReason, {
        executor: "dispatcher",
        resultSource: "approval",
        replyTo: task.replyTo,
        replyFormat: task.replyFormat,
        group: task.group,
        sequence: task.sequence,
        pipeline: task.pipeline,
        approval: {
          status: "rejected",
          requestedAt: approvalRequest?.requestedAt,
          decidedAt: approvalDecision.decidedAt,
          decisionSource: approvalDecision.source,
          operationKey,
        },
      })
    );
    await munin.write(
      result.namespace,
      "status",
      entry.content,
      buildTerminalStatusTags("failed", entry.tags, `runtime:${task.runtime}`),
      entry.updated_at
    );
    await munin.log(
      result.namespace,
      `Approval rejected for gated phase ${task.pipeline.phase} (${approvalDecision.source || "unknown source"}): ${rejectionReason}`
    );
    await promoteDependents(extractTaskId(result.namespace));
    await refreshPipelineSummary(task.pipeline.pipelineId);
    processed = true;
  }

  return processed;
}

async function processPipelineCancellationRequest(
  entry: MuninEntry & { found: true }
): Promise<boolean> {
  return handlePipelineCancellationEntry(
    munin,
    {
      clearCancellationRequest,
      clearResumeRequest,
      markTaskCancelled,
      requestCancellationForCurrentTask,
      refreshPipelineSummary,
    },
    entry,
    currentTask
  );
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

async function processResumeRequests(): Promise<boolean> {
  const { results } = await munin.query({
    query: "task",
    tags: [RESUME_REQUESTED_TAG],
    namespace: "tasks/",
    entry_type: "state",
    limit: 50,
  });

  let processed = false;
  for (const result of results) {
    if (result.key !== "status") continue;
    const entry = await munin.read(result.namespace, "status");
    if (!entry || !entry.tags.includes(RESUME_REQUESTED_TAG)) continue;

    const declaredRuntime = parseDeclaredRuntime(entry.content);
    if (declaredRuntime !== "pipeline" && !entry.tags.includes("runtime:pipeline")) {
      await clearResumeRequest(
        entry.namespace,
        entry,
        "Resume ignored; only pipeline parents can be resumed"
      );
      continue;
    }

    processed = (
      await handlePipelineResumeEntry(
        munin,
        {
          clearCancellationRequest,
          clearResumeRequest,
          markTaskCancelled,
          requestCancellationForCurrentTask,
          refreshPipelineSummary,
        },
        entry
      )
    ) || processed;
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
  const task = parseTask(entry.content);
  if (task && !task.sensitivityAssessment) {
    task.sensitivityAssessment = getTaskSensitivityAssessment(task);
    task.effectiveSensitivity = task.sensitivityAssessment.effective;
  }
  const classification = getTaskArtifactClassification(task || undefined, entry.content);
  await munin.write(
    taskNs,
    "status",
    entry.content,
    buildTerminalStatusTags("failed", entry.tags, runtimeTagOverride),
    entry.updated_at,
    classification
  );
  await munin.write(
    taskNs,
    "result",
    `## Result\n\n- **Exit code:** -1\n- **Error:** ${errorMessage}\n`,
    undefined,
    undefined,
    classification
  );
  if (runtime !== "pipeline") {
    await writeStructuredTaskResult(
      taskNs,
      createFailureStructuredResult(taskNs, runtime, errorMessage, {
        executor: "dispatcher",
        resultSource: "dispatcher",
        sensitivity: buildTaskSensitivitySnapshot(task?.sensitivityAssessment),
      }),
      classification,
    );
  }
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
    const loadedModels = await getLoadedModels();
    if (Object.keys(loadedModels).length > 0) heartbeat.ollama_loaded = loadedModels;
    await munin.write("tasks/_heartbeat", "status", JSON.stringify(heartbeat), ["heartbeat"]);
  } catch (err) {
    console.error("Heartbeat write failed:", err);
  }
}

// --- Poll loop ---

/**
 * Given a batch of Munin query results, return the pending task with the
 * earliest created_at timestamp (FIFO ordering).  Only "status" entries are
 * considered — other keys are internal bookkeeping entries that the dispatcher
 * should not act on.
 *
 * ISO-8601 timestamps sort correctly as strings, so a plain lexicographic
 * compare is sufficient.
 */
async function pollOnce(): Promise<{ hadTask: boolean; queueDepth: number }> {
  const { results, total } = await munin.query({
    query: "task",
    tags: ["pending"],
    namespace: "tasks/",
    entry_type: "state",
    limit: 10,
  });

  // Query running tasks to support group sequencing checks
  const { results: runningResults } = await munin.query({
    query: "task",
    tags: ["running"],
    namespace: "tasks/",
    entry_type: "state",
    limit: 50,
  });

  // Select the next eligible task respecting Group/Sequence ordering (FIFO within eligible set)
  const taskResult = selectNextTask(results, runningResults);
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

  const parsedTask =
    declaredRuntime === "pipeline" ? null : parseTask(entry.content);
  if (declaredRuntime !== "pipeline" && !parsedTask) {
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
  if (!isSubmitterAllowed(submittedBy, config.allowedSubmitters)) {
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

  if (declaredRuntime !== "pipeline" && parsedTask) {
    const sensitivityAssessment = await assessTaskSecurity(parsedTask);

    // Auto-route: resolve concrete runtime before security check (defense-in-depth)
    if (parsedTask.autoRouted) {
      try {
        const ollamaHosts = await probeAllHosts();
        const candidates = buildRuntimeCandidates(ollamaHosts);
        const decision = routeTask({
          effectiveSensitivity: sensitivityAssessment.effective,
          capabilities: parsedTask.capabilities,
          preferredModel: parsedTask.model,
          availableRuntimes: candidates,
        });
        parsedTask.runtime = decision.selectedRuntime.dispatcherRuntime;
        parsedTask.routingDecision = decision;
        if (decision.selectedRuntime.ollamaHost) {
          parsedTask.ollamaHost = decision.selectedRuntime.ollamaHost;
        }
        if (!parsedTask.model && decision.selectedRuntime.dispatcherRuntime === "ollama") {
          parsedTask.model = config.ollamaDefaultModel;
        }
        console.log(
          `Auto-routed task ${taskNs} → ${decision.selectedRuntime.id} (${decision.reason})`,
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`Auto-routing failed for ${taskNs}: ${errorMsg}`);
        const classification = getTaskArtifactClassification(parsedTask);
        await failTaskWithMessage(taskNs, entry, `Auto-routing failed: ${errorMsg}`);
        await writeStructuredTaskResult(
          taskNs,
          createFailureStructuredResult(taskNs, parsedTask.runtime, `Auto-routing failed: ${errorMsg}`, {
            executor: "dispatcher",
            resultSource: "router",
            replyTo: parsedTask.replyTo,
            replyFormat: parsedTask.replyFormat,
            group: parsedTask.group,
            sequence: parsedTask.sequence,
            pipeline: parsedTask.pipeline,
            sensitivity: buildTaskSensitivitySnapshot(sensitivityAssessment),
            runtimeMetadata: {
              autoRouted: true,
              routingReason: `routing failed: ${errorMsg}`,
            },
          }),
          classification,
        );
        await promoteDependents(extractTaskId(taskNs));
        await refreshPipelineSummaryFromContent(entry.content);
        return { hadTask: true, queueDepth };
      }
    }

    const securityViolation =
      getSecurityViolationForTask(parsedTask, sensitivityAssessment) ||
      getInjectionViolationForTask(parsedTask);
    if (securityViolation) {
      const classification = getTaskArtifactClassification(parsedTask);
      await munin.write(
        taskNs,
        "status",
        entry.content,
        buildTerminalStatusTags("failed", entry.tags),
        entry.updated_at,
        classification,
      );
      await munin.write(
        taskNs,
        "result",
        `## Result\n\n- **Exit code:** -1\n- **Error:** ${securityViolation}\n`,
        undefined,
        undefined,
        classification,
      );
      await writeStructuredTaskResult(
        taskNs,
        createFailureStructuredResult(taskNs, parsedTask.runtime, securityViolation, {
          executor: "dispatcher",
          resultSource: "security-policy",
          replyTo: parsedTask.replyTo,
          replyFormat: parsedTask.replyFormat,
          group: parsedTask.group,
          sequence: parsedTask.sequence,
          pipeline: parsedTask.pipeline,
          sensitivity: buildTaskSensitivitySnapshot(sensitivityAssessment),
        }),
        classification,
      );
      await munin.log(
        taskNs,
        `Task rejected by security policy: ${securityViolation}`,
      );
      await promoteDependents(extractTaskId(taskNs));
      await refreshPipelineSummaryFromContent(entry.content);
      return { hadTask: true, queueDepth };
    }
  }

  if (
    declaredRuntime !== "pipeline" &&
    parsedTask &&
    (await gatePendingTaskForApproval(taskNs, entry, parsedTask))
  ) {
    return { hadTask: true, queueDepth };
  }

  console.log(
    `Claiming task ${taskNs} (runtime: ${declaredRuntime}, submitter: ${submittedBy}, worker: ${workerId})`
  );

  // Claim the task with compare-and-swap, attaching worker identity and lease
  // For auto-routed tasks: replace runtime:auto with the resolved runtime and add routing:auto
  const tagsForClaim = parsedTask?.autoRouted && parsedTask.runtime
    ? entry.tags
        .map((t) => (t === "runtime:auto" ? `runtime:${parsedTask!.runtime}` : t))
        .concat("routing:auto")
    : entry.tags;
  const claimTags = buildClaimTags(tagsForClaim, "running");

  // Rotate the mcp-session-id so all MCP calls for this task execution share
  // one stable session (enables Munin's outcome-aware retrieval and telemetry
  // session-flow analysis). A fresh ID is set again in the finally block below.
  munin.setSessionId(randomUUID());
  try {
    const claimResult = await munin.write(
      taskNs,
      "status",
      entry.content,
      claimTags,
      entry.updated_at
    );
    // Update entry.updated_at so subsequent CAS writes (failTaskWithMessage, etc.) use the fresh timestamp
    if (typeof claimResult.updated_at === "string") {
      entry.updated_at = claimResult.updated_at;
    }
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

  try {
    if (declaredRuntime === "pipeline") {
      currentTaskConfig = null;
      const pipelineResult = await dispatchPipelineTask(
        munin,
        {
          failTaskWithMessage,
          promoteDependents,
          refreshPipelineSummary,
        },
        taskNs,
        entry,
        queueDepth,
        await probeAllHosts(),
        { allowOwnerOverride: isOwnerSubmitter(submittedBy) },
      );
      stopLeaseRenewal();
      stopCancellationWatch();
      currentTask = null;
      currentTaskConfig = null;
      return pipelineResult;
    }

    const task = parsedTask;
    if (!task) {
      throw new Error(`Internal dispatcher error: parsed task missing for ${taskNs}`);
    }

    // Pre-task: checkout a fresh hugin/<taskId> branch from origin/main (#47)
    const branchResult = await checkoutTaskBranch(task.workingDir, taskId);
    if (branchResult.action === "fetch-failed") {
      console.warn(`Pre-task branch checkout failed for ${taskNs} (non-fatal, proceeding without branch): ${branchResult.error}`);
    } else if (branchResult.action === "created") {
      console.log(`Pre-task: branch ${branchResult.branchName} ready in ${task.workingDir}`);
    }

    currentTaskConfig = task;
    const taskClassification = getTaskArtifactClassification(task);
    const taskSensitivitySnapshot = buildTaskSensitivitySnapshot(
      task.sensitivityAssessment,
    );
    let approvalMetadata: TaskExecutionApprovalMetadata | undefined;
    if (task.pipeline?.authority === "gated") {
      const [approvalRequestEntry, approvalDecisionEntry] = await Promise.all([
        munin.read(taskNs, "approval-request"),
        munin.read(taskNs, "approval-decision"),
      ]);
      const approvalRequest = approvalRequestEntry
        ? parsePhaseApprovalRequest(approvalRequestEntry.content)
        : null;
      const approvalDecision = approvalDecisionEntry
        ? parsePhaseApprovalDecision(approvalDecisionEntry.content)
        : null;
      approvalMetadata = {
        status: approvalDecision?.decision || "pending",
        requestedAt: approvalRequest?.requestedAt,
        decidedAt: approvalDecision?.decidedAt,
        decisionSource: approvalDecision?.source,
        operationKey:
          approvalRequest?.operationKey ||
          buildPhaseOperationKey(task.pipeline.pipelineId, taskId),
      };
    }
    if (task.pipeline?.pipelineId) {
      await refreshPipelineSummary(task.pipeline.pipelineId);
    }
    startCancellationWatch();

    const isOllama = task.runtime === "ollama";
    const isClaude = task.runtime === "claude";
    const executorLabel = isOllama ? "ollama" : isClaude ? "agent-sdk" : "spawn";

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
    const contextResolution = task.contextResolution || null;

    if (!host) {
      // No host available — check fallback
      const reason = `No ollama host available for model "${ollamaModel}"`;
      console.warn(`${reason} — task ${taskNs}`);

      if (
        task.fallback === "claude" &&
        compareSensitivity(task.effectiveSensitivity || "internal", "internal") <= 0
      ) {
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
            muninSessionId: munin.getSessionId(),
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
          reasoning: task.reasoning,
        },
        taskId,
        LOG_DIR,
        { abortController: ollamaAbort }
      );

      // Check for infra-level failure that should trigger fallback
      const isInfraFailure = ollamaResult.exitCode === 1 &&
        ollamaResult.output.match(/\[Ollama (HTTP|error:)/);

      if (
        isInfraFailure &&
        task.fallback === "claude" &&
        compareSensitivity(task.effectiveSensitivity || "internal", "internal") <= 0
      ) {
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
            muninSessionId: munin.getSessionId(),
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
        context_refs_quarantined: contextResolution?.refsQuarantined || [],
        context_chars_total: contextResolution?.totalChars || 0,
        context_truncated: contextResolution?.truncated || false,
        injection_policy: contextResolution?.injectionPolicy || "off",
        injection_max_severity: contextResolution?.maxInjectionSeverity || "none",
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
        context_refs_quarantined: contextResolution?.refsQuarantined || [],
        context_chars_total: contextResolution?.totalChars || 0,
        context_truncated: contextResolution?.truncated || false,
        injection_policy: contextResolution?.injectionPolicy || "off",
        injection_max_severity: contextResolution?.maxInjectionSeverity || "none",
      };
    }
    currentOllamaAbort = null;
    } else if (isClaude) {
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
        muninSessionId: munin.getSessionId(),
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
            ].join("\n"), undefined, undefined, taskClassification);
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

    // Post-task: finalize branch — auto-commit leftovers, push, open PR (#47)
    let prUrl: string | undefined;
    if (ok && !isCancelled && branchResult.action === "created" && branchResult.branchName) {
      const prBody = [
        `Automated changes from Hugin task \`${taskId}\`.`,
        "",
        `- **Runtime:** ${task.runtime}`,
        `- **Executor:** ${effectiveExecutor}`,
        "",
        "---",
        "*Created automatically by [Hugin](https://github.com/Magnus-Gille/hugin).*",
      ].join("\n");
      const finalizeResult = await finalizeTaskBranch(
        task.workingDir,
        branchResult.branchName,
        prBody,
        egressPolicy.allowedHosts,
      );
      if (finalizeResult.action === "pr-created" && finalizeResult.prUrl) {
        prUrl = finalizeResult.prUrl;
        await munin.log(taskNs, `PR created: ${prUrl}`);
      } else if (finalizeResult.action === "push-failed") {
        console.warn(`Post-task branch finalization failed for ${taskNs}: ${finalizeResult.error}`);
      }
    }

    console.log(
      `Task ${taskNs} ${isCancelled ? "cancelled" : ok ? "completed" : isTimeout ? "timed out" : "failed"} (exit: ${isCancelled ? "CANCELLED" : exitCode}, executor: ${executorLabel}, duration: ${Math.round(durationMs / 1000)}s)`
    );

    // For SDK/ollama executor, use resultText directly
    // For spawn executor, check for hook result, then fall back to stdout
    let resultBody: string;
    let resultSource: string;

    if ((isClaude || isOllama) && resultText) {
      resultSource = effectiveExecutor;
      resultBody = `### Response\n\n${resultText}`;
    } else if (!isClaude && !isOllama) {
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
    if (!(isTimeout && isClaude)) {
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
          prUrl,
          replyTo: task.replyTo,
          replyFormat: task.replyFormat,
          group: task.group,
          sequence: task.sequence,
          body: resultBody,
          autoRouted: task.autoRouted,
          routingReason: task.routingDecision?.reason,
        }),
        undefined,
        undefined,
        taskClassification,
      );
    }

    const structuredBodyKind: TaskExecutionBodyKind =
      resultSource === "stdout" ? "output" : "response";
    const structuredBodyText =
      resultSource === "stdout"
        ? output || "(no output)"
        : resultText || output || "(no output)";
    const baseRuntimeMetadata: TaskExecutionRuntimeMetadata | undefined =
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

    const runtimeMetadata: TaskExecutionRuntimeMetadata | undefined =
      task.autoRouted && task.routingDecision
        ? {
            ...baseRuntimeMetadata,
            autoRouted: true,
            routingReason: task.routingDecision.reason,
            eliminatedRuntimes: task.routingDecision.eliminated,
          }
        : baseRuntimeMetadata;

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
        }),
        undefined,
        undefined,
        taskClassification,
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
          approval: approvalMetadata,
          bodyKind: structuredBodyKind,
          bodyText: structuredBodyText,
          sensitivity: taskSensitivitySnapshot,
        }),
        taskClassification,
      );
      await munin.write(
        taskNs,
        "status",
        entry.content,
        buildTerminalStatusTags("cancelled", entry.tags, `runtime:${task.runtime}`),
        undefined,
        taskClassification,
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
          prUrl,
          bodyKind: structuredBodyKind,
          bodyText: structuredBodyText,
          errorMessage: ok ? undefined : structuredBodyText,
          runtimeMetadata,
          pipeline: task.pipeline,
          approval: approvalMetadata,
          sensitivity: taskSensitivitySnapshot,
        }),
        taskClassification,
      );

      await munin.write(
        taskNs,
        "status",
        entry.content,
        buildTerminalStatusTags(ok ? "completed" : "failed", entry.tags, `runtime:${task.runtime}`)
        ,
        undefined,
        taskClassification
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
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (isCancelled && cancellation?.pipelineId === task.pipeline.pipelineId) {
            const pipelineEntry = await munin.read(
              `tasks/${task.pipeline.pipelineId}`,
              "status"
            );
            if (pipelineEntry?.tags.includes(CANCEL_REQUESTED_TAG)) {
              await processPipelineCancellationRequest(pipelineEntry);
            } else {
              await refreshPipelineSummary(task.pipeline.pipelineId);
            }
          } else {
            await refreshPipelineSummary(task.pipeline.pipelineId);
          }
          break;
        } catch (err) {
          const finalAttempt = attempt === 2;
          console.error(
            `Post-task pipeline update failed for ${task.pipeline.pipelineId} (attempt ${attempt + 1}/3):`,
            err
          );
          if (finalAttempt) {
            break;
          }
          await sleepMs(1000 * (attempt + 1));
        }
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
  } finally {
    stopLeaseRenewal();
    stopCancellationWatch();
    currentSdkAbort = null;
    currentOllamaAbort = null;
    currentCancellation = null;
    currentTask = null;
    currentTaskConfig = null;
    // Rotate session off the task scope so subsequent poll/heartbeat writes
    // don't pollute the task's session window.
    munin.setSessionId(randomUUID());
  }
}

async function pollLoop(): Promise<void> {
  console.log(
    `Hugin dispatcher started (poll interval: ${config.pollIntervalMs}ms)`
  );

  // Kill orphan Hugin processes from previous runs (e.g. spawned by tasks in this repo)
  await killOrphanDispatchers();

  // Recover any tasks left running from a previous crash
  await recoverStaleTasks();
  await reconcileBlockedTasks();
  await primeTrackedPipelineSummaries();
  await reconcileTrackedPipelineSummaries();

  // Clean up old log files
  await rotateOldLogs();

  // Pre-warm ollama default model to avoid cold-start latency on first task (fire-and-forget)
  warmModel(config.ollamaDefaultModel).catch(() => {});

  let pollCount = 0;
  while (!shuttingDown) {
    let queueDepth = 0;
    try {
      pollCount++;
      await reconcileTrackedPipelineSummaries();
      // Reap tasks whose lease expired mid-run (e.g. worker crashed after
      // claiming). Runs every 5 polls (~2.5 min at default 30s interval) —
      // cheap but not free, and lease window is 2 minutes so faster cadence
      // buys little.
      if (pollCount % 5 === 0) {
        await reapExpiredLeases();
      }
      const processedCancellation = await processCancellationRequests();
      const processedResume = await processResumeRequests();
      const processedApproval = await processApprovalDecisions();
      const poll = await pollOnce();
      queueDepth = poll.queueDepth;
      lastQueueDepth = queueDepth;
      if (pollCount % 5 === 0) {
        await reconcileBlockedTasks();
      }
      lastBlockedTaskCount = await countTasksWithLifecycle("blocked");
      // Fire-and-forget heartbeat
      emitHeartbeat(queueDepth, lastBlockedTaskCount);
      if ((processedCancellation || processedResume || processedApproval || poll.hadTask) && !shuttingDown) continue; // Check for more immediately
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
    egress_policy: {
      enabled: egressPolicy.enabled,
      allowed_hosts: egressPolicy.allowedHosts,
    },
  });
});

// --- Graceful shutdown ---

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  console.log(`Received ${signal}, shutting down (worker: ${workerId})...`);
  shuttingDown = true;

  // Hard deadline: force exit after 30s regardless of cleanup state.
  // Unref'd so it doesn't keep the process alive if everything exits cleanly first.
  const exitTimer = setTimeout(() => {
    console.error("Shutdown timed out after 30s — forcing exit");
    process.exit(1);
  }, 30_000);
  exitTimer.unref();

  // Release the port immediately so a replacement instance can start.
  server?.close();

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

  if (currentChild && !currentChild.killed) {
    console.log("Forwarding signal to running task...");
    currentChild.kill("SIGTERM");
    // Wait for child to exit before we do, so it is not orphaned.
    // SIGKILL after 10s if it ignores SIGTERM; the outer 30s hard timer handles total deadline.
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        if (currentChild && !currentChild.killed) {
          console.log("Force killing child process");
          currentChild.kill("SIGKILL");
        }
        resolve();
      }, 10_000);
      currentChild!.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }

  process.exit(0);
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

server = app.listen(config.port, config.host, () => {
  console.log(`Hugin health endpoint: http://${config.host}:${config.port}/health`);
  console.log(`Munin: ${config.muninUrl}`);
  console.log(`Workspace: ${config.workspace}`);
  console.log("Claude executor: agent-sdk");
  console.log(`Allowed submitters: ${config.allowedSubmitters.includes("*") ? "* (all)" : config.allowedSubmitters.join(", ")}`);
  console.log(`Egress policy: allowlist (${egressPolicy.allowedHosts.join(", ")})`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${config.port} already in use — another Hugin instance is running. Exiting.`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
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
