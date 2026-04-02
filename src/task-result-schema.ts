import { z } from "zod";
import {
  pipelineAuthoritySchema,
  pipelineSensitivitySchema,
} from "./pipeline-ir.js";

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
});
export type TaskExecutionPipelineContext = z.infer<
  typeof taskExecutionPipelineContextSchema
>;

export const taskExecutionRuntimeMetadataSchema = z.object({
  requestedModel: z.string().min(1).optional(),
  effectiveModel: z.string().min(1).optional(),
  requestedHost: z.string().min(1).optional(),
  effectiveHost: z.string().min(1).optional(),
  fallbackTriggered: z.boolean().optional(),
  fallbackReason: z.string().min(1).optional(),
});
export type TaskExecutionRuntimeMetadata = z.infer<
  typeof taskExecutionRuntimeMetadataSchema
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
