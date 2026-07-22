/**
 * Frozen controlled-experiment packager -- contract (#233).
 *
 * Turns qualified, already-produced production candidates into an immutable,
 * content-blind, one-axis champion/challenger experiment package, then hands
 * the package to the existing durable experiment surface
 * (`LearningExperimentStore.create`, src/learning/experiment-store.ts) to run.
 * See candidate-packager.ts for the qualification/packaging logic itself;
 * this file only owns the shapes.
 *
 * Scope boundary: this module SELECTS and FREEZES already-qualified evidence.
 * It never generates a candidate (that is the registry/harvest side owned by
 * #232/#241) and never runs, evaluates, promotes, or routes an experiment
 * (src/learning/experiment-*.ts already owns that; gille-inference#8 owns
 * admission into capability/routing evidence). It is read-only over the
 * learning registry -- qualification never mutates a registry row.
 *
 * Content-blindness: a package carries only opaque identifiers, versions, and
 * digests, matching the content-blind evidence the learning registry
 * (src/learning-registry-schema.ts) and the champion/challenger contract
 * (src/learning/experiment-schema.ts) already use. It never copies a quality
 * receipt's free-text `ratingReason`, a task prompt, or a diff -- evidence is
 * referenced by receiptId/eventId and coarse classification only.
 *
 * Configuration provenance: `PackagerCandidateInput.configuration` is a
 * caller-supplied, already-fingerprinted `LearningConfiguration` -- the exact
 * shape `LearningExperimentStore.create` already accepts directly from a
 * human or another system (see tests/fixtures/learning.ts). Hugin's own
 * attempt evidence (src/learning-task-handshake.ts `origin_config`) proves
 * *which* prompt/harness ran; it does not carry model identity, which the M5
 * gateway owns (AGENTS.md: "the M5 gateway owns model selection ... Hugin
 * preserves validated provenance ... but must not build a competing
 * capability truth"). This module therefore does not reverse-engineer a
 * `LearningConfiguration` from raw stamp fields -- it validates one is
 * already present, self-consistent, and stable across the whole candidate
 * pool except for the single declared axis.
 */

import { z } from "zod";
import { taskTypeSchema } from "../broker/task-type-metadata.js";
import { qualityReceiptSchema, qualityReceiptV2Schema } from "../quality-receipt.js";
import {
  learningChangeAxisSchema,
  learningConfigurationSchema,
  learningExperimentGatesSchema,
} from "./experiment-schema.js";

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const packageIdSchema = z.string().regex(/^pkg-[a-f0-9]{64}$/);

export const nativeQualityReceiptSchema = z.union([qualityReceiptSchema, qualityReceiptV2Schema]);

export const packagerArmSchema = z.enum(["champion", "challenger"]);
export type PackagerArm = z.infer<typeof packagerArmSchema>;

export const packagerQualityRatingSchema = z.enum(["pass", "partial", "redo", "wrong"]);
export type PackagerQualityRating = z.infer<typeof packagerQualityRatingSchema>;

/**
 * One production candidate offered to the packager. The caller (an
 * orchestration wrapper such as `packageAndHandOff` below, or a future daily
 * factory conductor) is responsible for resolving `configuration` and
 * `qualityReceipt` from their own durable, owning stores -- this module never
 * fetches or fabricates them, it only validates and freezes.
 */
export const packagerCandidateInputSchema = z.object({
  taskId: z.string().min(1).max(200),
  attemptId: z.string().min(1).max(200),
  taskType: taskTypeSchema,
  configuration: learningConfigurationSchema,
  qualityReceipt: nativeQualityReceiptSchema,
}).strict();
export type PackagerCandidateInput = z.infer<typeof packagerCandidateInputSchema>;

/**
 * A content-blind reference to one matched, qualified candidate inside a
 * frozen package. Deliberately excludes `ratingReason`, prompt/response
 * bytes, and diffs -- see the module doc comment.
 */
export const packagerMatchedTaskSchema = z.object({
  taskId: z.string().min(1).max(200),
  attemptId: z.string().min(1).max(200),
  arm: packagerArmSchema,
  taskType: taskTypeSchema,
  qualityReceiptId: z.string().regex(/^qr-[0-9a-f]{24}$/),
  qualityRating: packagerQualityRatingSchema,
}).strict();
export type PackagerMatchedTask = z.infer<typeof packagerMatchedTaskSchema>;

/**
 * The frozen, immutable, content-addressed experiment package. `packageId`
 * and `idempotencyKey` are always equal -- two distinct fields exist so
 * callers have an explicit idempotency-key name (mirroring the registry's
 * own eventId/naturalKey split) without overloading `packageId`'s identity
 * semantics. Both are content-derived from every field below EXCEPT
 * `qualifiedAt`, so re-packaging the same qualified set at a different wall
 * clock time is still a no-op producing the same package.
 */
export const experimentPackageSchema = z.object({
  schemaVersion: z.literal(1),
  packageId: packageIdSchema,
  idempotencyKey: packageIdSchema,
  scope: slugSchema,
  taskType: taskTypeSchema,
  changeAxis: learningChangeAxisSchema,
  hypothesis: z.string().min(1).max(2_000),
  champion: learningConfigurationSchema,
  challenger: learningConfigurationSchema,
  gates: learningExperimentGatesSchema,
  matchedTasks: z.array(packagerMatchedTaskSchema).min(2),
  qualifiedAt: z.string().min(1),
}).strict().superRefine((value, ctx) => {
  if (value.idempotencyKey !== value.packageId) {
    ctx.addIssue({ code: "custom", path: ["idempotencyKey"], message: "idempotency key must equal the package id" });
  }
  const champCount = value.matchedTasks.filter((task) => task.arm === "champion").length;
  const challCount = value.matchedTasks.filter((task) => task.arm === "challenger").length;
  if (champCount === 0 || challCount === 0) {
    ctx.addIssue({ code: "custom", path: ["matchedTasks"], message: "a package requires at least one matched task per arm" });
  }
  const seen = new Set<string>();
  for (const task of value.matchedTasks) {
    const key = `${task.taskId}/${task.attemptId}`;
    if (seen.has(key)) {
      ctx.addIssue({ code: "custom", path: ["matchedTasks"], message: `duplicate matched task ${key}` });
    }
    seen.add(key);
  }
});
export type ExperimentPackage = z.infer<typeof experimentPackageSchema>;

// ---------------------------------------------------------------------------
// Fail-closed reasons -- per-candidate rejection and pool-level refusal.
// ---------------------------------------------------------------------------

export type CandidateRejectionReason =
  | { code: "missing-timeline" }
  | { code: "timeline-truncated" }
  | { code: "missing-attempt-reference" }
  | { code: "missing-terminal-outcome" }
  | { code: "attempt-reference-excluded"; reasons: string[] }
  | { code: "terminal-outcome-excluded"; reasons: string[] }
  | { code: "attempt-reference-superseded" }
  | { code: "terminal-outcome-superseded" }
  | { code: "outcome-not-completed"; outcome: string }
  | { code: "quality-receipt-task-mismatch" }
  | { code: "quality-receipt-attempt-mismatch" }
  | { code: "quality-receipt-not-independent"; independence: "self" | "unknown" }
  | { code: "quality-rating-insufficient"; rating: PackagerQualityRating };

export interface RejectedCandidate {
  taskId: string;
  attemptId: string;
  reasons: CandidateRejectionReason[];
}

export type PackageRefusalReason =
  | { code: "no-qualified-candidates" }
  | { code: "task-type-incoherent"; taskTypes: string[] }
  | { code: "insufficient-candidates"; arm: PackagerArm; count: number; required: number }
  | { code: "more-than-two-distinct-configurations"; distinctFingerprints: number }
  | { code: "multi-axis-delta"; changedAxes: string[] }
  | { code: "declared-axis-mismatch"; declared: string; detected: string[] }
  | { code: "no-champion-match"; championFingerprint: string };

export interface PackagingOutcome {
  status: "packaged" | "refused";
  qualified: Array<{ taskId: string; attemptId: string }>;
  rejected: RejectedCandidate[];
  refusalReasons: PackageRefusalReason[];
  package?: ExperimentPackage;
}

export const RATING_RANK: Record<PackagerQualityRating, number> = {
  pass: 3,
  partial: 2,
  redo: 1,
  wrong: 0,
};

export { sha256Schema };
