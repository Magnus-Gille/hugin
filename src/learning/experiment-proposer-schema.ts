/**
 * Read-only one-axis experiment proposer -- contract (#234).
 *
 * Scans already-qualified production evidence (the same qualified-candidate
 * shape the #233 packager consumes, `PackagerCandidateInput`) and proposes
 * which one-axis champion/challenger experiments are worth packaging. It
 * never packages, creates, runs, evaluates, or promotes anything -- see
 * experiment-proposer.ts's module doc comment for the read-only guarantee.
 *
 * Shape alignment with the #233 packager (candidate-packager-schema.ts):
 *  - `ExperimentProposal.matchedTasks` reuses `packagerMatchedTaskSchema`
 *    verbatim -- the exact content-blind (taskId/attemptId/arm/taskType/
 *    qualityReceiptId/qualityRating) reference shape the packager itself
 *    freezes into a package. A proposal never carries more than the packager
 *    would keep.
 *  - `experimentProposerModule.proposalToPackageRequest` (in
 *    experiment-proposer.ts) maps a proposal onto `PackageRequest` --
 *    (task-type, axis, champion, challenger, matched set) becomes
 *    (scope, hypothesis, changeAxis, championFingerprint) directly. The
 *    caller still resolves each `matchedTasks` entry back into a full
 *    `PackagerCandidateInput` (configuration + native quality receipt) from
 *    its own durable stores before calling the packager -- exactly mirroring
 *    how `packageAndHandOff` re-reads registry timelines from bare task ids
 *    rather than trusting a caller-supplied cache.
 *
 * Content-blindness: like the packager's `ExperimentPackage`, a proposal
 * carries only opaque identifiers, versions, digests, counts, and rates. It
 * never copies a quality receipt's free-text `ratingReason`, a task prompt,
 * or a diff.
 */

import { z } from "zod";
import { taskTypeSchema } from "../broker/task-type-metadata.js";
import {
  learningChangeAxisSchema,
  learningConfigurationSchema,
} from "./experiment-schema.js";
import {
  packagerCandidateInputSchema,
  packagerMatchedTaskSchema,
  sha256Schema,
  type CandidateRejectionReason,
  type PackagerCandidateInput,
  type PackagerMatchedTask,
} from "./candidate-packager-schema.js";

export { packagerCandidateInputSchema, sha256Schema };
export type { CandidateRejectionReason, PackagerCandidateInput, PackagerMatchedTask };

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/);
const proposalIdSchema = z.string().regex(/^prop-[a-f0-9]{64}$/);

export const proposalConfidenceSchema = z.enum(["low", "medium", "high"]);
export type ProposalConfidence = z.infer<typeof proposalConfidenceSchema>;

/**
 * Aggregate, content-blind evidence backing one proposal. Every field is a
 * count, rate, timestamp, or derived statistic -- never raw task content.
 */
export const proposalEvidenceSchema = z.object({
  championSamples: z.number().int().positive(),
  challengerSamples: z.number().int().positive(),
  championQualityRate: z.number().min(0).max(1),
  challengerQualityRate: z.number().min(0).max(1),
  /** challengerQualityRate - championQualityRate. Positive means the challenger looks better. */
  qualityRateDelta: z.number().min(-1).max(1),
  mostRecentEvidenceAt: z.string().min(1),
  /** Exponential recency decay applied to `mostRecentEvidenceAt` at proposal time; see rank.recencyWeight. */
  recencyWeight: z.number().min(0).max(1),
  /**
   * Normal approximation to a two-proportion z-test comparing
   * championQualityRate and challengerQualityRate. This is a coarse
   * screening heuristic, not a rigorous significance test: samples are not
   * guaranteed independent (a task type may share operators, prompts-under-
   * test, or time windows across arms) and no multiple-comparison
   * correction is applied across the proposals a single run emits. `null`
   * when the pooled standard error is degenerate (see computeConfidence).
   */
  zScore: z.number().nullable(),
  confidence: proposalConfidenceSchema,
}).strict();
export type ProposalEvidence = z.infer<typeof proposalEvidenceSchema>;

export const proposalRankSchema = z.object({
  /** effectSize * sampleSize * recencyWeight -- see experiment-proposer.ts's module doc for the rationale. */
  score: z.number().min(0),
  effectSize: z.number().min(0).max(1),
  sampleSize: z.number().int().positive(),
  recencyWeight: z.number().min(0).max(1),
}).strict();
export type ProposalRank = z.infer<typeof proposalRankSchema>;

/**
 * A read-only, content-blind proposal to run a one-axis experiment. Never
 * packaged, created, or executed by this module -- a human or the #233
 * packager decides whether to act on it.
 */
export const experimentProposalSchema = z.object({
  schemaVersion: z.literal(1),
  proposalId: proposalIdSchema,
  taskType: taskTypeSchema,
  changeAxis: learningChangeAxisSchema,
  championFingerprint: sha256Schema,
  challengerFingerprint: sha256Schema,
  champion: learningConfigurationSchema,
  challenger: learningConfigurationSchema,
  evidence: proposalEvidenceSchema,
  matchedTasks: z.array(packagerMatchedTaskSchema).min(2),
  hypothesis: z.string().min(1).max(2_000),
  /** A candidate scope slug for `PackageRequest.scope` -- the caller may override it. */
  suggestedScope: slugSchema,
  rank: proposalRankSchema,
  proposedAt: z.string().min(1),
}).strict().superRefine((value, ctx) => {
  if (value.championFingerprint === value.challengerFingerprint) {
    ctx.addIssue({ code: "custom", path: ["challengerFingerprint"], message: "challenger fingerprint must differ from champion" });
  }
  if (value.champion.fingerprint !== value.championFingerprint) {
    ctx.addIssue({ code: "custom", path: ["champion", "fingerprint"], message: "champion configuration fingerprint mismatch" });
  }
  if (value.challenger.fingerprint !== value.challengerFingerprint) {
    ctx.addIssue({ code: "custom", path: ["challenger", "fingerprint"], message: "challenger configuration fingerprint mismatch" });
  }
  const champCount = value.matchedTasks.filter((task) => task.arm === "champion").length;
  const challCount = value.matchedTasks.filter((task) => task.arm === "challenger").length;
  if (champCount === 0 || challCount === 0) {
    ctx.addIssue({ code: "custom", path: ["matchedTasks"], message: "a proposal requires at least one matched task per arm" });
  }
  if (champCount !== value.evidence.championSamples || challCount !== value.evidence.challengerSamples) {
    ctx.addIssue({ code: "custom", path: ["matchedTasks"], message: "matched task counts must match the reported evidence sample sizes" });
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
export type ExperimentProposal = z.infer<typeof experimentProposalSchema>;

// ---------------------------------------------------------------------------
// Fail-closed reasons -- why a population was never turned into a proposal.
// ---------------------------------------------------------------------------

export type PopulationDeclineReason =
  | { code: "no-qualified-evidence" }
  | { code: "single-configuration"; taskType: string; distinctConfigurations: number }
  | {
      code: "insufficient-samples";
      taskType: string;
      axis: string;
      arm: "champion" | "challenger";
      count: number;
      required: number;
      championFingerprint: string;
      challengerFingerprint: string;
    }
  | {
      code: "multi-axis-delta";
      taskType: string;
      championFingerprint: string;
      challengerFingerprint: string;
      changedAxes: string[];
    }
  | {
      code: "no-axis-delta";
      taskType: string;
      championFingerprint: string;
      challengerFingerprint: string;
    }
  | {
      code: "no-quality-signal-delta";
      taskType: string;
      axis: string;
      championFingerprint: string;
      challengerFingerprint: string;
      qualityRateDelta: number;
      threshold: number;
    };

export interface ProposalOutcome {
  status: "proposed" | "no-proposals";
  /** Ranked descending by rank.score. */
  proposals: ExperimentProposal[];
  /** Candidates dropped before grouping -- same fail-closed reasons the packager uses. */
  rejectedCandidates: Array<{ taskId: string; attemptId: string; reasons: CandidateRejectionReason[] }>;
  /** Populations considered but not proposal-worthy, with the concrete reason. */
  declinedPopulations: PopulationDeclineReason[];
}
