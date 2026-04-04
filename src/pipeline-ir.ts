import { z } from "zod";
import { sensitivitySchema, type Sensitivity } from "./sensitivity.js";

export const pipelineSensitivitySchema = sensitivitySchema;
export type PipelineSensitivity = Sensitivity;

export const pipelineAuthoritySchema = z.enum(["autonomous", "gated"]);
export type PipelineAuthority = z.infer<typeof pipelineAuthoritySchema>;

export const pipelineSideEffectIdSchema = z.enum([
  "git.push",
  "git.merge",
  "github.pr.create",
  "github.pr.merge",
  "deploy.service",
  "message.telegram.send",
  "message.email.send",
  "file.write.outside_workspace",
]);
export type PipelineSideEffectId = z.infer<typeof pipelineSideEffectIdSchema>;

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
  defaultModel?: string;
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
    defaultModel: "qwen2.5:3b",
  },
  "ollama-laptop": {
    id: "ollama-laptop",
    dispatcherRuntime: "ollama",
    ollamaHost: "laptop",
    defaultModel: "qwen3.5:35b-a3b",
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
  model: z.string().min(1).optional(),
  context: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)),
  dependencyTaskIds: z.array(z.string().min(1)),
  onDependencyFailure: pipelineDependencyFailureSchema,
  prompt: z.string().min(1),
  timeout: z.number().int().positive().optional(),
  authority: pipelineAuthoritySchema,
  sideEffects: z.array(pipelineSideEffectIdSchema).default([]),
  declaredSensitivity: pipelineSensitivitySchema.optional(),
  effectiveSensitivity: pipelineSensitivitySchema,
});

export type PipelinePhaseIR = z.infer<typeof pipelinePhaseIRSchema>;

export const pipelineIRSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  sourceTaskNamespace: z.string().min(1),
  declaredSensitivity: pipelineSensitivitySchema.optional(),
  sensitivity: pipelineSensitivitySchema,
  replyTo: z.string().min(1).optional(),
  replyFormat: z.string().min(1).optional(),
  group: z.string().min(1).optional(),
  sequence: z.number().int().nonnegative().optional(),
  submittedBy: z.string().min(1),
  submittedAt: z.string().min(1),
  phases: z.array(pipelinePhaseIRSchema).min(1),
});

export type PipelineIR = z.infer<typeof pipelineIRSchema>;

export interface PipelinePhaseTaskDraft {
  namespace: string;
  content: string;
  tags: string[];
  classification: PipelineSensitivity;
}
