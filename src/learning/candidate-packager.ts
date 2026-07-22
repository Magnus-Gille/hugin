/**
 * Frozen controlled-experiment packager -- logic (#233).
 *
 * See candidate-packager-schema.ts for the full scope-boundary and
 * content-blindness rationale. In short: this module selects, verifies, and
 * freezes production candidates the registry (#232) and quality-receipt
 * (#216) evidence already qualifies; it never generates a candidate and never
 * runs, evaluates, or promotes an experiment -- it hands a frozen package to
 * the existing `LearningExperimentStore.create` surface for that.
 *
 * Read-only guarantee: every function here either takes already-fetched
 * evidence (the pure `qualifyCandidate` / `packageExperimentCandidates`
 * core) or, in `packageAndHandOff`, only calls `listEventsForTask` (a read)
 * on the registry before calling `LearningExperimentStore.create` (which is
 * itself idempotent/create-only, never an update to existing rows). No
 * function in this module ever calls a registry mutation method.
 */

import { jcsDigestHex } from "../learning-registry-schema.js";
import { buildTaskLifecycleTimeline, type TaskLifecycleTimeline } from "../learning-registry-view.js";
import type { LearningRegistryStore } from "../learning-registry-store.js";
import {
  configurationChangedAxes,
  learningExperimentCreateSchema,
  type LearningChangeAxis,
  type LearningExperimentCreate,
  type LearningExperimentGates,
  type LearningExperimentState,
} from "./experiment-schema.js";
import type { LearningExperimentStore } from "./experiment-store.js";
import {
  RATING_RANK,
  experimentPackageSchema,
  packagerCandidateInputSchema,
  type CandidateRejectionReason,
  type ExperimentPackage,
  type PackageRefusalReason,
  type PackagerCandidateInput,
  type PackagerMatchedTask,
  type PackagerQualityRating,
  type PackagingOutcome,
  type RejectedCandidate,
} from "./candidate-packager-schema.js";

export * from "./candidate-packager-schema.js";

export interface PackageRequest {
  /** Owning scope for the resulting experiment -- passed through to `LearningExperimentStore.create`. */
  scope: string;
  hypothesis: string;
  changeAxis: LearningChangeAxis;
  /**
   * Fingerprint of the known incumbent configuration. Candidates whose
   * configuration fingerprint matches this are the champion arm; every other
   * *distinct* fingerprint among the qualified pool is a challenger
   * candidate for the single declared axis. This mirrors
   * `LearningExperimentStore`'s own per-scope champion baseline -- the
   * packager does not invent "which side is champion," it is told.
   */
  championFingerprint: string;
  gates: LearningExperimentGates;
  /** Minimum qualified candidates required per arm before a package is emitted. Default 2. */
  minCandidatesPerArm?: number;
  /** Minimum quality rating a candidate's receipt must carry. Default "pass". */
  minQualityRating?: PackagerQualityRating;
  now?: () => string;
}

const DEFAULT_MIN_CANDIDATES_PER_ARM = 2;
const DEFAULT_MIN_QUALITY_RATING: PackagerQualityRating = "pass";

function findAttemptReferenceEntry(timeline: TaskLifecycleTimeline, attemptId: string) {
  return timeline.entries.find((entry) =>
    entry.event.recordKind === "attempt-reference" && entry.event.attemptId === attemptId);
}

function findTerminalOutcomeEntry(timeline: TaskLifecycleTimeline, attemptId: string) {
  return timeline.entries.find((entry) =>
    entry.event.recordKind === "terminal-outcome" && entry.event.attemptId === attemptId);
}

/**
 * Verify one candidate against its already-fetched registry timeline and its
 * caller-supplied quality receipt. Never mutates anything; a truncated
 * timeline (the registry could not prove completeness) fails closed
 * immediately rather than reasoning over a possibly-incomplete view.
 */
export function qualifyCandidate(
  candidate: PackagerCandidateInput,
  timeline: TaskLifecycleTimeline,
  options: { minQualityRating?: PackagerQualityRating } = {},
): { ok: true } | { ok: false; reasons: CandidateRejectionReason[] } {
  if (timeline.truncated) {
    return { ok: false, reasons: [{ code: "timeline-truncated" }] };
  }

  const reasons: CandidateRejectionReason[] = [];

  const attemptEntry = findAttemptReferenceEntry(timeline, candidate.attemptId);
  if (!attemptEntry) {
    reasons.push({ code: "missing-attempt-reference" });
  } else {
    if (attemptEntry.excluded) {
      reasons.push({ code: "attempt-reference-excluded", reasons: attemptEntry.excludedReasons });
    }
    if (attemptEntry.superseded) {
      reasons.push({ code: "attempt-reference-superseded" });
    }
  }

  const outcomeEntry = findTerminalOutcomeEntry(timeline, candidate.attemptId);
  if (!outcomeEntry) {
    reasons.push({ code: "missing-terminal-outcome" });
  } else {
    if (outcomeEntry.excluded) {
      reasons.push({ code: "terminal-outcome-excluded", reasons: outcomeEntry.excludedReasons });
    }
    if (outcomeEntry.superseded) {
      reasons.push({ code: "terminal-outcome-superseded" });
    }
    if (outcomeEntry.event.recordKind === "terminal-outcome"
      && outcomeEntry.event.payload.outcome !== "completed") {
      reasons.push({ code: "outcome-not-completed", outcome: outcomeEntry.event.payload.outcome });
    }
  }

  // NOTE: this trusts `candidate.qualityReceipt` as already the ledger's
  // current EFFECTIVE receipt for this task/attempt. quality-receipt.ts
  // supports a correction chain (`correctsReceiptId` / `foldQualityReceipt`);
  // resolving that chain is the caller's job (e.g. via
  // `summarizeQualityReceipts`) before a receipt reaches this function --
  // qualifyCandidate has no independent way to detect a stale, since-corrected
  // receipt from the object alone.
  const receipt = candidate.qualityReceipt;
  if (receipt.taskId !== candidate.taskId) {
    reasons.push({ code: "quality-receipt-task-mismatch" });
  }
  if (receipt.schemaVersion === 2 && receipt.attemptId !== candidate.attemptId) {
    reasons.push({ code: "quality-receipt-attempt-mismatch" });
  }
  if (receipt.reviewer.independence !== "independent") {
    reasons.push({
      code: "quality-receipt-not-independent",
      independence: receipt.reviewer.independence,
    });
  }
  const minRating = options.minQualityRating ?? DEFAULT_MIN_QUALITY_RATING;
  if (RATING_RANK[receipt.rating] < RATING_RANK[minRating]) {
    reasons.push({ code: "quality-rating-insufficient", rating: receipt.rating });
  }

  return reasons.length > 0 ? { ok: false, reasons } : { ok: true };
}

/** Canonical digest input for a package -- excludes `qualifiedAt` so re-packaging the same set at a later wall-clock time is still idempotent. */
function packageDigestPayload(
  pkg: Omit<ExperimentPackage, "packageId" | "idempotencyKey" | "qualifiedAt">,
): unknown {
  return {
    schemaVersion: pkg.schemaVersion,
    scope: pkg.scope,
    taskType: pkg.taskType,
    changeAxis: pkg.changeAxis,
    hypothesis: pkg.hypothesis,
    champion: pkg.champion,
    challenger: pkg.challenger,
    gates: pkg.gates,
    matchedTasks: [...pkg.matchedTasks].sort((a, b) =>
      `${a.taskId}/${a.attemptId}`.localeCompare(`${b.taskId}/${b.attemptId}`)),
  };
}

function computePackageId(
  pkg: Omit<ExperimentPackage, "packageId" | "idempotencyKey" | "qualifiedAt">,
): string {
  return `pkg-${jcsDigestHex(packageDigestPayload(pkg))}`;
}

/**
 * Qualify every candidate, freeze exactly one axis of variation across the
 * matched set, and emit an immutable, content-blind experiment package. Pure
 * and deterministic over its inputs (aside from `qualifiedAt`, which never
 * feeds the package's content-addressed identity) -- calling this twice with
 * the same qualified candidate set always yields the same `packageId`.
 */
export function packageExperimentCandidates(
  candidates: PackagerCandidateInput[],
  timelines: ReadonlyMap<string, TaskLifecycleTimeline>,
  request: PackageRequest,
): PackagingOutcome {
  const parsedCandidates = candidates.map((candidate) => packagerCandidateInputSchema.parse(candidate));
  const minCandidatesPerArm = request.minCandidatesPerArm ?? DEFAULT_MIN_CANDIDATES_PER_ARM;
  const minQualityRating = request.minQualityRating ?? DEFAULT_MIN_QUALITY_RATING;
  const now = request.now ?? (() => new Date().toISOString());

  const qualified: PackagerCandidateInput[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const candidate of parsedCandidates) {
    const timeline = timelines.get(candidate.taskId);
    if (!timeline) {
      // Distinct from "timeline-truncated" (the registry itself proved it could
      // not enumerate a task's events completely): here the caller never
      // supplied a timeline for this task at all -- fail closed the same way,
      // but with a reason that points at the actual cause.
      rejected.push({
        taskId: candidate.taskId,
        attemptId: candidate.attemptId,
        reasons: [{ code: "missing-timeline" }],
      });
      continue;
    }
    const result = qualifyCandidate(candidate, timeline, { minQualityRating });
    if (result.ok) {
      qualified.push(candidate);
    } else {
      rejected.push({ taskId: candidate.taskId, attemptId: candidate.attemptId, reasons: result.reasons });
    }
  }

  const qualifiedSummary = qualified.map((candidate) => ({ taskId: candidate.taskId, attemptId: candidate.attemptId }));

  if (qualified.length === 0) {
    return {
      status: "refused",
      qualified: qualifiedSummary,
      rejected,
      refusalReasons: [{ code: "no-qualified-candidates" }],
    };
  }

  const refusalReasons: PackageRefusalReason[] = [];

  const distinctTaskTypes = [...new Set(qualified.map((candidate) => candidate.taskType))];
  if (distinctTaskTypes.length > 1) {
    refusalReasons.push({ code: "task-type-incoherent", taskTypes: distinctTaskTypes });
  }

  const championCandidates = qualified.filter(
    (candidate) => candidate.configuration.fingerprint === request.championFingerprint,
  );
  const otherFingerprints = [...new Set(
    qualified
      .filter((candidate) => candidate.configuration.fingerprint !== request.championFingerprint)
      .map((candidate) => candidate.configuration.fingerprint),
  )];

  if (championCandidates.length === 0) {
    refusalReasons.push({ code: "no-champion-match", championFingerprint: request.championFingerprint });
  }
  if (otherFingerprints.length > 1) {
    refusalReasons.push({
      code: "more-than-two-distinct-configurations",
      distinctFingerprints: otherFingerprints.length + (championCandidates.length > 0 ? 1 : 0),
    });
  }

  let challengerCandidates: PackagerCandidateInput[] = [];
  if (otherFingerprints.length === 1) {
    const challengerFingerprint = otherFingerprints[0]!;
    challengerCandidates = qualified.filter(
      (candidate) => candidate.configuration.fingerprint === challengerFingerprint,
    );
  }

  if (championCandidates.length < minCandidatesPerArm) {
    refusalReasons.push({
      code: "insufficient-candidates",
      arm: "champion",
      count: championCandidates.length,
      required: minCandidatesPerArm,
    });
  }
  if (challengerCandidates.length < minCandidatesPerArm) {
    refusalReasons.push({
      code: "insufficient-candidates",
      arm: "challenger",
      count: challengerCandidates.length,
      required: minCandidatesPerArm,
    });
  }

  // Only compare axes once we have exactly one non-champion configuration to
  // compare against -- otherwise the "changed axes" question is ambiguous
  // and the more-specific `more-than-two-distinct-configurations` /
  // `no-champion-match` reasons above already explain the refusal.
  if (championCandidates.length > 0 && challengerCandidates.length > 0 && otherFingerprints.length === 1) {
    const championConfig = championCandidates[0]!.configuration;
    const challengerConfig = challengerCandidates[0]!.configuration;
    const changed = configurationChangedAxes(championConfig, challengerConfig);
    // Defensive only: `championConfig`/`challengerConfig` were already
    // partitioned by DIFFERING `configuration.fingerprint` values above, and
    // `computeConfigurationFingerprint` hashes exactly the fields
    // `configurationChangedAxes` compares, so `changed.length === 0` should be
    // unreachable barring a SHA-256 collision. Kept as an explicit refusal
    // rather than a silent fall-through in case that invariant ever changes.
    if (changed.length === 0) {
      refusalReasons.push({
        code: "declared-axis-mismatch",
        declared: request.changeAxis,
        detected: [],
      });
    } else if (changed.length > 1) {
      refusalReasons.push({ code: "multi-axis-delta", changedAxes: changed });
    } else if (changed[0] !== request.changeAxis) {
      refusalReasons.push({ code: "declared-axis-mismatch", declared: request.changeAxis, detected: changed });
    }
  }

  if (refusalReasons.length > 0) {
    return { status: "refused", qualified: qualifiedSummary, rejected, refusalReasons };
  }

  const championConfig = championCandidates[0]!.configuration;
  const challengerConfig = challengerCandidates[0]!.configuration;
  const taskType = distinctTaskTypes[0]!;

  const matchedTasks: PackagerMatchedTask[] = [
    ...championCandidates.map((candidate): PackagerMatchedTask => ({
      taskId: candidate.taskId,
      attemptId: candidate.attemptId,
      arm: "champion",
      taskType: candidate.taskType,
      qualityReceiptId: candidate.qualityReceipt.receiptId,
      qualityRating: candidate.qualityReceipt.rating,
    })),
    ...challengerCandidates.map((candidate): PackagerMatchedTask => ({
      taskId: candidate.taskId,
      attemptId: candidate.attemptId,
      arm: "challenger",
      taskType: candidate.taskType,
      qualityReceiptId: candidate.qualityReceipt.receiptId,
      qualityRating: candidate.qualityReceipt.rating,
    })),
  ].sort((a, b) => `${a.taskId}/${a.attemptId}`.localeCompare(`${b.taskId}/${b.attemptId}`));

  const unstamped = {
    schemaVersion: 1 as const,
    scope: request.scope,
    taskType,
    changeAxis: request.changeAxis,
    hypothesis: request.hypothesis,
    champion: championConfig,
    challenger: challengerConfig,
    gates: request.gates,
    matchedTasks,
  };
  const packageId = computePackageId(unstamped);

  const pkg = experimentPackageSchema.parse({
    ...unstamped,
    packageId,
    idempotencyKey: packageId,
    qualifiedAt: now(),
  });

  return {
    status: "packaged",
    qualified: qualifiedSummary,
    rejected,
    refusalReasons: [],
    package: pkg,
  };
}

/** Map a frozen package onto the existing experiment-creation contract (src/learning/experiment-schema.ts). */
export function toExperimentCreateInput(pkg: ExperimentPackage): LearningExperimentCreate {
  return learningExperimentCreateSchema.parse({
    experiment_id: `pkg-${pkg.packageId.slice(4, 20)}`,
    scope: pkg.scope,
    task_type: pkg.taskType,
    hypothesis: pkg.hypothesis,
    change_axis: pkg.changeAxis,
    champion: pkg.champion,
    challenger: pkg.challenger,
    gates: pkg.gates,
  });
}

export interface PackageAndHandOffResult extends PackagingOutcome {
  createInput?: LearningExperimentCreate;
  experiment?: { state: LearningExperimentState; reused: boolean };
}

/**
 * Orchestration wrapper: fetch each candidate task's CURRENT registry
 * timeline (this is the freeze-time exposure recheck -- there is no earlier
 * cached view, every call re-reads from the registry), package, and hand the
 * result to the existing `LearningExperimentStore.create` surface. Execution
 * (running observations, evaluating, promoting) stays entirely inside that
 * existing store; this function only ever calls `.create`, which is itself
 * idempotent -- a second call with the same package returns `reused: true`
 * rather than creating a duplicate experiment.
 */
export async function packageAndHandOff(
  registry: Pick<LearningRegistryStore, "listEventsForTask">,
  experimentStore: LearningExperimentStore,
  principal: string,
  candidates: PackagerCandidateInput[],
  request: PackageRequest,
): Promise<PackageAndHandOffResult> {
  const taskIds = [...new Set(candidates.map((candidate) => candidate.taskId))];
  const timelines = new Map<string, TaskLifecycleTimeline>();
  for (const taskId of taskIds) {
    timelines.set(taskId, await buildTaskLifecycleTimeline(registry, taskId));
  }

  const outcome = packageExperimentCandidates(candidates, timelines, request);
  if (outcome.status !== "packaged" || !outcome.package) {
    return outcome;
  }

  const createInput = toExperimentCreateInput(outcome.package);
  const experiment = await experimentStore.create(principal, createInput);
  return { ...outcome, createInput, experiment };
}
