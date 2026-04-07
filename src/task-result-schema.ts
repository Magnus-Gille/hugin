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

export const dispatcherRuntimeSchema = z.enum(["claude", "codex", "ollama"]);
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
  runtimeMetadata: taskExecutionRuntimeMetadataSchema.optional(),
  pipeline: taskExecutionPipelineContextSchema.optional(),
  approval: taskExecutionApprovalMetadataSchema.optional(),
  sensitivity: taskExecutionSensitivitySchema.optional(),
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
