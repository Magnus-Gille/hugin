/**
 * External task/outcome receipt intake (hugin#237).
 *
 * Narrow, authenticated admission path for task/outcome receipts produced by
 * surfaces that complete real work WITHOUT ever entering Hugin's dispatcher
 * (Codex App, Codex CLI, Pi). An admitted receipt is mapped into the durable
 * append-only learning registry (#232) via its own natural-key idempotent
 * API — this module never reimplements the registry mechanism, it only
 * decides what to feed it.
 *
 * Admission order, each step fail-closed with a specific reason:
 *
 *  1. Structural + content-blindness validation (`externalReceiptEnvelopeSchema`,
 *     unknown fields and free-text-shaped tokens are rejected, not stripped).
 *  2. Authenticity (`verifyExternalReceiptSignature`) — an unauthenticated or
 *     mis-keyed body is never trusted, regardless of what it claims.
 *  3. Reconciliation binding, when the receipt claims to correspond to an
 *     already-native Hugin task — verified against the registry's own
 *     submission record, never taken on the caller's word.
 *  4. Idempotent, natural-key-safe mapping into #232's registry events.
 *
 * Non-goals (hugin#237 scope): no raw transcript ingestion, no treatment of
 * two capacity-principal subscriptions as independent reviewers, and no
 * routing/promotion decision is ever made from an imported receipt alone —
 * this module only appends evidence.
 */

import { z } from "zod";
import { MuninWriteRejectedError, type MuninClient } from "./munin-client.js";
import {
  LearningRegistryStore,
  RegistryNaturalKeyConflictError,
  registryEventNamespace,
  deriveEventId,
  canonicalEqual,
  sha256Hex,
  type RegistryEvidenceRef,
} from "./learning-registry-store.js";
import {
  externalReceiptEnvelopeSchema,
  storedExternalReceiptSchema,
  EXTERNAL_RECEIPT_SCHEMA_VERSION,
  EXTERNAL_RECEIPT_LATE_THRESHOLD_MS,
  type ExternalReceiptEnvelope,
  type ExternalReceiptCoverageState,
  type StoredExternalReceipt,
} from "./external-receipt-schema.js";
import {
  verifyExternalReceiptSignature,
  type ExternalReceiptVerifyOptions,
} from "./external-receipt-signing.js";
import type { KeyStore } from "./task-signing.js";

export const EXTERNAL_RECEIPT_REJECTION_REASONS = [
  "incomplete-envelope",
  "non-content-blind",
  "unsupported-schema-version",
  "unsupported-contract-version",
  "missing-signature",
  "unknown-producer",
  "producer-mismatch",
  "invalid-signature",
  "reconciliation-target-not-found",
  "reconciliation-target-conflict",
  "receipt-id-reused-with-different-content",
  "registry-natural-key-conflict",
] as const;
export type ExternalReceiptRejectionReason = (typeof EXTERNAL_RECEIPT_REJECTION_REASONS)[number];

export interface ExternalReceiptRejection {
  status: "rejected";
  reason: ExternalReceiptRejectionReason;
  detail: string;
}

export interface ExternalReceiptAdmission {
  status: "admitted";
  /** "created" the first time this evidence enters the registry; "exact-existing"
   * when every underlying registry write was an idempotent no-op (a genuine
   * re-ingest of the same receipt(s)). */
  admission: "created" | "exact-existing";
  taskId: string;
  attemptId: string;
  coverage: ExternalReceiptCoverageState;
  reconciledWithNativeTask: boolean;
  eventIds: string[];
}

export type ExternalReceiptIntakeResult = ExternalReceiptAdmission | ExternalReceiptRejection;

export interface ExternalReceiptIntakeDeps {
  munin: MuninClient;
  registry: LearningRegistryStore;
  keys: KeyStore;
  now?: () => string;
}

function rejected(reason: ExternalReceiptRejectionReason, detail: string): ExternalReceiptRejection {
  return { status: "rejected", reason, detail };
}

/**
 * Classify a failed `externalReceiptEnvelopeSchema` parse into one of the
 * intake's specific, auditable rejection reasons rather than one generic
 * "invalid" bucket — so a caller (and a test) can tell "you sent something
 * incomplete" apart from "you tried to sneak free text into an identity
 * field" apart from "you're speaking a version we don't support".
 */
function classifyEnvelopeParseError(error: z.ZodError): ExternalReceiptRejection {
  const issues = error.issues;

  const unrecognized = issues.find((issue) => issue.code === "unrecognized_keys");
  if (unrecognized) {
    const keys = (unrecognized as { keys?: string[] }).keys ?? [];
    return rejected(
      "non-content-blind",
      `unexpected field(s) not permitted by the content-blind receipt envelope: ${keys.join(", ") || "(unknown)"}`,
    );
  }

  const schemaVersionIssue = issues.find((issue) => issue.path.length === 1 && issue.path[0] === "schemaVersion");
  if (schemaVersionIssue) {
    return rejected("unsupported-schema-version", schemaVersionIssue.message);
  }

  const contractVersionIssue = issues.find((issue) => issue.path.length === 1 && issue.path[0] === "contractVersion");
  if (contractVersionIssue) {
    return rejected("unsupported-contract-version", contractVersionIssue.message);
  }

  const tokenViolation = issues.find((issue) => issue.code === "invalid_format");
  if (tokenViolation) {
    return rejected(
      "non-content-blind",
      `field "${tokenViolation.path.join(".")}" is not a short opaque token — looks like free text rather than identity metadata: ${tokenViolation.message}`,
    );
  }

  const detail = issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ")
    .slice(0, 500);
  return rejected("incomplete-envelope", detail || "receipt envelope failed validation");
}

function deriveExternalTaskId(surface: string, capacityPrincipal: string, taskInstanceId: string): string {
  return `ext-${sha256Hex(`task\0${surface}\0${capacityPrincipal}\0${taskInstanceId}`).slice(0, 40)}`;
}

function deriveExternalAttemptId(surface: string, capacityPrincipal: string, taskInstanceId: string): string {
  return `ext-attempt-${sha256Hex(`attempt\0${surface}\0${capacityPrincipal}\0${taskInstanceId}`).slice(0, 32)}`;
}

function externalReceiptDocKey(taskId: string, attemptId: string, kind: string, receiptId: string): string {
  return `external-receipt-${kind}-${sha256Hex(`${taskId}\0${attemptId}\0${kind}\0${receiptId}`).slice(0, 32)}`;
}

/** `receivedAt` and the `coverage` derived from it are the only fields that
 * legitimately differ between two deliveries of the exact same logical
 * receipt (retried now vs. retried tomorrow) — mirrors `appendRegistryEvent`'s
 * own `recordedAt` exclusion in `learning-registry-store.ts`. */
function withoutIntakeStampedFields(stored: StoredExternalReceipt): Record<string, unknown> {
  const { receivedAt: _receivedAt, coverage: _coverage, ...rest } = stored as unknown as Record<string, unknown>;
  return rest;
}

async function storeReceiptDoc(
  munin: MuninClient,
  stored: StoredExternalReceipt,
): Promise<{ outcome: "created" | "duplicate"; stored: StoredExternalReceipt } | { outcome: "conflict" }> {
  const namespace = registryEventNamespace(stored.taskId);
  const key = externalReceiptDocKey(stored.taskId, stored.attemptId, stored.receipt.kind, stored.receipt.receiptId);
  const content = JSON.stringify(stored);
  const tags = ["external-receipt", `external-receipt-surface:${stored.receipt.surface}`];

  try {
    await munin.write(namespace, key, content, tags, undefined, "internal", true);
    return { outcome: "created", stored };
  } catch (err) {
    if (err instanceof MuninWriteRejectedError && err.conflictReason === "already_exists") {
      const existing = await munin.read(namespace, key);
      if (!existing) {
        throw new Error(`external receipt doc ${namespace}/${key} reported already-existing but could not be read back`);
      }
      const existingStored = storedExternalReceiptSchema.parse(JSON.parse(existing.content));
      if (canonicalEqual(withoutIntakeStampedFields(existingStored), withoutIntakeStampedFields(stored))) {
        return { outcome: "duplicate", stored: existingStored };
      }
      return { outcome: "conflict" };
    }
    throw err;
  }
}

/**
 * Admit one external task/outcome receipt into the durable learning
 * registry, or reject it with a specific auditable reason. Content-blind
 * throughout: nothing this function reads, writes, or logs is ever raw
 * prompt/output/transcript/diff content — see `src/external-receipt-schema.ts`.
 */
export async function ingestExternalReceipt(
  deps: ExternalReceiptIntakeDeps,
  rawEnvelope: unknown,
  signatureRaw: string | null | undefined,
  verifyOpts: ExternalReceiptVerifyOptions = {},
): Promise<ExternalReceiptIntakeResult> {
  const now = deps.now ?? (() => new Date().toISOString());

  const parsed = externalReceiptEnvelopeSchema.safeParse(rawEnvelope);
  if (!parsed.success) {
    return classifyEnvelopeParseError(parsed.error);
  }
  const receipt: ExternalReceiptEnvelope = parsed.data;

  // Authenticity — never trust the body's own claimed capacityPrincipal
  // without a verified signature binding it.
  const verification = verifyExternalReceiptSignature(receipt, signatureRaw, deps.keys, verifyOpts);
  if (verification.status !== "valid") {
    const reason =
      verification.status === "missing" ? "missing-signature"
      : verification.status === "unknown-producer" ? "unknown-producer"
      : verification.status === "producer-mismatch" ? "producer-mismatch"
      : "invalid-signature"; // malformed | unsupported-version | invalid | expired | future-skew
    return rejected(reason, verification.reason ?? `signature status: ${verification.status}`);
  }

  // Reconciliation — an asserted link to a native Hugin task must resolve to
  // a real native submission event, never be taken on faith.
  //
  // Known accepted limitation (flagged by the #237 M5 review): this proves
  // the target taskId is a genuine native Hugin submission, but not that it
  // is actually the SAME underlying unit of work as this receipt — native
  // submission events (#232) do not themselves carry a sourceTaskRef to
  // check against. Closing that gap would mean growing #232's own
  // submission schema, which is out of this module's scope (see
  // docs/learning-registry.md's boundary note). The blast radius is bounded
  // by the operator-provisioned producer keystore (only a registered,
  // trusted capacity principal can even attempt reconciliation) and by what
  // a wrong reconciliation can actually do: it can only append an additional
  // attempt-reference/terminal-outcome to an already-existing native task's
  // timeline — it can never fabricate, overwrite, or remove that task's own
  // submission or terminal state. See docs/external-receipt-intake.md.
  let taskId: string;
  let reconciledWithNativeTask = false;
  const reconcileTarget = receipt.instance.reconcilesHuginTaskId;
  if (reconcileTarget !== undefined) {
    const nativeSubmissionId = deriveEventId({ recordKind: "submission", taskId: reconcileTarget });
    const nativeSubmission = await deps.registry.getEvent(reconcileTarget, nativeSubmissionId);
    if (!nativeSubmission) {
      return rejected(
        "reconciliation-target-not-found",
        `no native submission event found at declared reconciliation target task "${reconcileTarget}"`,
      );
    }
    if (nativeSubmission.recordKind !== "submission" || nativeSubmission.payload.originComponent !== "hugin") {
      return rejected(
        "reconciliation-target-conflict",
        `reconciliation target task "${reconcileTarget}" is not a native Hugin submission (originComponent=${
          nativeSubmission.recordKind === "submission" ? nativeSubmission.payload.originComponent : "n/a"
        })`,
      );
    }
    taskId = reconcileTarget;
    reconciledWithNativeTask = true;
  } else {
    taskId = deriveExternalTaskId(receipt.surface, receipt.capacityPrincipal, receipt.instance.taskInstanceId);
  }

  const attemptId = deriveExternalAttemptId(receipt.surface, receipt.capacityPrincipal, receipt.instance.taskInstanceId);
  const receivedAt = now();
  const lateMs = Date.parse(receivedAt) - Date.parse(receipt.occurredAt);
  const coverage: ExternalReceiptCoverageState = lateMs > EXTERNAL_RECEIPT_LATE_THRESHOLD_MS ? "imported-late" : "imported";

  const storedCandidate = storedExternalReceiptSchema.parse({
    schemaVersion: EXTERNAL_RECEIPT_SCHEMA_VERSION,
    receipt,
    taskId,
    attemptId,
    verifiedCapacityPrincipal: receipt.capacityPrincipal,
    keyId: verification.keyId,
    receivedAt,
    coverage,
    reconciledWithNativeTask,
  });

  const docResult = await storeReceiptDoc(deps.munin, storedCandidate);
  if (docResult.outcome === "conflict") {
    return rejected(
      "receipt-id-reused-with-different-content",
      `receiptId "${receipt.receiptId}" was already ingested with different content for task "${taskId}" / attempt "${attemptId}" — file a distinct receiptId or a correction, do not redeliver a mutated receipt under the same id`,
    );
  }
  const stored = docResult.stored;
  const docRef: RegistryEvidenceRef = {
    namespace: registryEventNamespace(stored.taskId),
    key: externalReceiptDocKey(stored.taskId, stored.attemptId, stored.receipt.kind, stored.receipt.receiptId),
  };

  const eventIds: string[] = [];
  let anyCreated = docResult.outcome === "created";

  try {
    // Submission — only the FIRST receipt to arrive for this taskId creates
    // it, so its taskOutcomeRef stays pinned to whichever receipt actually
    // established the task. A reconciled task already has a native
    // submission and must never get a second, conflicting one.
    const submissionEventId = deriveEventId({ recordKind: "submission", taskId: stored.taskId });
    const existingSubmission = await deps.registry.getEvent(stored.taskId, submissionEventId);
    if (!existingSubmission) {
      const submissionResult = await deps.registry.recordSubmission({
        taskId: stored.taskId,
        taskOutcomeRef: docRef,
        occurredAt: receipt.occurredAt,
        originComponent: receipt.surface,
      });
      anyCreated = anyCreated || submissionResult.status === "created";
      eventIds.push(submissionResult.event.eventId);
    } else {
      eventIds.push(existingSubmission.eventId);
    }

    // Attempt-reference — same idempotent-pin logic: only the first receipt
    // for this attemptId creates it.
    const attemptRefEventId = deriveEventId({ recordKind: "attempt-reference", taskId: stored.taskId, attemptId: stored.attemptId });
    const existingAttemptRef = await deps.registry.getEvent(stored.taskId, attemptRefEventId);
    if (!existingAttemptRef) {
      const attemptRefResult = await deps.registry.recordAttemptReference({
        taskId: stored.taskId,
        attemptId: stored.attemptId,
        attemptStartRef: docRef,
        taskOutcomeRef: docRef,
        occurredAt: receipt.occurredAt,
      });
      anyCreated = anyCreated || attemptRefResult.status === "created";
      eventIds.push(attemptRefResult.event.eventId);
    } else {
      eventIds.push(existingAttemptRef.eventId);
    }

    if (receipt.kind === "outcome") {
      // Unlike submission/attempt-reference above, terminal-outcome is
      // written unconditionally rather than pre-checked with getEvent: its
      // natural key is {taskId, attemptId} and only one genuine terminal
      // fact is ever expected per attempt, so the registry's own
      // create-if-absent-or-conflict behaviour (idempotent no-op on an exact
      // replay, RegistryNaturalKeyConflictError on a genuinely different
      // second outcome) is already the correct and complete answer — a
      // pre-check would only add a redundant read.
      const terminalResult = await deps.registry.recordTerminalOutcome({
        taskId: stored.taskId,
        attemptId: stored.attemptId,
        outcome: receipt.outcome,
        taskOutcomeRef: docRef,
        occurredAt: receipt.occurredAt,
      });
      anyCreated = anyCreated || terminalResult.status === "created";
      eventIds.push(terminalResult.event.eventId);
    }
  } catch (err) {
    if (err instanceof RegistryNaturalKeyConflictError) {
      return rejected(
        "registry-natural-key-conflict",
        `registry already holds different evidence at the same natural key: ${err.message}`,
      );
    }
    throw err;
  }

  return {
    status: "admitted",
    admission: anyCreated ? "created" : "exact-existing",
    taskId: stored.taskId,
    attemptId: stored.attemptId,
    coverage: stored.coverage,
    reconciledWithNativeTask,
    eventIds,
  };
}
