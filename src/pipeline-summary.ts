import { z } from "zod";
import {
  pipelineDependencyFailureSchema,
  pipelineIRSchema,
  pipelineRuntimeIdSchema,
} from "./pipeline-ir.js";
import {
  structuredTaskResultSchema,
  taskExecutionOutcomeSchema,
} from "./task-result-schema.js";

export const pipelinePhaseLifecycleSchema = z.enum([
  "missing",
  "pending",
  "blocked",
  "running",
  "completed",
  "failed",
]);
export type PipelinePhaseLifecycle = z.infer<typeof pipelinePhaseLifecycleSchema>;

export const pipelineExecutionStateSchema = z.enum([
  "decomposed",
  "running",
  "completed",
  "failed",
  "completed_with_failures",
]);
export type PipelineExecutionState = z.infer<typeof pipelineExecutionStateSchema>;

export const pipelinePhaseExecutionSummarySchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  taskId: z.string().min(1),
  taskNamespace: z.string().min(1),
  runtime: pipelineRuntimeIdSchema,
  dispatcherRuntime: z.enum(["claude", "codex", "ollama"]),
  ollamaHost: z.enum(["pi", "laptop"]).optional(),
  model: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)),
  dependencyTaskIds: z.array(z.string().min(1)),
  onDependencyFailure: pipelineDependencyFailureSchema,
  lifecycle: pipelinePhaseLifecycleSchema,
  outcome: taskExecutionOutcomeSchema.optional(),
  exitCode: z.union([z.number().int(), z.literal("TIMEOUT")]).optional(),
  startedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  executor: z.string().min(1).optional(),
  resultSource: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional(),
});
export type PipelinePhaseExecutionSummary = z.infer<
  typeof pipelinePhaseExecutionSummarySchema
>;

export const pipelineExecutionSummarySchema = z.object({
  schemaVersion: z.literal(1),
  pipelineId: z.string().min(1),
  pipelineTaskNamespace: z.string().min(1),
  title: z.string().min(1),
  submittedBy: z.string().min(1),
  submittedAt: z.string().min(1),
  sensitivity: z.enum(["public", "internal", "private"]),
  replyTo: z.string().min(1).optional(),
  replyFormat: z.string().min(1).optional(),
  group: z.string().min(1).optional(),
  sequence: z.number().int().nonnegative().optional(),
  generatedAt: z.string().min(1),
  executionState: pipelineExecutionStateSchema,
  terminal: z.boolean(),
  startedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  phaseCounts: z.object({
    total: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  phases: z.array(pipelinePhaseExecutionSummarySchema).min(1),
});
export type PipelineExecutionSummary = z.infer<
  typeof pipelineExecutionSummarySchema
>;

export interface PipelinePhaseSnapshot {
  phase: z.infer<typeof pipelineIRSchema>["phases"][number];
  lifecycle: PipelinePhaseLifecycle;
  structuredResult?: z.infer<typeof structuredTaskResultSchema>;
  errorMessage?: string;
}

export function getPipelinePhaseLifecycle(
  tags: string[] | undefined
): PipelinePhaseLifecycle {
  if (!tags || tags.length === 0) return "missing";
  if (tags.includes("failed")) return "failed";
  if (tags.includes("completed")) return "completed";
  if (tags.includes("running")) return "running";
  if (tags.includes("blocked")) return "blocked";
  if (tags.includes("pending")) return "pending";
  return "missing";
}

function getExecutionState(
  counts: PipelineExecutionSummary["phaseCounts"]
): PipelineExecutionState {
  const activeCount = counts.pending + counts.blocked + counts.running;

  if (counts.running > 0) {
    return "running";
  }

  if (counts.completed === 0 && counts.failed === 0) {
    return "decomposed";
  }

  if (activeCount > 0) {
    return "running";
  }

  if (counts.failed > 0 && counts.completed > 0) {
    return "completed_with_failures";
  }

  if (counts.failed > 0) {
    return "failed";
  }

  return "completed";
}

export function buildPipelineExecutionSummary(
  pipeline: z.infer<typeof pipelineIRSchema>,
  snapshots: PipelinePhaseSnapshot[],
  generatedAt = new Date().toISOString()
): PipelineExecutionSummary {
  const phases = snapshots.map((snapshot) =>
    pipelinePhaseExecutionSummarySchema.parse({
      name: snapshot.phase.name,
      slug: snapshot.phase.slug,
      taskId: snapshot.phase.taskId,
      taskNamespace: snapshot.phase.taskNamespace,
      runtime: snapshot.phase.runtime,
      dispatcherRuntime: snapshot.phase.dispatcherRuntime,
      ollamaHost: snapshot.phase.ollamaHost,
      model: snapshot.phase.model,
      dependsOn: snapshot.phase.dependsOn,
      dependencyTaskIds: snapshot.phase.dependencyTaskIds,
      onDependencyFailure: snapshot.phase.onDependencyFailure,
      lifecycle: snapshot.lifecycle,
      outcome: snapshot.structuredResult?.outcome,
      exitCode: snapshot.structuredResult?.exitCode,
      startedAt: snapshot.structuredResult?.startedAt,
      completedAt: snapshot.structuredResult?.completedAt,
      durationSeconds: snapshot.structuredResult?.durationSeconds,
      executor: snapshot.structuredResult?.executor,
      resultSource: snapshot.structuredResult?.resultSource,
      errorMessage: snapshot.structuredResult?.errorMessage || snapshot.errorMessage,
    })
  );

  const counts = {
    total: phases.length,
    missing: phases.filter((phase) => phase.lifecycle === "missing").length,
    pending: phases.filter((phase) => phase.lifecycle === "pending").length,
    blocked: phases.filter((phase) => phase.lifecycle === "blocked").length,
    running: phases.filter((phase) => phase.lifecycle === "running").length,
    completed: phases.filter((phase) => phase.lifecycle === "completed").length,
    failed: phases.filter((phase) => phase.lifecycle === "failed").length,
  };

  const startedAtCandidates = phases
    .map((phase) => phase.startedAt)
    .filter((value): value is string => Boolean(value));
  const completedAtCandidates = phases
    .map((phase) => phase.completedAt)
    .filter((value): value is string => Boolean(value));

  const startedAt = startedAtCandidates.sort()[0];
  const completedAt = completedAtCandidates.sort().slice(-1)[0];
  const durationSeconds =
    startedAt && completedAt
      ? Math.max(
          0,
          Math.round(
            (new Date(completedAt).getTime() - new Date(startedAt).getTime()) /
              1000
          )
        )
      : undefined;

  const executionState = getExecutionState(counts);
  const terminal =
    executionState === "completed" ||
    executionState === "failed" ||
    executionState === "completed_with_failures";

  return pipelineExecutionSummarySchema.parse({
    schemaVersion: 1,
    pipelineId: pipeline.id,
    pipelineTaskNamespace: pipeline.sourceTaskNamespace,
    title: pipeline.title,
    submittedBy: pipeline.submittedBy,
    submittedAt: pipeline.submittedAt,
    sensitivity: pipeline.sensitivity,
    replyTo: pipeline.replyTo,
    replyFormat: pipeline.replyFormat,
    group: pipeline.group,
    sequence: pipeline.sequence,
    generatedAt,
    executionState,
    terminal,
    startedAt,
    completedAt,
    durationSeconds,
    phaseCounts: counts,
    phases,
  });
}
