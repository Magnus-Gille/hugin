/** Pure, deterministic monotonic-promotion gate for learning experiments. */

import type {
  LearningArmSummary,
  LearningExperimentEvaluation,
  LearningExperimentGates,
  LearningPrimaryMetric,
  RecordedLearningObservation,
} from "./experiment-schema.js";

function mean(values: Array<number | undefined>): number | null {
  const measured = values.filter((value): value is number => value !== undefined);
  if (measured.length === 0) return null;
  return measured.reduce((sum, value) => sum + value, 0) / measured.length;
}

function isAuthoritative(observation: RecordedLearningObservation): boolean {
  return (
    observation.verifier.independent &&
    (observation.verifier.kind === "mechanical" || observation.verifier.kind === "human")
  );
}

function summarize(observations: RecordedLearningObservation[]): LearningArmSummary {
  const samples = observations.length;
  const verified = observations.filter(
    (observation) =>
      isAuthoritative(observation) &&
      (observation.quality_outcome === "pass" || observation.quality_outcome === "fail"),
  );
  const passes = verified.filter((observation) => observation.quality_outcome === "pass").length;
  const rated = observations.filter((observation) => observation.product_outcome !== "unrated");
  const useful = rated.filter(
    (observation) =>
      observation.product_outcome === "accepted-unchanged" ||
      observation.product_outcome === "minor-edit",
  ).length;
  const rescue = rated.filter(
    (observation) =>
      observation.product_outcome === "major-rewrite" ||
      observation.product_outcome === "discarded",
  ).length;
  const infra = observations.filter(
    (observation) => observation.quality_outcome === "infra-error",
  ).length;

  return {
    samples,
    verifiedSamples: verified.length,
    verifiedCoverage: samples > 0 ? verified.length / samples : 0,
    qualityRate: verified.length > 0 ? passes / verified.length : null,
    ratedSamples: rated.length,
    ratedCoverage: samples > 0 ? rated.length / samples : 0,
    usefulRate: rated.length > 0 ? useful / rated.length : null,
    rescueRate: rated.length > 0 ? rescue / rated.length : null,
    infraRate: samples > 0 ? infra / samples : 0,
    latencyMeanMs: mean(observations.map((observation) => observation.latency_ms)),
    costMeanUsd: mean(observations.map((observation) => observation.cost_usd)),
    humanReviewMeanSeconds: mean(
      observations.map((observation) => observation.human_review_seconds),
    ),
    editStartMeanMs: mean(observations.map((observation) => observation.edit_start_ms)),
    observabilityCoverageMean: mean(
      observations.map((observation) => observation.observability_coverage),
    ),
    verifierScoreMean: mean(
      observations.map((observation) => observation.verifier_score),
    ),
  };
}

function metricValue(summary: LearningArmSummary, metric: LearningPrimaryMetric): number | null {
  switch (metric) {
    case "quality-rate": return summary.qualityRate;
    case "useful-rate": return summary.usefulRate;
    case "rescue-rate": return summary.rescueRate;
    case "latency-ms": return summary.latencyMeanMs;
    case "cost-usd": return summary.costMeanUsd;
    case "human-review-seconds": return summary.humanReviewMeanSeconds;
    case "edit-start-ms": return summary.editStartMeanMs;
    case "observability-coverage": return summary.observabilityCoverageMean;
    case "verifier-score": return summary.verifierScoreMean;
  }
}

const HIGHER_IS_BETTER: ReadonlySet<LearningPrimaryMetric> = new Set([
  "quality-rate",
  "useful-rate",
  "observability-coverage",
  "verifier-score",
]);

type ObservationPair = Record<
  "champion" | "challenger",
  RecordedLearningObservation
>;

const SCALAR_METRICS: ReadonlySet<LearningPrimaryMetric> = new Set([
  "latency-ms",
  "cost-usd",
  "human-review-seconds",
  "edit-start-ms",
  "observability-coverage",
  "verifier-score",
]);

function scalarObservationValue(
  observation: RecordedLearningObservation,
  metric: LearningPrimaryMetric,
): number | undefined {
  switch (metric) {
    case "latency-ms": return observation.latency_ms;
    case "cost-usd": return observation.cost_usd;
    case "human-review-seconds": return observation.human_review_seconds;
    case "edit-start-ms": return observation.edit_start_ms;
    case "observability-coverage": return observation.observability_coverage;
    case "verifier-score": return observation.verifier_score;
    case "quality-rate":
    case "useful-rate":
    case "rescue-rate":
      return undefined;
  }
}

function pairedScalar(
  pairs: ObservationPair[],
  metric: LearningPrimaryMetric,
): { champion: number | null; challenger: number | null; count: number } {
  const measured = pairs.flatMap((pair) => {
    const champion = scalarObservationValue(pair.champion, metric);
    const challenger = scalarObservationValue(pair.challenger, metric);
    return champion === undefined || challenger === undefined
      ? []
      : [{ champion, challenger }];
  });
  return {
    champion: mean(measured.map((pair) => pair.champion)),
    challenger: mean(measured.map((pair) => pair.challenger)),
    count: measured.length,
  };
}

function primaryImprovement(
  metric: LearningPrimaryMetric,
  champion: number | null,
  challenger: number | null,
): number | null {
  if (champion === null || challenger === null) return null;
  if (HIGHER_IS_BETTER.has(metric)) return challenger - champion;
  if (champion === 0) return challenger === 0 ? 0 : -1;
  return (champion - challenger) / champion;
}

function collectFailureSignals(
  observations: RecordedLearningObservation[],
): Array<{ signal: string; count: number }> {
  const counts = new Map<string, number>();
  const add = (signal: string) => counts.set(signal, (counts.get(signal) ?? 0) + 1);

  for (const observation of observations) {
    if (observation.failure_kind) add(observation.failure_kind);
    if (observation.quality_outcome === "infra-error") add("infra-error");
    if (observation.quality_outcome === "unverified") add("unverified-output");
    if (observation.quality_outcome === "fail" && !observation.failure_kind) add("quality-fail");
    if (observation.edited === false) add("no-edit");
    if (observation.edited === true && observation.tests_run === false) add("tests-not-run");
    if (observation.tests_run === true && observation.tests_passed === false) add("tests-failed");
    if (observation.edit_start_ms === undefined && observation.phase_ms?.inspect !== undefined) {
      add("edit-start-unobserved");
    }
  }

  return [...counts.entries()]
    .map(([signal, count]) => ({ signal, count }))
    .sort((a, b) => b.count - a.count || a.signal.localeCompare(b.signal));
}

function addCoverageRequirements(
  missing: string[],
  champion: LearningArmSummary,
  challenger: LearningArmSummary,
  gates: LearningExperimentGates,
): void {
  if (
    champion.verifiedCoverage < gates.minVerifiedCoverage ||
    challenger.verifiedCoverage < gates.minVerifiedCoverage
  ) {
    missing.push(
      `verified coverage must be >= ${gates.minVerifiedCoverage} on both arms`,
    );
  }
  if (
    champion.ratedCoverage < gates.minRatedCoverage ||
    challenger.ratedCoverage < gates.minRatedCoverage
  ) {
    missing.push(`rated coverage must be >= ${gates.minRatedCoverage} on both arms`);
  }
}

function addGuardFailures(
  failures: string[],
  champion: LearningArmSummary,
  challenger: LearningArmSummary,
  gates: LearningExperimentGates,
): void {
  if (
    champion.qualityRate !== null &&
    challenger.qualityRate !== null &&
    challenger.qualityRate + gates.maxQualityRegression < champion.qualityRate
  ) {
    failures.push("quality regression exceeded the configured tolerance");
  }
  if (
    champion.usefulRate !== null &&
    challenger.usefulRate !== null &&
    challenger.usefulRate + gates.maxUsefulRegression < champion.usefulRate
  ) {
    failures.push("useful-completion regression exceeded the configured tolerance");
  }
  if (
    champion.rescueRate !== null &&
    challenger.rescueRate !== null &&
    challenger.rescueRate > champion.rescueRate + gates.maxRescueRateIncrease
  ) {
    failures.push("human rescue rate increased beyond the configured tolerance");
  }
  if (challenger.infraRate > champion.infraRate + gates.maxInfraRateIncrease) {
    failures.push("infrastructure failure rate increased beyond the configured tolerance");
  }
  if (
    gates.maxLatencyRatio !== null &&
    champion.latencyMeanMs !== null &&
    challenger.latencyMeanMs !== null &&
    challenger.latencyMeanMs > champion.latencyMeanMs * gates.maxLatencyRatio
  ) {
    failures.push("latency exceeded the configured ratio guard");
  }
  if (
    gates.maxCostRatio !== null &&
    champion.costMeanUsd !== null &&
    challenger.costMeanUsd !== null &&
    challenger.costMeanUsd > champion.costMeanUsd * gates.maxCostRatio
  ) {
    failures.push("cost exceeded the configured ratio guard");
  }
}

export function evaluateLearningExperiment(input: {
  observations: RecordedLearningObservation[];
  gates: LearningExperimentGates;
  now?: () => Date;
}): LearningExperimentEvaluation {
  const now = input.now ?? (() => new Date());
  const bySample = new Map<
    string,
    Partial<Record<"champion" | "challenger", RecordedLearningObservation>>
  >();
  for (const observation of input.observations) {
    const pair = bySample.get(observation.sample_id) ?? {};
    pair[observation.arm] = observation;
    bySample.set(observation.sample_id, pair);
  }

  const pairs = [...bySample.values()].filter(
    (pair): pair is Record<"champion" | "challenger", RecordedLearningObservation> =>
      pair.champion !== undefined && pair.challenger !== undefined,
  );
  const championObservations = pairs.map((pair) => pair.champion);
  const challengerObservations = pairs.map((pair) => pair.challenger);
  const champion = summarize(championObservations);
  const challenger = summarize(challengerObservations);
  // Scalar comparisons are paired too: never compare champion latency from
  // one subset with challenger latency from another subset merely because both
  // arms supplied at least one number somewhere.
  const scalarPairs = {
    latency: pairedScalar(pairs, "latency-ms"),
    cost: pairedScalar(pairs, "cost-usd"),
    review: pairedScalar(pairs, "human-review-seconds"),
    editStart: pairedScalar(pairs, "edit-start-ms"),
    observability: pairedScalar(pairs, "observability-coverage"),
    verifier: pairedScalar(pairs, "verifier-score"),
  };
  champion.latencyMeanMs = scalarPairs.latency.champion;
  challenger.latencyMeanMs = scalarPairs.latency.challenger;
  champion.costMeanUsd = scalarPairs.cost.champion;
  challenger.costMeanUsd = scalarPairs.cost.challenger;
  champion.humanReviewMeanSeconds = scalarPairs.review.champion;
  challenger.humanReviewMeanSeconds = scalarPairs.review.challenger;
  champion.editStartMeanMs = scalarPairs.editStart.champion;
  challenger.editStartMeanMs = scalarPairs.editStart.challenger;
  champion.observabilityCoverageMean = scalarPairs.observability.champion;
  challenger.observabilityCoverageMean = scalarPairs.observability.challenger;
  champion.verifierScoreMean = scalarPairs.verifier.champion;
  challenger.verifierScoreMean = scalarPairs.verifier.challenger;
  const holdoutPairs = pairs.filter(
    (pair) => pair.champion.holdout && pair.challenger.holdout,
  ).length;
  const unmatchedObservations = input.observations.length - pairs.length * 2;
  const missingRequirements: string[] = [];
  if (pairs.length < input.gates.minMatchedPairs) {
    missingRequirements.push(
      `need ${input.gates.minMatchedPairs - pairs.length} more matched pair(s)`,
    );
  }
  if (holdoutPairs < input.gates.minHoldoutPairs) {
    missingRequirements.push(
      `need ${input.gates.minHoldoutPairs - holdoutPairs} more holdout pair(s)`,
    );
  }
  addCoverageRequirements(missingRequirements, champion, challenger, input.gates);
  if (
    input.gates.maxLatencyRatio !== null &&
    scalarPairs.latency.count < input.gates.minMatchedPairs
  ) {
    missingRequirements.push(
      `latency guard needs ${input.gates.minMatchedPairs} paired measurement(s)`,
    );
  }
  if (
    input.gates.maxCostRatio !== null &&
    scalarPairs.cost.count < input.gates.minMatchedPairs
  ) {
    missingRequirements.push(
      `cost guard needs ${input.gates.minMatchedPairs} paired measurement(s)`,
    );
  }

  const primaryChampion = metricValue(champion, input.gates.primaryMetric);
  const primaryChallenger = metricValue(challenger, input.gates.primaryMetric);
  const improvement = primaryImprovement(
    input.gates.primaryMetric,
    primaryChampion,
    primaryChallenger,
  );
  if (SCALAR_METRICS.has(input.gates.primaryMetric)) {
    const primaryPairs = pairedScalar(pairs, input.gates.primaryMetric);
    if (primaryPairs.count < input.gates.minMatchedPairs) {
      missingRequirements.push(
        `primary metric ${input.gates.primaryMetric} needs ` +
        `${input.gates.minMatchedPairs} paired measurement(s)`,
      );
    }
  }
  if (primaryChampion === null || primaryChallenger === null) {
    missingRequirements.push(`primary metric ${input.gates.primaryMetric} is not measured on both arms`);
  }

  const guardFailures: string[] = [];
  addGuardFailures(guardFailures, champion, challenger, input.gates);
  const failureSignals = collectFailureSignals(challengerObservations);

  let decision: LearningExperimentEvaluation["decision"];
  let reason: string;
  let nextAction: string;
  if (missingRequirements.length > 0) {
    decision = "gathering";
    reason = "The experiment cannot be judged yet because required evidence is missing.";
    nextAction = `Collect matched evidence: ${missingRequirements.join("; ")}.`;
  } else if (guardFailures.length > 0) {
    decision = "reject";
    reason = "The challenger violated at least one monotonic production guard.";
    nextAction =
      `Keep the champion. The next experiment should address ${failureSignals[0]?.signal ?? "the failed guard"} ` +
      "and change only one declared axis.";
  } else if (improvement === null || improvement < input.gates.minPrimaryImprovement) {
    decision = "reject";
    reason =
      `The challenger did not clear the predeclared ${input.gates.primaryMetric} improvement threshold.`;
    nextAction =
      `Keep the champion and use ${failureSignals[0]?.signal ?? "the measured primary-metric gap"} ` +
      "as the hypothesis source for the next iteration.";
  } else {
    decision = "promotion-ready";
    reason = "The challenger improved the primary metric and passed every non-regression guard.";
    nextAction =
      "Review the evidence and promote the challenger through the owning configuration repository; " +
      "then seed the next experiment from that committed version.";
  }

  return {
    decision,
    reason,
    evaluatedAt: now().toISOString(),
    matchedPairs: pairs.length,
    holdoutPairs,
    unmatchedObservations,
    champion,
    challenger,
    primaryMetric: input.gates.primaryMetric,
    primaryChampion,
    primaryChallenger,
    primaryImprovement: improvement,
    guardFailures,
    missingRequirements,
    failureSignals,
    nextAction,
  };
}
