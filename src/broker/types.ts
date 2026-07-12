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
  "m5",
  "tiny",
  "medium",
  "large-reasoning",
  "pi-large-coder",
]);
export type Alias = z.infer<typeof aliasSchema>;

export const taskTypeSchema = z.enum([
  "code-implement",
  "code-edit",
  "code-review",
  "unit-test-gen",
  "summarize",
  "extract",
  "classify",
  "data-transform",
  "regex",
  "sql",
  "reason-math",
  "reason-hard",
  "rewrite",
  "translate",
  "plan-decompose",
  "qa-factual",
  "triage",
  "memory-decision",
  "research-plan",
  "source-distill",
  "claim-verify",
  "gap-check",
  "synthesis",
  "other",
]);
export type TaskType = z.infer<typeof taskTypeSchema>;

export const sensitivitySchema = z.enum(["public", "internal", "private"]);
export type DelegationSensitivity = z.infer<typeof sensitivitySchema>;

export const worktreeSpecSchema = z.object({
  repo: z.string().min(1),
  base_ref: z.string().min(1),
  target_files: z.array(z.string().min(1)).optional(),
  copy_node_modules: z.boolean().optional(),
});
export type WorktreeSpec = z.infer<typeof worktreeSpecSchema>;

export const verifierSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("nonEmpty"), minLen: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal("answerIs"), expected: z.string(), ci: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("exact"), expected: z.string(), ci: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("containsAll"), subs: z.array(z.string()).min(1), ci: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("matches"), pattern: z.string(), flags: z.string().regex(/^[dimsuv]*$/).optional() }).strict()
    .refine((value) => { try { new RegExp(value.pattern, value.flags); return true; } catch { return false; } }, "invalid regular expression"),
  z.object({ type: z.literal("numeric"), expected: z.number().finite(), tol: z.number().nonnegative().finite().optional() }).strict(),
  z.object({ type: z.literal("maxLength"), max: z.number().int().nonnegative(), min: z.number().int().nonnegative().optional() }).strict()
    .refine((value) => value.min === undefined || value.min <= value.max, "min must be <= max"),
  z.object({ type: z.literal("jsonValid") }).strict(),
]);

export const delegationRequestSchema = z.object({
  envelope_version: z.literal(2),
  idempotency_key: z.string().uuid(),
  orchestrator_session_id: z.string().min(1),
  orchestrator_submitter: z.string().min(1),
  parent_task_id: z.string().min(1).optional(),
  task_type: taskTypeSchema,
  prompt: z.string().min(1),
  alias_requested: aliasSchema,
  alias_map_version: z.number().int().nonnegative(),
  worktree: worktreeSpecSchema.optional(),
  sensitivity: sensitivitySchema,
  timeout_ms: z.number().int().positive().max(900_000),
  max_output_tokens: z.number().int().positive().max(32_768),
  acceptance: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("l1_review") }).strict(),
    z.object({
      mode: z.literal("verifier"),
      verifier: verifierSpecSchema,
    }).strict(),
  ]),
  allowed_destinations: z.array(z.literal("m5")).length(1),
  tool_policy: z.object({ mode: z.literal("none") }).strict(),
  budget: z.object({ max_attempts: z.literal(1), max_cost_usd: z.literal(0) }).strict(),
  durability: z.literal("required"),
  delivery: z.object({ mode: z.literal("munin") }).strict(),
  escalation: z.object({ mode: z.literal("return_to_l1") }).strict(),
});
export type DelegationRequest = z.infer<typeof delegationRequestSchema>;

export const runtimeFamilySchema = z.enum(["one-shot", "harness"]);
export const runtimeEffectiveSchema = z.enum([
  "homeserver",
  "ollama",
  "openrouter",
  "pi-harness",
]);
export const hostEffectiveSchema = z.enum(["m5", "pi", "mba", "openrouter"]);
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
  // Durable-handoff evidence (#164). OPTIONAL on purpose: an older hugin-mcp
  // sends no session id, and must keep working — it simply proves nothing. See
  // src/broker/await-observation.ts.
  orchestrator_session_id: z.string().min(1).optional(),
});
export type AwaitRequest = z.infer<typeof awaitRequestSchema>;

export const submitResponseSchema = z.object({
  task_id: z.string().min(1),
  received_at: z.string().min(1),
  reused_idempotency: z.boolean(),
  // Non-blocking submit-time advice (#184), e.g. a judgment-flavored
  // task_type submitted with the default l1_review acceptance and no
  // rubric in the prompt. Never causes rejection — see submit-warnings.ts.
  warnings: z.array(z.string()).optional(),
});
export type SubmitResponse = z.infer<typeof submitResponseSchema>;

export const listRequestSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  since_ts: z.string().min(1).optional(),
  outcome: z.enum(["completed", "failed", "running", "any"]).optional(),
  alias: aliasSchema.optional(),
});
export type ListRequest = z.infer<typeof listRequestSchema>;
