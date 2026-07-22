import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Server } from "node:http";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import { HEIMDALL_DESCRIPTOR, registerHeimdallDescriptorRoute } from "./heimdall-descriptor.js";
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
import { getFoundBatchEntry, extractTaskId, pickEarliestTask, selectNextTask, checkoutTaskBranch, finalizeTaskBranch, deriveRepositoryOutcome, prepareManagedCheckout, shouldReapExpiredLease, decideStartupRecovery, decideDeliveryRetry, finalizeTaskCompletion, resolveTaskWorkingDirectory, normalizeRoot, parseBaseBranchOverride, DEFAULT_REPOS_ROOT, MAX_TASK_OUTPUT_TOKENS, MAX_TASK_TIMEOUT_MS, parseBoundedPositiveInt, PUBLICATION_FAILED_TAG } from "./task-helpers.js";
import { persistPublicationFailure } from "./publication-recovery.js";
import { queryAllMuninEntries } from "./munin-pagination.js";
import {
  buildQueueObservabilityFields,
  shouldWarnQueueTruncation,
  snapshotPendingQueue,
  snapshotPendingQueueAfterDeparture,
  type PendingQueueSnapshot,
} from "./queue-observability.js";
import { executeSdkTask, type SdkExecutorResult, type SdkExecutorOptions, type SdkTaskConfig, type TaskPermissionProfile } from "./sdk-executor.js";
import {
  classifyClaudeFailure,
  driftFailureClassification,
  AUTH_FAILURE_KIND,
  DEPS_DRIFT_FAILURE_KIND,
} from "./failure-classification.js";
import {
  buildCodexSandboxFrictionEvent,
  CODEX_SANDBOX_FAILURE_KIND,
  codexSandboxFailureClassification,
  probeCodexSandbox,
  type CodexSandboxProbeResult,
} from "./codex-sandbox.js";
import {
  buildTaskSubprocessEnv,
  SENSITIVITY_CHECKPOINT_SECRET_ENV,
} from "./task-subprocess-env.js";
import {
  decideAuthAlarm,
  alertDeliveryCommitsTransition,
  hydratePersistedAuthAlarmState,
  INITIAL_AUTH_ALARM_STATE,
  type AlertEnvelope,
  type AlertDeliveryStatus,
  type AuthAlarmState,
} from "./auth-alarm.js";
import {
  buildVersionSnapshot,
  compareVersionSnapshots,
  hydrateVersionDriftAlertLifecycle,
  INITIAL_VERSION_DRIFT_ALERT_LIFECYCLE,
  recordVersionDriftFiring,
  recordVersionDriftResolutionAttempt,
  VERSION_DRIFT_DEDUP_KEY,
  versionDriftStartupResolution,
  type VersionDriftAlertLifecycle,
  type VersionDriftResult,
  type VersionSnapshot,
} from "./version-drift.js";
import { executeOllamaTask } from "./ollama-executor.js";
import {
  executeHomeserverTask,
  buildFreshHomeserverDelegateRequestBody,
  buildHomeserverDelegateTaskConfig,
  loadHomeserverGatewayConfig,
  renderHomeserverUserMessage,
  type HomeserverExecutorResult,
  type HomeserverVerifierSpec,
} from "./homeserver-executor.js";
import {
  createPreparedLearningTaskDispatch,
  learningTaskAttemptKey,
  learningTaskExecutionEvidenceSchema,
  learningTaskOutcomePersistenceFailure,
  prepareDurableLearningTaskAttempt,
  validatePreparedLearningTaskOutcome,
  type LearningTaskExecutionEvidence,
  type LearningTaskSource,
} from "./learning-task-handshake.js";
import {
  recoverAmbiguousStoredLearningTaskCandidate,
  recoverLatestStoredLearningTaskAttempt,
  type RecoveredStoredLearningTask,
} from "./learning-task-recovery.js";
import { createImmutableLearningArtifact } from "./learning-task-store.js";
import { buildAuthenticatedLearningTaskSource } from "./learning-task-source.js";
import {
  executeOpencodeTask,
  loadOpencodeGatewayConfig,
  type OpencodeExecutorResult,
} from "./opencode-executor.js";
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
  buildClaimedTerminalStatusTags,
  buildLeasedStatusTags,
  buildTerminalStatusTags,
  shouldDeferCancellationToClaimOwner,
  stripSchedulerDecisionPointers,
} from "./task-status-tags.js";
import { LearningLoopCollector } from "./learning-loop-collector.js";
import { LearningRegistryStore } from "./learning-registry-store.js";
import { LearningExperimentStore } from "./learning/experiment-store.js";
import { isPotentialAdmittedHomeserverAttempt } from "./homeserver-learning-registry-bridge.js";
import {
  LEARNING_REGISTRY_PENDING_TAG,
  capturePendingHomeserverLearningTask,
  reconcilePendingHomeserverLearningTasks,
} from "./homeserver-learning-registry-recovery.js";
import { fetchM5LedgerAttemptBinding } from "./m5-ledger-attempt-binding.js";
import { runHarnessLaneSampledAttempt, type LaneAttemptOutcome } from "./harness-lane-executor.js";
import { decideHarnessLane, isHarnessLaneEligibleTaskType } from "./harness-lane-sampler.js";
import { sanitizeProviderTokenCount } from "./m5-provenance.js";
import {
  buildTaskSensitivitySnapshot,
  buildStructuredTaskResult,
  type DispatcherRuntime,
  type StructuredTaskResult,
  type TaskExecutionApprovalMetadata,
  type TaskExecutionBodyKind,
  type TaskExecutionPipelineContext,
  type TaskExecutionRuntimeMetadata,
  type TaskExecutionSensitivity,
  type SkillRoute,
} from "./task-result-schema.js";
import {
  buildSensitivityCheckpoint,
  parseSensitivityCheckpoint,
  SENSITIVITY_CHECKPOINT_KEY,
  SENSITIVITY_CHECKPOINT_TAGS,
} from "./sensitivity-checkpoint.js";
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
import { parseTaskModelField } from "./task-document-metadata.js";
import { routeTask, type RouterDecision } from "./router.js";
import {
  buildRuntimeCandidates,
  isAutoRoutableDispatcherRuntime,
  isLegacyDispatcherRuntime,
  parseActiveSubscriptions,
  type RuntimeCapability,
} from "./runtime-registry.js";
import {
  extractSignatureField,
  buildTaskSubmissionProvenance,
  loadKeyStoreFromEnv,
  parseNonNegativeIntEnv,
  parseSignature,
  parseSigningPolicy,
  signingPolicyRejects,
  verifyTaskSignature,
  type KeyStore,
  type SigningPolicy,
  type TaskSignatureAssessment,
  type TaskSubmissionProvenance,
} from "./task-signing.js";
import { consultSkillLane } from "./skill/skill-lane-dispatch.js";
import { readBrokerEnv, type RunningBroker } from "./broker/server.js";
import {
  startBrokerWithRetry,
  computeBrokerHealthField,
  type BrokerBindStatus,
} from "./broker/bind-retry.js";
import { brokerExecutorCapabilities } from "./broker/executor-capabilities.js";
import { BrokerTaskStore, resolveHomeserverTaskSource } from "./broker/task-store.js";
import {
  parseStoredBrokerAttestation,
  validateBrokerAttestation,
} from "./broker/attestation.js";
import { DelegationJournal } from "./broker/journal.js";
import { IdempotencyIndex } from "./broker/idempotency.js";
import {
  effectiveOrchestratorConfig,
  isVerdictStoreEnabled,
  isSavingsEnabled,
} from "./orchestrator/config.js";
import { isSovereignGatewayHost } from "./orchestrator/provider-config.js";
import { createModelInvoker } from "./orchestrator/model-invoker.js";
import { runOrchestratorTask } from "./orchestrator/orchestrator-executor.js";
import { VerdictStore } from "./orchestrator/verdict-store.js";
import { LedgerClient } from "./orchestrator/ledger-client.js";
import { SavingsStore } from "./orchestrator/savings-store.js";
import type { SubtaskOutcome } from "./orchestrator/engine.js";
import type { SavingsSummary } from "./orchestrator/savings.js";

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
  const n = Number((raw ?? "").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/**
 * Parse a Telegram chat id (a positive integer) for the auth-alarm Ratatoskr
 * send target. Returns null when unset/malformed — the alarm then probes + logs
 * but sends nothing, rather than POSTing a bad chat_id Ratatoskr would 400/403.
 */
function parseChatIdEnv(raw: string | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : null;
}

const config = {
  port: parseBoundedPositiveInt(process.env.HUGIN_PORT, 3032, 65_535),
  host: process.env.HUGIN_HOST || "127.0.0.1",
  muninUrl: process.env.MUNIN_URL || "http://localhost:3030",
  muninApiKey: process.env.MUNIN_API_KEY || "",
  // Hugin-only producer key for sensitivity checkpoints. This must not be a
  // Munin credential: other agents can legitimately write tasks/* and must
  // not be able to mint phase authority.
  sensitivityCheckpointSecret:
    process.env[SENSITIVITY_CHECKPOINT_SECRET_ENV]?.trim() || "",
  pollIntervalMs: parseBoundedPositiveInt(
    process.env.HUGIN_POLL_INTERVAL_MS,
    30_000,
    3_600_000,
  ),
  defaultTimeoutMs: parseBoundedPositiveInt(
    process.env.HUGIN_DEFAULT_TIMEOUT_MS,
    300_000,
    MAX_TASK_TIMEOUT_MS,
  ),
  workspace: process.env.HUGIN_WORKSPACE || "/home/magnus/workspace",
  // Root under which `repo:<name>` aliases resolve and task branches are cut
  // (#139). Point this at an isolated tree to keep hugin tasks off the
  // production deploy checkouts under /home/magnus/repos. Default preserves
  // the historical hardcoded behavior.
  reposRoot: normalizeRoot(process.env.HUGIN_REPOS_ROOT || DEFAULT_REPOS_ROOT),
  maxOutputChars: parseBoundedPositiveInt(
    process.env.HUGIN_MAX_OUTPUT_CHARS,
    50_000,
    1_000_000,
  ),
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
  ollamaOrinUrl: process.env.OLLAMA_ORIN_URL || "",
  ollamaDefaultModel: process.env.OLLAMA_DEFAULT_MODEL || "qwen2.5:3b",
  // M5 local-inference gateway root (shared with the orchestrator's
  // homeserver provider via PROVIDER_CONFIG's baseUrlEnvVar and with the
  // standalone homeserver-executor). Read here only to allowlist its host
  // for egress; the provider itself re-reads the env var at request time.
  homeserverGatewayUrl: process.env.HOMESERVER_GATEWAY_URL?.trim() || "",
  extraAllowedEgressHosts: (process.env.HUGIN_ALLOWED_EGRESS_HOSTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  signingPolicy: parseSigningPolicy(process.env.HUGIN_SIGNING_POLICY) as SigningPolicy,
  // 900s (15 min) default: hugin polls every ~30s and runs one task at a time;
  // with a 300s task timeout a legitimately queued signed task can exceed 300s
  // before dispatch and would be wrongly rejected under `require`. A per-task-id
  // seen-guard is the stronger long-term fix (not yet implemented).
  // Set HUGIN_SIGNING_MAX_AGE_S=0 to disable the age check entirely.
  signingMaxAgeS: parseNonNegativeIntEnv(process.env.HUGIN_SIGNING_MAX_AGE_S, 900),
  submitterKeys: loadKeyStoreFromEnv() as KeyStore,
  exfilPolicy: parseExfilPolicy(process.env.HUGIN_EXFIL_POLICY),
  externalPolicy: parseExternalPolicy(process.env.HUGIN_EXTERNAL_POLICY),
  brokerReconciliationIntervalMs: parseBoundedPositiveInt(
    process.env.HUGIN_BROKER_RECONCILIATION_INTERVAL_MS,
    60_000,
    3_600_000,
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
  // Local-skill lane master switch (issue #84). Default OFF — the lane only ever
  // runs local when an `active`, drift-free, sensitivity-cleared RouteBinding is
  // selectable (src/skill/skill-lane.ts), which requires authored slice-one
  // artifacts + a real cell that do not exist yet. Until then the orchestrator
  // fails closed to the existing cloud auto-router, so flipping this on is a no-op.
  skillLaneEnabled: process.env.HUGIN_SKILL_LANE === "on",
  // Pre-flight Claude auth check (issue #129). When `on` (default), a Claude SDK
  // task probes the Pi's Claude credential BEFORE the (paid, slot-consuming) run
  // and short-circuits to a distinctly-classified AUTH_FAILED failure if the
  // credential is definitively invalid (HTTP 401) — instead of a silent ~9s
  // burn that reads as a generic `failed`. Fail-open: any non-401 probe result
  // (network error, missing endpoint, no creds file) lets the task run as before.
  // Set to `off` to disable the probe entirely.
  claudeAuthPreflight: (process.env.HUGIN_CLAUDE_AUTH_PREFLIGHT ?? "on") !== "off",
  // Version-drift self-check (issue #123). A baseline snapshot of the on-disk
  // @anthropic-ai/claude-agent-sdk version + vendored cli.js identity is taken
  // once at startup; before each agent-sdk task a fresh on-disk read is
  // compared against it (src/version-drift.ts). Default on. The CHECK itself
  // is always fail-open (a read error never blocks a task) — this flag only
  // disables the feature outright.
  versionDriftCheck: (process.env.HUGIN_VERSION_DRIFT_CHECK ?? "on") !== "off",
  // Proactive Pi Claude credential-expiry alarm (issue #131). A periodic probe
  // (the same OAuth-usage check the pre-flight uses) feeds the edge-triggered
  // state machine in src/auth-alarm.ts; a transition to `unauthorized` (or an
  // impending expiry) is pushed to the user via Ratatoskr's Alert Bus. Default
  // on, but inert unless a Ratatoskr send target + chat id are configured.
  authAlarm: (process.env.HUGIN_AUTH_ALARM ?? "on") !== "off",
  authAlarmIntervalMs: parsePositiveIntEnv(
    process.env.HUGIN_AUTH_ALARM_INTERVAL_MS,
    3_600_000, // 1h
  ),
  authAlarmExpiryWarnMs: parsePositiveIntEnv(
    process.env.HUGIN_AUTH_ALARM_EXPIRY_WARN_MS,
    43_200_000, // 12h
  ),
  // Ratatoskr Alert Bus target (ratatoskr/src/send-handler.ts, POST /api/send).
  // Empty send URL/key/chat id → the alarm still probes + logs, but cannot push
  // Telegram (graceful degrade). Kept out of the fetch egress allowlist by
  // design — this is a same-host Grimnir control-plane call, not task egress.
  ratatoskrSendUrl: process.env.HUGIN_RATATOSKR_SEND_URL?.trim() || "",
  ratatoskrSendApiKey: process.env.HUGIN_RATATOSKR_SEND_API_KEY?.trim() || "",
  authAlarmChatId: parseChatIdEnv(process.env.HUGIN_AUTH_ALARM_CHAT_ID),
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

if (config.sensitivityCheckpointSecret.length < 32) {
  console.warn(
    "HUGIN_SENSITIVITY_CHECKPOINT_SECRET is missing or shorter than 32 characters; " +
      "pipeline decomposition will fail closed and delivery recovery will recompute sensitivity",
  );
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
let currentOpencodeAbort: AbortController | null = null;
let currentOrchestratorAbort: AbortController | null = null;
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
// Live broker bind status for /health (issue #252). null until the retry
// loop's first onStatus callback fires (or forever, if the broker is
// disabled — computeBrokerHealthField never reads it in that case).
let brokerBindStatus: BrokerBindStatus | null = null;
// Cancels a pending broker bind retry on shutdown so it doesn't keep the
// process alive on a dangling timer or bind an orphaned listener after
// shutdown has already begun.
let brokerBindAbort: AbortController | null = null;
let leaseRenewalTimer: ReturnType<typeof setInterval> | null = null;
let cancelWatchTimer: ReturnType<typeof setInterval> | null = null;
let leaseReaperTimer: ReturnType<typeof setInterval> | null = null;
let leaseReaperInFlight = false;
// Deferred-delivery retry reaper (#72), armed only under `HUGIN_DELIVERY_POLICY=defer`.
let deliveryRetryReaperTimer: ReturnType<typeof setInterval> | null = null;
let deliveryRetryReaperInFlight = false;
// Proactive Claude auth-alarm reaper (#131), armed only under `HUGIN_AUTH_ALARM` on.
let authAlarmTimer: ReturnType<typeof setInterval> | null = null;
let authAlarmInFlight = false;
let authAlarmState: AuthAlarmState = INITIAL_AUTH_ALARM_STATE;
let lastPendingQueueSnapshot: PendingQueueSnapshot = snapshotPendingQueue([], false);
let lastQueueTruncationWarningAtMs: number | null = null;
let lastBlockedTaskCount = 0;
const startedAt = Date.now();
const pipelineSummaryManager = new PipelineSummaryManager();
// Claim-time assessment cache. It prevents a signature that was valid when a
// long task was admitted from being re-labelled expired at terminalization.
const taskProvenance = new Map<string, TaskSubmissionProvenance>();

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

// The auth-alarm push (#131) uses the global fetch, which is egress-gated below.
// The Ratatoskr Alert Bus host (typically `huginmunin` or the Pi Tailscale IP,
// not loopback — see ratatoskr bind-resilience notes) must therefore be
// allowlisted or the alarm's own POST would be denied before it leaves the box.
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
const ratatoskrEgressHost = config.ratatoskrSendUrl
  ? hostnameOf(config.ratatoskrSendUrl)
  : null;
// Only a sovereign (loopback/private-LAN/tailnet) gateway host is
// egress-allowlisted; a public host in HOMESERVER_GATEWAY_URL is rejected by
// resolveProviderBaseUrl anyway, and must not widen the allowlist either.
const homeserverEgressHost = config.homeserverGatewayUrl
  ? hostnameOf(config.homeserverGatewayUrl)
  : null;
const homeserverEgressUrl =
  homeserverEgressHost && isSovereignGatewayHost(homeserverEgressHost)
    ? config.homeserverGatewayUrl
    : undefined;

const egressPolicy = installFetchEgressPolicy(
  buildDefaultEgressHosts({
    muninUrl: config.muninUrl,
    ollamaPiUrl: config.ollamaPiUrl,
    ollamaLaptopUrl: config.ollamaLaptopUrl,
    ollamaOrinUrl: config.ollamaOrinUrl,
    homeserverGatewayUrl: homeserverEgressUrl,
    extraHosts: [
      ...config.extraAllowedEgressHosts,
      ...(ratatoskrEgressHost ? [ratatoskrEgressHost] : []),
    ],
  }),
);

const munin = createMuninClient();
const learningRegistry = new LearningRegistryStore(munin);
// Keep lease renewal, active-task cancellation polling, and the independent
// lease reaper off the main request slot so a long Retry-After on background
// work cannot delay them past expiry — and so reaper traffic does not queue up
// behind task-completion writes or contaminate the task-scoped session window.
const leaseMunin = createMuninClient();
const cancelWatchMunin = createMuninClient();
const reaperMunin = createMuninClient();
// Verdict-store traffic (batched record + confidence-source read, Fix #2c)
// gets its own dedicated client, same precedent as leaseMunin/cancelWatchMunin
// above: verdict recording is fire-and-forget background work and must never
// queue behind — or be queued behind by — task-completion writes on the main
// client's serial request slot.
const orchVerdictMunin = createMuninClient();
// Champion/challenger observations are operator-plane writes. Keep them off the
// dispatcher's serial Munin request slot so an experiment upload cannot delay a
// task claim, completion checkpoint, or lease renewal.
const learningExperimentMunin = createMuninClient();

// Verdict layer (docs/orchestrator-verdict-layer.md, V4/V7). Gated on a
// single master switch (HUGIN_ORCH_VERDICT_STORE, default "on") — when
// disabled, neither is constructed, so runOrchestratorTask receives no
// verdictStore/ledgerClient and both recording and the adaptive confidence
// gate are inert (the engine falls back to its unchanged default behavior).
// Hydrates nothing at boot: the store reads its Munin doc lazily per task.
const verdictLayerEnabled = isVerdictStoreEnabled(process.env);
const orchVerdictStore = verdictLayerEnabled
  ? new VerdictStore(orchVerdictMunin, (line) => console.log(`[verdict-store] ${line}`))
  : undefined;
const orchLedgerClient = verdictLayerEnabled ? new LedgerClient({ env: process.env }) : undefined;

// Savings tracker (PR3, docs/orchestrator-savings-tracker.md S3/S5). Gated on
// HUGIN_ORCH_SAVINGS (default "on"). Shares the SAME dedicated background
// Munin client as the verdict store above (orchVerdictMunin) — both are
// low-stakes background writers; the point of that client is isolation from
// the task path, not one-client-per-store.
const savingsLayerEnabled = isSavingsEnabled(process.env);
const orchSavingsStore = savingsLayerEnabled
  ? new SavingsStore(orchVerdictMunin, (line) => console.log(`[savings-store] ${line}`))
  : undefined;

// --- Task parsing ---

interface TaskConfig {
  prompt: string;
  runtime: "claude" | "codex" | "ollama" | "opencode" | "homeserver" | "orchestrator";
  workingDir: string;
  context?: string;
  baseBranch?: string;
  baseBranchError?: string;
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
  sensitivitySnapshot?: TaskExecutionSensitivity;
  contextResolution?: Awaited<ReturnType<typeof resolveContextRefs>>;
  pipeline?: TaskExecutionPipelineContext;
  capabilities?: RuntimeCapability[];
  permissionProfile?: TaskPermissionProfile;
  autoRouted?: boolean;
  routingDecision?: RouterDecision;
  // Local-skill lane audit record (issue #84). Set when HUGIN_SKILL_LANE=on and
  // the lane was consulted. Carried into the structured result for auditability.
  // Slice-one ships no `active` binding, so this is always an abstain record in
  // production until go-live — the dispatcher routes cloud regardless.
  skillRoute?: SkillRoute;
  // Runtime-owned artefact delivery (issue #68). Runtime-only — deliberately
  // NOT in SdkTaskConfig: the manifest must never reach the agent prompt.
  artifactManifest?: ArtifactManifest;
  artifactManifestError?: string;
  // "### Artifacts after ### Prompt" grammar violation — rejected even when
  // HUGIN_DELIVERY_POLICY=off (the manifest would otherwise leak into the
  // agent prompt; Codex review #5).
  artifactManifestGrammarViolation?: boolean;
  homeserverTaskType?: string;
  homeserverVerifier?: HomeserverVerifierSpec;
  maxOutputTokens?: number;
  homeserverPolicyError?: string;
  /** Authenticated Hugin Broker source, never parsed from free-form task prose. */
  brokerPrincipal?: string;
  brokerAttestedNamespace?: string;
  /** Why an embedded Broker claim did not qualify as authenticated learning provenance. */
  brokerAttestationError?: string;
}

type DeclaredRuntime = TaskConfig["runtime"] | "pipeline" | "auto";

function parseDeclaredRuntime(content: string): DeclaredRuntime | undefined {
  return content.match(/\*\*Runtime:\*\*\s*(claude|codex|ollama|opencode|homeserver|pipeline|auto|orchestrator)/i)?.[1]?.toLowerCase() as
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

function parseTask(content: string): TaskConfig | null {
  const declaredRuntimeRaw = parseDeclaredRuntime(content);
  const isAutoRoute = declaredRuntimeRaw === "auto";
  const runtime = (isAutoRoute ? undefined : declaredRuntimeRaw) as
      | "claude"
      | "codex"
      | "ollama"
      | "opencode"
      | "homeserver"
      | "orchestrator"
      | undefined;
  const workingDir = content.match(
    /\*\*Working dir:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const contextRaw = content.match(
    /\*\*Context:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const baseBranchOverride = parseBaseBranchOverride(content);
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
  const modelRaw = parseTaskModelField(content);
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
  const permissionProfileRaw = content.match(
    /\*\*Permission profile:\*\*\s*(.+)/i
  )?.[1]?.trim()?.toLowerCase();
  const homeserverTaskType = content.match(/\*\*Task type:\*\*\s*(.+)/i)?.[1]?.trim();
  const homeserverVerifierRaw = content.match(/\*\*Verifier:\*\*\s*(.+)/i)?.[1]?.trim();
  const homeserverMaxTokensRaw = content.match(/\*\*Max output tokens:\*\*\s*(\d+)/i)?.[1];
  const promptMatch = content.match(/###\s*Prompt\s*\n([\s\S]+)$/i);
  const prompt = promptMatch?.[1]?.trim();
  let homeserverVerifier: HomeserverVerifierSpec | undefined;
  let homeserverPolicyError: string | undefined;
  let canonicalBrokerEnvelope: import("./broker/types.js").DelegationEnvelope | undefined;
  if (homeserverVerifierRaw && homeserverVerifierRaw !== "none") {
    try {
      const parsed = JSON.parse(homeserverVerifierRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        homeserverVerifier = parsed as HomeserverVerifierSpec;
      }
    } catch {
      if (runtime !== "homeserver") homeserverPolicyError = "Verifier JSON is malformed";
    }
  }

  if (runtime === "homeserver") {
    const source = resolveHomeserverTaskSource(content);
    if (source.kind === "invalid") homeserverPolicyError = source.error;
    else if (source.kind === "broker") {
      canonicalBrokerEnvelope = source.envelope;
      homeserverPolicyError = undefined;
    }
  }

  const brokerAttestation = canonicalBrokerEnvelope
    ? validateBrokerAttestation({
        envelope: canonicalBrokerEnvelope,
        attestation: parseStoredBrokerAttestation(content),
        serverSecret: config.muninApiKey,
      })
    : null;

  if ((!prompt && !canonicalBrokerEnvelope) || (!runtime && !isAutoRoute)) return null;

  // Resolution priority: Context > Working dir > config.workspace
  const resolvedDir = resolveTaskWorkingDirectory(contextRaw, workingDir, {
    reposRoot: config.reposRoot,
    workspace: config.workspace,
  });

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
    prompt: canonicalBrokerEnvelope?.prompt ?? prompt!,
    runtime: runtime || "claude",  // temporary for auto — overwritten by router
    workingDir: resolvedDir,
    context: contextRaw || undefined,
    baseBranch: baseBranchOverride.baseBranch,
    baseBranchError: baseBranchOverride.error,
    timeoutMs: parseBoundedPositiveInt(
      canonicalBrokerEnvelope?.timeout_ms ?? timeoutStr,
      config.defaultTimeoutMs,
      MAX_TASK_TIMEOUT_MS,
    ),
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
    declaredSensitivity: canonicalBrokerEnvelope?.sensitivity
      ? sensitivitySchema.parse(canonicalBrokerEnvelope.sensitivity)
      : declaredSensitivityRaw
      ? sensitivitySchema.parse(declaredSensitivityRaw)
      : undefined,
    capabilities: validCapabilities.length > 0 ? validCapabilities : undefined,
    permissionProfile:
      permissionProfileRaw === "trusted-code" && validCapabilities.includes("code")
        ? "trusted-code"
        : "read-only",
    autoRouted: isAutoRoute || undefined,
    artifactManifest: artifactManifestResult.manifest ?? undefined,
    artifactManifestError: artifactManifestResult.error ?? undefined,
    artifactManifestGrammarViolation:
      artifactManifestResult.grammarViolation || undefined,
    homeserverTaskType: canonicalBrokerEnvelope?.task_type ?? homeserverTaskType ?? undefined,
    homeserverVerifier: canonicalBrokerEnvelope?.acceptance.mode === "verifier"
      ? canonicalBrokerEnvelope.acceptance.verifier
      : homeserverVerifier,
    maxOutputTokens: homeserverMaxTokensRaw || canonicalBrokerEnvelope?.max_output_tokens
      ? parseBoundedPositiveInt(
          canonicalBrokerEnvelope?.max_output_tokens ?? homeserverMaxTokensRaw,
          4_096,
          MAX_TASK_OUTPUT_TOKENS,
        )
      : undefined,
    homeserverPolicyError,
    brokerPrincipal: brokerAttestation?.ok ? brokerAttestation.principal : undefined,
    brokerAttestedNamespace: brokerAttestation?.ok
      ? brokerAttestation.attestation.namespace
      : undefined,
    brokerAttestationError: brokerAttestation && !brokerAttestation.ok
      ? brokerAttestation.error
      : undefined,
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

function buildLearningTaskSource(
  task: TaskConfig,
  taskNs: string,
  createdAt: string,
  acceptedAt: string,
  provenance: TaskSubmissionProvenance,
): LearningTaskSource {
  return buildAuthenticatedLearningTaskSource({
    taskNamespace: taskNs,
    createdAt,
    acceptedAt,
    verifiedSubmitter: provenance.verifiedSubmitter ?? undefined,
    brokerPrincipal: task.brokerPrincipal,
    brokerAttestedNamespace: task.brokerAttestedNamespace,
    brokerAttestationError: task.brokerAttestationError,
  });
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
  const contextSensitivity = classifyContextSensitivity(task.context, task.workingDir);
  const promptDetection = detectPromptSensitivity(task.prompt);
  const refsSensitivity = task.contextResolution?.maxSensitivity;
  return buildSensitivityAssessment({
    declared,
    // Any authentic pipeline classification arrives through the HMAC-bound
    // checkpoint and bypasses this fallback. Free-form pipeline fields are
    // untrusted here and must never lower the ordinary internal floor.
    baseline: "internal",
    context: contextSensitivity,
    prompt: promptDetection.sensitivity,
    refs: refsSensitivity,
    hardPrivate: promptDetection.hardPrivate,
    // Pipeline-phase authority is accepted only through the separate,
    // content-hash-bound Hugin checkpoint. Free-form pipeline metadata must
    // never upgrade a task's owner privileges, even when Submitted-by is hugin.
    allowOwnerOverride: !task.pipeline && isOwnerSubmitter(task.submittedBy),
  });
}

function getTaskRuntimeLabel(task: TaskConfig): string {
  if (task.runtime !== "ollama") return task.runtime;
  return task.ollamaHost ? `ollama:${task.ollamaHost}` : "ollama";
}

async function assessTaskSecurity(
  task: TaskConfig,
  trustedSnapshot?: TaskExecutionSensitivity,
): Promise<SensitivityAssessment> {
  if (task.contextRefs?.length) {
    task.contextResolution = await resolveContextRefs(
      task.contextRefs,
      task.contextBudget,
      munin,
      { externalPolicy: config.externalPolicy },
    );
  }

  const assessment = trustedSnapshot
    ? {
        declared: trustedSnapshot.declared,
        effective: trustedSnapshot.effective,
        detectorMax: trustedSnapshot.detectorMax ?? trustedSnapshot.effective,
        mismatch: trustedSnapshot.mismatch,
        reasons: trustedSnapshot.reasons ?? [],
        override: trustedSnapshot.override,
      }
    : getTaskSensitivityAssessment(task);
  task.effectiveSensitivity = assessment.effective;
  task.sensitivityAssessment = assessment;
  task.sensitivitySnapshot = trustedSnapshot;

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
  result: TaskSignatureAssessment;
  provenance: TaskSubmissionProvenance;
  reject: boolean;
  message: string;
}

function assessTaskEntrySignature(
  taskNs: string,
  content: string,
  parsedTask: TaskConfig | null,
  submittedBy: string,
  isPipeline: boolean,
): SigningVerdict {
  const policy = config.signingPolicy;
  const signatureRaw = extractSignatureField(content);

  if (policy === "off") {
    const parsedSignature = parseSignature(signatureRaw);
    const result: TaskSignatureAssessment = {
      status: "unverified",
      keyId: parsedSignature?.keyId,
      reason: "signature verification disabled by policy",
    };
    return {
      result,
      provenance: buildTaskSubmissionProvenance(submittedBy, policy, result),
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
    const result: TaskSignatureAssessment = {
      status: "internal-exempt",
      reason: "internally-generated task is exempt from signature policy",
    };
    return {
      result,
      provenance: buildTaskSubmissionProvenance(submittedBy, policy, result),
      reject: false,
      message: "",
    };
  }

  // Pipeline parent tasks don't produce a TaskConfig here — the HMAC
  // scheme binds prompt/context-refs, which pipelines express differently
  // (### Pipeline instead of ### Prompt). Until pipeline signing lands we
  // cannot accept these under `require`; `warn` passes through.
  if (isPipeline || !parsedTask) {
    const parsedSignature = parseSignature(signatureRaw);
    const result: TaskSignatureAssessment = {
      status: "unverifiable",
      keyId: parsedSignature?.keyId,
      reason: isPipeline
        ? "pipeline tasks cannot be verified by the v1 scheme"
        : "task fields required by the v1 scheme could not be parsed",
    };
    if (signingPolicyRejects(policy, result.status)) {
      return {
        result,
        provenance: buildTaskSubmissionProvenance(submittedBy, policy, result),
        reject: true,
        message:
          `Task rejected by HUGIN_SIGNING_POLICY=require: ${result.reason}`,
      };
    }
    return {
      result,
      provenance: buildTaskSubmissionProvenance(submittedBy, policy, result),
      reject: false,
      message: "",
    };
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

  const result = verifyTaskSignature(params, signatureRaw, config.submitterKeys, {
    maxAgeS: config.signingMaxAgeS,
  });

  if (result.status === "valid") {
    console.log(`[signing] task ${taskNs} signature valid (keyId=${result.keyId})`);
    return {
      result,
      provenance: buildTaskSubmissionProvenance(submittedBy, policy, result),
      reject: false,
      message: "",
    };
  }

  const descriptor =
    result.status === "missing"
      ? "missing Signature field"
      : `${result.status}${result.reason ? ` (${result.reason})` : ""}`;

  if (policy === "warn") {
    console.warn(`[signing] task ${taskNs} ${descriptor} — policy=warn, proceeding`);
    return {
      result,
      provenance: buildTaskSubmissionProvenance(submittedBy, policy, result),
      reject: false,
      message: "",
    };
  }

  // policy === "require"
  if (!signingPolicyRejects(policy, result.status)) {
    return {
      result,
      provenance: buildTaskSubmissionProvenance(submittedBy, policy, result),
      reject: false,
      message: "",
    };
  }
  return {
    result,
    provenance: buildTaskSubmissionProvenance(submittedBy, policy, result),
    reject: true,
    message: `Task rejected by HUGIN_SIGNING_POLICY=require: ${descriptor}`,
  };
}

function formatTaskProvenance(provenance: TaskSubmissionProvenance): string {
  return (
    `[provenance] claimed=${JSON.stringify(provenance.claimedSubmitter)} ` +
    `verified=${provenance.verifiedSubmitter === null ? "none" : JSON.stringify(provenance.verifiedSubmitter)} ` +
    `policy=${provenance.policy} signature=${provenance.signatureStatus} ` +
    `keyId=${provenance.keyId === null ? "none" : JSON.stringify(provenance.keyId)}`
  );
}

async function resolveTaskProvenance(
  taskNs: string,
  client: MuninClient,
): Promise<TaskSubmissionProvenance> {
  const cached = taskProvenance.get(taskNs);
  if (cached) return cached;

  const entry = await client.read(taskNs, "status");
  const content = entry?.content ?? "";
  const declaredRuntime = parseDeclaredRuntime(content);
  const parsedTask =
    declaredRuntime && declaredRuntime !== "pipeline" ? parseTask(content) : null;
  return assessTaskEntrySignature(
    taskNs,
    content,
    parsedTask,
    parseSubmittedByField(content),
    declaredRuntime === "pipeline",
  ).provenance;
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
  const provenance = result.provenance ?? await resolveTaskProvenance(taskNs, client);
  await client.write(
    taskNs,
    "result-structured",
    JSON.stringify(buildStructuredTaskResult({ ...result, provenance }), null, 2),
    ["type:task-result", "type:task-result-structured"],
    undefined,
    classification,
  );
  taskProvenance.delete(taskNs);
  try {
    await client.log(taskNs, formatTaskProvenance(provenance));
  } catch (err) {
    console.warn(
      `[provenance] failed to append lifecycle log for ${taskNs}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
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
): DispatcherRuntime {
  return (tags.find((tag) => tag.startsWith("runtime:")) || runtimeFallback).replace(
    /^runtime:/,
    ""
  ) as DispatcherRuntime;
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

/**
 * Probe the Pi's Claude credential against the OAuth usage endpoint.
 *
 * Doubles as the quota snapshot source AND the pre-flight auth signal (issue
 * #129): the usage endpoint is authed with the same OAuth token the SDK task
 * uses, so a definitive 401 here means the task run would 401 too. `auth`:
 * - `ok`           — endpoint returned 2xx, credential is valid.
 * - `unauthorized` — endpoint returned 401, credential is expired/absent.
 * - `unknown`      — no creds file, no token, network error, a non-401 HTTP
 *                    status (incl. 403 — a forbidden *endpoint* is not a bad
 *                    *credential*, and the SDK auth may still work), or any
 *                    other non-auth failure. Callers MUST fail open on `unknown`
 *                    so a transient probe glitch never blocks a fine task.
 */
async function probeClaudeUsage(): Promise<{
  auth: "ok" | "unauthorized" | "unknown";
  snapshot: QuotaSnapshot;
  /**
   * Effective credential expiry (epoch ms), or null when there is nothing to
   * pre-warn about. NOTE: the credential file's `expiresAt` is the SHORT-LIVED
   * *access* token's expiry (~8h), which Claude Code silently auto-refreshes
   * using the long-lived `refreshToken` in the same file — so it is NOT when
   * autonomous tasks break. We therefore only surface `expiresAt` as a real
   * expiry when NO refresh token is present (nothing can auto-refresh it);
   * otherwise null, and we rely on the actual `unauthorized` transition (a
   * failed refresh / logout) to alarm. Prevents an ~8h false-alarm loop.
   */
  expiresAtMs: number | null;
  expiryEvidence: "known" | "not-applicable" | "unknown";
}> {
  const none: QuotaSnapshot = { q5: null, q7: null };
  let expiresAtMs: number | null = null;
  let expiryEvidence: "known" | "not-applicable" | "unknown" = "unknown";
  try {
    const credPath = path.join(process.env.HOME || "/home/magnus", ".claude", ".credentials.json");
    const creds = JSON.parse(fs.readFileSync(credPath, "utf-8"));
    const token = creds?.claudeAiOauth?.accessToken;
    const rawExpiry = creds?.claudeAiOauth?.expiresAt;
    const hasRefreshToken =
      typeof creds?.claudeAiOauth?.refreshToken === "string" &&
      creds.claudeAiOauth.refreshToken.length > 0;
    if (hasRefreshToken) {
      expiryEvidence = "not-applicable";
    } else if (
      !hasRefreshToken &&
      typeof rawExpiry === "number" &&
      Number.isFinite(rawExpiry)
    ) {
      expiresAtMs = rawExpiry;
      expiryEvidence = "known";
    }
    if (!token) return { auth: "unknown", snapshot: none, expiresAtMs, expiryEvidence };

    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        "anthropic-beta": "oauth-2025-04-20",
        "Authorization": `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) {
      // A 401 from the file's access token is only CONCLUSIVE when there is no
      // refresh token. With a refresh token present, Claude Code refreshes the
      // (merely stale) access token on next use — so the probe must NOT claim
      // the credential is dead: that would false-alarm AND make the #130
      // pre-flight block an overnight task that would have refreshed and
      // succeeded (regressing #129). Fail open to `unknown`; the reliable
      // dead-credential signal is an actual runtime AUTH_FAILED, fed into the
      // alarm reactively (see noteClaudeAuthOutcome).
      return {
        auth: hasRefreshToken ? "unknown" : "unauthorized",
        snapshot: none,
        expiresAtMs,
        expiryEvidence,
      };
    }
    if (!res.ok) return { auth: "unknown", snapshot: none, expiresAtMs, expiryEvidence };
    const data = await res.json() as Record<string, Record<string, number>>;
    return {
      auth: "ok",
      snapshot: {
        q5: data?.five_hour?.utilization ?? null,
        q7: data?.seven_day?.utilization ?? null,
      },
      expiresAtMs,
      expiryEvidence,
    };
  } catch {
    return { auth: "unknown", snapshot: none, expiresAtMs, expiryEvidence };
  }
}

async function fetchQuota(): Promise<QuotaSnapshot> {
  return (await probeClaudeUsage()).snapshot;
}

// --- Version-drift self-check (#123) ---

// Resolves via Node's own module resolution (not a hardcoded src/vs-dist
// relative path), so it always finds whichever @anthropic-ai/claude-agent-sdk
// this running process actually imported. Resolves the bare package specifier
// (its main entry, sdk.mjs) rather than a subpath — the package's `exports`
// map does NOT expose `./package.json` or `./cli.js` as subpaths, so
// resolving those directly throws ERR_PACKAGE_PATH_NOT_EXPORTED. sdk.mjs
// lives in the package root alongside package.json and cli.js, so its
// dirname is the directory we actually want.
const requireFromHere = createRequire(import.meta.url);

function resolveClaudeSdkDir(): string {
  return path.dirname(requireFromHere.resolve("@anthropic-ai/claude-agent-sdk"));
}

/**
 * Read the on-disk SDK version + vendored cli.js identity. Dependency-light:
 * only `fs`/`path`, no hashing of the (multi-MB) cli.js bundle — size + mtime
 * are a cheap, sufficient proxy for "did the binary content change". Throws on
 * any read error; callers decide how to fail open.
 */
function readOnDiskVersionSnapshot(sdkDir: string): VersionSnapshot {
  const pkg = JSON.parse(fs.readFileSync(path.join(sdkDir, "package.json"), "utf-8")) as {
    version?: string;
  };
  const cliPath = path.join(sdkDir, "cli.js");
  const stat = fs.statSync(cliPath);
  return buildVersionSnapshot({
    sdkVersion: pkg.version,
    cliPath,
    cliSizeBytes: stat.size,
    cliMtimeMs: stat.mtimeMs,
  });
}

// Baseline snapshot taken once at process start — this is what the running
// process actually has loaded (Node caches the imported SDK module for the
// life of the process, even if node_modules is overwritten on disk later).
// null means either the check is disabled or the startup snapshot failed
// (logged below); either way the drift check fails open and never runs.
let versionDriftBaseline: VersionSnapshot | null = null;
if (config.versionDriftCheck) {
  try {
    versionDriftBaseline = readOnDiskVersionSnapshot(resolveClaudeSdkDir());
    console.log(
      `[version-drift] baseline snapshot: sdk=${versionDriftBaseline.sdkVersion} ` +
        `cli=${versionDriftBaseline.cliPath} (${versionDriftBaseline.cliSizeBytes}b, ` +
        `mtime=${new Date(versionDriftBaseline.cliMtimeMs).toISOString()})`,
    );
  } catch (err) {
    console.error(
      "[version-drift] Failed to snapshot on-disk SDK/binary state at startup — drift self-check disabled for this process run:",
      err,
    );
  }
}

/**
 * Re-read the on-disk SDK/binary state and compare against the startup
 * baseline. Fail-open by design (issue #123): any read error here — a
 * mid-`npm install` partial write, a permissions hiccup — must never block a
 * task, so it is caught and treated as "no drift detected" rather than
 * propagated. Only a genuine, confirmed mismatch returns non-null.
 */
function checkVersionDrift(): VersionDriftResult | null {
  if (!versionDriftBaseline) return null;
  try {
    const current = readOnDiskVersionSnapshot(resolveClaudeSdkDir());
    const result = compareVersionSnapshots(versionDriftBaseline, current);
    return result.drifted ? result : null;
  } catch (err) {
    console.error(
      "[version-drift] Failed to read on-disk SDK/binary state before task — skipping drift check for this task (fail-open):",
      err,
    );
    return null;
  }
}

// Edge-triggered like the auth alarm (#131): once the drift alert has been
// successfully delivered (or there is no send target configured), don't
// re-push it on every subsequent refused task — the worker still refuses
// EVERY task while drifted, only the alert push is deduped. A process restart
// re-takes the baseline and may resolve a previously persisted firing alert.
let versionDriftAlerted = false;
let versionDriftAlarmLifecycle: VersionDriftAlertLifecycle =
  INITIAL_VERSION_DRIFT_ALERT_LIFECYCLE;
let versionDriftFiringPersistencePending = false;
const VERSION_DRIFT_ALARM_NS = "tasks/_version_drift_alarm";

async function hydrateVersionDriftAlarmState(): Promise<void> {
  try {
    const entry = await reaperMunin.read(VERSION_DRIFT_ALARM_NS, "state");
    if (!entry) return;
    const parsed = JSON.parse(entry.content) as { active?: unknown };
    versionDriftAlarmLifecycle = hydrateVersionDriftAlertLifecycle(
      parsed.active === true,
      versionDriftBaseline !== null,
    );
  } catch {
    // Missing/malformed state means there is no proven external firing alert.
  }
}

async function persistVersionDriftAlarmState(active: boolean): Promise<boolean> {
  try {
    await reaperMunin.write(
      VERSION_DRIFT_ALARM_NS,
      "state",
      JSON.stringify({ active }),
      ["version-drift-alarm"],
    );
    return true;
  } catch (err) {
    console.error("[version-drift] Failed to persist alert state:", err);
    return false;
  }
}

async function maybeResolveVersionDriftAlert(): Promise<void> {
  const resolution = versionDriftStartupResolution(versionDriftAlarmLifecycle);
  if (!resolution) return;
  const status = await sendRatatoskrAlert(resolution);
  if (status !== "delivered") return;
  // Persist before clearing in-memory state. If persistence fails, the next
  // poll retries the idempotent resolution rather than forgetting it.
  const persisted = await persistVersionDriftAlarmState(false);
  versionDriftAlarmLifecycle = recordVersionDriftResolutionAttempt(
    versionDriftAlarmLifecycle,
    true,
    persisted,
  );
}

async function flushVersionDriftFiringState(): Promise<void> {
  if (!versionDriftFiringPersistencePending) return;
  if (await persistVersionDriftAlarmState(true)) {
    versionDriftFiringPersistencePending = false;
  }
}

async function maybeAlertVersionDrift(drift: VersionDriftResult): Promise<void> {
  if (versionDriftAlerted) return;
  const alert: AlertEnvelope = {
    severity: "critical",
    source: "hugin",
    title: "Hugin worker: on-disk SDK/binary changed under live process",
    body:
      `Agent-sdk tasks are being refused until the worker restarts. ${drift.message}`,
    dedup_key: VERSION_DRIFT_DEDUP_KEY,
  };
  const status = await sendRatatoskrAlert(alert);
  if (status === "delivered") {
    versionDriftAlarmLifecycle = recordVersionDriftFiring();
    versionDriftFiringPersistencePending =
      !(await persistVersionDriftAlarmState(true));
    versionDriftAlerted = true;
  } else if (status === "skipped") {
    // Nothing external was opened, but avoid repeating the local log for every
    // refused task in this process.
    versionDriftAlerted = true;
  }
}

/**
 * {@link SdkExecutorResult} plus, ONLY for a synthetic pre-flight
 * short-circuit, a trusted failure-kind discriminator. The caller already
 * knows with certainty which check refused the task — this lets the shared
 * finalize path classify it directly instead of regex-sniffing `output`
 * (Codex review, issue #123: a regex could false-positive on a legitimate
 * task's real output). Absent (undefined) for an actual SDK run, which keeps
 * classifying via {@link classifyClaudeFailure} exactly as before.
 */
interface PreflightCheckedSdkResult extends SdkExecutorResult {
  preflightFailureKind?: typeof AUTH_FAILURE_KIND | typeof DEPS_DRIFT_FAILURE_KIND;
}

/**
 * Run a Claude SDK task, but first refuse it fast on a confirmed drift or
 * auth problem instead of burning a paid, slot-consuming run that can only
 * fail:
 *  - (issue #123) the on-disk SDK/cli.js has changed since this worker
 *    process started (see checkVersionDrift above) — deps were bumped
 *    out-of-band under a live worker.
 *  - (issue #129) the Pi Claude credential is definitively invalid (401).
 * Both short-circuits are fail-open on anything inconclusive; only a
 * confirmed problem blocks.
 */
async function runClaudeSdkPreflight(
  taskId: string,
  logDir: string,
): Promise<PreflightCheckedSdkResult | null> {
  const drift = checkVersionDrift();
  if (drift) {
    const logFile = path.join(logDir, `${taskId}.log`);
    const reason = `Version-drift pre-flight check failed. DEPS_DRIFT: ${drift.message}`;
    try {
      fs.writeFileSync(
        logFile,
        [
          "=== Hugin Task Log (SDK) ===",
          `Task: ${taskId}`,
          "Runtime: claude (agent-sdk)",
          `Started: ${new Date().toISOString()}`,
          "===",
          reason,
          "",
          "===",
          "Exit code: 1",
          "Failure kind: DEPS_DRIFT",
          "===",
          "",
        ].join("\n"),
        { encoding: "utf-8" },
      );
    } catch {
      /* log is best-effort — never fail the task on a log write */
    }
    console.error(
      `Version-drift pre-flight check failed for task ${taskId} — refusing to spawn agent-sdk task (restart the worker)`,
    );
    await maybeAlertVersionDrift(drift).catch((err) =>
      console.error("[version-drift] Failed to send drift alert:", err),
    );
    return {
      exitCode: 1,
      output: reason,
      logFile,
      resultText: null,
      costUsd: 0,
      numTurns: 0,
      durationApiMs: 0,
      preflightFailureKind: DEPS_DRIFT_FAILURE_KIND,
    };
  }

  if (config.claudeAuthPreflight) {
    const probe = await probeClaudeUsage();
    if (probe.auth === "unauthorized") {
      const logFile = path.join(logDir, `${taskId}.log`);
      const reason =
        "Pre-flight Claude auth check failed. API Error: 401 authentication_error: " +
        "Invalid authentication credentials. Refresh the Pi's Claude Code credential.";
      try {
        fs.writeFileSync(
          logFile,
          [
            "=== Hugin Task Log (SDK) ===",
            `Task: ${taskId}`,
            "Runtime: claude (agent-sdk)",
            `Started: ${new Date().toISOString()}`,
            "===",
            reason,
            "",
            "===",
            "Exit code: 1",
            "Failure kind: AUTH_FAILED",
            "===",
            "",
          ].join("\n"),
          { encoding: "utf-8" },
        );
      } catch {
        /* log is best-effort — never fail the task on a log write */
      }
      console.error(
        `Pre-flight Claude auth check failed for task ${taskId} — short-circuiting to AUTH_FAILED (no paid run)`,
      );
      return {
        exitCode: 1,
        output: reason,
        logFile,
        resultText: null,
        costUsd: 0,
        numTurns: 0,
        durationApiMs: 0,
        preflightFailureKind: AUTH_FAILURE_KIND,
      };
    }
  }
  return null;
}

async function executeClaudeSdkWithPreflightChecks(
  cfg: SdkTaskConfig,
  taskId: string,
  logDir: string,
  options?: SdkExecutorOptions,
): Promise<PreflightCheckedSdkResult> {
  const refusal = await runClaudeSdkPreflight(taskId, logDir);
  return refusal ?? executeSdkTask(cfg, taskId, logDir, options);
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

interface SpawnRuntimeResult {
  exitCode: number | "TIMEOUT";
  output: string;
  logFile: string;
  preflightFailureKind?: typeof CODEX_SANDBOX_FAILURE_KIND;
  preflightFailureReason?: string;
}

let codexSandboxStatus: CodexSandboxProbeResult | null = null;

async function refreshCodexSandboxStatus(): Promise<CodexSandboxProbeResult> {
  const result = await probeCodexSandbox();
  codexSandboxStatus = result;
  if (result.available) {
    console.log(`[codex-sandbox] ready (${result.command})`);
  } else {
    console.error(`[codex-sandbox] unavailable: ${result.reason}`);
  }
  return result;
}

function spawnRuntime(
  task: TaskConfig,
  ctx: SpawnContext
): Promise<SpawnRuntimeResult> {
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
        ...buildTaskSubprocessEnv(),
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

async function runCodexPreflight(
  task: TaskConfig,
  ctx: SpawnContext,
): Promise<SpawnRuntimeResult | null> {
  const probe = await refreshCodexSandboxStatus();
  if (probe.available) return null;

  const taskId = extractTaskId(ctx.taskNs);
  const logFile = path.join(LOG_DIR, `${taskId}.log`);
  const reason = probe.reason || "Codex sandbox self-test failed without a diagnostic";
  try {
    fs.writeFileSync(
      logFile,
      [
        "=== Hugin Task Log (Codex preflight) ===",
        `Task: ${ctx.taskNs}`,
        `Started: ${new Date().toISOString()}`,
        "===",
        reason,
        "",
        "===",
        "Exit code: 1",
        `Failure kind: ${CODEX_SANDBOX_FAILURE_KIND}`,
        "No model was invoked.",
        "===",
        "",
      ].join("\n"),
      { encoding: "utf8" },
    );
  } catch {
    /* log is best-effort — never turn a known infra refusal into a crash */
  }
  return {
    exitCode: 1,
    output: reason,
    logFile,
    preflightFailureKind: CODEX_SANDBOX_FAILURE_KIND,
    preflightFailureReason: reason,
  };
}

async function executeCodexWithPreflightChecks(
  task: TaskConfig,
  ctx: SpawnContext,
): Promise<SpawnRuntimeResult> {
  const refusal = await runCodexPreflight(task, ctx);
  return refusal ?? spawnRuntime(task, ctx);
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
  return buildLeasedStatusTags(baseTags, lifecycle, workerId, leaseExpiry());
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
  if (currentOpencodeAbort && !currentOpencodeAbort.signal.aborted) {
    currentOpencodeAbort.abort(request.reason);
  }
  if (currentOrchestratorAbort && !currentOrchestratorAbort.signal.aborted) {
    currentOrchestratorAbort.abort(request.reason);
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
      const child = spawn("pgrep", ["-f", "node dist/index.js"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: buildTaskSubprocessEnv(),
      });
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

async function writeSensitivityCheckpoint(
  taskNs: string,
  taskContent: string,
  sensitivity: TaskExecutionSensitivity | undefined,
  client: MuninClient,
  classification?: string,
): Promise<void> {
  if (!sensitivity || config.sensitivityCheckpointSecret.length < 32) return;
  await client.write(
    taskNs,
    SENSITIVITY_CHECKPOINT_KEY,
    buildSensitivityCheckpoint(
      taskNs,
      taskContent,
      sensitivity,
      config.sensitivityCheckpointSecret,
    ),
    [...SENSITIVITY_CHECKPOINT_TAGS],
    undefined,
    classification,
  );
}

async function readSensitivityCheckpoint(
  taskNs: string,
  taskContent: string,
  client: MuninClient,
): Promise<TaskExecutionSensitivity | undefined> {
  try {
    const entry = await client.read(taskNs, SENSITIVITY_CHECKPOINT_KEY);
    if (!entry?.content) return undefined;
    return parseSensitivityCheckpoint(
      entry.content,
      taskNs,
      taskContent,
      config.sensitivityCheckpointSecret,
    );
  } catch {
    return undefined;
  }
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
  const recoverySensitivity =
    await readSensitivityCheckpoint(taskNs, entry.content, client) ??
    (task
      ? buildTaskSensitivitySnapshot(getTaskSensitivityAssessment(task))
      : undefined);

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
    buildClaimedTerminalStatusTags(
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
      sensitivity: recoverySensitivity,
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
  await client.log(
    taskNs,
    `Delivery reconciled: ${delivery.ok ? "verified" : "failed"}`,
  );
  await promoteDependents(extractTaskId(taskNs), client);
  await refreshPipelineSummaryFromContent(entry.content, client);
}

// Operational sweeps must see beyond Munin's 50-row response cap, but they
// also run on timers and cannot be allowed to turn one backlog into unbounded
// network/read work. Repeated sweeps drain the bounded window as lifecycle
// tags are cleared. `truncated` is logged so operators know the pass was a
// lower bound rather than a complete census.
const OPERATIONAL_SCAN_BUDGET = { maxPages: 4, maxResults: 200 } as const;
const operationalScanCursors = new Map<string, string>();

async function queryOperationalTaskEntries(
  client: MuninClient,
  tags: string[],
  label: string,
): Promise<import("./munin-client.js").MuninQueryResult[]> {
  const cursorKey = `${label}\0${tags.join("\0")}`;
  const until = operationalScanCursors.get(cursorKey);
  const page = await queryAllMuninEntries(
    client,
    {
      tags,
      namespace: "tasks/",
      entry_type: "state",
      ...(until ? { until } : {}),
    },
    OPERATIONAL_SCAN_BUDGET,
  );
  if (page.budgetExhausted) {
    if (page.continuationUntil) {
      operationalScanCursors.set(cursorKey, page.continuationUntil);
    } else {
      operationalScanCursors.delete(cursorKey);
    }
    console.warn(
      `${label}: operational scan reached its ${OPERATIONAL_SCAN_BUDGET.maxResults}-entry budget; ` +
        "this pass is a lower bound and the next sweep will continue from the oldest scanned timestamp",
    );
  } else {
    // The older tail is exhausted. Restart at the newest edge next time so
    // entries created or retagged while this scan rotated are observed.
    operationalScanCursors.delete(cursorKey);
  }
  return page.results;
}

async function recoverPreparedLearningAttempt(
  taskNs: string,
  classification?: string,
): Promise<RecoveredStoredLearningTask | null> {
  return recoverLatestStoredLearningTaskAttempt({
    munin,
    taskNamespace: taskNs,
    taskClassification: classification,
    gateway: loadHomeserverGatewayConfig(process.env),
  });
}

async function recoverStaleTasks(): Promise<void> {
  try {
    const results = await queryOperationalTaskEntries(munin, ["running"], "startup recovery");

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
      const learningRecovery = runtimeTag === "runtime:homeserver"
        ? await recoverPreparedLearningAttempt(result.namespace, entry.classification)
        : null;
      const recoveryOutputClassification = learningRecovery?.classification
        ?? entry.classification;
      await munin.write(
        result.namespace,
        "status",
        entry.content,
        buildClaimedTerminalStatusTags("failed", entry.tags),
        entry.updated_at,
        recoveryOutputClassification,
      );
      await munin.write(
        result.namespace,
        "result",
        `## Result\n\n- **Exit code:** ${DISPATCHER_FAILURE_EXIT_CODE}\n- **Error:** Task recovered (${reason}, worker: ${claimedBy || "unknown"}, elapsed: ${elapsed}s)\n`,
        undefined,
        undefined,
        recoveryOutputClassification,
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
            ...(learningRecovery
              ? {
                  runtimeMetadata: {
                    huginTaskIdentity: learningRecovery.huginTaskIdentity,
                    learningTask: learningRecovery.evidence,
                  },
                }
              : {}),
          }
        ),
        recoveryOutputClassification,
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
    const results = await queryOperationalTaskEntries(
      reaperMunin,
      ["running"],
      "lease reaper",
    );

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
          buildClaimedTerminalStatusTags("failed", entry.tags),
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
    const results = await queryOperationalTaskEntries(
      reaperMunin,
      ["running", "delivery:pending"],
      "delivery retry reaper",
    );
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

// --- Proactive Claude auth-expiry alarm (#131) ---

const AUTH_ALARM_NS = "tasks/_auth_alarm";

/**
 * Deliver an alert envelope to the user via Ratatoskr's Alert Bus
 * (POST /api/send → Telegram + Heimdall echo). Best-effort: a missing send
 * target or a network error is logged and swallowed so the alarm loop never
 * throws. The alarm condition is always `console.error`'d regardless, so the
 * journal has it even when the push can't go out.
 */
// `delivered` — Ratatoskr accepted it (2xx). `skipped` — no send target
// configured, nothing more we can do (treated as terminal so we don't re-log
// every tick). `failed` — configured but the push errored/non-2xx, so the
// caller must NOT advance the edge state and should retry next tick.
async function sendRatatoskrAlert(alert: AlertEnvelope): Promise<AlertDeliveryStatus> {
  const logLine = alert.state === "resolved"
    ? `[alert-bus] resolved: ${alert.dedup_key ?? "unknown"}`
    : `[alert-bus] ${alert.severity ?? "info"}: ${alert.title ?? "untitled"}`;
  if (alert.severity === "error" || alert.severity === "critical") {
    console.error(logLine);
  } else {
    console.warn(logLine);
  }
  if (!config.ratatoskrSendUrl || !config.ratatoskrSendApiKey || config.authAlarmChatId === null) {
    console.warn(
      "[auth-alarm] Ratatoskr send target not fully configured — alarm logged but not pushed to Telegram",
    );
    return "skipped";
  }
  try {
    const res = await fetch(config.ratatoskrSendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.ratatoskrSendApiKey}`,
      },
      body: JSON.stringify({ chat_id: config.authAlarmChatId, alert }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[auth-alarm] Ratatoskr /api/send returned ${res.status}`);
      return "failed";
    }
    return "delivered";
  } catch (err) {
    console.error("[auth-alarm] Failed to push alarm to Ratatoskr:", err);
    return "failed";
  }
}

/**
 * Hydrate the edge-trigger state from Munin on startup so a dispatcher restart
 * doesn't re-fire an alarm for a condition already notified before the restart.
 * A missing/malformed entry falls back to the initial state (fail-safe: the
 * worst case is one duplicate alert, never a missed one).
 */
async function hydrateAuthAlarmState(): Promise<void> {
  try {
    const entry = await reaperMunin.read(AUTH_ALARM_NS, "state");
    if (!entry) return;
    authAlarmState = hydratePersistedAuthAlarmState(JSON.parse(entry.content));
  } catch {
    // Keep INITIAL_AUTH_ALARM_STATE.
  }
}

async function persistAuthAlarmState(): Promise<void> {
  try {
    await reaperMunin.write(
      AUTH_ALARM_NS,
      "state",
      JSON.stringify(authAlarmState),
      ["auth-alarm"],
    );
  } catch (err) {
    console.error("[auth-alarm] Failed to persist alarm state:", err);
  }
}

// Serialize all mutations of `authAlarmState`. The periodic reaper AND the
// reactive task-outcome path (noteClaudeAuthOutcome) both drive the same edge
// state; without this a reaper `ok` read racing a reactive `unauthorized` could
// lost-update and mask the critical alert. The chain queues rather than drops,
// so no reading is lost. Frequency is tiny (hourly probe + task completions),
// so the queue is effectively never deep.
let authAlarmLock: Promise<void> = Promise.resolve();
function withAuthAlarmLock(fn: () => Promise<void>): Promise<void> {
  const run = authAlarmLock.then(fn, fn);
  authAlarmLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * Apply one auth reading to the alarm state machine: decide → deliver → commit.
 * MUST be called while holding {@link withAuthAlarmLock}. Delivery gates the
 * commit (Codex review, High): a `failed` push holds the old state so the SAME
 * alert retries; `delivered`/`skipped` let the transition commit.
 */
async function applyAuthReadingLocked(reading: {
  auth: "ok" | "unauthorized" | "unknown";
  expiresAtMs: number | null;
  expiryEvidence?: "known" | "not-applicable" | "unknown";
}): Promise<void> {
  const prevState = authAlarmState;
  const { alerts, nextState } = decideAuthAlarm(prevState, reading, {
    nowMs: Date.now(),
    expiryWarnMs: config.authAlarmExpiryWarnMs,
  });

  let allDelivered = true;
  for (const alert of alerts) {
    const status = await sendRatatoskrAlert(alert);
    // A firing alert may commit when no transport is configured (the existing
    // anti-spam behavior). A resolution is an external state mutation: only a
    // confirmed Ratatoskr 2xx may clear the persisted firing state.
    if (!alertDeliveryCommitsTransition(alert, status)) {
      allDelivered = false;
    }
  }
  if (alerts.length > 0 && !allDelivered) {
    // Hold the old state; retry the undelivered alert on the next reading.
    return;
  }

  const changed =
    nextState.lastAuth !== prevState.lastAuth ||
    nextState.expiryWarned !== prevState.expiryWarned ||
    nextState.expiryAlertLifecycleVersion !== prevState.expiryAlertLifecycleVersion;
  authAlarmState = nextState;
  if (changed) {
    await persistAuthAlarmState();
  }
}

function processAuthReading(reading: {
  auth: "ok" | "unauthorized" | "unknown";
  expiresAtMs: number | null;
  expiryEvidence?: "known" | "not-applicable" | "unknown";
}): Promise<void> {
  return withAuthAlarmLock(() => applyAuthReadingLocked(reading));
}

async function runAuthAlarmProbe(): Promise<void> {
  // Probe INSIDE the lock (Codex review, TOCTOU): if the network probe ran
  // outside it, a slow `ok` reading captured before a newer reactive
  // `unauthorized` could be applied AFTER it — a false recovery masking the real
  // alarm. Acquiring the lock first makes readings apply in lock-acquisition
  // order and the probe reflect reality at apply time.
  await withAuthAlarmLock(async () => {
    const probe = await probeClaudeUsage();
    await applyAuthReadingLocked({
      auth: probe.auth,
      expiresAtMs: probe.expiresAtMs,
      expiryEvidence: probe.expiryEvidence,
    });
  });
}

/**
 * Feed a CONFIRMED Claude runtime auth outcome into the alarm (#131). Unlike the
 * periodic probe against a possibly-stale access token, an actual task result is
 * authoritative: an `AUTH_FAILED` classification means the credential is truly
 * dead (a failed refresh / logout), and a success means it authenticates. This
 * is the reliable proactive-alarm trigger for the normal (refresh-token-present)
 * credential the probe can't conclusively judge. Deduped by the shared edge
 * state, so N failing overnight tasks yield ONE alert, not N.
 */
async function noteClaudeAuthOutcome(auth: "ok" | "unauthorized"): Promise<void> {
  if (!config.authAlarm) return;
  await processAuthReading({ auth, expiresAtMs: null, expiryEvidence: "unknown" });
}

function startAuthAlarmReaper(): void {
  stopAuthAlarmReaper();
  if (!config.authAlarm) return;
  authAlarmTimer = setInterval(() => {
    if (authAlarmInFlight || shuttingDown) return;
    authAlarmInFlight = true;
    void runAuthAlarmProbe()
      .catch((err) => console.error("[auth-alarm] Periodic probe failed:", err))
      .finally(() => {
        authAlarmInFlight = false;
      });
  }, config.authAlarmIntervalMs);
}

function stopAuthAlarmReaper(): void {
  if (authAlarmTimer) {
    clearInterval(authAlarmTimer);
    authAlarmTimer = null;
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
    const results = await queryOperationalTaskEntries(
      client,
      ["blocked", `depends-on:${completedTaskId}`],
      `dependency scan for ${completedTaskId}`,
    );

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

    if (promoted > 0 || failed > 0) {
      console.log(
        `Dependency scan for ${completedTaskId}: promoted=${promoted}, failed=${failed}, scanned=${results.length}`
      );
    }
  } catch (err) {
    console.error(`Failed to promote dependents for ${completedTaskId}:`, err);
  }
}

async function reconcileBlockedTasks(): Promise<void> {
  try {
    const results = await queryOperationalTaskEntries(
      munin,
      ["blocked"],
      "blocked-task reconciliation",
    );

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

    if (promoted > 0 || failed > 0) {
      console.log(
        `Blocked-task reconciliation: promoted=${promoted}, failed=${failed}, scanned=${results.length}`
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
  const results = await queryOperationalTaskEntries(
    munin,
    ["awaiting-approval"],
    "approval decisions",
  );

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
  const results = await queryOperationalTaskEntries(
    munin,
    [CANCEL_REQUESTED_TAG],
    "cancellation requests",
  );

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

    if (shouldDeferCancellationToClaimOwner(entry.tags)) {
      // This generic scanner has no independent proof that a lifecycle tag
      // followed Hugin's claim CAS. The active owner watches cancellation and
      // preserves its dispatcher-owned pointer; stale owners are reconciled by
      // startup/lease recovery. Never promote a caller-supplied pointer here.
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
  const results = await queryOperationalTaskEntries(
    munin,
    [RESUME_REQUESTED_TAG],
    "resume requests",
  );

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
  preserveClaimedSchedulerPointer = false,
): Promise<void> {
  const runtime = (
    runtimeTagOverride ||
    entry.tags.find((tag) => tag.startsWith("runtime:")) ||
    "runtime:claude"
  ).replace(/^runtime:/, "") as DispatcherRuntime;
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
    preserveClaimedSchedulerPointer
      ? buildClaimedTerminalStatusTags("failed", entry.tags, runtimeTagOverride)
      : buildTerminalStatusTags("failed", entry.tags, runtimeTagOverride),
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

// --- Heartbeat ---

async function emitHeartbeat(blockedTasks: number): Promise<void> {
  try {
    const heartbeat: Record<string, unknown> = {
      worker_id: workerId,
      process_instance_id: processInstanceId,
      polled_at: new Date().toISOString(),
      ...buildQueueObservabilityFields(lastPendingQueueSnapshot),
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

/** Enumerate the complete pending window and claim the oldest eligible task. */
async function pollOnce(): Promise<{ hadTask: boolean; queueDepth: number }> {
  const [pendingPage, runningPage] = await Promise.all([
    queryAllMuninEntries(munin, {
      tags: ["pending"],
      namespace: "tasks/",
      entry_type: "state",
    }),
    // Query running tasks to support group sequencing checks.
    queryAllMuninEntries(munin, {
      tags: ["running"],
      namespace: "tasks/",
      entry_type: "state",
    }),
  ]);
  const results = pendingPage.results;
  const runningResults = runningPage.results;
  lastPendingQueueSnapshot = snapshotPendingQueue(results, pendingPage.truncated);
  const paginationTruncated = pendingPage.truncated || runningPage.truncated;
  const warningNowMs = Date.now();
  if (shouldWarnQueueTruncation(
    paginationTruncated,
    warningNowMs,
    lastQueueTruncationWarningAtMs,
  )) {
    console.warn(
      "Task queue pagination is truncated by a >=50-entry same-millisecond updated_at bucket; " +
      "claiming continues from visible rows and affected enumeration counts are lower bounds",
    );
    lastQueueTruncationWarningAtMs = warningNowMs;
  }

  // Orchestrator v1 tasks (broker-submitted, tagged "orch-v1") are dispatched
  // by the Pi-side broker, not by the legacy in-process poller. Filter them
  // out so the dispatcher does not greedily claim a runtime:openrouter or
  // runtime:pi-harness task and fail it as "missing prompt or runtime".
  // See docs/orchestrator-v1-data-model.md §3 for the broker submit path.
  const dispatchableResults = results.filter(
    (r) => !r.tags.includes("orch-v1"),
  );
  const queueDepth = lastPendingQueueSnapshot.pendingCount;

  // Select the next eligible task respecting Group/Sequence ordering (FIFO within eligible set)
  const taskResult = selectNextTask(dispatchableResults, runningResults);
  if (!taskResult) return { hadTask: false, queueDepth };

  const taskNs = taskResult.namespace;
  const updatePendingQueueSnapshotAfterDeparture = (): void => {
    lastPendingQueueSnapshot = snapshotPendingQueueAfterDeparture(
      results,
      pendingPage.truncated,
      taskNs,
    );
  };
  const pendingTaskDeparted = (hadTask: boolean = true) => {
    updatePendingQueueSnapshotAfterDeparture();
    return { hadTask, queueDepth };
  };
  const entry = await munin.read(taskNs, "status");
  if (!entry) return { hadTask: false, queueDepth };

  // Verify it's still pending (another dispatcher might have claimed it)
  if (!entry.tags.includes("pending")) {
    console.log(`Task ${taskNs} no longer pending, skipping`);
    return pendingTaskDeparted(false);
  }

  if (entry.tags.includes(CANCEL_REQUESTED_TAG)) {
    if (parseDeclaredRuntime(entry.content) === "pipeline" || entry.tags.includes("runtime:pipeline")) {
      const processed = await processPipelineCancellationRequest(entry);
      if (!processed) return { hadTask: true, queueDepth };
      const refreshedEntry = await munin.read(taskNs, "status");
      if (refreshedEntry?.tags.includes("pending")) {
        return { hadTask: true, queueDepth };
      }
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
    return pendingTaskDeparted();
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
    return pendingTaskDeparted();
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
    return pendingTaskDeparted();
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
    return pendingTaskDeparted();
  }

  // Verify task signature per HUGIN_SIGNING_POLICY
  const signingVerdict = assessTaskEntrySignature(
    taskNs,
    entry.content,
    parsedTask,
    submittedBy,
    declaredRuntime === "pipeline",
  );
  taskProvenance.set(taskNs, signingVerdict.provenance);
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
    return pendingTaskDeparted();
  }

  if (parsedTask?.baseBranchError) {
    const rejection = `Repository base branch invalid: ${parsedTask.baseBranchError}`;
    console.warn(`Rejecting task ${taskNs}: ${rejection}`);
    await failTaskWithMessage(taskNs, entry, rejection);
    await munin.log(taskNs, `Task rejected before execution: ${rejection}`);
    await promoteDependents(extractTaskId(taskNs));
    await refreshPipelineSummaryFromContent(entry.content);
    return pendingTaskDeparted();
  }

  if (declaredRuntime !== "pipeline" && parsedTask) {
    const trustedPipelineSensitivity =
      parsedTask.pipeline && entry.tags.includes("type:pipeline-phase")
        ? await readSensitivityCheckpoint(taskNs, entry.content, munin)
        : undefined;
    const sensitivityAssessment = await assessTaskSecurity(
      parsedTask,
      trustedPipelineSensitivity,
    );

    // Local-skill lane pre-step (issue #84), GUARDED by HUGIN_SKILL_LANE.
    // Default OFF ⇒ consultSkillLane returns null ⇒ a true no-op: the dispatcher
    // proceeds with the existing cloud auto-router exactly as before. When ON, it
    // fails closed to cloud unless a fully verified `active` RouteBinding is
    // selectable — which requires authored slice-one artifacts driven to active
    // against a real local cell (a deliberate human go-live step). Until then the
    // lane only ever records an abstain audit record; it never short-circuits to a
    // local executor here (the local executor itself is a separate go-live step).
    try {
      const laneResult = await consultSkillLane(
        {
          prompt: parsedTask.prompt,
          sensitivity: sensitivityAssessment.effective,
        },
        munin,
        { enabled: config.skillLaneEnabled },
      );
      if (laneResult) {
        parsedTask.skillRoute = laneResult.skillRoute;
        if (laneResult.selectedLocal) {
          // Defense-in-depth: slice-one ships no active binding and there is no
          // local executor wired here yet. If a future change makes the lane
          // select local, refuse to silently mis-route — record the abstain and
          // fall through to cloud rather than pretend to execute locally.
          console.warn(
            `[skill-lane] ${taskNs}: lane selected a local route but no local ` +
              `executor is wired; falling through to cloud (binding ` +
              `${laneResult.skillRoute.bindingId ?? "?"}).`,
          );
          parsedTask.skillRoute = {
            ...laneResult.skillRoute,
            abstained: true,
            abstainReason: "local-executor-not-wired",
          };
        } else {
          console.log(
            `[skill-lane] ${taskNs}: fall-through (${laneResult.skillRoute.abstainReason ?? "abstain"}) → cloud`,
          );
        }
      }
    } catch (err) {
      // Fail-closed: any lane error must never block the existing cloud path.
      console.warn(
        `[skill-lane] ${taskNs}: consultation failed, ignoring (cloud path unaffected):`,
        err instanceof Error ? err.message : String(err),
      );
    }

    // Auto-route: resolve concrete runtime before security check (defense-in-depth)
    if (parsedTask.autoRouted) {
      try {
        const ollamaHosts = await probeAllHosts();
        const activeSubscriptions = parseActiveSubscriptions(
          process.env.HUGIN_ACTIVE_SUBSCRIPTIONS,
        );
        const candidates = buildRuntimeCandidates(ollamaHosts, { activeSubscriptions });
        const decision = routeTask({
          effectiveSensitivity: sensitivityAssessment.effective,
          capabilities: parsedTask.capabilities,
          preferredModel: parsedTask.model,
          availableRuntimes: candidates,
        });
        // Auto-router is contractually required to exclude autoEligible:false
        // runtimes (opencode, openrouter, pi-harness). Verify rather than cast — if this
        // ever fires, the contract was violated upstream and the dispatcher
        // cannot execute the selection.
        const selectedRuntime = decision.selectedRuntime.dispatcherRuntime;
        if (!isAutoRoutableDispatcherRuntime(selectedRuntime)) {
          throw new Error(
            `Auto-router selected non-auto-routable runtime "${selectedRuntime}" — ` +
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
          {
            ...createFailureStructuredResult(
              taskNs,
              parsedTask.runtime,
              `Auto-routing failed: ${errorMsg}`,
              {
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
              },
            ),
            // failTaskWithMessage already emitted a generic structured result
            // and cleared the cache. Preserve the original claim-time identity
            // on this richer replacement instead of re-verifying at a later
            // timestamp (which could relabel a boundary-age signature).
            provenance: signingVerdict.provenance,
          },
          classification,
        );
        await promoteDependents(extractTaskId(taskNs));
        await refreshPipelineSummaryFromContent(entry.content);
        return pendingTaskDeparted();
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
      return pendingTaskDeparted();
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
      return pendingTaskDeparted();
    }
  }

  if (
    declaredRuntime !== "pipeline" &&
    parsedTask &&
    (await gatePendingTaskForApproval(taskNs, entry, parsedTask))
  ) {
    // Awaiting approval is non-terminal. Do not retain an assessment for a
    // task that can sit for days and may be edited/re-signed before it is
    // returned to pending; it will be assessed again on the next claim.
    taskProvenance.delete(taskNs);
    return pendingTaskDeparted();
  }

  console.log(
    `Claiming task ${taskNs} (runtime: ${declaredRuntime}, submitter: ${submittedBy}, worker: ${workerId})`
  );

  // Claim the task with compare-and-swap, attaching worker identity and lease
  // For auto-routed tasks: replace runtime:auto with the resolved runtime and add routing:auto
  const claimInputTags = parsedTask?.autoRouted && parsedTask.runtime
    ? entry.tags
        .map((t) => (t === "runtime:auto" ? `runtime:${parsedTask!.runtime}` : t))
        .concat("routing:auto")
    : entry.tags;
  // Until the dispatcher adds its own schema-valid prediction in the next
  // slice, never carry caller-supplied scheduler identities into a winning
  // claim. attachSchedulerDecisionPointer performs the same replacement when
  // prediction persistence is wired.
  const tagsForClaim = stripSchedulerDecisionPointers(claimInputTags);
  const claimTags = buildClaimTags(tagsForClaim, "running");

  // Rotate the mcp-session-id so all MCP calls for this task execution share
  // one stable session (enables Munin's outcome-aware retrieval and telemetry
  // session-flow analysis). A fresh ID is set again in the finally block below.
  munin.setSessionId(randomUUID());
  let claimAcceptedAt = entry.updated_at;
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
      claimAcceptedAt = claimResult.updated_at;
    }
    // From this point onward the winning claim tags are authoritative. In
    // particular, dispatcher-owned scheduler pointers added to the claim CAS
    // must not be replaced by the pre-claim pending snapshot during renewal,
    // delivery checkpoints, terminalization, or recovery hand-off.
    entry.tags = claimTags;
  } catch (err) {
    // Another dispatcher won the CAS. Its claim-time assessment owns the
    // eventual result; retaining ours risks applying stale identity to a
    // later re-submission under the same namespace.
    taskProvenance.delete(taskNs);
    console.log(`Failed to claim ${taskNs} (concurrent claim?):`, err);
    return { hadTask: false, queueDepth };
  }

  // The selected status is now running. Keep /health accurate while the task
  // executes instead of reporting the accepted claim as still pending.
  updatePendingQueueSnapshotAfterDeparture();

  currentTask = taskNs;
  currentCancellation = null;
  const acceptedAtMs = Date.parse(claimAcceptedAt);
  const startedAt = new Date(
    Number.isNaN(acceptedAtMs) ? Date.now() : Math.max(Date.now(), acceptedAtMs),
  ).toISOString();
  const taskId = extractTaskId(taskNs);
  console.log(`Executing task ${taskNs}...`);

  // Start periodic lease renewal
  startLeaseRenewal(taskNs, entry.content, claimTags);

  try {
    if (declaredRuntime === "pipeline") {
      currentTaskConfig = null;
      const pipelineResult = await dispatchPipelineTask(
        munin,
        {
          failTaskWithMessage: (namespace, claimedEntry, message, runtimeTag) =>
            failTaskWithMessage(namespace, claimedEntry, message, runtimeTag, true),
          promoteDependents,
          refreshPipelineSummary,
          writeStructuredResult: writeStructuredTaskResult,
        },
        taskNs,
        entry,
        queueDepth,
        await probeAllHosts(),
        {
          allowOwnerOverride: isOwnerSubmitter(submittedBy),
          sensitivityCheckpointSecret: config.sensitivityCheckpointSecret,
        },
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

    const isOllama = task.runtime === "ollama";
    const isClaude = task.runtime === "claude";
    const isCodex = task.runtime === "codex";
    const isOpencode = task.runtime === "opencode";
    const isHomeserver = task.runtime === "homeserver";
    const isOrchestrator = task.runtime === "orchestrator";

    // Mutation-capable per issue #236: whether THIS runtime/permission
    // profile can itself write to the managed working directory, regardless
    // of what the task's prompt asks for. Codex spawns `--full-auto` (always
    // write-capable). Claude SDK and OpenCode gate writes behind
    // `permissionProfile === "trusted-code"` (sdk-executor.ts,
    // opencode-executor.ts). Ollama has no file-write tool at all. Orchestrator
    // fans out to a `pi`-harness worker whose write capability this dispatcher
    // cannot cheaply prove either way, so it is treated as mutation-capable —
    // the safe default is to fail closed, not to assume read-only.
    const mutationCapable =
      isCodex ||
      isOrchestrator ||
      ((isClaude || isOpencode) && task.permissionProfile === "trusted-code");

    // Pre-task: checkout a fresh hugin/<taskId> branch from the repository's
    // resolved default branch (or validated explicit override, #217), then
    // durably verify it is actually clean at that exact commit before trusting
    // it (#236) — `checkoutTaskBranch` succeeding does not by itself prove the
    // tree is clean, since `git checkout -b` can carry over an earlier task's
    // uncommitted leftovers instead of conflicting.
    let branchResult: Awaited<ReturnType<typeof checkoutTaskBranch>> = { action: "skipped" };
    let checkoutGateRefusalReason: string | undefined;
    let checkoutGateDegraded = false;
    if (task.runtime !== "homeserver") {
      const gate = await prepareManagedCheckout(task.workingDir, taskId, {
        reposRoot: config.reposRoot,
        baseBranchOverride: task.baseBranch,
        mutationCapable,
      });
      branchResult = gate.branch;
      checkoutGateRefusalReason = gate.refusalReason;
      checkoutGateDegraded = Boolean(gate.degraded);
      if (gate.refusalReason) {
        console.error(
          `Managed checkout refused for ${taskNs} (mutation-capable, contaminated/unverified working directory): ${gate.refusalReason}`,
        );
      } else if (gate.degraded) {
        console.warn(
          `Managed checkout degraded for ${taskNs} (read-only, proceeding against unverified working directory): ${gate.degradedReason}`,
        );
      } else if (gate.recovered) {
        console.warn(
          `Managed checkout recovered for ${taskNs}: an earlier contaminated/unverified working directory was reset and re-verified clean before this task ran.`,
        );
      } else if (branchResult.action === "created") {
        console.log(`Pre-task: branch ${branchResult.branchName} ready in ${task.workingDir}`);
      }
    }
    let repositoryOutcome: StructuredTaskResult["repositoryOutcome"] =
      deriveRepositoryOutcome(branchResult, undefined, Boolean(checkoutGateRefusalReason));

    currentTaskConfig = task;
    const taskClassification = getTaskArtifactClassification(task);
    const taskSensitivitySnapshot = task.sensitivitySnapshot ??
      buildTaskSensitivitySnapshot(task.sensitivityAssessment);
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

    const executorLabel = isOllama
      ? "ollama"
      : isClaude
        ? "agent-sdk"
        : isCodex
          ? "codex-spawn"
          : isHomeserver
            ? "homeserver-delegate"
            : isOpencode
              ? "opencode"
              : isOrchestrator
                ? "orchestrator"
                : "spawn";

    // Capture quota before task execution (skip for ollama — it's Claude-specific)
    const quotaBefore = isOllama || isHomeserver ? { q5: null, q7: null } : await fetchQuota();

    await munin.log(
      taskNs,
      `Task started by Hugin (runtime: ${task.runtime}, executor: ${executorLabel}, model: ${task.model || "default"}, worker: ${workerId}, timeout: ${task.timeoutMs}ms)`
    );

    const startMs = Date.now();

    // --- Execute via ollama, SDK, or spawn ---
    let exitCode: number | "TIMEOUT" = 1;
    let output = "";
    let logFile = path.join(LOG_DIR, `${taskId}.log`);
    let resultText: string | null = null;
    let costUsd: number | null = null;
    // Verdict layer (V8): per-worker outcomes from the orchestrator engine,
    // carried into the structured result below. Empty for every other runtime.
    let orchOutcomes: SubtaskOutcome[] = [];
    // Savings tracker (PR3, S4): per-task savings summary from the orchestrator
    // engine, carried into the structured result below. Null for every other
    // runtime and whenever savings weren't computed for this run.
    let orchSavings: SavingsSummary | null = null;
    let ollamaJournalExtras: Record<string, unknown> = {};
    let opencodeJournalExtras: Record<string, unknown> = {};
    let opencodeResult: OpencodeExecutorResult | null = null;
    let homeserverResult: HomeserverExecutorResult | null = null;
    let effectiveExecutor = executorLabel;
    // Trusted failure-kind discriminator from a pre-flight short-circuit
    // (issue #123 Codex review) — set only when executeClaudeSdkWithPreflightChecks
    // refused the task itself, so the classification below never has to
    // regex-sniff synthetic output.
    let sdkPreflightFailureKind: typeof AUTH_FAILURE_KIND | typeof DEPS_DRIFT_FAILURE_KIND | undefined;
    let codexPreflightFailureReason: string | undefined;
    let fallbackTriggered = false;
    let fallbackReason: string | null = null;

    // Issue #274: the standing harness sampler belongs at the mutation-task
    // execution seam, after the managed-checkout gate and the applicable
    // one-shot runtime preflight. Broker /delegate tasks are deliberately not
    // included: their authenticated envelope promises tool_policy:none and no
    // worktree, so silently replacing them with a file-editing harness would
    // exceed the submitted authority. Direct Claude/Codex tasks carrying one
    // of #267's canonical bounded-coding task types are the live eligible set.
    const harnessLaneCheckoutPassed = !checkoutGateRefusalReason;
    const harnessLaneTaskType =
      harnessLaneCheckoutPassed &&
      (isClaude || isCodex) &&
      task.homeserverTaskType !== undefined &&
      isHarnessLaneEligibleTaskType(task.homeserverTaskType)
        ? task.homeserverTaskType
        : undefined;
    const harnessLaneDispatchEligible = harnessLaneTaskType !== undefined;

    // These return a synthetic one-shot failure on refusal and null on pass.
    // Running them here creates the production callback point that did not
    // previously exist: the sampler cannot bypass checkout, dependency drift,
    // Claude auth, or the Codex sandbox profile probe.
    const harnessLaneClaudePreflight = harnessLaneDispatchEligible && isClaude
      ? await runClaudeSdkPreflight(taskId, LOG_DIR)
      : undefined;
    const harnessLaneCodexPreflight = harnessLaneDispatchEligible && isCodex
      ? await runCodexPreflight(task, { taskNs, muninClient: munin })
      : undefined;
    const harnessLanePreflightsPassed =
      harnessLaneDispatchEligible &&
      (isClaude ? harnessLaneClaudePreflight === null : harnessLaneCodexPreflight === null);
    const harnessLaneDecision = harnessLanePreflightsPassed && harnessLaneTaskType
      ? decideHarnessLane({ taskId, taskType: harnessLaneTaskType })
      : undefined;

    const harnessLaneTaskOutcomeRef = { namespace: taskNs, key: "result-structured" };
    const laneOutcomeFromExitCode = (
      code: number | "TIMEOUT",
      extras: Omit<LaneAttemptOutcome, "outcome" | "taskOutcomeRef">,
    ): LaneAttemptOutcome => ({
      outcome: code === "TIMEOUT" ? "timed_out" : code === 0 ? "completed" : "failed",
      taskOutcomeRef: harnessLaneTaskOutcomeRef,
      ...extras,
    });

    const executeSampledHarness = async (): Promise<LaneAttemptOutcome> => {
      effectiveExecutor = "opencode-sampled";
      const opencodeGateway = loadOpencodeGatewayConfig(process.env);
      if (!opencodeGateway) {
        exitCode = 1;
        output =
          "Sampled harness runtime is not configured: set HOMESERVER_GATEWAY_URL + " +
          "HOMESERVER_GATEWAY_API_KEY or HUGIN_OPENCODE_BASE_URL + HUGIN_OPENCODE_API_KEY";
        logFile = path.join(LOG_DIR, `${taskId}.log`);
        fs.writeFileSync(
          logFile,
          [
            "=== Hugin Task Log (sampled harness) ===",
            `Task: ${taskNs}`,
            output,
            "",
          ].join("\n"),
        );
        opencodeJournalExtras = {
          runtime_requested: task.runtime,
          runtime_effective: "none",
          harness_lane: "harness",
          opencode_configured: false,
        };
        return laneOutcomeFromExitCode(exitCode, {
          verifierKind: "none",
          verdict: "error",
          nodeId: "opencode-m5",
        });
      }

      const opencodeAbort = new AbortController();
      currentOpencodeAbort = opencodeAbort;
      opencodeResult = await executeOpencodeTask(
        {
          prompt: task.prompt,
          workingDir: task.workingDir,
          timeoutMs: task.timeoutMs,
          maxOutputChars: config.maxOutputChars,
          gatewayBaseUrl: opencodeGateway.gatewayBaseUrl,
          apiKey: opencodeGateway.apiKey,
          providerId: opencodeGateway.providerId,
          model: opencodeGateway.defaultModel,
          // Preserve the already-admitted write ceiling. Codex is always
          // full-auto; Claude only writes under trusted-code.
          permissionProfile: isCodex ? "trusted-code" : task.permissionProfile || "read-only",
          opencodeCommand: opencodeGateway.opencodeCommand,
        },
        taskId,
        LOG_DIR,
        { abortController: opencodeAbort },
      );
      currentOpencodeAbort = null;
      exitCode = opencodeResult.exitCode;
      output = opencodeResult.output;
      logFile = opencodeResult.logFile;
      resultText = opencodeResult.resultText;
      const completedTestCalls = opencodeResult.toolCalls.filter(
        (call) =>
          call.tool === "bash" &&
          call.command !== undefined &&
          opencodeResult!.testCommands.includes(call.command) &&
          call.exitCode !== undefined,
      );
      const hasMechanicalGrade = completedTestCalls.length > 0;
      const mechanicalPass = hasMechanicalGrade && completedTestCalls.every((call) => call.exitCode === 0);
      const iterations = opencodeResult.events.filter((event) => event.type === "step_finish").length;
      opencodeJournalExtras = {
        runtime_requested: task.runtime,
        runtime_effective: "opencode",
        harness_lane: "harness",
        opencode_configured: true,
        model_effective: opencodeResult.model,
        opencode_agent: opencodeResult.agent,
        permission_profile: opencodeResult.permissionProfile,
        tool_calls: opencodeResult.toolCalls.length,
        changed_files: opencodeResult.changedFiles,
        test_commands: opencodeResult.testCommands,
        config_dir_removed: opencodeResult.configDirRemoved,
      };
      return laneOutcomeFromExitCode(exitCode, {
        verifierKind: hasMechanicalGrade ? "mechanical" : "none",
        verdict: hasMechanicalGrade
          ? mechanicalPass ? "pass" : "fail"
          : exitCode === 0 ? "unverified" : "error",
        ...(hasMechanicalGrade
          ? { verifierNotes: `test-commands=${completedTestCalls.length}; failed=${completedTestCalls.filter((call) => call.exitCode !== 0).length}` }
          : {}),
        modelId: opencodeResult.model,
        nodeId: "opencode-m5",
        ...(iterations > 0 ? { iterations } : {}),
      });
    };

    if (checkoutGateRefusalReason) {
      // Issue #236: the pre-execution clean-verification gate refused this
      // mutation-capable task before any executor ran — the managed checkout
      // could not be proven clean at the intended commit even after an
      // explicit recovery attempt. This must never fall through to any
      // runtime branch below; the model-execution path itself is untouched.
      exitCode = 1;
      output = checkoutGateRefusalReason;
      logFile = path.join(LOG_DIR, `${taskId}.log`);
      try {
        fs.writeFileSync(
          logFile,
          [
            "=== Hugin Task Log ===",
            `Task: ${taskId}`,
            `Runtime: ${task.runtime}`,
            "===",
            "Managed checkout refused by the pre-execution clean-verification gate (#236):",
            checkoutGateRefusalReason,
            "",
            "===",
            "Exit code: 1",
            "===",
            "",
          ].join("\n"),
          { encoding: "utf-8" },
        );
      } catch {
        /* log is best-effort — never fail the task on a log write */
      }
    } else if (isOllama) {
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
        const sdkResult = await executeClaudeSdkWithPreflightChecks(
          {
            prompt: task.prompt,
            workingDir: task.workingDir,
            timeoutMs: task.timeoutMs,
            muninUrl: config.muninUrl,
            muninApiKey: config.muninApiKey,
            maxOutputChars: config.maxOutputChars,
            muninSessionId: munin.getSessionId(),
            permissionProfile: task.permissionProfile,
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
        sdkPreflightFailureKind = sdkResult.preflightFailureKind;
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
          maxOutputTokens: task.maxOutputTokens,
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
        const sdkResult = await executeClaudeSdkWithPreflightChecks(
          {
            prompt: task.prompt,
            workingDir: task.workingDir,
            timeoutMs: task.timeoutMs,
            muninUrl: config.muninUrl,
            muninApiKey: config.muninApiKey,
            maxOutputChars: config.maxOutputChars,
            muninSessionId: munin.getSessionId(),
            permissionProfile: task.permissionProfile,
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
        sdkPreflightFailureKind = sdkResult.preflightFailureKind;
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
    } else if (isHomeserver) {
    const gateway = loadHomeserverGatewayConfig(process.env);
    if (!gateway || !task.homeserverTaskType || task.homeserverPolicyError) {
      exitCode = 1;
      output = task.homeserverPolicyError
        ? `Runtime homeserver policy rejected: ${task.homeserverPolicyError}`
        : !gateway
        ? "Runtime homeserver is not configured: set HOMESERVER_GATEWAY_URL and HOMESERVER_GATEWAY_API_KEY"
        : "Runtime homeserver requires a canonical Task type";
      logFile = path.join(LOG_DIR, `${taskId}.log`);
      fs.writeFileSync(logFile, `=== Hugin Task Log (homeserver/M5) ===\n${output}\n`);
    } else {
      const homeserverAbort = new AbortController();
      currentOllamaAbort = homeserverAbort;
      const renderedPrompt = renderHomeserverUserMessage({
        prompt: task.prompt,
        gatewayBaseUrl: gateway.baseUrl,
        apiKey: gateway.apiKey,
        path: "delegate",
        taskType: task.homeserverTaskType,
        maxTokens: task.maxOutputTokens,
        verifier: task.homeserverVerifier,
        timeoutMs: task.timeoutMs,
        maxOutputChars: config.maxOutputChars,
        injectedContext: task.contextResolution?.content || undefined,
      });
      const homeserverTaskConfig = buildHomeserverDelegateTaskConfig({
        prompt: task.prompt,
        gatewayBaseUrl: gateway.baseUrl,
        apiKey: gateway.apiKey,
        taskType: task.homeserverTaskType,
        model: task.model,
        maxTokens: task.maxOutputTokens,
        verifier: task.homeserverVerifier,
        timeoutMs: task.timeoutMs,
        maxOutputChars: config.maxOutputChars,
        injectedContext: task.contextResolution?.content || undefined,
      });
      let authenticatedLearningSource: LearningTaskSource | undefined;
      try {
        authenticatedLearningSource = buildLearningTaskSource(
          task,
          taskNs,
          entry.created_at,
          claimAcceptedAt,
          signingVerdict.provenance,
        );
      } catch (error) {
        // Existing unstamped /delegate traffic remains operational but is not
        // learning-eligible. Only authenticated source identities enter the
        // durable harvest/join protocol.
        console.log(
          `LearningTaskContract ineligible for ${taskNs}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const preparedLearningTask = authenticatedLearningSource
        ? await prepareDurableLearningTaskAttempt({
        taskId,
        startedAt,
        rawTaskText: task.prompt,
        renderedPrompt,
        gatewayBaseUrl: gateway.baseUrl,
        apiKey: gateway.apiKey,
        buildSource: () => authenticatedLearningSource!,
        // This immutable, UUID-keyed start is the authoritative attempt clock.
        // It lands before capability negotiation, request stamping, admission,
        // or any model call and contains no prompt or response bytes.
        persistStart: async (ref, record) => {
          await createImmutableLearningArtifact(munin, {
            namespace: ref.namespace,
            key: ref.key,
            content: JSON.stringify(record),
            tags: ["learning-task-attempt", "attempt:started", "contract:grimnir-learning-task-v1"],
            classification: taskClassification,
          });
        },
        buildPreparedDispatch: (context) => {
          const requestBody = buildFreshHomeserverDelegateRequestBody(
            homeserverTaskConfig,
            taskId,
            context,
          );
          return createPreparedLearningTaskDispatch({
            context,
            requestStamp: requestBody.learningTaskStamp!,
            requestBody,
          });
        },
        persistReplayPayload: async (ref, record) => {
          await createImmutableLearningArtifact(munin, {
            namespace: ref.namespace,
            key: ref.key,
            content: JSON.stringify(record),
            tags: ["learning-task-replay", "attempt:prepared", "contract:grimnir-learning-task-v1"],
            classification: taskClassification,
          });
        },
        persistPrepared: async (ref, record) => {
          await createImmutableLearningArtifact(munin, {
            namespace: ref.namespace,
            key: ref.key,
            content: JSON.stringify(record),
            tags: ["learning-task-dispatch", "attempt:prepared", "contract:grimnir-learning-task-v1"],
            classification: taskClassification,
          });
        },
      })
        : null;
      const learningAttempt = preparedLearningTask?.attempt;
      const learningAttemptKey = learningAttempt
        ? learningTaskAttemptKey(learningAttempt.attemptId)
        : undefined;
      homeserverResult = await executeHomeserverTask({
        ...homeserverTaskConfig,
        learningTask: preparedLearningTask?.preparation ?? { kind: "ineligible" },
      }, taskId, LOG_DIR, {
        abortController: homeserverAbort,
        recoverAmbiguousLearningTask: async (failureEvidence) => {
          const preparation = preparedLearningTask?.preparation;
          if (homeserverAbort.signal.aborted || preparation?.kind !== "ready") return null;
          const recovered = await recoverAmbiguousStoredLearningTaskCandidate({
            munin,
            taskNamespace: taskNs,
            taskClassification,
            preparedDispatchRef: preparation.preparedDispatch.preparedDispatchRef,
            failureEvidence,
            gateway,
            signal: homeserverAbort.signal,
          });
          return recovered?.evidence ?? null;
        },
      });
      if (homeserverResult.learningTask && learningAttemptKey) {
        const outcomeKey = `${learningAttemptKey}-outcome`;
        const attemptOutcomeRef = { namespace: taskNs, key: outcomeKey };
        try {
          const parsedEvidence = learningTaskExecutionEvidenceSchema.parse({
            ...homeserverResult.learningTask,
            attemptOutcomeRef,
          });
          const durableEvidence = preparedLearningTask?.preparation.kind === "ready"
            ? validatePreparedLearningTaskOutcome(
                preparedLearningTask.preparation.preparedDispatch,
                parsedEvidence,
              )
            : parsedEvidence;
          await createImmutableLearningArtifact(munin, {
            namespace: taskNs,
            key: outcomeKey,
            content: JSON.stringify(durableEvidence),
            tags: [
              "learning-task-attempt",
              durableEvidence.state === "m5-admitted" ? "attempt:admitted" : "attempt:not-admitted",
              "contract:grimnir-learning-task-v1",
            ],
            classification: taskClassification,
          }, { allowExactExisting: true });
          homeserverResult.learningTask = durableEvidence;
        } catch (err) {
          const failureReason = "durable learning-task attempt outcome write failed";
          homeserverResult.learningTask = learningTaskOutcomePersistenceFailure(
            homeserverResult.learningTask,
            failureReason,
          );
          homeserverResult.exitCode = 1;
          homeserverResult.resultText = null;
          homeserverResult.provenance = null;
          homeserverResult.output = `[LearningTaskContract evidence rejected: ${failureReason}]\n`;
          console.error(`${failureReason} for ${taskNs}:`, err);
        }
      }
      currentOllamaAbort = null;
      exitCode = homeserverResult.exitCode;
      output = homeserverResult.output;
      logFile = homeserverResult.logFile;
      resultText = homeserverResult.resultText;
    }
    } else if (isClaude) {
    const executeClaudeOneShot = async (): Promise<LaneAttemptOutcome> => {
      console.log(`Using Agent SDK executor for task ${taskNs}`);
      const sdkAbort = new AbortController();
      currentSdkAbort = sdkAbort;
      const sdkConfig: SdkTaskConfig = {
        prompt: task.prompt,
        workingDir: task.workingDir,
        timeoutMs: task.timeoutMs,
        muninUrl: config.muninUrl,
        muninApiKey: config.muninApiKey,
        maxOutputChars: config.maxOutputChars,
        model: task.model,
        muninSessionId: munin.getSessionId(),
        permissionProfile: task.permissionProfile,
      };
      const sdkOptions: SdkExecutorOptions = {
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
      };
      const sdkResult: PreflightCheckedSdkResult = harnessLaneDispatchEligible
        ? harnessLaneClaudePreflight ?? await executeSdkTask(sdkConfig, taskId, LOG_DIR, sdkOptions)
        : await executeClaudeSdkWithPreflightChecks(sdkConfig, taskId, LOG_DIR, sdkOptions);
      currentSdkAbort = null;
      exitCode = sdkResult.exitCode;
      output = sdkResult.output;
      logFile = sdkResult.logFile;
      resultText = sdkResult.resultText;
      costUsd = sdkResult.costUsd;
      sdkPreflightFailureKind = sdkResult.preflightFailureKind;
      return laneOutcomeFromExitCode(exitCode, {
        verifierKind: "none",
        verdict: exitCode === 0 ? "unverified" : "error",
        modelId: task.model || "claude-sdk",
        nodeId: "claude-sdk",
      });
    };
    if (harnessLaneDecision && harnessLaneTaskType) {
      await runHarnessLaneSampledAttempt(
        learningRegistry,
        { taskId, attemptId: `${taskId}:dispatch`, taskType: harnessLaneTaskType, occurredAt: startedAt },
        { oneShot: executeClaudeOneShot, harness: executeSampledHarness },
        {},
        harnessLaneDecision,
      );
    } else {
      await executeClaudeOneShot();
    }
    } else if (isOpencode) {
    console.log(`Using OpenCode executor for task ${taskNs}`);
    const opencodeGateway = loadOpencodeGatewayConfig(process.env);
    if (!opencodeGateway) {
      exitCode = 1;
      output =
        "Runtime opencode is not configured: set HOMESERVER_GATEWAY_URL + HOMESERVER_GATEWAY_API_KEY " +
        "or HUGIN_OPENCODE_BASE_URL + HUGIN_OPENCODE_API_KEY";
      logFile = path.join(LOG_DIR, `${taskId}.log`);
      fs.writeFileSync(
        logFile,
        [
          "=== Hugin Task Log (opencode) ===",
          `Task: ${taskNs}`,
          output,
          "",
        ].join("\n"),
      );
      opencodeJournalExtras = {
        runtime_requested: "opencode",
        runtime_effective: "none",
        opencode_configured: false,
      };
    } else {
      const opencodeAbort = new AbortController();
      currentOpencodeAbort = opencodeAbort;
      opencodeResult = await executeOpencodeTask(
        {
          prompt: task.prompt,
          workingDir: task.workingDir,
          timeoutMs: task.timeoutMs,
          maxOutputChars: config.maxOutputChars,
          gatewayBaseUrl: opencodeGateway.gatewayBaseUrl,
          apiKey: opencodeGateway.apiKey,
          providerId: opencodeGateway.providerId,
          model: task.model || opencodeGateway.defaultModel,
          permissionProfile: task.permissionProfile || "read-only",
          opencodeCommand: opencodeGateway.opencodeCommand,
        },
        taskId,
        LOG_DIR,
        { abortController: opencodeAbort },
      );
      exitCode = opencodeResult.exitCode;
      output = opencodeResult.output;
      logFile = opencodeResult.logFile;
      resultText = opencodeResult.resultText;
      currentOpencodeAbort = null;
      opencodeJournalExtras = {
        runtime_requested: "opencode",
        runtime_effective: "opencode",
        opencode_configured: true,
        model_effective: opencodeResult.model,
        opencode_agent: opencodeResult.agent,
        permission_profile: opencodeResult.permissionProfile,
        tool_calls: opencodeResult.toolCalls.length,
        changed_files: opencodeResult.changedFiles,
        test_commands: opencodeResult.testCommands,
        config_dir_removed: opencodeResult.configDirRemoved,
      };
    }
    } else if (isOrchestrator) {
    // --- Orchestrator execution path ---
    console.log(`Using orchestrator executor for task ${taskNs}`);
    const orchAbort = new AbortController();
    currentOrchestratorAbort = orchAbort;
    logFile = path.join(LOG_DIR, `${taskId}.log`);
    const orchLogStream = fs.createWriteStream(logFile, { encoding: "utf-8" });
    orchLogStream.write(
      [
        "=== Hugin Task Log (orchestrator) ===",
        `Task: ${taskNs}`,
        `Runtime: orchestrator`,
        `Working dir: ${task.workingDir}`,
        `Timeout: ${task.timeoutMs}`,
        `Started: ${startedAt}`,
        "===\n",
      ].join("\n"),
    );
    // Guarded config: runOrchestratorTask's sensitivity guard judges THIS
    // (post-Model:-override) config — see effectiveOrchestratorConfig's doc.
    const orchConfig = effectiveOrchestratorConfig(process.env, task.model);
    const orchInvoker = createModelInvoker(orchConfig.roles, {
      timeoutMs: orchConfig.perCallTimeoutMs,
      maxOutputChars: config.maxOutputChars,
      maxTokens: orchConfig.maxTokens,
    });
    const orchResult = await runOrchestratorTask(
      {
        prompt: task.prompt,
        sensitivity: task.effectiveSensitivity || "internal",
        timeoutMs: task.timeoutMs,
        maxOutputChars: config.maxOutputChars,
        injectedContext: task.contextResolution?.content || undefined,
      },
      orchConfig,
      {
        invoker: orchInvoker,
        onLog: (line) => {
          console.log(`[orch:${taskId}] ${line}`);
          orchLogStream.write(`${line}\n`);
        },
        signal: orchAbort.signal,
        verdictStore: orchVerdictStore,
        ledgerClient: orchLedgerClient,
        savingsStore: orchSavingsStore,
      },
    );
    orchLogStream.end();
    currentOrchestratorAbort = null;
    exitCode = orchResult.exitCode;
    output = orchResult.output;
    resultText = orchResult.resultText;
    costUsd = orchResult.costUsd;
    orchOutcomes = orchResult.outcomes;
    orchSavings = orchResult.savings;
    } else {
      const executeCodexOneShot = async (): Promise<LaneAttemptOutcome> => {
        const spawnContext = { taskNs, muninClient: munin };
        const spawnResult = harnessLaneDispatchEligible
          ? harnessLaneCodexPreflight ?? await spawnRuntime(task, spawnContext)
          : await executeCodexWithPreflightChecks(task, spawnContext);
        exitCode = spawnResult.exitCode;
        output = spawnResult.output;
        logFile = spawnResult.logFile;
        if (spawnResult.preflightFailureKind === CODEX_SANDBOX_FAILURE_KIND) {
          codexPreflightFailureReason = spawnResult.preflightFailureReason;
        }
        return laneOutcomeFromExitCode(exitCode, {
          verifierKind: "none",
          verdict: exitCode === 0 ? "unverified" : "error",
          modelId: task.model || "codex",
          nodeId: "codex-spawn",
        });
      };
      if (harnessLaneDecision && harnessLaneTaskType) {
        await runHarnessLaneSampledAttempt(
          learningRegistry,
          { taskId, attemptId: `${taskId}:dispatch`, taskType: harnessLaneTaskType, occurredAt: startedAt },
          { oneShot: executeCodexOneShot, harness: executeSampledHarness },
          {},
          harnessLaneDecision,
        );
      } else {
        await executeCodexOneShot();
      }
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
    currentOpencodeAbort = null;
    currentOrchestratorAbort = null;

    const durationMs = Date.now() - startMs;
    const completedAt = new Date().toISOString();
    const sampledHarnessLane = harnessLaneDecision?.lane === "harness";
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

    // Distinct failure classification: a Claude SDK run (direct or via
    // ollama→claude fallback) that failed to authenticate (401 / expired Pi
    // credential, issue #129) or was refused by the version-drift pre-flight
    // check (issue #123) is tagged + surfaced distinctly from a generic
    // task-logic failure, so the cause is legible in Munin instead of buried
    // in the raw log. A pre-flight short-circuit already carries a trusted
    // discriminator (sdkPreflightFailureKind) — only a REAL SDK run (no
    // discriminator) falls back to regex-classifying its output (Codex
    // review, #123: DEPS_DRIFT is never inferred from output text).
    const failureClassification = !ok && !isTimeout && !isCancelled
      ? isCodex && codexPreflightFailureReason
        ? codexSandboxFailureClassification(codexPreflightFailureReason)
        : isClaude || fallbackTriggered
          ? sdkPreflightFailureKind === DEPS_DRIFT_FAILURE_KIND
            ? driftFailureClassification()
            : classifyClaudeFailure(output)
          : null
      : null;
    if (failureClassification) {
      await munin.log(
        taskNs,
        `Task failed (${failureClassification.kind}): ${failureClassification.reason}`,
      );
    }
    if (failureClassification?.kind === CODEX_SANDBOX_FAILURE_KIND) {
      const friction = buildCodexSandboxFrictionEvent({
        taskId,
        modelId: task.model,
        reason: failureClassification.reason,
        recordedAt: new Date(),
      });
      try {
        await munin.write(
          friction.namespace,
          friction.key,
          friction.content,
          friction.tags,
          undefined,
          taskClassification,
        );
      } catch (err) {
        console.error(
          `[codex-sandbox] failed to persist infrastructure friction for ${taskNs}:`,
          err,
        );
      }
    }

    // #131: feed the CONFIRMED Claude auth outcome into the proactive alarm. A
    // real runtime AUTH_FAILED is the reliable dead-credential signal (the probe
    // can't judge a refreshable token); a Claude success confirms recovery. Only
    // for Claude-involving runs — an ollama/orchestrator outcome says nothing
    // about the Pi Claude credential. Best-effort: never let it fail the task.
    // Gated specifically on AUTH_FAILURE_KIND (Codex review, #123): a
    // DEPS_DRIFT classification says nothing about the credential and must
    // never flip the auth alarm to "unauthorized" or block its recovery.
    if (isClaude || fallbackTriggered) {
      if (failureClassification?.kind === AUTH_FAILURE_KIND) {
        await noteClaudeAuthOutcome("unauthorized").catch((err) =>
          console.error("[auth-alarm] reactive unauthorized note failed:", err),
        );
      } else if (ok) {
        await noteClaudeAuthOutcome("ok").catch((err) =>
          console.error("[auth-alarm] reactive ok note failed:", err),
        );
      }
    }

    // Post-task: finalize branch — auto-commit leftovers, push, open PR (#47)
    let prUrl: string | undefined;
    let repositoryChange: StructuredTaskResult["repositoryChange"];
    // Issue #225: a publication (push/PR) failure AFTER the paid model work
    // completed must never strand the exact commit as invisible service-log
    // noise. This tag survives the terminal status write below so an
    // operator can discover and retry it without a rerun.
    let publicationFailureTag: string | undefined;
    // Issue #236: a task that ran in explicit degraded mode against an
    // unverified/contaminated checkout must never have finalizeTaskBranch
    // auto-commit and publish whatever was ALREADY on disk — that state may
    // belong to an earlier task entirely, not to this one's output.
    if (ok && !isCancelled && !checkoutGateDegraded && branchResult.action === "created" && branchResult.branchName) {
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
        {
          captureRepositoryChange: true,
          baseBranch: branchResult.baseBranch,
          baseCommit: branchResult.baseCommit,
        },
      );
      repositoryChange = finalizeResult.repositoryChange;
      repositoryOutcome = deriveRepositoryOutcome(branchResult, finalizeResult.action);
      if (finalizeResult.action === "pr-created" && finalizeResult.prUrl) {
        prUrl = finalizeResult.prUrl;
        await munin.log(taskNs, `PR created: ${prUrl}`);
      } else if (finalizeResult.action === "push-failed") {
        console.warn(`Post-task branch finalization failed for ${taskNs}: ${finalizeResult.error}`);
        publicationFailureTag = PUBLICATION_FAILED_TAG;
        try {
          await persistPublicationFailure(munin, {
            taskId,
            taskNamespace: taskNs,
            workingDir: task.workingDir,
            branchName: finalizeResult.branchName ?? branchResult.branchName,
            baseBranch: branchResult.baseBranch ?? "main",
            baseCommit: repositoryChange?.baseCommit ?? branchResult.baseCommit ?? "",
            headCommit: repositoryChange?.headCommit,
            prBody,
            allowedEgressHosts: egressPolicy.allowedHosts,
            failureReason: finalizeResult.error ?? "publication failed",
            classification: taskClassification,
          });
        } catch (err) {
          // The durable record is best-effort UX for recovery, not the
          // source of truth — result-structured's `publication-failed`
          // repositoryOutcome (written below) is. Never let this throw
          // strand the task off its terminal write.
          console.error(`[publication-recovery] failed to persist durable record for ${taskNs}:`, err);
        }
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

    if ((isClaude || isOllama || isOrchestrator || isOpencode || isHomeserver || sampledHarnessLane) && resultText) {
      resultSource = isOpencode || sampledHarnessLane
        ? "opencode-json"
        : isHomeserver
          ? "homeserver-delegate"
          : effectiveExecutor;
      rawBodyText = resultText;
      structuredBodyKind = "response";
      resultBody = `### Response\n\n${resultText}`;
    } else if (!isClaude && !isOllama && !isOrchestrator && !isOpencode && !isHomeserver && !sampledHarnessLane) {
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
      await writeSensitivityCheckpoint(
        taskNs,
        checkpointContent,
        taskSensitivitySnapshot,
        munin,
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
          failureKind: deliveryFailureKind ?? failureClassification?.kind,
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
      sampledHarnessLane && opencodeResult
        ? {
            ...(task.model ? { requestedModel: task.model } : {}),
            effectiveModel: opencodeResult.model,
          }
      : isHomeserver && homeserverResult
        ? {
            effectiveModel: homeserverResult.modelId ?? undefined,
            effectiveHost: homeserverResult.nodeId ?? "m5",
            // Issue #163: the sanitized provenance is the whole delegation
            // trace (node/model/verifier + route policy + price-catalog
            // version). Spread it wholesale rather than re-listing fields, so a
            // field added to the shared M5 shape can never be silently dropped
            // here again. `taskType` keeps its historical fallback to the
            // requested type when the gateway echoes none.
            delegation: {
              ...(homeserverResult.provenance ?? {}),
              taskType: homeserverResult.taskType ?? task.homeserverTaskType,
            },
            huginTaskIdentity: homeserverResult.huginTaskIdentity ?? undefined,
            learningTask: homeserverResult.learningTask ?? undefined,
          }
        : isOllama
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
          ? isOpencode && opencodeResult
            ? {
                requestedModel: task.model,
                effectiveModel: opencodeResult.model,
              }
            : {
                requestedModel: task.model,
                effectiveModel: task.model,
              }
          : isOpencode && opencodeResult
          ? {
              effectiveModel: opencodeResult.model,
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

    // Verdict layer (V8): surface the engine's per-worker outcomes in the
    // structured result. Additive/optional — undefined for every non-
    // orchestrator runtime and for orchestrator runs with no recorded
    // outcomes (e.g. a rejected/aborted/timed-out run — see
    // OrchestratorExecResult.outcomes' doc).
    const orchestratorOutcomes =
      isOrchestrator && orchOutcomes.length > 0
        ? orchOutcomes.map((o) => ({
            subtaskId: o.subtask.id,
            taskType: o.subtask.taskType,
            provider: o.result.provider,
            model: o.result.model,
            ok: o.result.ok,
            verdictOk: o.verdict !== undefined ? o.verdict.ok : null,
            costUsd: o.result.costUsd,
            latencyMs: o.result.latencyMs,
            // Savings tracker (PR3, S4): thread the per-call token counts
            // already present on WorkerResult through into the structured
            // result. Coerced to the schema's nonnegative-integer contract —
            // an out-of-contract provider value must degrade to null, not fail
            // the whole result-structured write after a successful run. Uses
            // the one shared sanitizer (#163) rather than repeating the
            // predicate: the local copy checked Number.isInteger, which lets
            // 2**53 through into a zod `.int()` that rejects it.
            inputTokens: sanitizeProviderTokenCount(o.result.inputTokens),
            outputTokens: sanitizeProviderTokenCount(o.result.outputTokens),
            ...(o.result.selectedNode ? { selectedNode: o.result.selectedNode } : {}),
            ...(o.result.effectiveNode ? { effectiveNode: o.result.effectiveNode } : {}),
            ...(o.result.fallbackTriggered !== undefined
              ? { fallbackTriggered: o.result.fallbackTriggered }
              : {}),
            ...(o.result.fallbackReason ? { fallbackReason: o.result.fallbackReason } : {}),
            // Per-worker failure detail (issue #157): preserve the worker's
            // exact error (e.g. `HTTP 503 server_busy retryAfterS=5`) so a
            // failed fanout leaf is diagnosable from the structured result.
            ...(o.result.error ? { error: o.result.error } : {}),
            // M5 execution provenance (issue #163): the node/model/verifier that
            // actually produced this leaf, plus the ledgerId that joins it to
            // M5's authoritative evidence row. Present only for `homeserver`
            // leaves that went through /delegate; already sanitized against the
            // untrusted gateway response by src/m5-provenance.ts.
            ...(o.result.delegation ? { delegation: o.result.delegation } : {}),
          }))
        : undefined;

    // Savings tracker (PR3, S4): per-task savings summary, additive/optional —
    // undefined for every non-orchestrator runtime and whenever savings
    // weren't computed for this run (HUGIN_ORCH_SAVINGS=off, an unpriced
    // baseline, or a rejected/aborted/timed-out run). Only the per-task fields
    // per the ADR's S4 shape — byModel/inputTokens/outputTokens are aggregate-
    // only (see savings-store.ts's tasks/_savings doc).
    const savingsResult =
      isOrchestrator && orchSavings
        ? {
            baselineModelId: orchSavings.baselineModelId,
            coveredCalls: orchSavings.coveredCalls,
            uncoveredCalls: orchSavings.uncoveredCalls,
            actualCostUsd: orchSavings.actualCostUsd,
            baselineCostUsd: orchSavings.baselineCostUsd,
            savedUsd: orchSavings.savedUsd,
            // Quality-adjusted series (issue #144): the verdict-joined
            // headline any decision-making consumer must read (see
            // src/orchestrator/README.md); savedUsd above is raw-only.
            qaBaselineCreditUsd: orchSavings.qaBaselineCreditUsd,
            qualityAdjustedSavedUsd: orchSavings.qualityAdjustedSavedUsd,
            byOutcome: orchSavings.byOutcome,
          }
        : undefined;

    // Carry the terminal delivery marker (issue #68) into the persistent tag
    // set so downstream consumers + startup reconciliation see a consistent
    // terminal delivery state. Shared by the cancelled and normal branches —
    // a cancel mid-delivery still set terminalDeliveryTag = "delivery:failed".
    const deliveryAwareFinalizeTags = terminalDeliveryTag
      ? [
          ...entry.tags.filter((t) => !t.startsWith("delivery:")),
          terminalDeliveryTag,
        ]
      : entry.tags;
    const learningCapturePending = isHomeserver
      && repositoryOutcome.state === "not-managed"
      && isPotentialAdmittedHomeserverAttempt(
        homeserverResult?.learningTask,
        runtimeMetadata?.delegation,
      );
    const finalizeBaseTags = learningCapturePending
      ? [
          ...deliveryAwareFinalizeTags.filter((tag) => !tag.startsWith("learning-registry:")),
          LEARNING_REGISTRY_PENDING_TAG,
        ]
      : deliveryAwareFinalizeTags;

    let terminalStructuredResultOk = false;
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
        terminalTags: buildClaimedTerminalStatusTags("cancelled", finalizeBaseTags, `runtime:${task.runtime}`),
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
      terminalStructuredResultOk = cancelledFinalize.structuredResultOk;
    } else {
      // Append the distinct failure tag (issue #129) and the publication
      // failure tag (issue #225) AFTER the claimed terminal-tag transform, whose
      // persistent-tag filter would otherwise drop tags not already present
      // on the pre-task entry.
      const terminalTags = buildClaimedTerminalStatusTags(
        ok ? "completed" : "failed",
        finalizeBaseTags,
        `runtime:${task.runtime}`,
      );
      const extraTerminalTags = [
        ...(failureClassification ? [failureClassification.tag] : []),
        ...(publicationFailureTag ? [publicationFailureTag] : []),
      ];
      const finalizeOutcome = await finalizeTaskCompletion(munin, taskNs, {
        statusContent: entry.content,
        terminalTags: extraTerminalTags.length > 0
          ? [...terminalTags, ...extraTerminalTags]
          : terminalTags,
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
            repositoryOutcome,
            repositoryChange,
            bodyKind: structuredBodyKind,
            bodyText: structuredBodyText,
            errorMessage: ok
              ? undefined
              : failureClassification
                ? failureClassification.reason
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
            orchestratorOutcomes,
            savings: savingsResult,
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
      terminalStructuredResultOk = finalizeOutcome.structuredResultOk;
    }

    // hugin#284: capture from the DURABLE terminal result, never from mutable
    // executor locals. A pending status survives partial registry writes and
    // is replayed idempotently by startup/periodic reconciliation. The M5
    // ledger read must independently bind ledger/model/task to this exact
    // admitted task+attempt before the first registry event is accepted.
    if (terminalStructuredResultOk && learningCapturePending) {
      try {
        const gateway = loadHomeserverGatewayConfig(process.env);
        if (!gateway) throw new Error("homeserver gateway unavailable for authoritative ledger binding");
        await capturePendingHomeserverLearningTask({
          munin,
          registry: learningRegistry,
          resolveLedgerAttemptBinding: (ledgerId) => fetchM5LedgerAttemptBinding(gateway, ledgerId),
        }, taskNs);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`Learning registry capture pending for ${taskNs}: ${detail}`);
        await munin.log(
          taskNs,
          `Learning registry capture pending after terminalization: ${detail}`,
        ).catch((logError) => {
          console.error(`Learning registry failure log also failed for ${taskNs}:`, logError);
        });
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
    const quotaAfter = isClaude || fallbackTriggered
      ? await fetchQuota()
      : { q5: null, q7: null };

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
      ...opencodeJournalExtras,
    });

    currentTask = null;
    currentTaskConfig = null;
    return { hadTask: true, queueDepth };
  } finally {
    stopLeaseRenewal();
    stopCancellationWatch();
    currentSdkAbort = null;
    currentOllamaAbort = null;
    currentOpencodeAbort = null;
    currentOrchestratorAbort = null;
    currentCancellation = null;
    currentTask = null;
    currentTaskConfig = null;
    // Rotate session off the task scope so subsequent poll/heartbeat writes
    // don't pollute the task's session window.
    munin.setSessionId(randomUUID());
  }
}

async function runHomeserverLearningRegistryReconciliation(): Promise<void> {
  const gateway = loadHomeserverGatewayConfig(process.env);
  if (!gateway) return;
  try {
    const result = await reconcilePendingHomeserverLearningTasks({
      munin,
      registry: learningRegistry,
      resolveLedgerAttemptBinding: (ledgerId) => fetchM5LedgerAttemptBinding(gateway, ledgerId),
    });
    if (result.scanned > 0 || result.truncated) {
      console.log(
        `Learning registry reconciliation: scanned=${result.scanned} captured=${result.captured} `
        + `rejected=${result.rejected} failed=${result.failed} truncated=${result.truncated}`,
      );
    }
  } catch (error) {
    console.error("Learning registry reconciliation failed:", error);
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
  await runHomeserverLearningRegistryReconciliation();
  await primeTrackedPipelineSummaries();
  await reconcileTrackedPipelineSummaries();

  // A clean process restart is the recovery action for dependency drift. Only
  // a successfully captured fresh baseline may resolve the prior firing alert;
  // a failed baseline remains inconclusive and leaves it open.
  await hydrateVersionDriftAlarmState();
  await maybeResolveVersionDriftAlert().catch((err) =>
    console.error("[version-drift] Failed to resolve prior drift alert:", err),
  );

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
  // #131: proactive Claude auth-expiry alarm. Hydrate the edge-trigger state
  // from Munin (so a restart doesn't re-fire), run one probe immediately (catch
  // an already-dead credential at boot rather than waiting a full interval),
  // then arm the periodic reaper.
  if (config.authAlarm) {
    await hydrateAuthAlarmState();
    await runAuthAlarmProbe().catch((err) =>
      console.error("[auth-alarm] Initial probe failed:", err),
    );
    startAuthAlarmReaper();
  }

  let pollCount = 0;
  while (!shuttingDown) {
    try {
      pollCount++;
      await flushVersionDriftFiringState();
      await maybeResolveVersionDriftAlert();
      await reconcileTrackedPipelineSummaries();
      const processedCancellation = await processCancellationRequests();
      const processedResume = await processResumeRequests();
      const processedApproval = await processApprovalDecisions();
      const poll = await pollOnce();
      if (pollCount % 5 === 0) {
        await reconcileBlockedTasks();
      }
      if (pollCount % 60 === 0) {
        await runHomeserverLearningRegistryReconciliation();
      }
      lastBlockedTaskCount = await countTasksWithLifecycle("blocked");
      // Fire-and-forget heartbeat
      emitHeartbeat(lastBlockedTaskCount);
      if ((processedCancellation || processedResume || processedApproval || poll.hadTask) && !shuttingDown) continue; // Check for more immediately
    } catch (err) {
      console.error("Poll error:", err);
      // Still emit heartbeat on error
      emitHeartbeat(lastBlockedTaskCount);
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
    ...buildQueueObservabilityFields(lastPendingQueueSnapshot),
    blocked_tasks: lastBlockedTaskCount,
    ollama_hosts: getHostStatus(),
    egress_policy: {
      enabled: egressPolicy.enabled,
      allowed_hosts: egressPolicy.allowedHosts,
    },
    codex_sandbox: codexSandboxStatus
      ? {
          available: codexSandboxStatus.available,
          checked_at: codexSandboxStatus.checkedAt,
          command: codexSandboxStatus.command,
          failure_kind: codexSandboxStatus.failureKind,
          reason: codexSandboxStatus.reason,
        }
      : {
          available: false,
          state: "checking",
        },
    // Broker bind visibility (issue #252): distinguishes intentionally
    // disabled (no HUGIN_BROKER_KEYS) from configured-but-not-listening
    // (bind failed / still retrying / permanently failed) from listening.
    // Top-level `status` deliberately stays "ok" here — existing
    // Heimdall/monitor consumers key off it for "the dispatcher process is
    // up", which remains true even when the broker is degraded. Consumers
    // that care about the broker specifically should key off
    // `broker.degraded` (or `broker.state`), not top-level `status`.
    broker: computeBrokerHealthField(brokerEnv.enabled, brokerBindStatus),
  });
});

// Learning-loop health panels (#164). Its own LedgerClient (cached, fail-open)
// so the dashboard surface does not depend on the verdict layer being enabled.
// The collector is bounded + TTL-cached and can never break /heimdall.json.
registerHeimdallDescriptorRoute(
  app,
  new LearningLoopCollector({
    munin,
    ledgerClient: new LedgerClient({ env: process.env }),
  })
);

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
  // Cancel a pending broker bind retry (issue #252) — otherwise a queued
  // backoff timer keeps a reference alive and a late successful bind would
  // race the shutdown (handled defensively in the .then() above too).
  brokerBindAbort?.abort();
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
  stopAuthAlarmReaper();

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
          buildClaimedTerminalStatusTags("failed", entry.tags),
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

  if (currentOpencodeAbort) {
    console.log("Aborting running OpenCode task...");
    currentOpencodeAbort.abort();
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
  orinUrl: config.ollamaOrinUrl,
});
if (config.ollamaPiUrl) {
  console.log(`Ollama Pi: ${config.ollamaPiUrl}`);
}
if (config.ollamaLaptopUrl) {
  console.log(`Ollama Laptop: ${config.ollamaLaptopUrl}`);
}
if (config.ollamaOrinUrl) {
  console.log(`Ollama Orin: ${config.ollamaOrinUrl}`);
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
  const taskStore = new BrokerTaskStore(munin, { attestationSecret: config.muninApiKey });
  const learningStore = new LearningExperimentStore(learningExperimentMunin);
  const idempotency = new IdempotencyIndex();
  const homeserverReady = loadHomeserverGatewayConfig(process.env) !== null;
  const executorCapabilities = brokerExecutorCapabilities({
    homeserverEnabled: homeserverReady,
  });
  // Bounded-retry bind (issue #252): a not-yet-assigned tailnet IP
  // (HUGIN_BROKER_HOST) at boot fails EADDRNOTAVAIL until tailscaled
  // assigns it — retry transient failures with backoff rather than
  // degrading to "dispatcher without broker" on the first attempt.
  // Permanent errors (EADDRINUSE/EACCES) fail fast without retrying.
  // brokerBindStatus is updated on every transition so /health reflects
  // the live state instead of only learning about success after the fact.
  brokerBindAbort = new AbortController();
  startBrokerWithRetry(
    {
      host: brokerEnv.host,
      port: brokerEnv.port,
      keys: brokerEnv.keys,
      learningStore,
      deps: { taskStore, journal, idempotency, executorCapabilities },
    },
    {
      signal: brokerBindAbort.signal,
      onStatus: (status) => {
        brokerBindStatus = status;
      },
      onLog: (level, message) => {
        if (level === "error") console.error(`[broker] ${message}`);
        else if (level === "warn") console.warn(`[broker] ${message}`);
        else console.log(`[broker] ${message}`);
      },
    },
  ).then((rb) => {
    if (!rb) return; // permanently failed, retries exhausted, or cancelled — already logged/reported
    if (shuttingDown) {
      // Bound while shutdown was already in progress (retry sleep raced the
      // shutdown signal): don't leak an open listener into a dying process.
      rb.close().catch(() => {});
      return;
    }
    runningBroker = rb;
    console.log(
      `Broker endpoint: http://${brokerEnv.host}:${brokerEnv.port}/v1/delegate/* (principals: ${Object.keys(brokerEnv.keys).join(", ")})`,
    );
    console.log(
      `Broker canonical lifecycle: Munin dispatcher (legacy journal read-only: ${brokerHome})`,
    );
    console.log(`Broker M5 delegate executor: ${homeserverReady ? "enabled" : "disabled"}`);
  });
} else {
  brokerBindStatus = null;
  console.log("Broker: disabled (set HUGIN_BROKER_KEYS to enable)");
}

// Check Munin and the zero-token Codex sandbox concurrently before polling.
// The HTTP server is already listening so deploy acceptance can observe the
// probe's transient `checking` state, then its definitive result.
Promise.all([munin.health(), refreshCodexSandboxStatus()]).then(([ok]) => {
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
