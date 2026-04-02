import { z } from "zod";

export const pipelineSensitivitySchema = z.enum(["public", "internal", "private"]);
export type PipelineSensitivity = z.infer<typeof pipelineSensitivitySchema>;

export const pipelineAuthoritySchema = z.enum(["autonomous", "gated"]);
export type PipelineAuthority = z.infer<typeof pipelineAuthoritySchema>;

export const pipelineDependencyFailureSchema = z.enum(["fail", "continue"]);
export type PipelineDependencyFailure = z.infer<typeof pipelineDependencyFailureSchema>;

export const pipelineRuntimeIdSchema = z.enum([
  "claude-sdk",
  "codex-spawn",
  "ollama-pi",
  "ollama-laptop",
]);
export type PipelineRuntimeId = z.infer<typeof pipelineRuntimeIdSchema>;

export interface PipelineRuntimeDefinition {
  id: PipelineRuntimeId;
  dispatcherRuntime: "claude" | "codex" | "ollama";
  ollamaHost?: "pi" | "laptop";
}

export const PIPELINE_RUNTIME_REGISTRY: Record<PipelineRuntimeId, PipelineRuntimeDefinition> = {
  "claude-sdk": {
    id: "claude-sdk",
    dispatcherRuntime: "claude",
  },
  "codex-spawn": {
    id: "codex-spawn",
    dispatcherRuntime: "codex",
  },
  "ollama-pi": {
    id: "ollama-pi",
    dispatcherRuntime: "ollama",
    ollamaHost: "pi",
  },
  "ollama-laptop": {
    id: "ollama-laptop",
    dispatcherRuntime: "ollama",
    ollamaHost: "laptop",
  },
};

export const pipelinePhaseIRSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  taskId: z.string().min(1),
  taskNamespace: z.string().min(1),
  runtime: pipelineRuntimeIdSchema,
  dispatcherRuntime: z.enum(["claude", "codex", "ollama"]),
  ollamaHost: z.enum(["pi", "laptop"]).optional(),
  context: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)),
  dependencyTaskIds: z.array(z.string().min(1)),
  onDependencyFailure: pipelineDependencyFailureSchema,
  prompt: z.string().min(1),
  timeout: z.number().int().positive().optional(),
  authority: pipelineAuthoritySchema,
  effectiveSensitivity: pipelineSensitivitySchema,
});

export type PipelinePhaseIR = z.infer<typeof pipelinePhaseIRSchema>;

export const pipelineIRSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  sourceTaskNamespace: z.string().min(1),
  sensitivity: pipelineSensitivitySchema,
  replyTo: z.string().min(1).optional(),
  replyFormat: z.string().min(1).optional(),
  submittedBy: z.string().min(1),
  submittedAt: z.string().min(1),
  phases: z.array(pipelinePhaseIRSchema).min(1),
});

export type PipelineIR = z.infer<typeof pipelineIRSchema>;

export interface PipelinePhaseTaskDraft {
  namespace: string;
  content: string;
  tags: string[];
}
