/**
 * Durable append-only task/outcome learning registry — record model (#232).
 *
 * Scope boundary (hugin#241 "Boundary clarification", 2026-07-20): this module
 * owns the *mechanism* — natural keys, membership evidence issued at capture,
 * and the partition/high-water proof primitives. Monthly closes, cross-owner
 * gille accounting, and candidate packaging are explicitly out of scope; #241
 * and #233 consume what this module issues, they do not re-implement it.
 *
 * Every event is content-blind: it carries opaque ids, refs, digests, and
 * closed classifications only. It never carries prompt or response bytes.
 * Existing durable evidence (learning-task attempt start/prepared/replay/
 * outcome rows, `result-structured`) is referenced by namespace/key, never
 * copied — see docs/learning-task-handshake.md.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { jcsCanonicalize } from "./learning-task-handshake.js";
import { taskExecutionOutcomeSchema } from "./task-result-schema.js";

export const LEARNING_REGISTRY_SCHEMA_VERSION = 1 as const;
/** Every #232-mechanism event is owned and counted by Hugin itself. Cross-owner
 * counters (#241) are consumed through this mechanism, not emitted by it. */
export const LEARNING_REGISTRY_COUNTER_OWNER = "hugin" as const;

const utcTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

function isExactUtcTimestamp(value: string): boolean {
  const match = utcTimestampPattern.exec(value);
  if (!match) return false;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return false;
  return instant.getUTCFullYear() === Number(match[1])
    && instant.getUTCMonth() + 1 === Number(match[2])
    && instant.getUTCDate() === Number(match[3])
    && instant.getUTCHours() === Number(match[4])
    && instant.getUTCMinutes() === Number(match[5])
    && instant.getUTCSeconds() === Number(match[6]);
}

export const registryTimestampSchema = z.string().refine(isExactUtcTimestamp, {
  message: "invalid RFC 3339 UTC timestamp",
});

/** Half-open UTC calendar month, e.g. "2026-07". */
export const occurrencePeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export function occurrencePeriodUtcFromInstant(iso: string): string {
  if (!isExactUtcTimestamp(iso)) {
    throw new LearningRegistryError(`cannot derive occurrence period from invalid timestamp ${iso}`);
  }
  return iso.slice(0, 7);
}

export class LearningRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningRegistryError";
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function jcsDigestHex(value: unknown): string {
  return sha256Hex(jcsCanonicalize(value));
}

export function canonicalEqual(left: unknown, right: unknown): boolean {
  return jcsCanonicalize(left) === jcsCanonicalize(right);
}

export const registryEvidenceRefSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
}).strict();
export type RegistryEvidenceRef = z.infer<typeof registryEvidenceRefSchema>;

export const REGISTRY_RECORD_KINDS = [
  "submission",
  "attempt-reference",
  "terminal-outcome",
  "publication",
  "correction",
  "exclusion-adjustment",
] as const;
export const registryRecordKindSchema = z.enum(REGISTRY_RECORD_KINDS);
export type RegistryRecordKind = z.infer<typeof registryRecordKindSchema>;

// ---------------------------------------------------------------------------
// Natural keys — one discriminated shape per record kind. Denominator
// membership binds the *natural key*, so two records with the same kind and
// same identity fields are the same logical fact: a duplicate delivery, never
// a second independent event.
// ---------------------------------------------------------------------------

const submissionNaturalKeySchema = z.object({
  recordKind: z.literal("submission"),
  taskId: z.string().min(1),
}).strict();

const attemptReferenceNaturalKeySchema = z.object({
  recordKind: z.literal("attempt-reference"),
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
}).strict();

const terminalOutcomeNaturalKeySchema = z.object({
  recordKind: z.literal("terminal-outcome"),
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
}).strict();

const publicationNaturalKeySchema = z.object({
  recordKind: z.literal("publication"),
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  publicationRef: z.string().min(1).max(128),
}).strict();

const correctionNaturalKeySchema = z.object({
  recordKind: z.literal("correction"),
  taskId: z.string().min(1),
  predecessorEventId: z.string().min(1),
}).strict();

const exclusionAdjustmentNaturalKeySchema = z.object({
  recordKind: z.literal("exclusion-adjustment"),
  taskId: z.string().min(1),
  targetEventId: z.string().min(1),
}).strict();

export const registryNaturalKeySchema = z.discriminatedUnion("recordKind", [
  submissionNaturalKeySchema,
  attemptReferenceNaturalKeySchema,
  terminalOutcomeNaturalKeySchema,
  publicationNaturalKeySchema,
  correctionNaturalKeySchema,
  exclusionAdjustmentNaturalKeySchema,
]);
export type RegistryNaturalKey = z.infer<typeof registryNaturalKeySchema>;

/** Deterministic content-derived id: same natural key -> same event id, always. */
export function naturalKeyDigest(key: RegistryNaturalKey): string {
  return jcsDigestHex(registryNaturalKeySchema.parse(key));
}

export function deriveEventId(key: RegistryNaturalKey): string {
  return `reg-${naturalKeyDigest(key).slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Membership evidence — bound at capture time. Owner-review binding (#232,
// 2026-07-19): "Denominator membership must bind the original natural key,
// occurrence period, counter, and owner so erasure cannot move July evidence
// into August or relabel joined/direct traffic."
// ---------------------------------------------------------------------------

export const registryMembershipSchema = z.object({
  naturalKey: registryNaturalKeySchema,
  occurrencePeriodUtc: occurrencePeriodSchema,
  counter: registryRecordKindSchema,
  counterOwner: z.literal(LEARNING_REGISTRY_COUNTER_OWNER),
  /** Issued at original capture time — never re-derived or backdated later. */
  issuedAt: registryTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (value.naturalKey.recordKind !== value.counter) {
    ctx.addIssue({
      code: "custom",
      path: ["counter"],
      message: "membership counter must equal the natural key's record kind",
    });
  }
});
export type RegistryMembership = z.infer<typeof registryMembershipSchema>;

export function buildMembership(input: {
  naturalKey: RegistryNaturalKey;
  issuedAt: string;
}): RegistryMembership {
  return registryMembershipSchema.parse({
    naturalKey: input.naturalKey,
    occurrencePeriodUtc: occurrencePeriodUtcFromInstant(input.issuedAt),
    counter: input.naturalKey.recordKind,
    counterOwner: LEARNING_REGISTRY_COUNTER_OWNER,
    issuedAt: input.issuedAt,
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const registryEventBase = {
  schemaVersion: z.literal(LEARNING_REGISTRY_SCHEMA_VERSION),
  eventId: z.string().regex(/^reg-[0-9a-f]{32}$/),
  taskId: z.string().min(1),
  membership: registryMembershipSchema,
  /** When the underlying fact happened. */
  occurredAt: registryTimestampSchema,
  /** When the registry durably accepted the event. */
  recordedAt: registryTimestampSchema,
};

export const submissionEventSchema = z.object({
  ...registryEventBase,
  recordKind: z.literal("submission"),
  payload: z.object({
    taskOutcomeRef: registryEvidenceRefSchema,
    originComponent: z.literal("hugin"),
  }).strict(),
}).strict();

export const attemptReferenceEventSchema = z.object({
  ...registryEventBase,
  recordKind: z.literal("attempt-reference"),
  attemptId: z.string().min(1),
  payload: z.object({
    /** Reference into the existing durable LearningTask attempt row — never copied. */
    attemptStartRef: registryEvidenceRefSchema,
    taskOutcomeRef: registryEvidenceRefSchema,
  }).strict(),
}).strict();

export const terminalOutcomeEventSchema = z.object({
  ...registryEventBase,
  recordKind: z.literal("terminal-outcome"),
  attemptId: z.string().min(1),
  payload: z.object({
    outcome: taskExecutionOutcomeSchema,
    repositoryOutcomeState: z.enum([
      "not-managed",
      "checkout-failed",
      "not-finalized",
      "no-changes",
      "changes-present",
      "publication-failed",
    ]).optional(),
    taskOutcomeRef: registryEvidenceRefSchema,
    attemptOutcomeRef: registryEvidenceRefSchema.optional(),
  }).strict(),
}).strict();

export const publicationEventSchema = z.object({
  ...registryEventBase,
  recordKind: z.literal("publication"),
  attemptId: z.string().min(1),
  payload: z.object({
    publicationRef: z.string().min(1).max(128),
    label: z.enum([
      "pr-published",
      "quality-receipt",
      "experiment-product-rating",
      "label-applied",
    ]),
    evidenceRef: registryEvidenceRefSchema,
  }).strict(),
}).strict();

export const correctionEventSchema = z.object({
  ...registryEventBase,
  recordKind: z.literal("correction"),
  payload: z.object({
    predecessorEventId: z.string().min(1),
    /** Must equal the predecessor's own natural key — a correction cannot retarget. */
    correctedNaturalKey: registryNaturalKeySchema,
    reason: z.string().min(1).max(512),
    evidenceRef: registryEvidenceRefSchema.optional(),
  }).strict(),
}).strict();

export const exclusionAdjustmentEventSchema = z.object({
  ...registryEventBase,
  recordKind: z.literal("exclusion-adjustment"),
  payload: z.object({
    targetEventId: z.string().min(1),
    targetNaturalKey: registryNaturalKeySchema,
    adjustmentReason: z.enum(["erasure", "exclusion"]),
    note: z.string().min(1).max(512).optional(),
  }).strict(),
}).strict();

export const registryEventSchema = z.discriminatedUnion("recordKind", [
  submissionEventSchema,
  attemptReferenceEventSchema,
  terminalOutcomeEventSchema,
  publicationEventSchema,
  correctionEventSchema,
  exclusionAdjustmentEventSchema,
]).superRefine((value, ctx) => {
  if (value.membership.counter !== value.recordKind) {
    ctx.addIssue({ code: "custom", message: "event record kind does not match its membership counter" });
  }
  if (value.membership.naturalKey.recordKind !== value.recordKind
    || value.membership.naturalKey.taskId !== value.taskId) {
    ctx.addIssue({ code: "custom", message: "event does not bind its own natural key" });
  }
  if (Date.parse(value.occurredAt) > Date.parse(value.recordedAt)) {
    ctx.addIssue({ code: "custom", message: "occurredAt cannot be after recordedAt" });
  }
  if (value.occurredAt !== value.membership.issuedAt) {
    ctx.addIssue({
      code: "custom",
      message: "membership evidence must be issued at original capture time (occurredAt)",
    });
  }
  const expectedEventId = deriveEventId(value.membership.naturalKey);
  if (value.eventId !== expectedEventId) {
    ctx.addIssue({ code: "custom", path: ["eventId"], message: "event id is not content-derived from its natural key" });
  }
  if (value.recordKind === "attempt-reference" || value.recordKind === "terminal-outcome"
    || value.recordKind === "publication") {
    const key = value.membership.naturalKey as { attemptId?: string };
    if (key.attemptId !== value.attemptId) {
      ctx.addIssue({ code: "custom", path: ["attemptId"], message: "event attemptId does not match its natural key" });
    }
  }
  if (value.recordKind === "publication"
    && value.membership.naturalKey.recordKind === "publication"
    && value.membership.naturalKey.publicationRef !== value.payload.publicationRef) {
    ctx.addIssue({ code: "custom", path: ["payload", "publicationRef"], message: "publication ref does not match its natural key" });
  }
  if (value.recordKind === "correction") {
    if (value.membership.naturalKey.recordKind === "correction"
      && value.membership.naturalKey.predecessorEventId !== value.payload.predecessorEventId) {
      ctx.addIssue({ code: "custom", path: ["payload", "predecessorEventId"], message: "correction natural key does not match its own predecessor" });
    }
    if (value.payload.predecessorEventId === value.eventId) {
      ctx.addIssue({ code: "custom", message: "a correction cannot target itself" });
    }
  }
  if (value.recordKind === "exclusion-adjustment") {
    if (value.membership.naturalKey.recordKind === "exclusion-adjustment"
      && value.membership.naturalKey.targetEventId !== value.payload.targetEventId) {
      ctx.addIssue({ code: "custom", path: ["payload", "targetEventId"], message: "exclusion-adjustment natural key does not match its own target" });
    }
    if (value.payload.targetEventId === value.eventId) {
      ctx.addIssue({ code: "custom", message: "an exclusion-adjustment cannot target itself" });
    }
  }
});
export type RegistryEvent = z.infer<typeof registryEventSchema>;
export type SubmissionEvent = z.infer<typeof submissionEventSchema>;
export type AttemptReferenceEvent = z.infer<typeof attemptReferenceEventSchema>;
export type TerminalOutcomeEvent = z.infer<typeof terminalOutcomeEventSchema>;
export type PublicationEvent = z.infer<typeof publicationEventSchema>;
export type CorrectionEvent = z.infer<typeof correctionEventSchema>;
export type ExclusionAdjustmentEvent = z.infer<typeof exclusionAdjustmentEventSchema>;

export function registryEventNamespace(taskId: string): string {
  return `tasks/${taskId}`;
}

/** Munin key for one event — deterministic, so retries and idempotency checks
 * never need to search: they read the exact expected key directly. */
export function registryEventKey(eventId: string): string {
  if (!/^reg-[0-9a-f]{32}$/.test(eventId)) {
    throw new LearningRegistryError(`not a valid registry event id: ${eventId}`);
  }
  return eventId;
}

export const REGISTRY_EVENT_TAG = "learning-registry";

export function registryPartitionTag(counter: RegistryRecordKind, occurrencePeriodUtc: string): string {
  occurrencePeriodSchema.parse(occurrencePeriodUtc);
  return `learning-registry-partition:${LEARNING_REGISTRY_COUNTER_OWNER}:${counter}:${occurrencePeriodUtc}`;
}

// ---------------------------------------------------------------------------
// Partition / high-water proof primitives
// ---------------------------------------------------------------------------

/** Events live per-task (`tasks/<taskId>/reg-...`), so a partition doc must
 * carry enough to locate each member without a second global index. */
export const registryPartitionMemberSchema = z.object({
  taskId: z.string().min(1),
  eventId: z.string().min(1),
}).strict();
export type RegistryPartitionMember = z.infer<typeof registryPartitionMemberSchema>;

export const registryHighWaterDocSchema = z.object({
  schemaVersion: z.literal(LEARNING_REGISTRY_SCHEMA_VERSION),
  counter: registryRecordKindSchema,
  counterOwner: z.literal(LEARNING_REGISTRY_COUNTER_OWNER),
  occurrencePeriodUtc: occurrencePeriodSchema,
  highWaterSeq: z.number().int().nonnegative(),
  /** Append-ordered members currently known in this partition. */
  members: z.array(registryPartitionMemberSchema),
  /** Running hash chain over ordered event digests — tamper-evident. */
  chainDigest: z.string().regex(/^[0-9a-f]{64}$/),
  updatedAt: registryTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (value.members.length !== value.highWaterSeq) {
    ctx.addIssue({ code: "custom", message: "high-water sequence does not match the recorded event count" });
  }
  const seen = new Set<string>();
  for (const member of value.members) {
    if (seen.has(member.eventId)) {
      ctx.addIssue({ code: "custom", path: ["members"], message: `duplicate member event id ${member.eventId}` });
    }
    seen.add(member.eventId);
  }
});
export type RegistryHighWaterDoc = z.infer<typeof registryHighWaterDocSchema>;

export const EMPTY_CHAIN_DIGEST = sha256Hex("");

export function nextChainDigest(previousChainDigest: string, eventDigest: string): string {
  return sha256Hex(`${previousChainDigest}\0${eventDigest}`);
}

export const registryPartitionProofStatusSchema = z.enum(["complete", "empty-confirmed", "partial"]);
export type RegistryPartitionProofStatus = z.infer<typeof registryPartitionProofStatusSchema>;

export const registryPartitionProofSchema = z.object({
  schemaVersion: z.literal(LEARNING_REGISTRY_SCHEMA_VERSION),
  counter: registryRecordKindSchema,
  counterOwner: z.literal(LEARNING_REGISTRY_COUNTER_OWNER),
  occurrencePeriodUtc: occurrencePeriodSchema,
  status: registryPartitionProofStatusSchema,
  highWaterSeq: z.number().int().nonnegative(),
  members: z.array(registryPartitionMemberSchema),
  chainDigest: z.string().regex(/^[0-9a-f]{64}$/),
  issuedAt: registryTimestampSchema,
  /** Non-empty only for status "partial" — why certification was refused. */
  partialReason: z.string().min(1).max(256).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "partial" && !value.partialReason) {
    ctx.addIssue({ code: "custom", path: ["partialReason"], message: "a partial proof must explain why it is not certifiable" });
  }
  if (value.status !== "partial" && value.partialReason) {
    ctx.addIssue({ code: "custom", path: ["partialReason"], message: "only a partial proof carries a partialReason" });
  }
  if (value.status === "empty-confirmed" && (value.highWaterSeq !== 0 || value.members.length !== 0)) {
    ctx.addIssue({ code: "custom", message: "an empty-confirmed proof cannot carry events" });
  }
  if (value.members.length !== value.highWaterSeq) {
    ctx.addIssue({ code: "custom", message: "proof event count does not match its high-water sequence" });
  }
});
export type RegistryPartitionProof = z.infer<typeof registryPartitionProofSchema>;

/** Only a "complete" or an authenticated "empty-confirmed" proof may certify a
 * full-period view. A "partial" proof — including one a caller derives by
 * recomputing a digest over whatever subset it happened to load — is always
 * ineligible, per the #232 owner-review binding criteria. */
export function isEligibleForCertification(proof: RegistryPartitionProof): boolean {
  return proof.status === "complete" || proof.status === "empty-confirmed";
}
