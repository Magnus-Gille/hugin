/**
 * Zod schemas for the Pi-side broker (orchestrator v1).
 *
 * Mirrors the wire contract in docs/orchestrator-v1-data-model.md §3 (request
 * envelope), §4 (await/result), §5 (journal events). These schemas live on the
 * Hugin side; the MCP package will publish a separate, narrower set for client
 * use, but the broker is the authoritative validator.
 */

import { z } from "zod";

export const aliasSchema = z.enum([
  "tiny",
  "medium",
  "large-reasoning",
  "pi-large-coder",
]);
export type Alias = z.infer<typeof aliasSchema>;

export const taskTypeSchema = z.enum([
  "summarize",
  "extract",
  "classify",
  "draft",
  "reason",
  "rewrite",
  "code-edit",
  "other",
]);
export type TaskType = z.infer<typeof taskTypeSchema>;

export const sensitivitySchema = z.enum(["public", "internal"]);
export type DelegationSensitivity = z.infer<typeof sensitivitySchema>;

export const worktreeSpecSchema = z.object({
  repo: z.string().min(1),
  base_ref: z.string().min(1),
  target_files: z.array(z.string().min(1)).optional(),
  copy_node_modules: z.boolean().optional(),
});
export type WorktreeSpec = z.infer<typeof worktreeSpecSchema>;

export const delegationRequestSchema = z.object({
  envelope_version: z.literal(1),
  idempotency_key: z.string().uuid(),
  orchestrator_session_id: z.string().min(1),
  orchestrator_submitter: z.string().min(1),
  parent_task_id: z.string().min(1).optional(),
  task_type: taskTypeSchema,
  prompt: z.string().min(1),
  alias_requested: aliasSchema,
  alias_map_version: z.number().int().nonnegative(),
  worktree: worktreeSpecSchema.optional(),
  sensitivity: sensitivitySchema.optional(),
  timeout_ms: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
});
export type DelegationRequest = z.infer<typeof delegationRequestSchema>;

export const runtimeFamilySchema = z.enum(["one-shot", "harness"]);
export const runtimeEffectiveSchema = z.enum([
  "ollama",
  "openrouter",
  "pi-harness",
]);
export const hostEffectiveSchema = z.enum(["pi", "mba", "openrouter"]);
export const reasoningLevelSchema = z.enum(["low", "medium", "high"]);

export const aliasResolvedSchema = z.object({
  alias: aliasSchema,
  family: runtimeFamilySchema,
  harness: z.literal("pi").optional(),
  harness_version: z.string().min(1).optional(),
  model_requested: z.string().min(1),
  runtime: runtimeEffectiveSchema,
  runtime_row_id: z.string().min(1),
  host: hostEffectiveSchema,
  reasoning_level: reasoningLevelSchema.optional(),
});
export type AliasResolved = z.infer<typeof aliasResolvedSchema>;

export const worktreeResolvedSchema = z.object({
  repo: z.string().min(1),
  base_ref: z.string().min(1),
  base_sha: z.string().min(1),
  worktree_path: z.string().min(1),
});
export type WorktreeResolved = z.infer<typeof worktreeResolvedSchema>;

export const brokerAnnotationsSchema = z.object({
  task_id: z.string().min(1),
  broker_principal: z.string().min(1),
  received_at: z.string().min(1),
  alias_resolved: aliasResolvedSchema,
  worktree_resolved: worktreeResolvedSchema.optional(),
  policy_version: z.string().min(1),
});
export type BrokerAnnotations = z.infer<typeof brokerAnnotationsSchema>;

export const delegationEnvelopeSchema =
  delegationRequestSchema.merge(brokerAnnotationsSchema);
export type DelegationEnvelope = z.infer<typeof delegationEnvelopeSchema>;

export const delegationErrorKindSchema = z.enum([
  "alias_unknown",
  "alias_unavailable",
  "policy_rejected",
  "executor_failed",
  "scanner_blocked",
  "timeout",
  "internal",
]);
export type DelegationErrorKind = z.infer<typeof delegationErrorKindSchema>;

export const delegationErrorSchema = z.object({
  task_id: z.string().min(1),
  kind: delegationErrorKindSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
});
export type DelegationError = z.infer<typeof delegationErrorSchema>;

export const ratingSchema = z.enum(["pass", "partial", "redo", "wrong"]);
export const verificationOutcomeSchema = z.enum([
  "accepted_unchanged",
  "minor_edit",
  "major_rewrite",
  "discarded",
  "escalated_to_claude",
]);

export const rateRequestSchema = z.object({
  task_id: z.string().min(1),
  rating: ratingSchema,
  rating_reason: z.string().min(1),
  verification_outcome: verificationOutcomeSchema,
  retries_count: z.number().int().nonnegative().optional(),
});
export type RateRequest = z.infer<typeof rateRequestSchema>;

export const awaitRequestSchema = z.object({
  task_id: z.string().min(1),
  max_wait_s: z.number().int().nonnegative().optional(),
});
export type AwaitRequest = z.infer<typeof awaitRequestSchema>;

export const submitResponseSchema = z.object({
  task_id: z.string().min(1),
  received_at: z.string().min(1),
  reused_idempotency: z.boolean(),
});
export type SubmitResponse = z.infer<typeof submitResponseSchema>;

export const listRequestSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  since_ts: z.string().min(1).optional(),
  outcome: z.enum(["completed", "failed", "running", "any"]).optional(),
  alias: aliasSchema.optional(),
});
export type ListRequest = z.infer<typeof listRequestSchema>;
