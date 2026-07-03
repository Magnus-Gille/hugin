import { z } from "zod";
import {
  pipelineAuthoritySchema,
  pipelineSideEffectIdSchema,
  pipelineSensitivitySchema,
} from "./pipeline-ir.js";
import { sensitivitySchema } from "./sensitivity.js";

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
  "auto",
  "orchestrator",
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
// This is the raw material for a future savings tracker (PR3) and closes the
// "rich per-worker data computed then discarded" gap in the orchestrator
// runtime. `verdictOk` is `null` when the subtask was never verified (or the
// verifier call itself failed — V3), distinct from an explicit pass/fail.
export const orchestratorOutcomeSchema = z.object({
  subtaskId: z.string().min(1),
  taskType: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  ok: z.boolean(),
  verdictOk: z.boolean().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative(),
});
export type OrchestratorOutcomeRecord = z.infer<typeof orchestratorOutcomeSchema>;

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
  runtimeMetadata: taskExecutionRuntimeMetadataSchema.optional(),
  pipeline: taskExecutionPipelineContextSchema.optional(),
  approval: taskExecutionApprovalMetadataSchema.optional(),
  sensitivity: taskExecutionSensitivitySchema.optional(),
  artifactDelivery: artifactDeliverySchema.optional(),
  orchestratorOutcomes: z.array(orchestratorOutcomeSchema).optional(),
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
