/**
 * Zod schemas for the Pi-side broker (orchestrator v1).
 *
 * Mirrors the wire contract in docs/orchestrator-v1-data-model.md §3 (request
 * envelope), §4 (await/result), §5 (journal events). These schemas live on the
 * Hugin side; the MCP package will publish a separate, narrower set for client
 * use, but the broker is the authoritative validator.
 */

import { z } from "zod";
import {
  qualityFailureCodeSchema,
  qualityRubricSchema,
  qualityVerifierIdentitySchema,
} from "../quality-receipt.js";
import {
  taskTypeSchema,
  type TaskType,
} from "./task-type-metadata.js";

export { taskTypeSchema, type TaskType } from "./task-type-metadata.js";

export const aliasSchema = z.enum([
  "m5",
  "tiny",
  "medium",
  "large-reasoning",
  "pi-large-coder",
]);
export type Alias = z.infer<typeof aliasSchema>;

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

const qualityWireConfigurationIdentitySchema = z.object({
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(200),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const qualityCorrectionRequestSchema = z.object({
  predecessor_receipt_id: z.string().regex(/^qr-[0-9a-f]{24}$/),
  rubric: qualityRubricSchema,
  verifier: qualityVerifierIdentitySchema,
  failure: z.object({
    taxonomy: z.object({
      id: z.string().min(1).max(200),
      version: z.string().min(1).max(200),
    }).strict(),
    code: qualityFailureCodeSchema,
  }).strict(),
  producing_configuration: z.object({
    prompt: qualityWireConfigurationIdentitySchema.optional(),
    harness: qualityWireConfigurationIdentitySchema.optional(),
    model: z.object({
      id: z.string().min(1).max(200),
      configuration_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict().optional(),
    tool_policy: qualityWireConfigurationIdentitySchema.optional(),
  }).strict().refine(
    (value) => Object.values(value).some((child) => child !== undefined),
    "producing_configuration must contain at least one identity",
  ).optional(),
  references: z.object({
    corrected_successor: z.object({
      task_id: z.string().min(1).max(200),
      structured_result_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict().optional(),
    follow_up_task_id: z.string().min(1).max(200).optional(),
    pull_request_url: z.string().url().optional(),
    replacement_commit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  }).strict().refine(
    (value) => Object.values(value).some((child) => child !== undefined),
    "references must contain at least one reference",
  ).optional(),
}).strict();

export const rateRequestSchema = z.object({
  task_id: z.string().min(1),
  rating: ratingSchema,
  rating_reason: z.string().min(1),
  verification_outcome: verificationOutcomeSchema,
  retries_count: z.number().int().nonnegative().optional(),
  reviewer_role: z.enum(["independent", "self"]).optional(),
  correction: qualityCorrectionRequestSchema.optional(),
  expected_binding: z.object({
    task_document_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    structured_result_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    repository_diff_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  const fullyAccepted = value.rating === "pass" &&
    value.verification_outcome === "accepted_unchanged";
  if (value.correction && !fullyAccepted && value.correction.failure.code === "none") {
    ctx.addIssue({
      code: "custom",
      path: ["correction", "failure", "code"],
      message: "a non-accepted correction requires a structured failure code",
    });
  }
  if (value.correction && fullyAccepted && value.correction.failure.code !== "none") {
    ctx.addIssue({
      code: "custom",
      path: ["correction", "failure", "code"],
      message: "an accepted unchanged correction must use failure code none",
    });
  }
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
  // Pagination and the final historical-row filter both interpret this as an
  // instant. Reject arbitrary non-empty strings up front so SQLite's lexical
  // timestamp comparison and JavaScript's Date.parse cannot disagree about
  // which rows belong in the response.
  since_ts: z.string().datetime({ offset: true }).optional(),
  outcome: z.enum(["completed", "failed", "running", "any"]).optional(),
  alias: aliasSchema.optional(),
});
export type ListRequest = z.infer<typeof listRequestSchema>;
