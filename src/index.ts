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
import { getFoundBatchEntry, extractTaskId, pickEarliestTask, selectNextTask, checkoutTaskBranch, finalizeTaskBranch, shouldReapExpiredLease, decideStartupRecovery, decideDeliveryRetry, finalizeTaskCompletion } from "./task-helpers.js";
import { executeSdkTask } from "./sdk-executor.js";
import { executeOllamaTask } from "./ollama-executor.js";
import { configureHosts, resolveOllamaHost, getHostStatus, probeAllHosts, warmModel, getLoadedModels } from "./ollama-hosts.js";
import { resolveContextRefs } from "./context-loader.js";
import { parseExternalPolicy, type ExternalPolicy } from "./provenance.js";
import {
  scanForExfiltration,
  redactExfiltration,
  type ExfilScanResult,
} from "./exfiltration-scanner.js";
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
  parseArtifactManifest,
  deliverArtifacts,
  parseDeliveryPolicy,
  loadDeliveryTargets,
  renderArtifactDeliverySection,
  type ArtifactManifest,
  type DeliveryResult,
} from "./artifact-delivery.js";
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
  isLegacyDispatcherRuntime,
  type RuntimeCapability,
} from "./runtime-registry.js";
import {
  extractSignatureField,
  loadKeyStoreFromEnv,
  parseSigningPolicy,
  verifyTaskSignature,
  type KeyStore,
  type SigningPolicy,
  type VerificationResult,
} from "./task-signing.js";
import { readBrokerEnv, startBroker, type RunningBroker } from "./broker/server.js";
import { BrokerTaskStore } from "./broker/task-store.js";
import { DelegationJournal } from "./broker/journal.js";
import { IdempotencyIndex } from "./broker/idempotency.js";
import { BrokerReconciler } from "./broker/reconciliation.js";
import { OrchWorker } from "./broker/orch-worker.js";
import { OpenRouterClient } from "./openrouter-client.js";

export type ExfilPolicy = "off" | "warn" | "flag" | "redact";

function parseExfilPolicy(raw: string | undefined): ExfilPolicy {
  const v = raw?.trim().toLowerCase();
  if (v === "off" || v === "warn" || v === "flag" || v === "redact") return v;
  if (v && v.length > 0) {
    throw new Error(
      `Invalid HUGIN_EXFIL_POLICY=${raw}; expected off | warn | flag | redact`,
    );
  }
  return "warn";
}

interface ExfilPolicyOutcome {
  scan: ExfilScanResult;
  redactedBody: string;
  redactedStructured: string;
  resultTags?: string[];
  securitySection?: string;
}

function applyExfilPolicy(
  taskNs: string,
  resultBody: string,
  structuredBody: string,
  policy: ExfilPolicy,
): ExfilPolicyOutcome {
  if (policy === "off") {
    return {
      scan: { severity: "none", matches: [] },
      redactedBody: resultBody,
      redactedStructured: structuredBody,
    };
  }

  const scan = scanForExfiltration(structuredBody);
  if (scan.severity === "none") {
    return {
      scan,
      redactedBody: resultBody,
      redactedStructured: structuredBody,
    };
  }

  const patterns = scan.matches.map((m) => m.pattern);
  const uniquePatterns = [...new Set(patterns)];
  console.warn(
    `[exfil] task=${taskNs} severity=${scan.severity} policy=${policy} patterns=[${uniquePatterns.join(", ")}] count=${scan.matches.length}`,
  );

  let redactedBody = resultBody;
  let redactedStructured = structuredBody;
  if (policy === "redact") {
    redactedStructured = redactExfiltration(structuredBody, scan);
    const bodyScan = scanForExfiltration(resultBody);
    redactedBody = redactExfiltration(resultBody, bodyScan);
  }

  const section = [
    "",
    "### Security Scan",
    "",
    `- **Exfiltration severity:** ${scan.severity}`,
    `- **Patterns:** ${uniquePatterns.join(", ")}`,
    `- **Matches:** ${scan.matches.length}`,
    `- **Policy applied:** ${policy}`,
  ].join("\n");

  const resultTags =
    policy === "flag" || policy === "redact"
      ? ["security:exfil-suspected", `security:exfil-${scan.severity}`]
      : undefined;

  return {
    scan,
    redactedBody,
    redactedStructured,
    resultTags,
    securitySection: section,
  };
}

const HUGIN_HOME = path.join(process.env.HOME || "/home/magnus", ".hugin");
const LOG_DIR = path.join(HUGIN_HOME, "logs");
const HOOK_RESULT_DIR = path.join(HUGIN_HOME, "hook-results");
const CANCEL_REQUESTED_TAG = "cancel-requested";
const RESUME_REQUESTED_TAG = "resume-requested";
const CANCEL_WATCH_INTERVAL_MS = 2000;

// --- Configuration ---

// Parse a positive-integer env var, falling back to a safe default on a
// missing / non-finite / non-positive value. Used for the #72 retry-budget and
// interval settings so a malformed env var (e.g. `NaN`) cannot produce an
// immortal task or a tight-loop `setInterval` (review MED).
function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  const n = parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

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
  signingPolicy: parseSigningPolicy(process.env.HUGIN_SIGNING_POLICY) as SigningPolicy,
  submitterKeys: loadKeyStoreFromEnv() as KeyStore,
  exfilPolicy: parseExfilPolicy(process.env.HUGIN_EXFIL_POLICY),
  externalPolicy: parseExternalPolicy(process.env.HUGIN_EXTERNAL_POLICY),
  brokerReconciliationIntervalMs: parseInt(
    process.env.HUGIN_BROKER_RECONCILIATION_INTERVAL_MS || "60000",
  ),
  // Runtime-owned artefact delivery (issue #68). `parseDeliveryPolicy` and
  // `loadDeliveryTargets` throw on malformed input — fail fast at startup
  // rather than silently mis-deliver.
  deliveryPolicy: parseDeliveryPolicy(process.env.HUGIN_DELIVERY_POLICY),
  deliveryTargets: loadDeliveryTargets(process.env.HUGIN_DELIVERY_TARGETS),
  // Deferred-delivery retry budget (issue #72, only consulted under `defer`).
  // parsePositiveIntEnv falls back to the default on a malformed value so a bad
  // env var can't disable the budget (immortal task) or tight-loop the reaper.
  deliveryRetryMaxAttempts: parsePositiveIntEnv(
    process.env.HUGIN_DELIVERY_RETRY_MAX_ATTEMPTS,
    10,
  ),
  deliveryRetryMaxAgeMs: parsePositiveIntEnv(
    process.env.HUGIN_DELIVERY_RETRY_MAX_AGE_MS,
    86_400_000, // 24h
  ),
  deliveryRetryIntervalMs: parsePositiveIntEnv(
    process.env.HUGIN_DELIVERY_RETRY_INTERVAL_MS,
    300_000, // 5min
  ),
};

const brokerEnv = readBrokerEnv(process.env);

if (config.signingPolicy !== "off") {
  const keyIds = Object.keys(config.submitterKeys);
  console.log(
    `[signing] policy=${config.signingPolicy} keys=${keyIds.length ? keyIds.join(",") : "(none configured)"}`,
  );
  if (config.signingPolicy === "require" && keyIds.length === 0) {
    console.error(
      "HUGIN_SIGNING_POLICY=require but no keys configured (set HUGIN_SUBMITTER_KEYS or HUGIN_SUBMITTER_KEYS_FILE). All tasks will be rejected.",
    );
  }
}

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

// Positive, non-zero exit code for dispatcher-side failure paths (recovery,
// reaper, shutdown, security rejection, generic failures). Ratatoskr decides
// success by matching `/\*\*Exit code:\*\*\s*(\d+)/` and treats a NON-match as
// success — a negative code (`-1`) fails `(\d+)`, so it was mis-rendered as a
// successful task (issue #73). Any non-zero positive integer reads as failure.
const DISPATCHER_FAILURE_EXIT_CODE = 1;

const LEASE_DURATION_MS = 120_000; // 2 minutes — renewed during execution
const LEASE_RENEWAL_INTERVAL_MS = 60_000; // renew every 60s
const LEASE_REAPER_INTERVAL_MS = 60_000; // scan for expired foreign leases every 60s

// Worker identity is HOST-based, NOT PID-based (issue #77). A PID-derived id
// meant that after a `kill -9` + systemd `Restart=always`, the new process got a
// new id, so `recoverStaleTasks`/the reaper saw the dead incarnation's tasks as
// "not ours" and — while the dead worker's lease was still live — refused to
// recover them, stranding a `delivery:pending` checkpoint non-terminal until a
// second, post-lease-expiry restart. systemd runs exactly one Hugin per host, so
// a host-stable id lets a restarted process re-adopt and reconcile its own
// in-flight tasks immediately. The PID is retained separately for observability.
const workerId = `hugin-${os.hostname()}`;
const processInstanceId = `${workerId}-${process.pid}`;

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
// Runtime-owned artefact delivery (issue #68). Aborted by operator cancel /
// shutdown so a hung `ssh`/`rsync` cannot wedge the single dispatcher slot.
let currentDeliveryAbort: AbortController | null = null;
// Separate abort slot for RECONCILE-path deliveries (`reconcileDeliveryPending`,
// driven by startup recovery and the lease reaper). The reaper runs on its own
// timer concurrently with the poll loop, so its reconcile must NOT share
// `currentDeliveryAbort` with the live in-process delivery — clobbering that
// shared slot would leave the live delivery un-abortable by operator cancel /
// shutdown (review F1, #77). At most one reconcile runs at a time (startup
// completes before the reaper timer arms; the reaper processes tasks serially
// under `leaseReaperInFlight`), so a single slot is sufficient. Shutdown aborts
// both slots; operator cancel targets only the live delivery (a reconcile is
// always for a non-current, dead-owner task).
let currentReconcileAbort: AbortController | null = null;
let server: Server;
let runningBroker: RunningBroker | null = null;
let brokerReconciler: BrokerReconciler | null = null;
let orchWorker: OrchWorker | null = null;
let leaseRenewalTimer: ReturnType<typeof setInterval> | null = null;
let cancelWatchTimer: ReturnType<typeof setInterval> | null = null;
let leaseReaperTimer: ReturnType<typeof setInterval> | null = null;
let leaseReaperInFlight = false;
// Deferred-delivery retry reaper (#72), armed only under `HUGIN_DELIVERY_POLICY=defer`.
let deliveryRetryReaperTimer: ReturnType<typeof setInterval> | null = null;
let deliveryRetryReaperInFlight = false;
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
// Keep lease renewal, active-task cancellation polling, and the independent
// lease reaper off the main request slot so a long Retry-After on background
// work cannot delay them past expiry — and so reaper traffic does not queue up
// behind task-completion writes or contaminate the task-scoped session window.
const leaseMunin = createMuninClient();
const cancelWatchMunin = createMuninClient();
const reaperMunin = createMuninClient();

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
  // Runtime-owned artefact delivery (issue #68). Runtime-only — deliberately
  // NOT in SdkTaskConfig: the manifest must never reach the agent prompt.
  artifactManifest?: ArtifactManifest;
  artifactManifestError?: string;
  // "### Artifacts after ### Prompt" grammar violation — rejected even when
  // HUGIN_DELIVERY_POLICY=off (the manifest would otherwise leak into the
  // agent prompt; Codex review #5).
  artifactManifestGrammarViolation?: boolean;
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

  // Runtime-owned artefact delivery manifest (issue #68). Parsed unconditionally
  // so submit-time validation can reject a malformed/placeholder-leaking
  // manifest BEFORE the paid spike; acted on only when policy != off.
  const artifactManifestResult = parseArtifactManifest(
    content,
    config.deliveryTargets,
  );

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
    artifactManifest: artifactManifestResult.manifest ?? undefined,
    artifactManifestError: artifactManifestResult.error ?? undefined,
    artifactManifestGrammarViolation:
      artifactManifestResult.grammarViolation || undefined,
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
      { externalPolicy: config.externalPolicy },
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

interface SigningVerdict {
  result: VerificationResult;
  reject: boolean;
  message: string;
}

function verifyTaskEntrySignature(
  taskNs: string,
  content: string,
  parsedTask: TaskConfig | null,
  submittedBy: string,
): SigningVerdict {
  const policy = config.signingPolicy;
  const signatureRaw = extractSignatureField(content);

  if (policy === "off") {
    return {
      result: signatureRaw ? { status: "valid" } : { status: "missing" },
      reject: false,
      message: "",
    };
  }

  // Internally-generated tasks (pipeline phase children, summary tasks,
  // etc.) are submitted by Hugin itself. They never carry a signature
  // because there is no external signer — the dispatcher trusts its own
  // writes. Exempt them so `require` doesn't brick pipeline execution.
  // When pipeline-aware signing ships (see docs/security/task-signing.md),
  // this exemption becomes a proper internal signing path.
  if (submittedBy === "hugin") {
    return { result: { status: "valid" }, reject: false, message: "" };
  }

  // Pipeline parent tasks don't produce a TaskConfig here — the HMAC
  // scheme binds prompt/context-refs, which pipelines express differently
  // (### Pipeline instead of ### Prompt). Until pipeline signing lands we
  // cannot accept these under `require`; `warn` passes through.
  if (!parsedTask) {
    if (policy === "require") {
      return {
        result: { status: "missing" },
        reject: true,
        message:
          "Task rejected by HUGIN_SIGNING_POLICY=require: pipeline tasks cannot be verified by the v1 scheme",
      };
    }
    return { result: { status: "missing" }, reject: false, message: "" };
  }

  // Use the runtime *as declared in the task body*, not the resolved
  // execution runtime. Auto-routed tasks sign with `runtime=auto`; the
  // dispatcher later overwrites parsedTask.runtime with the router's
  // pick, so reading it here would break verification.
  const declaredRuntime = parseDeclaredRuntime(content) ?? parsedTask.runtime;

  const params = {
    taskId: extractTaskId(taskNs),
    submitter: submittedBy,
    submittedAt: parsedTask.submittedAt,
    runtime: declaredRuntime,
    prompt: parsedTask.prompt,
    contextRefs: parsedTask.contextRefs,
  };

  const result = verifyTaskSignature(params, signatureRaw, config.submitterKeys);

  if (result.status === "valid") {
    console.log(`[signing] task ${taskNs} signature valid (keyId=${result.keyId})`);
    return { result, reject: false, message: "" };
  }

  const descriptor =
    result.status === "missing"
      ? "missing Signature field"
      : `${result.status}${result.reason ? ` (${result.reason})` : ""}`;

  if (policy === "warn") {
    console.warn(`[signing] task ${taskNs} ${descriptor} — policy=warn, proceeding`);
    return { result, reject: false, message: "" };
  }

  // policy === "require"
  return {
    result,
    reject: true,
    message: `Task rejected by HUGIN_SIGNING_POLICY=require: ${descriptor}`,
  };
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

function getExternalProvenanceViolationForTask(task: TaskConfig): string | null {
  const resolution = task.contextResolution;
  if (!resolution || !resolution.externalBlocked) return null;
  const flagged = resolution.refs.find(
    (ref) => ref.provenance === "external" && ref.quarantined,
  );
  if (!flagged) return null;
  const reason = flagged.provenanceReason || "source:external";
  return (
    `Task rejected by HUGIN_EXTERNAL_POLICY=fail: context-ref "${flagged.ref}" ` +
    `is externally sourced (${reason})`
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
  client: MuninClient = munin,
): Promise<void> {
  await client.write(
    taskNs,
    "result-structured",
    JSON.stringify(buildStructuredTaskResult(result), null, 2),
    ["type:task-result", "type:task-result-structured"],
    undefined,
    classification,
  );
}

async function refreshPipelineSummary(
  pipelineId: string,
  client: MuninClient = munin,
): Promise<void> {
  await pipelineSummaryManager.refresh(client, pipelineId, console);
}

async function refreshPipelineSummaryFromContent(
  content: string,
  client: MuninClient = munin,
): Promise<void> {
  await pipelineSummaryManager.refreshFromContent(client, content, console);
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
    exitCode: options.exitCode || DISPATCHER_FAILURE_EXIT_CODE,
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
    `- **Exit code:** ${DISPATCHER_FAILURE_EXIT_CODE}`,
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
  // `delivery:*` must survive lease renewal so the nonterminal
  // `running + delivery:pending` checkpoint is not silently dropped when the
  // lease renews mid-delivery (issue #68, debate R2 §A).
  const deliveryTags = baseTags.filter((t) => t.startsWith("delivery:"));
  return [
    lifecycle,
    ...(runtimeTag ? [runtimeTag] : []),
    ...typeTags,
    ...authorityTags,
    ...sensitivityTags,
    ...routingTags,
    ...deliveryTags,
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
  if (currentDeliveryAbort && !currentDeliveryAbort.signal.aborted) {
    currentDeliveryAbort.abort(request.reason);
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

// Deferred-delivery retry metadata (issue #72, `HUGIN_DELIVERY_POLICY=defer`).
// Stored in a dedicated `delivery-retry` Munin key — NOT in status tags — so it
// is decoupled from the lease/claim tag machinery (`buildClaimTags` only
// preserves a fixed prefix set). `attempts` is the number of delivery attempts
// completed so far; `firstAttemptAt` is the deferral-clock origin for the
// max-age budget.
interface DeliveryRetryMeta {
  attempts: number;
  firstAttemptAt: string;
}

async function readDeliveryRetryMeta(
  taskNs: string,
  client: MuninClient,
): Promise<DeliveryRetryMeta | null> {
  try {
    const entry = await client.read(taskNs, "delivery-retry");
    if (!entry?.content) return null;
    const parsed = JSON.parse(entry.content) as Partial<DeliveryRetryMeta>;
    if (
      typeof parsed.attempts === "number" &&
      typeof parsed.firstAttemptAt === "string"
    ) {
      return { attempts: parsed.attempts, firstAttemptAt: parsed.firstAttemptAt };
    }
  } catch {
    /* missing / malformed → treat as no prior attempts */
  }
  return null;
}

async function writeDeliveryRetryMeta(
  taskNs: string,
  meta: DeliveryRetryMeta,
  client: MuninClient,
  classification?: string,
): Promise<void> {
  await client.write(
    taskNs,
    "delivery-retry",
    JSON.stringify(meta),
    undefined,
    undefined,
    classification,
  );
}

// Runtime-owned artefact delivery (issue #68 / #77): a `running +
// delivery:pending` checkpoint means the agent content is durably preserved in
// `result` but delivery did not finalize (crash/restart mid-delivery).
// Re-deliver ONCE under a single CAS reclaim and finalize terminally — no paid
// rerun. Invoked from two paths: startup recovery (`recoverStaleTasks`, default
// `munin` client) and the lease reaper (`reapExpiredLeases`, passing
// `reaperMunin` so its writes carry the reaper's own session id). The CAS
// reclaim makes the two paths mutually safe — whichever reaches the task first
// wins; the loser's CAS write fails and it bails out without double-delivering.
async function reconcileDeliveryPending(
  taskNs: string,
  entry: MuninEntry,
  client: MuninClient = munin,
): Promise<void> {
  const task = parseTask(entry.content);
  const classification = getTaskArtifactClassification(
    task || undefined,
    entry.content,
  );
  const runtimeTag = entry.tags.find((t) => t.startsWith("runtime:"));
  const runtime = (runtimeTag || "runtime:claude").replace(
    /^runtime:/,
    "",
  ) as DispatcherRuntime;

  // Single CAS ownership: reclaim with a fresh lease, keep delivery:pending.
  const reclaimTags = buildClaimTags(
    [...entry.tags.filter((t) => !t.startsWith("delivery:")), "delivery:pending"],
    "running",
  );
  try {
    const r = await client.write(
      taskNs,
      "status",
      entry.content,
      reclaimTags,
      entry.updated_at,
    );
    if (typeof r.updated_at === "string") entry.updated_at = r.updated_at;
  } catch {
    console.log(
      `Skipping delivery reconciliation for ${taskNs} (lost CAS race)`,
    );
    return;
  }

  const resultEntry = await client.read(taskNs, "result");
  let baseDoc = resultEntry?.content ?? "## Result\n\n- **Exit code:** 0\n";
  const dIdx = baseDoc.lastIndexOf("\n### Artifact Delivery");
  if (dIdx !== -1) baseDoc = baseDoc.slice(0, dIdx);

  let delivery: DeliveryResult;
  let ok = true;
  if (config.deliveryPolicy === "off" || !task?.artifactManifest) {
    // Cannot re-deliver (feature off or manifest gone at recovery). Terminalize
    // as a delivery failure WITHOUT a paid rerun — content stays preserved.
    ok = false;
    delivery = {
      ok: false,
      records: [],
      failureKind: "infra",
      error:
        "delivery checkpoint unrecoverable (policy off or manifest missing at recovery)",
    };
  } else {
    const logPath = path.join(LOG_DIR, `${extractTaskId(taskNs)}.log`);
    const abort = new AbortController();
    // Reconcile-path slot, NOT the live-delivery slot (review F1): a reaper-driven
    // reconcile must not clobber a concurrent live delivery's abort controller.
    currentReconcileAbort = abort;
    try {
      delivery = await deliverArtifacts({
        manifest: task.artifactManifest,
        // Symmetric with the active path (Codex review A): without
        // stagingPrefixes the realpath-containment guard is disabled, so a
        // recovered delivery could escape the staging root undetected.
        stagingPrefixes: config.deliveryTargets.map(
          (t) => t.localStagingPrefix,
        ),
        appendLog: (line) => {
          try {
            fs.appendFileSync(logPath, `${line}\n`);
          } catch {
            /* best-effort */
          }
        },
        signal: abort.signal,
      });
    } finally {
      currentReconcileAbort = null;
    }
    if (!delivery.ok) {
      // missing-local / unsafe-local (no trustworthy deliverable) are ALWAYS
      // terminal regardless of policy; infra is terminal under `require`.
      // Symmetric with the active path (Codex review B).
      const terminal =
        delivery.failureKind === "missing-local" ||
        delivery.failureKind === "unsafe-local" ||
        config.deliveryPolicy === "require";
      if (terminal) ok = false;
    }
  }

  // Deferred policy (#72): an INFRA failure with retry budget remaining leaves
  // the task `running + delivery:pending` (already reclaimed above) for the
  // delivery-retry reaper to re-attempt — instead of terminalizing. Only `infra`
  // reaches here non-terminal under `defer` (missing-local/unsafe-local set
  // `ok=false` in the block above regardless of policy, so they are never
  // deferrable). Budget exhaustion falls through to the terminal write below.
  if (
    config.deliveryPolicy === "defer" &&
    !delivery.ok &&
    delivery.failureKind === "infra" &&
    // Only a RECOVERABLE infra failure is deferrable. The "manifest gone at
    // recovery / policy off" synthetic failure above is also tagged `infra` but
    // can NEVER succeed (no manifest to re-deliver), so it must terminalize, not
    // burn the retry budget (review HIGH). A present manifest is the recoverable
    // signal — deliverArtifacts actually ran.
    !!task?.artifactManifest
  ) {
    const meta = await readDeliveryRetryMeta(taskNs, client);
    // Guard a corrupt/missing first-attempt timestamp so the max-age budget
    // still bounds the task instead of being silently disabled (review note 7).
    const parsedFirst = meta?.firstAttemptAt
      ? Date.parse(meta.firstAttemptAt)
      : NaN;
    const firstAttemptAtMs = Number.isNaN(parsedFirst) ? Date.now() : parsedFirst;
    const firstAttemptAt = new Date(firstAttemptAtMs).toISOString();
    const attempts = (meta?.attempts ?? 0) + 1;
    const decision = decideDeliveryRetry({
      attempts,
      firstAttemptAtMs,
      now: Date.now(),
      maxAttempts: config.deliveryRetryMaxAttempts,
      maxAgeMs: config.deliveryRetryMaxAgeMs,
    });
    if (decision.action === "retry") {
      await writeDeliveryRetryMeta(
        taskNs,
        { attempts, firstAttemptAt },
        client,
        classification,
      );
      // Keep the result informative but the task NON-terminal — status is
      // already `running + delivery:pending` from the reclaim above.
      await client.write(
        taskNs,
        "result",
        `${baseDoc}${renderArtifactDeliverySection(delivery)}\n- **Delivery:** deferred (attempt ${attempts}, infra failure) — will retry\n`,
        undefined,
        undefined,
        classification,
      );
      await client.log(
        taskNs,
        `Delivery deferred (attempt ${attempts}): ${delivery.error ?? "infra failure"} — will retry`,
      );
      return;
    }
    // Budget exhausted → terminalize as a delivery failure (Exit 2 below).
    ok = false;
    await client.log(taskNs, `Delivery retry budget exhausted: ${decision.reason}`);
  }

  if (!ok) {
    baseDoc = baseDoc.replace(
      /- \*\*Exit code:\*\* 0\b/,
      "- **Exit code:** 2\n- **Failure kind:** DELIVERY_FAILED",
    );
  }
  await client.write(
    taskNs,
    "result",
    `${baseDoc}${renderArtifactDeliverySection(delivery)}`,
    undefined,
    undefined,
    classification,
  );

  const terminalDeliveryTag = delivery.ok
    ? "delivery:verified"
    : "delivery:failed";
  await client.write(
    taskNs,
    "status",
    entry.content,
    buildTerminalStatusTags(
      ok ? "completed" : "failed",
      [
        ...entry.tags.filter((t) => !t.startsWith("delivery:")),
        terminalDeliveryTag,
      ],
      runtimeTag || `runtime:${runtime}`,
    ),
    entry.updated_at,
    classification,
  );
  if ((runtime as string) !== "pipeline") {
    await writeStructuredTaskResult(
      taskNs,
      buildStructuredTaskResult({
        schemaVersion: 1,
        taskId: extractTaskId(taskNs),
        taskNamespace: taskNs,
        lifecycle: ok ? "completed" : "failed",
        outcome: ok ? "completed" : "failed",
        runtime,
        executor: "dispatcher",
        resultSource: "delivery-reconciliation",
        exitCode: ok ? 0 : 2,
        completedAt: new Date().toISOString(),
        bodyKind: "response",
        bodyText: "",
        errorMessage: ok ? undefined : delivery.error ?? "delivery failed",
        artifactDelivery: {
          ok: delivery.ok,
          failureKind: delivery.failureKind,
          artifacts: delivery.records.map((r) => ({
            id: r.id,
            status: r.status,
            remote: r.remote,
            bytes: r.bytes,
            sha256: r.sha256,
            error: r.error,
          })),
        },
      }),
      classification,
      client,
    );
  }
  await client.log(
    taskNs,
    `Delivery reconciled: ${delivery.ok ? "verified" : "failed"}`,
  );
  await promoteDependents(extractTaskId(taskNs), client);
  await refreshPipelineSummaryFromContent(entry.content, client);
}

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

      const now = Date.now();

      // Decide whether to recover this task (issue #77: workerId is host-stable
      // so our own dead incarnation's tasks are recognised as "ours"):
      // - Our own tasks: always recover (we just restarted)
      // - Other worker's tasks: only if lease expired
      const decision = decideStartupRecovery({
        tags: entry.tags,
        workerId,
        now,
      });
      const { claimedBy, leaseExpires, isOurs } = decision;

      if (decision.action === "skip") {
        if (leaseExpires !== null) {
          console.log(
            `Skipping task ${result.namespace} — claimed by ${claimedBy}, lease expires in ${Math.round((leaseExpires - now) / 1000)}s`
          );
        }
        continue;
      }

      // Runtime-owned artefact delivery (issue #68): resume an interrupted
      // delivery instead of generic-failing it (which would discard the
      // deliverable and mis-render as success). MUST be gated on the same
      // single-owner test above (Codex review #1) — reconciling a task still
      // owned by a live worker would double-deliver. reconcileDeliveryPending
      // additionally CAS-reclaims, so even a gate race cannot duplicate rsync.
      if (decision.action === "reconcile-delivery") {
        console.log(
          `Reconciling delivery:pending task ${result.namespace} on startup`,
        );
        await reconcileDeliveryPending(result.namespace, entry);
        continue;
      }

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
        `## Result\n\n- **Exit code:** ${DISPATCHER_FAILURE_EXIT_CODE}\n- **Error:** Task recovered (${reason}, worker: ${claimedBy || "unknown"}, elapsed: ${elapsed}s)\n`
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

// --- Lease reaping ---
// `recoverStaleTasks` only runs at startup. While the dispatcher is alive,
// a crashed runtime or OOM kill can leave a task stuck with the `running` tag
// past its lease. This reaper runs on its own 60s timer (see `startLeaseReaper`)
// so it is not gated on `pollOnce` finishing the current task, and routes its
// query + CAS writes through a dedicated `reaperMunin` client so they do not
// queue behind task-completion writes on the main client. Fail-fast: no
// auto-retry to pending.

async function reapExpiredLeases(): Promise<void> {
  try {
    const { results } = await reaperMunin.query({
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

      const entry = await reaperMunin.read(result.namespace, "status");
      if (!entry) continue;

      // Re-check with authoritative tags (lease may have just been renewed).
      const decision = shouldReapExpiredLease({
        tags: entry.tags,
        namespace: result.namespace,
        currentTask,
        now: Date.now(),
      });
      if (!decision.reap) continue;

      // Runtime-owned artefact delivery (issue #68 / #77): a delivery:pending
      // checkpoint must NEVER be generic-reaped to terminal `failed` — the agent
      // content is preserved there and a generic reap would discard the
      // deliverable. Previously the reaper deferred to startup reconciliation,
      // but a PID-stable workerId could deadlock that path (#77): startup
      // recovery skipped a live-leased foreign task while the reaper skipped
      // delivery:pending, so an orphaned checkpoint never reached a terminal
      // state. We reach this branch only after `decision.reap` (lease expired,
      // not the currently-executing task) — the owning worker is provably dead —
      // so the reaper reconciles the delivery itself (re-delivers without a paid
      // rerun, CAS-reclaiming first so it cannot double-deliver against a
      // concurrent startup scan). This is defence in depth alongside the now
      // host-stable workerId, which lets startup recovery handle the common
      // crash+restart case directly.
      if (entry.tags.includes("delivery:pending")) {
        // Under `defer` (#72) the dedicated delivery-retry reaper owns
        // delivery:pending at the configured cadence — leave it alone here so a
        // lease-expiry tick doesn't race the retry reaper (both would be CAS-safe,
        // but the retry reaper is the single, predictable driver under defer).
        if (config.deliveryPolicy === "defer") {
          console.log(
            `Skipping reap of ${result.namespace} — delivery:pending under defer (delivery-retry reaper owns it)`,
          );
          continue;
        }
        console.log(
          `Reconciling delivery:pending task ${result.namespace} via lease reaper (lease expired)`,
        );
        await reconcileDeliveryPending(result.namespace, entry, reaperMunin);
        continue;
      }

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
        await reaperMunin.write(
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

      await reaperMunin.write(
        result.namespace,
        "result",
        `## Result\n\n- **Exit code:** ${DISPATCHER_FAILURE_EXIT_CODE}\n- **Error:** ${errorMessage}\n`,
        undefined,
        undefined,
        classification,
      );
      // Route all reaper follow-up work (structured result, dependent promotion,
      // pipeline summary refresh) through `reaperMunin` as well so every write
      // the reaper emits carries the reaper's own mcp-session-id. Using the
      // shared `munin` client here would attribute these writes to the active
      // task's task-scoped session (rotated at claim time in `executeTask`),
      // polluting the outcome-aware session telemetry from #48.
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
          reaperMunin,
        );
      }
      await reaperMunin.log(result.namespace, `Lease reaped: ${errorMessage}`);
      await promoteDependents(extractTaskId(result.namespace), reaperMunin);
      await refreshPipelineSummaryFromContent(entry.content, reaperMunin);
    }
  } catch (err) {
    console.error("Failed to reap expired leases:", err);
  }
}

// Independent reaper timer so expired foreign leases get cleaned up even when
// `pollOnce` is blocked on a long-running current task. The reaper only acts on
// tasks it doesn't own (or whose lease has expired), so running concurrently
// with the dispatcher's current task is safe.
function startLeaseReaper(): void {
  stopLeaseReaper();
  leaseReaperTimer = setInterval(() => {
    if (leaseReaperInFlight || shuttingDown) return;
    leaseReaperInFlight = true;
    void reapExpiredLeases().finally(() => {
      leaseReaperInFlight = false;
    });
  }, LEASE_REAPER_INTERVAL_MS);
}

function stopLeaseReaper(): void {
  if (leaseReaperTimer) {
    clearInterval(leaseReaperTimer);
    leaseReaperTimer = null;
  }
}

// --- Deferred-delivery retry reaper (issue #72) ---
// Under `HUGIN_DELIVERY_POLICY=defer`, an infra delivery failure leaves the task
// `running + delivery:pending` instead of terminalizing. This periodic reaper
// re-attempts those deliveries on its own configurable cadence
// (`HUGIN_DELIVERY_RETRY_INTERVAL_MS`), independent of lease expiry.
// `reconcileDeliveryPending` is the single attempt-and-finalize primitive: under
// defer it CAS-reclaims, re-runs `deliverArtifacts` (skipping already-verified
// artefacts is idempotent at the rsync+sha layer), and either re-defers (budget
// remaining) or terminalizes (budget exhausted, → failed + Exit 2). The
// `currentTask` guard skips the live in-process delivery; the CAS reclaim makes
// it safe against any concurrent reconcile.
async function reapDeferredDeliveries(): Promise<void> {
  if (config.deliveryPolicy !== "defer") return;
  try {
    const { results } = await reaperMunin.query({
      query: "task",
      tags: ["running", "delivery:pending"],
      namespace: "tasks/",
      entry_type: "state",
      limit: 20,
    });
    for (const result of results) {
      if (!result.key || result.key !== "status") continue;
      // Never touch the live in-process delivery (mirrors the lease reaper's
      // currentTask guard) — reconciliation is only for non-current checkpoints.
      if (result.namespace === currentTask) continue;
      const entry = await reaperMunin.read(result.namespace, "status");
      if (!entry || !entry.tags.includes("delivery:pending")) continue;
      if (result.namespace === currentTask) continue; // re-check after the read
      console.log(
        `Delivery-retry reaper re-attempting ${result.namespace} (defer)`,
      );
      await reconcileDeliveryPending(result.namespace, entry, reaperMunin);
    }
  } catch (err) {
    console.error("Failed to reap deferred deliveries:", err);
  }
}

function startDeliveryRetryReaper(): void {
  stopDeliveryRetryReaper();
  if (config.deliveryPolicy !== "defer") return;
  deliveryRetryReaperTimer = setInterval(() => {
    if (deliveryRetryReaperInFlight || shuttingDown) return;
    deliveryRetryReaperInFlight = true;
    void reapDeferredDeliveries().finally(() => {
      deliveryRetryReaperInFlight = false;
    });
  }, config.deliveryRetryIntervalMs);
}

function stopDeliveryRetryReaper(): void {
  if (deliveryRetryReaperTimer) {
    clearInterval(deliveryRetryReaperTimer);
    deliveryRetryReaperTimer = null;
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

async function readDependencyStates(
  dependencyIds: string[],
  client: MuninClient = munin,
): Promise<Record<string, DependencyState>> {
  const entries = await client.readBatch(
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
  errorMessage: string,
  client: MuninClient = munin,
): Promise<void> {
  const task = parseTask(entry.content);
  if (task && !task.sensitivityAssessment) {
    task.sensitivityAssessment = getTaskSensitivityAssessment(task);
    task.effectiveSensitivity = task.sensitivityAssessment.effective;
  }
  const classification = getTaskArtifactClassification(task || undefined, entry.content);
  await client.write(
    taskNs,
    "status",
    entry.content,
    buildTerminalStatusTags("failed", entry.tags),
    entry.updated_at,
    classification
  );
  await client.write(
    taskNs,
    "result",
    `## Result\n\n- **Exit code:** ${DISPATCHER_FAILURE_EXIT_CODE}\n- **Error:** ${errorMessage}\n`,
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
    client,
  );
  await client.log(taskNs, `Failed due to dependency state: ${errorMessage}`);
  await refreshPipelineSummaryFromContent(entry.content, client);
}

async function evaluateBlockedTaskState(
  taskNs: string,
  client: MuninClient = munin,
): Promise<"promoted" | "failed" | "waiting"> {
  const entry = await client.read(taskNs, "status");
  if (!entry || !entry.tags.includes("blocked")) return "waiting";

  const dependencyIds = getDependencyIds(entry.tags);
  const dependencyStates = await readDependencyStates(dependencyIds, client);
  const evaluation = evaluateBlockedTask(entry.tags, dependencyStates);

  if (evaluation.shouldFail) {
    const errorMessage = evaluation.failureReason || "Dependency failure";
    await failBlockedTask(taskNs, entry, errorMessage, client);
    console.log(`Blocked task ${taskNs} failed (${errorMessage})`);
    return "failed";
  }

  if (evaluation.shouldPromote) {
    const promotedTags = buildPromotedTags(entry.tags);
    await client.write(taskNs, "status", entry.content, promotedTags, entry.updated_at);
    const statusReason = evaluation.failedIds.length > 0
      ? `Promoted from blocked -> pending (all ${evaluation.dependencyIds.length} dependencies reached terminal state; continuing after failures)`
      : `Promoted from blocked -> pending (all ${evaluation.dependencyIds.length} dependencies met)`;
    await client.log(taskNs, statusReason);
    console.log(`Promoted ${taskNs} -> pending (deps checked: ${evaluation.dependencyIds.length})`);
    await refreshPipelineSummaryFromContent(entry.content, client);
    return "promoted";
  }

  return "waiting";
}

async function promoteDependents(
  completedTaskId: string,
  client: MuninClient = munin,
): Promise<void> {
  try {
    const { results, total } = await client.query({
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
        const outcome = await evaluateBlockedTaskState(result.namespace, client);
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
  // Apply exfil policy defensively: today's callers pass no body, but the
  // helper's signature accepts one, so route body/bodyText through the
  // scanner so a future caller cannot bypass redaction/tagging.
  const cancelExfil = applyExfilPolicy(
    taskNs,
    options.body ?? "",
    options.bodyText ?? "",
    config.exfilPolicy,
  );
  const effectiveBody = options.body
    ? cancelExfil.securitySection
      ? `${cancelExfil.redactedBody}\n${cancelExfil.securitySection}`
      : cancelExfil.redactedBody
    : options.body;
  const effectiveBodyText = options.bodyText ? cancelExfil.redactedStructured : options.bodyText;
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
  // CAS the terminal `status` first so a concurrent reaper or other terminal
  // transition cannot land between our `result`/`result-structured` writes and
  // our own CAS — which would leave `status=failed` with a cancelled result
  // payload. If the CAS loses, abort without writing the cancelled artifacts.
  try {
    await munin.write(
      taskNs,
      "status",
      entry.content,
      buildTerminalStatusTags("cancelled", entry.tags),
      entry.updated_at,
      classification
    );
  } catch (err) {
    console.log(
      `Cancel of ${taskNs} aborted (lost CAS race): ${(err as Error).message}`,
    );
    return;
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
      body: effectiveBody,
    }),
    cancelExfil.resultTags,
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
        bodyText: effectiveBodyText,
        sensitivity: buildTaskSensitivitySnapshot(task?.sensitivityAssessment),
      }),
      classification,
    );
  }

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
    `## Result\n\n- **Exit code:** ${DISPATCHER_FAILURE_EXIT_CODE}\n- **Error:** ${errorMessage}\n`,
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
      process_instance_id: processInstanceId,
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

  // Orchestrator v1 tasks (broker-submitted, tagged "orch-v1") are dispatched
  // by the Pi-side broker, not by the legacy in-process poller. Filter them
  // out so the dispatcher does not greedily claim a runtime:openrouter or
  // runtime:pi-harness task and fail it as "missing prompt or runtime".
  // See docs/orchestrator-v1-data-model.md §3 for the broker submit path.
  const dispatchableResults = results.filter(
    (r) => !r.tags.includes("orch-v1"),
  );

  // Select the next eligible task respecting Group/Sequence ordering (FIFO within eligible set)
  const taskResult = selectNextTask(dispatchableResults, runningResults);
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

  // Verify task signature per HUGIN_SIGNING_POLICY
  const signingVerdict = verifyTaskEntrySignature(
    taskNs,
    entry.content,
    parsedTask,
    submittedBy,
  );
  if (signingVerdict.reject) {
    console.warn(
      `Rejecting task ${taskNs}: signature ${signingVerdict.result.status}` +
        (signingVerdict.result.reason ? ` (${signingVerdict.result.reason})` : ""),
    );
    await failTaskWithMessage(
      taskNs,
      entry,
      signingVerdict.message,
      declaredRuntime === "pipeline" ? "runtime:pipeline" : undefined,
    );
    await munin.log(taskNs, `Task rejected by signing policy: ${signingVerdict.message}`);
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
        // Auto-router is contractually required to exclude autoEligible:false
        // runtimes (openrouter, pi-harness). Verify rather than cast — if this
        // ever fires, the contract was violated upstream and the dispatcher
        // cannot execute the selection.
        const selectedRuntime = decision.selectedRuntime.dispatcherRuntime;
        if (!isLegacyDispatcherRuntime(selectedRuntime)) {
          throw new Error(
            `Auto-router selected non-legacy runtime "${selectedRuntime}" — ` +
              `autoEligible filter contract violated. selected_id=${decision.selectedRuntime.id}`,
          );
        }
        parsedTask.runtime = selectedRuntime;
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

    // Runtime-owned artefact delivery (issue #68): reject a malformed /
    // placeholder-leaking / disallowed-target manifest at claim time, BEFORE
    // any execution or spend. Skipped when policy=off (rollback / old-skill
    // compatibility) EXCEPT the grammar violation (### Artifacts after
    // ### Prompt), which leaks the manifest into the agent prompt and so must
    // be rejected regardless of policy (Codex review #5).
    if (
      parsedTask.artifactManifestError &&
      (config.deliveryPolicy !== "off" ||
        parsedTask.artifactManifestGrammarViolation)
    ) {
      const rejection = `Artefact manifest invalid: ${parsedTask.artifactManifestError}`;
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
        `## Result\n\n- **Exit code:** 2\n- **Failure kind:** DELIVERY_MANIFEST_INVALID\n- **Error:** ${rejection}\n`,
        undefined,
        undefined,
        classification,
      );
      await writeStructuredTaskResult(
        taskNs,
        createFailureStructuredResult(taskNs, parsedTask.runtime, rejection, {
          executor: "dispatcher",
          resultSource: "delivery-manifest-validation",
          exitCode: 2,
          replyTo: parsedTask.replyTo,
          replyFormat: parsedTask.replyFormat,
          group: parsedTask.group,
          sequence: parsedTask.sequence,
          pipeline: parsedTask.pipeline,
          sensitivity: buildTaskSensitivitySnapshot(sensitivityAssessment),
        }),
        classification,
      );
      await munin.log(taskNs, `Task rejected: ${rejection}`);
      await promoteDependents(extractTaskId(taskNs));
      await refreshPipelineSummaryFromContent(entry.content);
      return { hadTask: true, queueDepth };
    }

    const securityViolation =
      getSecurityViolationForTask(parsedTask, sensitivityAssessment) ||
      getInjectionViolationForTask(parsedTask) ||
      getExternalProvenanceViolationForTask(parsedTask);
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
        `## Result\n\n- **Exit code:** ${DISPATCHER_FAILURE_EXIT_CODE}\n- **Error:** ${securityViolation}\n`,
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
        external_policy: contextResolution?.externalPolicy || "warn",
        max_provenance: contextResolution?.maxProvenance || "trusted",
        context_refs_external: contextResolution?.refsExternal || [],
        external_blocked: contextResolution?.externalBlocked || false,
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
        external_policy: contextResolution?.externalPolicy || "warn",
        max_provenance: contextResolution?.maxProvenance || "trusted",
        context_refs_external: contextResolution?.refsExternal || [],
        external_blocked: contextResolution?.externalBlocked || false,
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

    // The agent run is done. Lease renewal is stopped HERE, before the
    // delivery checkpoint, to remove the renewal-vs-checkpoint race (Codex
    // review #2): a renewal tick firing during the checkpoint transition would
    // rewrite `running` tags built from the OLD base set and strip
    // `delivery:pending`. Delivery doesn't need lease renewal — the reaper never
    // touches the currently-executing task (`shouldReapExpiredLease` returns
    // reap:false for `namespace === currentTask`, regardless of lease), and
    // delivery is bounded by its own timeout — so dropping renewal here is safe.
    // (The reaper *does* reconcile a delivery:pending checkpoint once its lease
    // expires AND it is not the current task, i.e. the owning worker is dead —
    // see #77 — but that can never be this live in-process delivery.) The
    // cancellation watch stays
    // ACTIVE through delivery so an operator can still abort a hung rsync; it
    // is stopped after delivery finalization below.
    stopLeaseRenewal();
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
    let ok = exitCode === 0;
    // `let` (not `const`): an operator cancel that lands DURING runtime-owned
    // delivery is folded back in after the delivery block (Codex review #4) so
    // the task finalizes as `cancelled`, not as a spurious DELIVERY_FAILED.
    let isCancelled = cancellation !== null;

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
    let rawBodyText: string;
    let structuredBodyKind: TaskExecutionBodyKind;

    if ((isClaude || isOllama) && resultText) {
      resultSource = effectiveExecutor;
      rawBodyText = resultText;
      structuredBodyKind = "response";
      resultBody = `### Response\n\n${resultText}`;
    } else if (!isClaude && !isOllama) {
      const hookResult = readHookResult(taskId);
      if (hookResult) {
        resultSource = "hook";
        rawBodyText = hookResult.last_assistant_message;
        structuredBodyKind = "response";
        resultBody = `### Response\n\n${hookResult.last_assistant_message}`;
        console.log(`Using Stop hook result for task ${taskNs}`);
      } else {
        resultSource = "stdout";
        rawBodyText = output || "(no output)";
        structuredBodyKind = "output";
        resultBody = `### Output\n\`\`\`\n${rawBodyText}\n\`\`\``;
      }
    } else {
      resultSource = effectiveExecutor;
      rawBodyText = output || "(no output)";
      structuredBodyKind = "output";
      resultBody = `### Output\n\`\`\`\n${rawBodyText}\n\`\`\``;
    }

    const exfilOutcome = applyExfilPolicy(
      taskNs,
      resultBody,
      rawBodyText,
      config.exfilPolicy,
    );
    const structuredBodyText = exfilOutcome.redactedStructured;
    const finalResultBody = exfilOutcome.securitySection
      ? `${exfilOutcome.redactedBody}\n${exfilOutcome.securitySection}`
      : exfilOutcome.redactedBody;

    // --- Runtime-owned artefact delivery (issue #68, lifecycle protocol) ---
    // Hugin (not the agent) delivers + verifies declared artefacts. The agent
    // content is durably checkpointed BEFORE delivery so a delivery failure
    // never costs another paid run; a terminal delivery failure renders a
    // POSITIVE numeric `Exit code: 2` (Ratatoskr's `(\d+)` regex treats
    // non-numeric/negative as success → would mis-render a loss as success).
    let bodyForResult = finalResultBody;
    let deliveryResult: DeliveryResult | undefined;
    let deliveryFailureKind: string | undefined;
    let terminalDeliveryTag: string | undefined;
    // #72: set when a live infra delivery failure under `defer` should leave the
    // task delivery:pending for the retry reaper rather than terminalizing.
    let deferDeliveryPending = false;
    // updated_at of the delivery checkpoint status write. The terminal status
    // flip CASes on this so a concurrent startup reconciler that reclaimed the
    // checkpoint (single-owner model, Codex review #1) cannot be clobbered by
    // this worker's late finalize.
    let deliveryCheckpointUpdatedAt: string | undefined;
    const deliveryEligible =
      config.deliveryPolicy !== "off" &&
      !!task.artifactManifest &&
      ok &&
      !isCancelled &&
      !isTimeout;

    if (deliveryEligible && task.artifactManifest) {
      // 1. Durable NONTERMINAL checkpoint: persist exfil-scanned agent content
      //    + a delivery-in-progress notice, CAS status → running +
      //    delivery:pending. Never `pending` (dispatcher would re-execute) and
      //    never terminal (Ratatoskr would read the checkpoint as final).
      const checkpointEntry = await munin.read(taskNs, "status");
      const checkpointContent = checkpointEntry?.content ?? entry.content;
      const checkpointBaseTags = (
        checkpointEntry?.tags ?? entry.tags
      ).filter((t) => !t.startsWith("delivery:"));
      const checkpointTags = buildClaimTags(
        [...checkpointBaseTags, "delivery:pending"],
        "running",
      );
      const checkpointBody = `${finalResultBody}\n\n### Artifact Delivery\n\n- **Delivery:** in progress (Hugin runtime owns delivery — see log)\n`;
      await munin.write(
        taskNs,
        "result",
        buildTaskResultDocument({
          exitCode: 0,
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
          body: checkpointBody,
          autoRouted: task.autoRouted,
          routingReason: task.routingDecision?.reason,
        }),
        exfilOutcome.resultTags,
        undefined,
        taskClassification,
      );
      const checkpointWrite = await munin.write(
        taskNs,
        "status",
        checkpointContent,
        checkpointTags,
        checkpointEntry?.updated_at,
      );
      // Lease renewal is deliberately NOT re-armed (Codex review #2): a
      // renewal tick would race the terminal-finalize CAS below. The reaper
      // never reaps the currently-executing task (its `currentTask` guard, #77)
      // and delivery is bounded, so no renewal is needed. The terminal flip
      // CASes on this checkpoint's updated_at.
      deliveryCheckpointUpdatedAt =
        typeof checkpointWrite?.updated_at === "string"
          ? checkpointWrite.updated_at
          : undefined;

      // 2. Deliver + verify. Bounded + abortable so a hung ssh cannot wedge
      //    the single dispatcher slot, and operator cancel still aborts it.
      const deliveryAbort = new AbortController();
      currentDeliveryAbort = deliveryAbort;
      const logPath = path.join(LOG_DIR, `${taskId}.log`);
      try {
        deliveryResult = await deliverArtifacts({
          manifest: task.artifactManifest,
          stagingPrefixes: config.deliveryTargets.map(
            (t) => t.localStagingPrefix,
          ),
          appendLog: (line) => {
            try {
              fs.appendFileSync(logPath, `${line}\n`);
            } catch {
              /* log is best-effort; never fail delivery on a log write */
            }
          },
          signal: deliveryAbort.signal,
        });
      } finally {
        currentDeliveryAbort = null;
      }

      bodyForResult = `${finalResultBody}\n${renderArtifactDeliverySection(deliveryResult)}`;

      // Fold in an operator cancel that landed during delivery (Codex review
      // #4): finalize as `cancelled`, not as a spurious DELIVERY_FAILED.
      if (!isCancelled && currentCancellation) {
        cancellation = currentCancellation;
        isCancelled = true;
      }

      if (isCancelled) {
        // Cancelled mid-delivery — leave the checkpoint markers alone; the
        // cancelled-finalize branch below owns the terminal write.
        terminalDeliveryTag = "delivery:failed";
      } else if (deliveryResult.ok) {
        terminalDeliveryTag = "delivery:verified";
      } else {
        terminalDeliveryTag = "delivery:failed";
        // missing-local / unsafe-local (no trustworthy deliverable) are ALWAYS
        // terminal; infra is terminal under `require`.
        const terminalFailure =
          deliveryResult.failureKind === "missing-local" ||
          deliveryResult.failureKind === "unsafe-local" ||
          config.deliveryPolicy === "require";
        if (terminalFailure) {
          ok = false;
          exitCode = 2;
          deliveryFailureKind = "DELIVERY_FAILED";
        } else if (
          // Deferred policy (#72): a first-attempt INFRA failure under `defer`
          // leaves the task `running + delivery:pending` (the pre-delivery
          // checkpoint, already written above) for the delivery-retry reaper —
          // resolved in the deferral block right after this loop.
          config.deliveryPolicy === "defer" &&
          deliveryResult.failureKind === "infra"
        ) {
          deferDeliveryPending = true;
        }
      }
    }
    currentCancellation = null;

    // Deferred-delivery handling (#72): if the live first attempt hit an infra
    // failure under `defer` and the retry budget is not yet exhausted, leave the
    // task `running + delivery:pending` (status untouched — it is already the
    // pre-delivery checkpoint) and EARLY-RETURN without terminalizing. The
    // delivery-retry reaper re-attempts on its own cadence; budget exhaustion
    // there (or here, if maxAttempts<=1) terminalizes as Exit 2 / DELIVERY_FAILED.
    if (deferDeliveryPending && deliveryResult && !isCancelled) {
      const meta = await readDeliveryRetryMeta(taskNs, munin);
      const parsedFirst = meta?.firstAttemptAt
        ? Date.parse(meta.firstAttemptAt)
        : Date.parse(completedAt);
      const firstAttemptAtMs = Number.isNaN(parsedFirst)
        ? Date.now()
        : parsedFirst;
      const firstAttemptAt = new Date(firstAttemptAtMs).toISOString();
      const attempts = (meta?.attempts ?? 0) + 1;
      const decision = decideDeliveryRetry({
        attempts,
        firstAttemptAtMs,
        now: Date.now(),
        maxAttempts: config.deliveryRetryMaxAttempts,
        maxAgeMs: config.deliveryRetryMaxAgeMs,
      });
      if (decision.action === "retry") {
        stopLeaseRenewal();
        stopCancellationWatch();
        await writeDeliveryRetryMeta(
          taskNs,
          { attempts, firstAttemptAt },
          munin,
          taskClassification,
        );
        await munin.write(
          taskNs,
          "result",
          buildTaskResultDocument({
            exitCode: 0,
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
            body: `${finalResultBody}\n${renderArtifactDeliverySection(deliveryResult)}\n- **Delivery:** deferred (attempt ${attempts}, infra failure) — will retry\n`,
            autoRouted: task.autoRouted,
            routingReason: task.routingDecision?.reason,
          }),
          exfilOutcome.resultTags,
          undefined,
          taskClassification,
        );
        await munin.log(
          taskNs,
          `Delivery deferred (attempt ${attempts}): ${deliveryResult.error ?? "infra failure"} — will retry`,
        );
        currentTask = null;
        currentTaskConfig = null;
        return { hadTask: true, queueDepth };
      }
      // Budget already exhausted on the first attempt (e.g. maxAttempts<=1):
      // terminalize as a delivery failure via the normal finalize path below.
      ok = false;
      exitCode = 2;
      deliveryFailureKind = "DELIVERY_FAILED";
      await munin.log(
        taskNs,
        `Delivery retry budget exhausted: ${decision.reason}`,
      );
    }

    // Agent run + delivery both finished. Lease renewal was already stopped
    // before the delivery checkpoint (see ~L3487, Codex review #2) — the call
    // below is an idempotent guard, not the primary stop. The cancellation
    // watch, however, was kept ACTIVE through delivery so an operator could
    // abort a hung rsync; THIS is where it is finally stopped.
    stopLeaseRenewal();
    stopCancellationWatch();

    // Write result to Munin (skip if timeout already wrote partial result via SDK)
    if (!(isTimeout && isClaude)) {
      await munin.write(
        taskNs,
        "result",
        buildTaskResultDocument({
          timedOut: isTimeout,
          exitCode,
          failureKind: deliveryFailureKind,
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
          body: bodyForResult,
          autoRouted: task.autoRouted,
          routingReason: task.routingDecision?.reason,
        }),
        exfilOutcome.resultTags,
        undefined,
        taskClassification,
      );
    }
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

    // Carry the terminal delivery marker (issue #68) into the persistent tag
    // set so downstream consumers + startup reconciliation see a consistent
    // terminal delivery state. Shared by the cancelled and normal branches —
    // a cancel mid-delivery still set terminalDeliveryTag = "delivery:failed".
    const finalizeBaseTags = terminalDeliveryTag
      ? [
          ...entry.tags.filter((t) => !t.startsWith("delivery:")),
          terminalDeliveryTag,
        ]
      : entry.tags;

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
          body: finalResultBody,
        }),
        exfilOutcome.resultTags,
        undefined,
        taskClassification,
      );
      const cancelledFinalize = await finalizeTaskCompletion(munin, taskNs, {
        statusContent: entry.content,
        terminalTags: buildTerminalStatusTags("cancelled", finalizeBaseTags, `runtime:${task.runtime}`),
        classification: taskClassification,
        // Single-owner CAS for runtime-owned delivery (#68, Codex review C):
        // if a startup reconciler reclaimed the delivery checkpoint while we
        // were delivering, this CAS is rejected and we must NOT finalize. When
        // the task never entered delivery this is undefined → no CAS, same as
        // the prior behaviour.
        expectedUpdatedAt: deliveryCheckpointUpdatedAt,
        writeStructuredResult: () => writeStructuredTaskResult(
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
        ),
        logMessage: `Task cancelled in ${Math.round(durationMs / 1000)}s (reason: ${cancellation.reason}, executor: ${executorLabel})`,
      });
      if (cancelledFinalize.statusCasLost) {
        // The startup reconciler re-owns this task (single-owner model). It
        // will write the terminal state, promote dependents, and refresh the
        // pipeline — doing it here too would double-fire those side effects.
        console.warn(
          `Task ${taskNs} cancelled-finalize CAS lost — delivery reconciliation owns terminalization`,
        );
        currentTask = null;
        currentTaskConfig = null;
        return { hadTask: true, queueDepth };
      }
    } else {
      const finalizeOutcome = await finalizeTaskCompletion(munin, taskNs, {
        statusContent: entry.content,
        terminalTags: buildTerminalStatusTags(ok ? "completed" : "failed", finalizeBaseTags, `runtime:${task.runtime}`),
        classification: taskClassification,
        // Single-owner CAS for runtime-owned delivery (#68): if a startup
        // reconciler reclaimed the checkpoint while we were delivering, this
        // CAS is rejected and we must NOT finalize — the new owner stands.
        expectedUpdatedAt: deliveryCheckpointUpdatedAt,
        writeStructuredResult: () => writeStructuredTaskResult(
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
            errorMessage: ok
              ? undefined
              : deliveryResult && !deliveryResult.ok
                ? deliveryResult.error ?? structuredBodyText
                : structuredBodyText,
            runtimeMetadata,
            pipeline: task.pipeline,
            approval: approvalMetadata,
            sensitivity: taskSensitivitySnapshot,
            artifactDelivery: deliveryResult
              ? {
                  ok: deliveryResult.ok,
                  failureKind: deliveryResult.failureKind,
                  artifacts: deliveryResult.records.map((r) => ({
                    id: r.id,
                    status: r.status,
                    remote: r.remote,
                    bytes: r.bytes,
                    sha256: r.sha256,
                    error: r.error,
                  })),
                }
              : undefined,
          }),
          taskClassification,
        ),
        logMessage: `Task ${ok ? "completed" : isTimeout ? "timed out" : "failed"} in ${Math.round(durationMs / 1000)}s (exit ${exitCode}, executor: ${executorLabel}${costUsd !== null ? `, cost: $${costUsd.toFixed(4)}` : ""})`,
      });
      if (finalizeOutcome.statusCasLost) {
        // The startup reconciler re-owns this task (single-owner model). It
        // will write the terminal state, promote dependents, and refresh the
        // pipeline — doing it here too would double-fire those side effects.
        console.warn(
          `Task ${taskNs} finalize CAS lost — delivery reconciliation owns terminalization`,
        );
        currentTask = null;
        currentTaskConfig = null;
        return { hadTask: true, queueDepth };
      }
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

  // Start the independent reaper so expired foreign leases get cleaned up even
  // while pollOnce is blocked on a long-running current task. The poll loop no
  // longer invokes the reaper — this timer is the single source of truth.
  startLeaseReaper();
  // #72: drive deferred-delivery retries on their own cadence (no-op unless
  // HUGIN_DELIVERY_POLICY=defer).
  startDeliveryRetryReaper();

  let pollCount = 0;
  while (!shuttingDown) {
    let queueDepth = 0;
    try {
      pollCount++;
      await reconcileTrackedPipelineSummaries();
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
    process_instance_id: processInstanceId,
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
  brokerReconciler?.stop();
  orchWorker?.stop();
  if (runningBroker) {
    runningBroker.close().catch((err) => {
      console.error(
        `Broker close error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  stopLeaseRenewal();
  stopCancellationWatch();
  stopLeaseReaper();
  stopDeliveryRetryReaper();

  // Mark the current task as failed before killing the process
  if (currentTask) {
    console.log(`Marking current task ${currentTask} as failed (shutdown)...`);
    try {
      const entry = await munin.read(currentTask, "status");
      if (entry && entry.tags.includes("delivery:pending")) {
        // Runtime-owned artefact delivery (issue #68): a delivery:pending
        // checkpoint is the nonterminal source of truth — the agent content is
        // already preserved in `result`. Do NOT generic-overwrite it with a
        // terminal `failed` (that would mis-render as success / discard the
        // checkpoint). Leave it running+delivery:pending so startup
        // reconciliation re-delivers without a paid rerun.
        console.log(
          `Leaving ${currentTask} as delivery:pending for startup reconciliation (shutdown)`,
        );
      } else if (entry) {
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
          `## Result\n\n- **Exit code:** ${DISPATCHER_FAILURE_EXIT_CODE}\n- **Error:** Task interrupted by dispatcher shutdown (${signal}, worker: ${workerId})\n`
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

  if (currentDeliveryAbort) {
    console.log("Aborting running artefact delivery...");
    currentDeliveryAbort.abort();
  }

  if (currentReconcileAbort) {
    console.log("Aborting running delivery reconciliation...");
    currentReconcileAbort.abort();
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
console.log(`Worker ID: ${workerId} (instance: ${processInstanceId})`);
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

// Optional orchestrator-v1 broker (separate port; opt-in via HUGIN_BROKER_KEYS).
if (brokerEnv.enabled) {
  const brokerHome = path.join(HUGIN_HOME, "delegation-events.jsonl");
  const journal = new DelegationJournal({ path: brokerHome });
  const taskStore = new BrokerTaskStore(munin);
  const idempotency = new IdempotencyIndex();
  brokerReconciler = new BrokerReconciler({
    taskStore,
    journal,
    intervalMs: config.brokerReconciliationIntervalMs,
  });
  startBroker({
    host: brokerEnv.host,
    port: brokerEnv.port,
    keys: brokerEnv.keys,
    deps: { taskStore, journal, idempotency },
  })
    .then((rb) => {
      runningBroker = rb;
      console.log(
        `Broker endpoint: http://${brokerEnv.host}:${brokerEnv.port}/v1/delegate/* (principals: ${Object.keys(brokerEnv.keys).join(", ")})`,
      );
      brokerReconciler?.start();
      console.log(
        `Broker reconciler: every ${config.brokerReconciliationIntervalMs}ms (journal: ${brokerHome})`,
      );

      const orKey = process.env.OPENROUTER_API_KEY?.trim();
      if (orKey) {
        const orClient = new OpenRouterClient({
          apiKey: orKey,
          referer: process.env.OPENROUTER_REFERER || "https://hugin.local",
          appTitle: process.env.OPENROUTER_APP_TITLE || "hugin-orch-v1",
        });
        orchWorker = new OrchWorker({
          munin,
          taskStore,
          journal,
          openrouterClient: orClient,
          workerId: `orch-${workerId}`,
          pollIntervalMs: config.pollIntervalMs,
        });
        orchWorker.start();
        console.log(
          `Orch worker (openrouter): polling every ${config.pollIntervalMs}ms`,
        );
      } else {
        console.log(
          "Orch worker (openrouter): disabled (set OPENROUTER_API_KEY to enable)",
        );
      }
    })
    .catch((err) => {
      console.error(
        `Failed to start broker: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
} else {
  console.log("Broker: disabled (set HUGIN_BROKER_KEYS to enable)");
}

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
