/**
 * External task/outcome receipt intake — schema (hugin#237).
 *
 * Magnus's day-to-day work is moving toward Codex App, Codex CLI, and Pi
 * surfaces that complete real tasks WITHOUT ever entering Hugin's dispatcher.
 * Without an intake path, the durable learning registry (#232) stays
 * systematically incomplete and success-biased toward Hugin-managed
 * execution. This module defines the versioned, content-blind wire shape a
 * receipt must satisfy to become admissible evidence — see
 * `src/external-receipt-intake.ts` for authentication and admission, and
 * `docs/external-receipt-intake.md` for the design writeup.
 *
 * Content-blindness is structural, not a convention layered on top:
 *
 *  - Every object in this file is `.strict()`, so an attacker (or a careless
 *    producer) cannot smuggle an extra `transcript`/`prompt`/`diff` field
 *    past validation — Zod rejects unknown keys outright.
 *  - Every identity/instance string is an *opaque token*
 *    (`externalReceiptTokenSchema` / `externalReceiptRefTokenSchema`): a
 *    bounded character class with no whitespace, so free-text content
 *    structurally cannot fit through an identity field either.
 *  - The one required "note" about capacity vs. model independence is a
 *    fixed literal (`CAPACITY_PRINCIPAL_INDEPENDENCE_NOTE`), never
 *    caller-supplied prose, so it cannot become a content-smuggling vector.
 *
 * Non-goals (see hugin#237 scope): this is not a transcript importer, not a
 * second reviewer-independence mechanism, and not a routing/promotion input.
 */

import { z } from "zod";
import { LEARNING_TASK_CONTRACT_VERSION } from "./learning-task-handshake.js";
import { registryTimestampSchema } from "./learning-registry-schema.js";
import { taskExecutionOutcomeSchema } from "./task-result-schema.js";

export const EXTERNAL_RECEIPT_SCHEMA_VERSION = 1 as const;

/** Versioned under the same LearningTaskContract the gateway side (#230/#231/
 * gille-inference#10) uses, per the #237 scope. An envelope declaring any
 * other value fails closed as `unsupported-contract-version`. */
export const EXTERNAL_RECEIPT_CONTRACT_VERSION = LEARNING_TASK_CONTRACT_VERSION;

/** The three non-Hugin surfaces this intake accepts. Native Hugin execution
 * never goes through this path — it already has `originComponent: "hugin"`. */
export const EXTERNAL_RECEIPT_SURFACES = ["codex_app", "codex_cli", "pi"] as const;
export const externalReceiptSurfaceSchema = z.enum(EXTERNAL_RECEIPT_SURFACES);
export type ExternalReceiptSurface = z.infer<typeof externalReceiptSurfaceSchema>;

export const EXTERNAL_RECEIPT_KINDS = ["observation", "outcome"] as const;
export const externalReceiptKindSchema = z.enum(EXTERNAL_RECEIPT_KINDS);
export type ExternalReceiptKind = z.infer<typeof externalReceiptKindSchema>;

/** Producer coverage state a successfully admitted receipt is honestly
 * marked with (#237 scope: "a late/imported receipt is marked as such
 * honestly"). Every admitted external receipt is inherently "imported" —
 * this is never claimed as native Hugin coverage. */
export const EXTERNAL_RECEIPT_COVERAGE_STATES = ["imported", "imported-late"] as const;
export const externalReceiptCoverageStateSchema = z.enum(EXTERNAL_RECEIPT_COVERAGE_STATES);
export type ExternalReceiptCoverageState = z.infer<typeof externalReceiptCoverageStateSchema>;

/** A terminal receipt arriving more than this long after its own `occurredAt`
 * is marked `imported-late` rather than silently folded in as if it had been
 * timely. Generous on purpose — external surfaces have no dispatcher
 * heartbeat forcing prompt reporting. */
export const EXTERNAL_RECEIPT_LATE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fixed, non-caller-supplied annotation bound into every admitted receipt's
 * stored record (#237: "treat separate subscriptions as capacity principals,
 * NOT independent model evidence... a note in the record"). Being a literal
 * rather than free text keeps this assertion itself content-blind and
 * tamper-proof: a producer cannot phrase their way out of it, and it cannot
 * become a channel for smuggled prose.
 */
export const CAPACITY_PRINCIPAL_INDEPENDENCE_NOTE =
  "capacity-principal-not-independent-model-evidence" as const;

/**
 * Opaque identity/instance token: letters, digits, and a small punctuation
 * set used by real identifiers (`.`, `_`, `:`, `@`, `/`, `-`). No whitespace
 * or control characters, so this can never hold a sentence, let alone a
 * transcript — it is what makes identity fields structurally content-blind
 * rather than merely policy-blind.
 */
export const externalReceiptTokenSchema = z.string().regex(
  /^[A-Za-z0-9._:@/-]{1,128}$/,
  { message: "must be a short opaque token (letters, digits, . _ : @ / -), not free text" },
);

/** Slightly more permissive token for a source-task reference id (e.g.
 * `owner/repo#123`), which legitimately needs `#`. Still bounded and
 * whitespace-free. */
export const externalReceiptRefTokenSchema = z.string().regex(
  /^[A-Za-z0-9._:@/#-]{1,256}$/,
  { message: "must be a short opaque reference token, not free text" },
);

export const externalTaskIdentitySchema = z.object({
  /** e.g. "openai", "anthropic". Never used alone as evidence of model
   * behaviour — always read together with `model` and `harness`. */
  provider: externalReceiptTokenSchema,
  model: externalReceiptTokenSchema,
  /** e.g. "codex-cli@1.4.2", "pi-app@4.5.0". */
  harness: externalReceiptTokenSchema,
}).strict();
export type ExternalTaskIdentity = z.infer<typeof externalTaskIdentitySchema>;

/** Opaque descriptor of the originating task — a reference, never content.
 * `system` names the reference space (e.g. "github-issue", "github-pr",
 * "branch"); `id` is that system's own opaque id/slug, never a rendered
 * prompt, diff, or transcript excerpt. */
export const sourceTaskRefSchema = z.object({
  system: externalReceiptTokenSchema,
  id: externalReceiptRefTokenSchema,
}).strict();
export type SourceTaskRef = z.infer<typeof sourceTaskRefSchema>;

export const externalTaskInstanceSchema = z.object({
  /** Stable across an instance's observation and outcome receipts — this is
   * what lets both receipts resolve to the same registry attempt. */
  taskInstanceId: externalReceiptTokenSchema,
  sourceTaskRef: sourceTaskRefSchema,
  /**
   * Optional explicit link to an existing NATIVE Hugin registry taskId for
   * the same logical unit of work (e.g. the same issue/branch/PR was also
   * dispatched through Hugin). Intake verifies this points at a real native
   * submission before honouring it — an unverifiable claim fails closed
   * (`reconciliation-target-not-found` / `-conflict`) rather than silently
   * grafting an import onto an unrelated or fabricated taskId.
   */
  reconcilesHuginTaskId: externalReceiptTokenSchema.optional(),
}).strict();
export type ExternalTaskInstance = z.infer<typeof externalTaskInstanceSchema>;

const externalReceiptBaseFields = {
  schemaVersion: z.literal(EXTERNAL_RECEIPT_SCHEMA_VERSION),
  contractVersion: z.literal(EXTERNAL_RECEIPT_CONTRACT_VERSION),
  surface: externalReceiptSurfaceSchema,
  /** Delivery-level id for this exact receipt (distinct from the stable
   * `taskInstanceId` an observation and its later outcome share). */
  receiptId: externalReceiptTokenSchema,
  /** The authenticated producer/subscription identity that signed this
   * receipt — a capacity principal, never independent model evidence (see
   * `CAPACITY_PRINCIPAL_INDEPENDENCE_NOTE`). */
  capacityPrincipal: externalReceiptTokenSchema,
  identity: externalTaskIdentitySchema,
  instance: externalTaskInstanceSchema,
  /** When the underlying fact happened, per the producer. */
  occurredAt: registryTimestampSchema,
  /** When the producer generated/signed this receipt — may be well after
   * `occurredAt` for a late report; never before it. */
  producedAt: registryTimestampSchema,
  reviewerIndependenceNote: z.literal(CAPACITY_PRINCIPAL_INDEPENDENCE_NOTE),
};

const externalObservationReceiptSchema = z.object({
  ...externalReceiptBaseFields,
  kind: z.literal("observation"),
}).strict();

const externalOutcomeReceiptSchema = z.object({
  ...externalReceiptBaseFields,
  kind: z.literal("outcome"),
  outcome: taskExecutionOutcomeSchema,
}).strict();

export const externalReceiptEnvelopeSchema = z.discriminatedUnion("kind", [
  externalObservationReceiptSchema,
  externalOutcomeReceiptSchema,
]).superRefine((value, ctx) => {
  if (Date.parse(value.occurredAt) > Date.parse(value.producedAt)) {
    ctx.addIssue({ code: "custom", message: "occurredAt cannot be after producedAt" });
  }
});
export type ExternalObservationReceipt = z.infer<typeof externalObservationReceiptSchema>;
export type ExternalOutcomeReceipt = z.infer<typeof externalOutcomeReceiptSchema>;
export type ExternalReceiptEnvelope = z.infer<typeof externalReceiptEnvelopeSchema>;

/**
 * The durable, content-blind record intake persists once a receipt is
 * admitted — this is the evidence a registry `taskOutcomeRef` /
 * `attemptStartRef` / `attemptOutcomeRef` points at (referenced, never
 * copied into the registry mechanism itself). It carries the full validated
 * envelope (already proven content-blind above) plus intake's own
 * server-stamped verification facts, which a caller can never forge because
 * they are never accepted as caller input.
 */
export const storedExternalReceiptSchema = z.object({
  schemaVersion: z.literal(EXTERNAL_RECEIPT_SCHEMA_VERSION),
  receipt: externalReceiptEnvelopeSchema,
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  /** The capacityPrincipal that actually verified — always equal to
   * `receipt.capacityPrincipal` once stored, but kept as its own field so a
   * reader never has to trust the nested envelope for the load-bearing fact. */
  verifiedCapacityPrincipal: externalReceiptTokenSchema,
  keyId: externalReceiptTokenSchema,
  /** Hugin-stamped intake time — never caller-supplied, so lateness cannot
   * be gamed by asserting a favourable receive time. */
  receivedAt: registryTimestampSchema,
  coverage: externalReceiptCoverageStateSchema,
  reconciledWithNativeTask: z.boolean(),
}).strict();
export type StoredExternalReceipt = z.infer<typeof storedExternalReceiptSchema>;
