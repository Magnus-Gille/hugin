/**
 * Read-only one-axis experiment proposer -- logic (#234).
 *
 * See experiment-proposer-schema.ts for the full scope-boundary and
 * content-blindness rationale. In short: this module reads already-qualified
 * production evidence (candidate/timeline pairs, exactly the shape the #233
 * packager consumes), groups it into comparable populations, and proposes
 * ranked one-axis champion/challenger experiments worth packaging. It never
 * generates evidence, never packages, and never runs, evaluates, or promotes
 * an experiment -- that stays entirely inside candidate-packager.ts and
 * experiment-store.ts.
 *
 * Read-only guarantee: `proposeExperiments` is a pure function over
 * caller-supplied candidates and timelines. `proposeExperimentsFromRegistry`
 * only calls `listEventsForTask` (via `buildTaskLifecycleTimeline`, itself
 * read-only) before delegating to the pure core -- it never calls a registry
 * mutation method, an experiment store, or the packager.
 *
 * One-axis detection: reuses `configurationChangedAxes` (experiment-schema.ts)
 * -- the same axis vocabulary and comparison the packager and
 * `LearningExperimentStore.create` already enforce -- so a proposal's
 * `changeAxis` can never disagree with what the packager would itself detect
 * for the same champion/challenger pair.
 *
 * Ranking heuristic: `score = effectSize * sampleSize * recencyWeight`.
 *  - `effectSize` is the absolute pass-rate delta between the two arms
 *    (0..1) -- a coarse but interpretable proxy for "how much does this axis
 *    seem to matter", matching the `quality-rate` primary metric the gates
 *    schema already defines.
 *  - `sampleSize` is `min(championSamples, challengerSamples)` -- an
 *    experiment's statistical power is bound by its thinner arm, so the
 *    weaker side should suppress the score even when the other arm is huge.
 *  - `recencyWeight` is an exponential half-life decay (default 14 days)
 *    applied to the most recent evidence timestamp in the pair, so a
 *    population built entirely from stale evidence is ranked below an
 *    equally-sized fresh one even with an identical effect size.
 * This is a deliberately simple, auditable scoring function, not a
 * statistical model -- `evidence.confidence` (a normal-approximation
 * two-proportion z-test) is reported alongside it as an explicit caveat
 * rather than folded into the score, since it is not resistant to
 * non-independent samples or multiple-comparison inflation across the
 * several populations one run may propose.
 */

import { jcsDigestHex } from "../learning-registry-schema.js";
import { buildTaskLifecycleTimeline, type TaskLifecycleTimeline } from "../learning-registry-view.js";
import type { LearningRegistryStore } from "../learning-registry-store.js";
import {
  configurationChangedAxes,
  learningExperimentGatesSchema,
  type LearningExperimentGates,
} from "./experiment-schema.js";
import { qualifyCandidate, type PackageRequest } from "./candidate-packager.js";
import type { PackagerQualityRating } from "./candidate-packager-schema.js";
import {
  experimentProposalSchema,
  type ExperimentProposal,
  type PackagerCandidateInput,
  type PackagerMatchedTask,
  type PopulationDeclineReason,
  type ProposalOutcome,
} from "./experiment-proposer-schema.js";

export * from "./experiment-proposer-schema.js";

export interface ProposeRequest {
  now?: () => string;
  /** Minimum qualified samples required in EACH arm before a pair is proposal-worthy. Default 3. */
  minSamplesPerArm?: number;
  /**
   * Rating floor passed through to `qualifyCandidate`'s per-candidate
   * contamination checks. Default "wrong" (the lowest rating -- every rated,
   * uncontaminated attempt is eligible) so the population reflects the full
   * outcome spectrum; see DEFAULT_MIN_QUALITY_RATING's comment for why this
   * differs from the packager's "pass" floor.
   */
  minQualityRating?: PackagerQualityRating;
  /** Minimum |challengerQualityRate - championQualityRate| worth surfacing. Default 0.1 (10 points). */
  minQualityRateDelta?: number;
  /** Half-life, in days, of the recency weight applied to a population's most recent evidence. Default 14. */
  recencyHalfLifeDays?: number;
  /** Prefix for the generated `suggestedScope` slug. Default "proposed". */
  scopePrefix?: string;
}

const DEFAULT_MIN_SAMPLES_PER_ARM = 3;
/**
 * Unlike the #233 packager -- which only ever freezes already-winning
 * candidates and therefore floors at "pass" -- the proposer needs the full
 * outcome spectrum to detect a quality delta between two configurations at
 * all. Flooring at "pass" here would mean only already-passing candidates
 * ever survive qualification, making every surviving population's pass rate
 * trivially 1.0 and the whole quality-signal comparison vacuous. The lowest
 * rating floor still leaves every OTHER `qualifyCandidate` contamination
 * check (timeline completeness, exclusion/erasure, superseded evidence,
 * receipt binding) fully in force -- only the rating floor itself differs.
 */
const DEFAULT_MIN_QUALITY_RATING: PackagerQualityRating = "wrong";
const DEFAULT_MIN_QUALITY_RATE_DELTA = 0.1;
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 14;
const DEFAULT_SCOPE_PREFIX = "proposed";
const MS_PER_DAY = 86_400_000;

function groupBy<T, K>(items: readonly T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key);
    if (list) list.push(item); else map.set(key, [item]);
  }
  return map;
}

/** "pass" scores 1, everything else (already floored above `minQualityRating`) scores 0. */
function qualityScoreOf(candidate: PackagerCandidateInput): number {
  return candidate.qualityReceipt.rating === "pass" ? 1 : 0;
}

function meanQualityRate(group: readonly PackagerCandidateInput[]): number {
  return group.reduce((sum, candidate) => sum + qualityScoreOf(candidate), 0) / group.length;
}

function ratedTimestamps(group: readonly PackagerCandidateInput[]): string[] {
  return group.map((candidate) => candidate.qualityReceipt.ratedAt);
}

function earliestTimestamp(group: readonly PackagerCandidateInput[]): string {
  return ratedTimestamps(group).reduce((a, b) => (a <= b ? a : b));
}

function latestTimestamp(group: readonly PackagerCandidateInput[]): string {
  return ratedTimestamps(group).reduce((a, b) => (a >= b ? a : b));
}

function computeRecencyWeight(mostRecentIso: string, nowIso: string, halfLifeDays: number): number {
  const ageMs = Date.parse(nowIso) - Date.parse(mostRecentIso);
  const ageDays = Math.max(0, ageMs / MS_PER_DAY);
  const safeHalfLife = Math.max(halfLifeDays, 0.001);
  return Math.pow(0.5, ageDays / safeHalfLife);
}

/**
 * Normal approximation to a two-proportion z-test. See the module doc
 * comment for its limitations. `null` when the pooled standard error is
 * degenerate (e.g. one arm is 0% and the other 100%, giving zero pooled
 * variance) -- confidence then falls back to sample size alone.
 */
function computeConfidence(
  championRate: number,
  championN: number,
  challengerRate: number,
  challengerN: number,
): { zScore: number | null; confidence: "low" | "medium" | "high" } {
  const pooled = (championRate * championN + challengerRate * challengerN) / (championN + challengerN);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / championN + 1 / challengerN));
  if (se === 0) {
    const minN = Math.min(championN, challengerN);
    return { zScore: null, confidence: minN >= 8 ? "high" : minN >= 4 ? "medium" : "low" };
  }
  const z = (challengerRate - championRate) / se;
  const absZ = Math.abs(z);
  const confidence = absZ >= 1.96 ? "high" : absZ >= 1 ? "medium" : "low";
  return { zScore: z, confidence };
}

function matchedTaskFor(candidate: PackagerCandidateInput, arm: "champion" | "challenger"): PackagerMatchedTask {
  return {
    taskId: candidate.taskId,
    attemptId: candidate.attemptId,
    arm,
    taskType: candidate.taskType,
    qualityReceiptId: candidate.qualityReceipt.receiptId,
    qualityRating: candidate.qualityReceipt.rating,
  };
}

function slugPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function buildSuggestedScope(prefix: string, taskType: string, axis: string): string {
  const joined = [slugPart(prefix), slugPart(taskType), slugPart(axis)].filter((part) => part.length > 0).join("-");
  const clipped = joined.slice(0, 79).replace(/-+$/g, "");
  // slugSchema requires at least 2 characters starting with [a-z0-9]; every real
  // taskType/axis value is well above that, so this pad is defensive only.
  return clipped.length >= 2 ? clipped : `${clipped}-x`;
}

/** Canonical digest input for a proposal -- excludes every wall-clock-dependent field
 * (`proposedAt`, `evidence.recencyWeight`, `rank.recencyWeight`, `rank.score`) so the
 * same underlying evidence pool re-analyzed at a later time still yields the same
 * `proposalId`. This lets a downstream conductor detect "the same proposal, evidence
 * unchanged" versus "a new/expanded evidence pool" cheaply by comparing ids, though
 * building that dedup conductor itself is out of this module's scope. */
function proposalDigestPayload(proposal: Omit<ExperimentProposal, "proposalId" | "proposedAt">): unknown {
  const { recencyWeight: _evidenceRecencyWeight, ...evidenceForDigest } = proposal.evidence;
  const { recencyWeight: _rankRecencyWeight, score: _score, ...rankForDigest } = proposal.rank;
  return {
    schemaVersion: proposal.schemaVersion,
    taskType: proposal.taskType,
    changeAxis: proposal.changeAxis,
    championFingerprint: proposal.championFingerprint,
    challengerFingerprint: proposal.challengerFingerprint,
    champion: proposal.champion,
    challenger: proposal.challenger,
    evidence: evidenceForDigest,
    matchedTasks: [...proposal.matchedTasks].sort((a, b) =>
      `${a.taskId}/${a.attemptId}`.localeCompare(`${b.taskId}/${b.attemptId}`)),
    hypothesis: proposal.hypothesis,
    suggestedScope: proposal.suggestedScope,
    rank: rankForDigest,
  };
}

function computeProposalId(proposal: Omit<ExperimentProposal, "proposalId" | "proposedAt">): string {
  return `prop-${jcsDigestHex(proposalDigestPayload(proposal))}`;
}

/**
 * Scan qualified production evidence and propose ranked one-axis
 * champion/challenger experiments. Pure and deterministic given its inputs,
 * aside from `request.now`, which never feeds a proposal's content-addressed
 * identity (see `proposalDigestPayload`).
 */
export function proposeExperiments(
  candidates: readonly PackagerCandidateInput[],
  timelines: ReadonlyMap<string, TaskLifecycleTimeline>,
  request: ProposeRequest = {},
): ProposalOutcome {
  const now = request.now ?? (() => new Date().toISOString());
  const nowIso = now();
  const minSamplesPerArm = request.minSamplesPerArm ?? DEFAULT_MIN_SAMPLES_PER_ARM;
  const minQualityRating = request.minQualityRating ?? DEFAULT_MIN_QUALITY_RATING;
  const minQualityRateDelta = request.minQualityRateDelta ?? DEFAULT_MIN_QUALITY_RATE_DELTA;
  const recencyHalfLifeDays = request.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const scopePrefix = request.scopePrefix ?? DEFAULT_SCOPE_PREFIX;

  // Fail closed on the same per-candidate contamination checks the packager
  // uses (truncated timeline, excluded/superseded evidence, incomplete
  // attempts, mismatched or sub-floor quality receipts) before any evidence
  // is grouped into a population.
  const qualified: PackagerCandidateInput[] = [];
  const rejectedCandidates: ProposalOutcome["rejectedCandidates"] = [];
  for (const candidate of candidates) {
    const timeline = timelines.get(candidate.taskId);
    if (!timeline) {
      rejectedCandidates.push({
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
      rejectedCandidates.push({ taskId: candidate.taskId, attemptId: candidate.attemptId, reasons: result.reasons });
    }
  }

  if (qualified.length === 0) {
    return {
      status: "no-proposals",
      proposals: [],
      rejectedCandidates,
      declinedPopulations: [{ code: "no-qualified-evidence" }],
    };
  }

  const declinedPopulations: PopulationDeclineReason[] = [];
  const proposals: ExperimentProposal[] = [];

  const byTaskType = groupBy(qualified, (candidate) => candidate.taskType);
  for (const [taskType, taskCandidates] of [...byTaskType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const byFingerprint = groupBy(taskCandidates, (candidate) => candidate.configuration.fingerprint);
    const fingerprints = [...byFingerprint.keys()].sort();

    if (fingerprints.length < 2) {
      declinedPopulations.push({
        code: "single-configuration",
        taskType,
        distinctConfigurations: fingerprints.length,
      });
      continue;
    }

    // Compare every pairwise combination of distinct configurations within
    // this task type -- a population is not required to reduce to exactly
    // two configurations the way a frozen package must; the proposer's job
    // is to surface every proposal-worthy pair, ranked, not to pick one.
    for (let i = 0; i < fingerprints.length; i += 1) {
      for (let j = i + 1; j < fingerprints.length; j += 1) {
        const fingerprintA = fingerprints[i]!;
        const fingerprintB = fingerprints[j]!;
        const groupA = byFingerprint.get(fingerprintA)!;
        const groupB = byFingerprint.get(fingerprintB)!;
        const configA = groupA[0]!.configuration;
        const configB = groupB[0]!.configuration;

        const changed = configurationChangedAxes(configA, configB);
        if (changed.length === 0) {
          // Defensive only: differing fingerprints already imply differing
          // canonicalized content barring a SHA-256 collision (identical
          // reasoning to candidate-packager.ts's own defensive comment).
          declinedPopulations.push({
            code: "no-axis-delta",
            taskType,
            championFingerprint: fingerprintA,
            challengerFingerprint: fingerprintB,
          });
          continue;
        }
        if (changed.length > 1) {
          declinedPopulations.push({
            code: "multi-axis-delta",
            taskType,
            championFingerprint: fingerprintA,
            challengerFingerprint: fingerprintB,
            changedAxes: changed,
          });
          continue;
        }
        const axis = changed[0]!;

        // Older evidence is treated as the incumbent (champion); the group
        // that started appearing later is the challenger under test. Ties
        // fall back to the lexicographically smaller fingerprint so the
        // assignment is deterministic.
        const aEarliest = earliestTimestamp(groupA);
        const bEarliest = earliestTimestamp(groupB);
        const aIsChampion = aEarliest !== bEarliest ? aEarliest < bEarliest : fingerprintA < fingerprintB;
        const [champGroup, challGroup, champConfig, challConfig, champFp, challFp] = aIsChampion
          ? [groupA, groupB, configA, configB, fingerprintA, fingerprintB]
          : [groupB, groupA, configB, configA, fingerprintB, fingerprintA];

        if (champGroup.length < minSamplesPerArm || challGroup.length < minSamplesPerArm) {
          const shortArm: "champion" | "challenger" = champGroup.length < minSamplesPerArm ? "champion" : "challenger";
          declinedPopulations.push({
            code: "insufficient-samples",
            taskType,
            axis,
            arm: shortArm,
            count: shortArm === "champion" ? champGroup.length : challGroup.length,
            required: minSamplesPerArm,
            championFingerprint: champFp,
            challengerFingerprint: challFp,
          });
          continue;
        }

        const championQualityRate = meanQualityRate(champGroup);
        const challengerQualityRate = meanQualityRate(challGroup);
        const qualityRateDelta = challengerQualityRate - championQualityRate;
        if (Math.abs(qualityRateDelta) < minQualityRateDelta) {
          declinedPopulations.push({
            code: "no-quality-signal-delta",
            taskType,
            axis,
            championFingerprint: champFp,
            challengerFingerprint: challFp,
            qualityRateDelta,
            threshold: minQualityRateDelta,
          });
          continue;
        }

        const mostRecentEvidenceAt = [latestTimestamp(champGroup), latestTimestamp(challGroup)]
          .reduce((a, b) => (a >= b ? a : b));
        const recencyWeight = computeRecencyWeight(mostRecentEvidenceAt, nowIso, recencyHalfLifeDays);
        const sampleSize = Math.min(champGroup.length, challGroup.length);
        const effectSize = Math.abs(qualityRateDelta);
        const score = effectSize * sampleSize * recencyWeight;
        const { zScore, confidence } = computeConfidence(
          championQualityRate, champGroup.length, challengerQualityRate, challGroup.length,
        );

        const matchedTasks = [
          ...champGroup.map((candidate) => matchedTaskFor(candidate, "champion")),
          ...challGroup.map((candidate) => matchedTaskFor(candidate, "challenger")),
        ].sort((a, b) => `${a.taskId}/${a.attemptId}`.localeCompare(`${b.taskId}/${b.attemptId}`));

        const deltaPoints = (qualityRateDelta * 100).toFixed(1);
        const direction = qualityRateDelta > 0 ? "higher" : "lower";
        const hypothesis =
          `Varying ${axis} for ${taskType} tasks is associated with a ${Math.abs(Number(deltaPoints))}-point ` +
          `${direction} pass rate (challenger ${(challengerQualityRate * 100).toFixed(1)}% over ${challGroup.length} ` +
          `samples vs champion ${(championQualityRate * 100).toFixed(1)}% over ${champGroup.length} samples); ` +
          `worth a controlled one-axis experiment to confirm.`;

        const unstamped = {
          schemaVersion: 1 as const,
          taskType,
          changeAxis: axis,
          championFingerprint: champFp,
          challengerFingerprint: challFp,
          champion: champConfig,
          challenger: challConfig,
          evidence: {
            championSamples: champGroup.length,
            challengerSamples: challGroup.length,
            championQualityRate,
            challengerQualityRate,
            qualityRateDelta,
            mostRecentEvidenceAt,
            recencyWeight,
            zScore,
            confidence,
          },
          matchedTasks,
          hypothesis,
          suggestedScope: buildSuggestedScope(scopePrefix, taskType, axis),
          rank: { score, effectSize, sampleSize, recencyWeight },
        };
        const proposalId = computeProposalId(unstamped);
        proposals.push(experimentProposalSchema.parse({ ...unstamped, proposalId, proposedAt: nowIso }));
      }
    }
  }

  proposals.sort((a, b) => b.rank.score - a.rank.score || a.proposalId.localeCompare(b.proposalId));

  return {
    status: proposals.length > 0 ? "proposed" : "no-proposals",
    proposals,
    rejectedCandidates,
    declinedPopulations,
  };
}

/**
 * Orchestration wrapper: fetch each candidate task's CURRENT registry
 * timeline (mirroring `packageAndHandOff`'s freeze-time recheck) and hand the
 * result to the pure `proposeExperiments` core. Never calls a registry
 * mutation method, an experiment store, or the packager -- this function's
 * only I/O is `listEventsForTask` reads.
 */
export async function proposeExperimentsFromRegistry(
  registry: Pick<LearningRegistryStore, "listEventsForTask">,
  candidates: readonly PackagerCandidateInput[],
  request: ProposeRequest = {},
): Promise<ProposalOutcome> {
  const taskIds = [...new Set(candidates.map((candidate) => candidate.taskId))];
  const timelines = new Map<string, TaskLifecycleTimeline>();
  for (const taskId of taskIds) {
    timelines.set(taskId, await buildTaskLifecycleTimeline(registry, taskId));
  }
  return proposeExperiments(candidates, timelines, request);
}

/**
 * Map a proposal onto the #233 packager's `PackageRequest` shape --
 * (task-type, axis, champion, challenger, matched set) becomes (scope,
 * hypothesis, changeAxis, championFingerprint) directly, with `gates`
 * defaulted to the `quality-rate` primary metric the proposer itself
 * screened on. Deliberately does NOT return `PackagerCandidateInput[]`: a
 * proposal only carries content-blind `matchedTasks` references (taskId /
 * attemptId / arm / taskType / qualityReceiptId / qualityRating), never a
 * candidate's full configuration or native quality receipt. The caller must
 * still resolve each `proposal.matchedTasks` entry back into a full
 * `PackagerCandidateInput` from its own durable stores (the registry and the
 * quality-receipt ledger) before calling `packageExperimentCandidates` --
 * exactly the same re-fetch-by-id discipline `packageAndHandOff` already
 * applies to registry timelines rather than trusting a cached view.
 */
export function proposalToPackageRequest(
  proposal: ExperimentProposal,
  overrides: {
    scope?: string;
    gates?: LearningExperimentGates;
    minCandidatesPerArm?: number;
    minQualityRating?: PackagerQualityRating;
    now?: () => string;
  } = {},
): PackageRequest {
  return {
    scope: overrides.scope ?? proposal.suggestedScope,
    hypothesis: proposal.hypothesis,
    changeAxis: proposal.changeAxis,
    championFingerprint: proposal.championFingerprint,
    gates: overrides.gates ?? learningExperimentGatesSchema.parse({ primaryMetric: "quality-rate" }),
    ...(overrides.minCandidatesPerArm !== undefined ? { minCandidatesPerArm: overrides.minCandidatesPerArm } : {}),
    ...(overrides.minQualityRating !== undefined ? { minQualityRating: overrides.minQualityRating } : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  };
}
