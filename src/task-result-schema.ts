import { z } from "zod";
import {
  pipelineAuthoritySchema,
  pipelineSideEffectIdSchema,
  pipelineSensitivitySchema,
} from "./pipeline-ir.js";
import { M5_OUTCOMES } from "./m5-provenance.js";
import { sensitivitySchema } from "./sensitivity.js";
import {
  SIGNING_POLICIES,
  TASK_SIGNATURE_STATUSES,
} from "./task-signing.js";
import { huginTaskIdentitySchema } from "./task-identity.js";
import { learningTaskExecutionEvidenceSchema } from "./learning-task-handshake.js";

export const taskExecutionOutcomeSchema = z.enum([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
]);
export type TaskExecutionOutcome = z.infer<typeof taskExecutionOutcomeSchema>;

export const taskExecutionBodyKindSchema = z.enum([
  "response",
  "output",
  "error",
]);
export type TaskExecutionBodyKind = z.infer<typeof taskExecutionBodyKindSchema>;

// The structured task result schema is the dispatcher's local view. It only
// sees the legacy executor runtimes (claude/codex/ollama). Orchestrator-only
// runtimes (openrouter, pi-harness) flow through a separate broker path and
// produce DelegationResult, never StructuredTaskResult.
// "orchestrator" is the in-process multi-model fanout runtime (Phase 3b).
export const dispatcherRuntimeSchema = z.enum([
  "claude",
  "codex",
  "ollama",
  "opencode",
  "homeserver",
  "auto",
  "orchestrator",
  "pipeline",
]);
export type DispatcherRuntime = z.infer<typeof dispatcherRuntimeSchema>;

export const taskExecutionPipelineContextSchema = z.object({
  pipelineId: z.string().min(1),
  phase: z.string().min(1),
  dependencyTaskIds: z.array(z.string().min(1)).default([]),
  dependencyPhases: z.array(z.string().min(1)).default([]),
  submittedBy: z.string().min(1).optional(),
  sensitivity: pipelineSensitivitySchema.optional(),
  authority: pipelineAuthoritySchema.optional(),
  sideEffects: z.array(pipelineSideEffectIdSchema).default([]),
});
export type TaskExecutionPipelineContext = z.infer<
  typeof taskExecutionPipelineContextSchema
>;

export const taskApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
]);
export type TaskApprovalStatus = z.infer<typeof taskApprovalStatusSchema>;

export const taskExecutionApprovalMetadataSchema = z.object({
  status: taskApprovalStatusSchema,
  requestedAt: z.string().min(1).optional(),
  decidedAt: z.string().min(1).optional(),
  decisionSource: z.string().min(1).optional(),
  operationKey: z.string().min(1).optional(),
});
export type TaskExecutionApprovalMetadata = z.infer<
  typeof taskExecutionApprovalMetadataSchema
>;

export const routingEliminationSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
});

// Skill-lane routing decision (issue #84 / #79–#83). Recorded for EVERY task the
// local-skill lane considers — including abstentions — so a route decision is
// auditable. Additive + optional, same non-breaking rationale as artifactDelivery
// below: old Zod readers strip it. The classifier/retrieval/binding selection
// lives in src/skill/*; this is just the audit record carried in the result.
export const skillRouteSchema = z.object({
  bindingId: z.string().min(1).optional(),
  bindingVersion: z.number().int().nonnegative().optional(),
  classId: z.string().min(1).optional(),
  classConfidence: z.number().min(0).max(1).optional(),
  abstained: z.boolean().default(false),
  abstainReason: z.string().min(1).optional(),
});
export type SkillRoute = z.infer<typeof skillRouteSchema>;

// M5 execution provenance (issue #163). ONE canonical shape, shared by both
// places Hugin delegates to M5: `runtimeMetadata.delegation` (the direct
// homeserver executor, which backs the canonical #167 MCP-Broker leaf) and
// `orchestratorOutcomes[].delegation` (each orchestrator fan-out leaf). Before
// #163 the orchestrator path carried none of this, so a fanout leaf could not
// be traced to the node/model/verifier that produced it.
//
// Every field is optional: a gateway that omits one, or emits one out of
// contract, must degrade to "absent" rather than fail the result-structured
// write of an already-successful, paid run. src/m5-provenance.ts is the only
// sanctioned producer — it validates enums/bounds on the untrusted gateway
// response so this schema never sees a value it would reject.
//
// This is a TRACE, not a verdict: `ledgerId` joins back to M5's authoritative
// evidence row. Hugin never duplicates M5's capability judgement into a
// Hugin-owned capability store.
export const delegationProvenanceSchema = z.object({
  ledgerId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  taskType: z.string().min(1).optional(),
  // Enum + bounds declared here as well as in the sanitizer, so the contract
  // cannot silently drift between the two (Codex review of #163).
  outcome: z.enum(M5_OUTCOMES).optional(),
  score: z.number().min(0).max(1).optional(),
  decisionReason: z.string().min(1).optional(),
  verifier: z.string().min(1).optional(),
  verifierNotes: z.string().min(1).optional(),
  delegated: z.boolean().optional(),
  escalated: z.boolean().optional(),
  formatRetried: z.boolean().optional(),
  policyMode: z.string().min(1).optional(),
  policyAction: z.string().min(1).optional(),
  policyReason: z.string().min(1).optional(),
  priceCatalogVersion: z.string().min(1).optional(),
  costTraceId: z.string().min(1).optional(),
});
export type DelegationProvenance = z.infer<typeof delegationProvenanceSchema>;

export const taskExecutionRuntimeMetadataSchema = z.object({
  requestedModel: z.string().min(1).optional(),
  effectiveModel: z.string().min(1).optional(),
  requestedHost: z.string().min(1).optional(),
  effectiveHost: z.string().min(1).optional(),
  fallbackTriggered: z.boolean().optional(),
  fallbackReason: z.string().min(1).optional(),
  autoRouted: z.boolean().optional(),
  routingReason: z.string().min(1).optional(),
  eliminatedRuntimes: z.array(routingEliminationSchema).optional(),
  skillRoute: skillRouteSchema.optional(),
  delegation: delegationProvenanceSchema.optional(),
  // Producer-side identity only. Gateway-authenticated acceptance/echo lives
  // in the separate LearningTaskContract evidence field below.
  huginTaskIdentity: huginTaskIdentitySchema.optional(),
  // Authenticated LearningTaskContract v1 producer stamp/echo and the exact
  // durable Hugin attempt references. This remains separate from the legacy
  // #230 identity so raw and rendered prompt semantics cannot collapse.
  learningTask: learningTaskExecutionEvidenceSchema.optional(),
});
export type TaskExecutionRuntimeMetadata = z.infer<
  typeof taskExecutionRuntimeMetadataSchema
>;

export const taskExecutionSensitivitySchema = z.object({
  declared: sensitivitySchema.optional(),
  effective: sensitivitySchema,
  mismatch: z.boolean().default(false),
});
export type TaskExecutionSensitivity = z.infer<
  typeof taskExecutionSensitivitySchema
>;

// Optional runtime-owned artefact delivery state (issue #68). Added under
// schemaVersion 1 WITHOUT a version bump or `outcome` enum widening: Codex's
// consumer grep confirmed Ratatoskr/broker/hugin-mcp neither pin
// `schemaVersion` nor exhaustively switch `outcome`, so an extra optional
// object is non-breaking. Old Zod readers strip it, so delivery state is ALSO
// carried in status tags (`delivery:*`) + human markdown — this field is a
// convenience for new consumers, not the source of truth.
export const artifactDeliveryRecordSchema = z.object({
  id: z.string().min(1),
  status: z.enum([
    "verified",
    "missing-local",
    "unsafe-local",
    "delivery-failed",
    "verify-failed",
  ]),
  remote: z.string().min(1),
  bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

export const artifactDeliverySchema = z.object({
  ok: z.boolean(),
  failureKind: z.enum(["missing-local", "unsafe-local", "infra"]).optional(),
  artifacts: z.array(artifactDeliveryRecordSchema).default([]),
});
export type ArtifactDeliveryStructured = z.infer<typeof artifactDeliverySchema>;

// Optional per-worker outcome record (verdict layer V8, issue #137 follow-up —
// docs/orchestrator-verdict-layer.md). Additive + optional, same non-breaking
// rationale as artifactDelivery/skillRoute above: old Zod readers strip it.
// This is the raw material for the savings tracker (PR3, docs/orchestrator-
// savings-tracker.md S4) and closes the "rich per-worker data computed then
// discarded" gap in the orchestrator runtime. `verdictOk` is `null` when the
// subtask was never verified (or the verifier call itself failed — V3),
// distinct from an explicit pass/fail. `inputTokens`/`outputTokens` (PR3 S4)
// are additive + optional/nullable on top of the V8 shape — they close the
// gap that motivated the savings tracker's per-call ledger (engine.ts
// ModelCallRecord) and make outcomes self-sufficient for offline analysis;
// `null`/absent when the underlying WorkerResult didn't report token counts
// (e.g. a failed call).
export const orchestratorOutcomeSchema = z.object({
  subtaskId: z.string().min(1),
  taskType: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  ok: z.boolean(),
  verdictOk: z.boolean().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable().optional(),
  outputTokens: z.number().int().nonnegative().nullable().optional(),
  // Issue #160: Hugin's explicit macro route and its effective destination.
  // These describe only node selection, never prompts or context content.
  selectedNode: z.string().min(1).optional(),
  effectiveNode: z.string().min(1).optional(),
  fallbackTriggered: z.boolean().optional(),
  fallbackReason: z.string().min(1).optional(),
  // Per-worker failure detail (issue #157) — additive + optional, same
  // non-breaking rationale as the token fields above. Carries the worker's
  // exact error verbatim (e.g. `HTTP 503 server_busy retryAfterS=5 — gave up
  // after 6 attempts`) so a failed fanout leaf is diagnosable from the
  // structured result instead of reading as mysterious agent flakiness.
  // Absent for successful workers.
  error: z.string().min(1).optional(),
  // M5 execution provenance for this leaf (issue #163) — additive + optional,
  // same non-breaking rationale as the fields above. Present only for workers
  // that actually went through the M5 `/delegate` lane (provider `homeserver`);
  // absent for OpenRouter/Berget/pi-harness leaves, which have no M5 ledger row.
  delegation: delegationProvenanceSchema.optional(),
});
export type OrchestratorOutcomeRecord = z.infer<typeof orchestratorOutcomeSchema>;

// Optional per-task savings summary (PR3, S4 — docs/orchestrator-savings-
// tracker.md). Additive + optional, same non-breaking rationale as
// artifactDelivery/orchestratorOutcomes above: old Zod readers strip it. This
// is the per-task view of savings vs the all-Claude baseline, computed by
// src/orchestrator/savings.ts#computeSavings from the engine's per-call
// ledger — NEVER from totalCostUsd (all-or-nothing-null). The aggregate
// (cross-task) counters live separately in the tasks/_savings Munin doc
// (src/orchestrator/savings-store.ts); this field carries only the single
// run's numbers, mirroring the per-task/aggregate split used by the verdict
// layer (orchestratorOutcomes vs tasks/_verdicts).
// Per-verdict-outcome bucket (issue #144) — covered subtask-attributed calls
// (worker + verifier) grouped by the subtask's verdict outcome. Keys are
// SavingsVerdictOutcome values ("pass" | "fail" | "unknown" | "error" |
// "escalated"); kept as a plain string record so an outcome added later
// doesn't break old readers.
export const savingsOutcomeBucketSchema = z.object({
  calls: z.number().int().nonnegative(),
  actualCostUsd: z.number().nonnegative(),
  baselineCostUsd: z.number().nonnegative(),
  qaBaselineCreditUsd: z.number().nonnegative(),
});

export const savingsSummarySchema = z.object({
  baselineModelId: z.string().min(1),
  coveredCalls: z.number().int().nonnegative(),
  uncoveredCalls: z.number().int().nonnegative(),
  actualCostUsd: z.number().nonnegative(),
  baselineCostUsd: z.number().nonnegative(),
  savedUsd: z.number(),
  // Quality-adjusted series (issue #144) — additive + optional so results
  // written before the join still parse. `qualityAdjustedSavedUsd` is the
  // headline number decisions must read (can be negative — a cheap-but-wrong
  // run is a loss, not a saving); `savedUsd` above is the RAW series, kept
  // for comparability only.
  qaBaselineCreditUsd: z.number().nonnegative().optional(),
  qualityAdjustedSavedUsd: z.number().optional(),
  byOutcome: z.record(z.string(), savingsOutcomeBucketSchema).optional(),
});
export type SavingsSummaryRecord = z.infer<typeof savingsSummarySchema>;

// Submission identity is additive/optional for compatibility with historical
// schemaVersion=1 results, but every current dispatcher writer supplies it.
// Null is explicit: absence of cryptographic verification must never be
// mistaken for the claimed submitter being authenticated.
export const taskSubmissionProvenanceSchema = z.object({
  claimedSubmitter: z.string().min(1),
  verifiedSubmitter: z.string().min(1).nullable(),
  policy: z.enum(SIGNING_POLICIES),
  signatureStatus: z.enum(TASK_SIGNATURE_STATUSES),
  keyId: z.string().min(1).nullable(),
});
export type TaskSubmissionProvenance = z.infer<
  typeof taskSubmissionProvenanceSchema
>;

// Exact, content-blind repository binding for completed managed-checkout work.
// This is deliberately optional for historical/non-code tasks and contains no
// prompt, answer, diff, credential, or file contents. It lets the offline exam
// factory reconstruct the exact before/after trees from Git without trusting
// an agent's prose claim that it edited or tested something.
export const repositoryChangeEvidenceSchema = z.object({
  // Optional only for historical schema-v1 results. Every current managed
  // repository writer supplies the resolved/validated branch (#217).
  baseBranch: z.string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    .refine(
      (value) =>
        value.toUpperCase() !== "HEAD" &&
        !value.startsWith("origin/") &&
        !value.startsWith("refs/") &&
        !value.includes("..") &&
        !value.includes("//") &&
        !value.split("/").some(
          (component) => component.startsWith(".") || component.endsWith(".lock"),
        ),
      "invalid repository base branch",
    )
    .optional(),
  baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
  headCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
  changedFiles: z.array(z.string().min(1)).min(1).max(10_000),
  diffSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict().superRefine((value, ctx) => {
  if (value.baseCommit === value.headCommit) {
    ctx.addIssue({
      code: "custom",
      path: ["headCommit"],
      message: "head commit must differ from base commit",
    });
  }
  value.changedFiles.forEach((file, index) => {
    if (file.startsWith("/") || file.split("/").includes("..") || file.includes("\0")) {
      ctx.addIssue({
        code: "custom",
        path: ["changedFiles", index],
        message: "changed file must be a safe repository-relative path",
      });
    }
  });
});
export type RepositoryChangeEvidence = z.infer<typeof repositoryChangeEvidenceSchema>;

// Execution and publication are separate facts from semantic acceptance.
// Current writers always emit this content-blind repository outcome, including
// an explicit no-op. It remains optional so historical schema-v1 results parse.
export const repositoryOutcomeSchema = z.object({
  state: z.enum([
    "not-managed",
    "checkout-failed",
    "not-finalized",
    "no-changes",
    "changes-present",
    "publication-failed",
    // Issue #225: reached only via the durable publication-recovery seam,
    // never by the primary execution path. "publication-recovered" means an
    // authorized operator retried a prior "publication-failed" outcome and
    // the push/PR was confirmed complete (freshly published or reconciled
    // against a partial success). "publication-abandoned" means recovery
    // could not safely proceed (e.g. the local task branch no longer matches
    // the recorded exact head) and the failure is terminal without a rerun.
    "publication-recovered",
    "publication-abandoned",
  ]),
  baseBranch: repositoryChangeEvidenceSchema.shape.baseBranch,
  baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
}).strict().superRefine((value, ctx) => {
  if ([
    "no-changes",
    "changes-present",
    "publication-failed",
    "publication-recovered",
    "publication-abandoned",
  ].includes(value.state)) {
    if (!value.baseBranch) {
      ctx.addIssue({ code: "custom", path: ["baseBranch"], message: "managed outcome requires baseBranch" });
    }
    if (!value.baseCommit) {
      ctx.addIssue({ code: "custom", path: ["baseCommit"], message: "managed outcome requires baseCommit" });
    }
  }
});
export type RepositoryOutcome = z.infer<typeof repositoryOutcomeSchema>;

export const structuredTaskResultSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  taskNamespace: z.string().min(1),
  lifecycle: z.enum(["completed", "failed", "cancelled"]),
  outcome: taskExecutionOutcomeSchema,
  runtime: dispatcherRuntimeSchema,
  executor: z.string().min(1),
  resultSource: z.string().min(1),
  exitCode: z.union([
    z.number().int(),
    z.literal("TIMEOUT"),
    z.literal("CANCELLED"),
  ]),
  startedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1),
  durationSeconds: z.number().int().nonnegative().optional(),
  logFile: z.string().min(1).optional(),
  replyTo: z.string().min(1).optional(),
  replyFormat: z.string().min(1).optional(),
  group: z.string().min(1).optional(),
  sequence: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  bodyKind: taskExecutionBodyKindSchema,
  bodyText: z.string(),
  errorMessage: z.string().min(1).optional(),
  prUrl: z.string().url().optional(),
  repositoryOutcome: repositoryOutcomeSchema.optional(),
  repositoryChange: repositoryChangeEvidenceSchema.optional(),
  runtimeMetadata: taskExecutionRuntimeMetadataSchema.optional(),
  pipeline: taskExecutionPipelineContextSchema.optional(),
  approval: taskExecutionApprovalMetadataSchema.optional(),
  sensitivity: taskExecutionSensitivitySchema.optional(),
  artifactDelivery: artifactDeliverySchema.optional(),
  orchestratorOutcomes: z.array(orchestratorOutcomeSchema).optional(),
  savings: savingsSummarySchema.optional(),
  provenance: taskSubmissionProvenanceSchema.optional(),
}).superRefine((value, ctx) => {
  const learning = value.runtimeMetadata?.learningTask;
  if (!learning) return;
  const producerIdentity = value.runtimeMetadata?.huginTaskIdentity;
  if (!producerIdentity) {
    ctx.addIssue({
      code: "custom",
      path: ["runtimeMetadata", "huginTaskIdentity"],
      message: "learning evidence requires the exact Hugin producer identity",
    });
    return;
  }
  if (learning.taskId !== value.taskId) {
    ctx.addIssue({
      code: "custom",
      path: ["runtimeMetadata", "learningTask", "taskId"],
      message: "learning evidence task id does not match the structured result",
    });
  }
  if (learning.taskOutcomeRef.namespace !== value.taskNamespace
    || learning.taskOutcomeRef.key !== "result-structured") {
    ctx.addIssue({
      code: "custom",
      path: ["runtimeMetadata", "learningTask", "taskOutcomeRef"],
      message: "learning evidence task outcome reference does not match the structured result",
    });
  }
  if (producerIdentity.taskId !== value.taskId
    || producerIdentity.taskId !== learning.taskId) {
    ctx.addIssue({
      code: "custom",
      path: ["runtimeMetadata", "huginTaskIdentity", "taskId"],
      message: "Hugin producer identity task id does not match the structured result learning task",
    });
  }
  if (producerIdentity.rawTaskFingerprint.algorithm !== learning.rawFingerprint.algorithm
    || producerIdentity.rawTaskFingerprint.version !== learning.rawFingerprint.version
    || producerIdentity.rawTaskFingerprint.digest !== learning.rawFingerprint.digest) {
    ctx.addIssue({
      code: "custom",
      path: ["runtimeMetadata", "huginTaskIdentity", "rawTaskFingerprint"],
      message: "Hugin producer identity raw fingerprint does not match learning evidence",
    });
  }
  if (learning.requestStamp
    && (learning.requestStamp.raw_fingerprint.algorithm !== producerIdentity.rawTaskFingerprint.algorithm
      || learning.requestStamp.raw_fingerprint.version !== producerIdentity.rawTaskFingerprint.version
      || learning.requestStamp.raw_fingerprint.digest !== producerIdentity.rawTaskFingerprint.digest)) {
    ctx.addIssue({
      code: "custom",
      path: ["runtimeMetadata", "learningTask", "requestStamp", "raw_fingerprint"],
      message: "learning request stamp raw fingerprint does not match the Hugin producer identity",
    });
  }
});
export type StructuredTaskResult = z.infer<typeof structuredTaskResultSchema>;

export function buildStructuredTaskResult(
  input: StructuredTaskResult
): StructuredTaskResult {
  const normalizedErrorMessage = input.errorMessage?.trim();
  return structuredTaskResultSchema.parse({
    ...input,
    errorMessage: normalizedErrorMessage || undefined,
  });
}
