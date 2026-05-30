/**
 * eval-runner.ts — offline eval harness for issue #83 (A6).
 *
 * Designed for testability:
 *   - `runEvalSuite` accepts an injected `runFixture` executor so tests never
 *     need a real model, cell, or Munin instance.
 *   - No imports from route-binding-schema, procedure-package-schema,
 *     retrieval-schema, or any other #79–#82 modules — this module is
 *     independently compilable and testable.
 *   - Does not import from Munin client, index.ts, or router.ts.
 *
 * Anti-Goodhart rules enforced at runtime (mirrors the schema-level refines):
 *   1. `assertIndependentOracle` throws if no oracle is independent.
 *   2. A `judge-model` oracle verdict is advisory: it can never alone decide
 *      pass or fail.  A definitive verdict requires at least one non-judge
 *      oracle.
 */

import type { EvalSuite, Oracle, Fixture, RetrievalFixture } from "./eval-suite-schema.js";
import type { FailureStage } from "./refs.js";
import { calibratedMetricsSchema } from "./refs.js";
import type { CalibratedMetrics } from "./refs.js";

// ---------------------------------------------------------------------------
// Per-fixture result shape (typed locally — caller assembles full ValidationRun)
// ---------------------------------------------------------------------------

export interface PerFixtureResult {
  fixtureId: string;
  outcome: "pass" | "fail" | "abstain";
  /** Set on fail: which stage the failure was caught at. */
  caughtAtStage?: FailureStage;
  /** The oracle that produced the definitive verdict. */
  oracleId: string;
}

// ---------------------------------------------------------------------------
// Eval-suite aggregate result
// ---------------------------------------------------------------------------

export interface EvalSuiteRunResult {
  metrics: CalibratedMetrics;
  perFixtureResults: PerFixtureResult[];
}

// ---------------------------------------------------------------------------
// Runtime anti-Goodhart guard
// ---------------------------------------------------------------------------

/**
 * Throw if the suite has no independent oracle.  Mirrors the schema .refine so
 * callers can enforce this at runtime (e.g. before recording a ValidationRun).
 */
export function assertIndependentOracle(suite: EvalSuite): void {
  if (!suite.oracles.some((o) => o.independent)) {
    throw new Error(
      `EvalSuite "${suite.evalSuiteId}": at least one independent oracle required`,
    );
  }
}

// ---------------------------------------------------------------------------
// Single-fixture grading
// ---------------------------------------------------------------------------

/**
 * Grade a single fixture output against the provided oracles.
 *
 * Oracle evaluation order:
 *   1. Non-judge oracles are consulted first and are authoritative.
 *   2. A `judge-model` oracle is advisory: its verdict is recorded in
 *      `oracleId` only when there is no authoritative verdict from a
 *      non-judge oracle.  It can never cause pass/fail alone — if the only
 *      oracles are judge-model, the outcome is "abstain".
 *
 * This function does NOT execute oracles externally.  In the offline eval
 * harness, oracle execution is the responsibility of `runFixture` (the
 * injected executor).  `gradeFixture` decides the verdict based on the
 * output already produced.  The oracle array is used to determine which
 * oracle's logic should be applied; the actual check is a structural
 * equality comparison between `output` and `fixture.expected` (suitable
 * for deterministic test-suite and schema-validator oracle kinds).
 *
 * For richer oracle dispatch (running external commands, calling APIs),
 * replace this function with one that accepts pre-computed per-oracle
 * verdicts.  The anti-Goodhart contract (judge advisory, independent
 * required) is enforced regardless.
 */
export function gradeFixture(
  f: Fixture,
  output: unknown,
  oracles: Oracle[],
): PerFixtureResult {
  const nonJudgeOracles = oracles.filter((o) => o.kind !== "judge-model");
  const judgeOracles = oracles.filter((o) => o.kind === "judge-model");

  // Determine match: structural equality (JSON round-trip safe for primitives
  // and plain objects).  Callers with richer oracle kinds should wrap this
  // function to inject oracle-specific verdicts.
  const matches = JSON.stringify(output) === JSON.stringify(f.expected);

  // --- Non-judge oracles (authoritative) -----------------------------------
  if (nonJudgeOracles.length > 0) {
    // Use the first independent non-judge oracle for the definitive verdict.
    // If none is independent, fall back to the first non-judge oracle.
    const authoritative =
      nonJudgeOracles.find((o) => o.independent) ?? nonJudgeOracles[0];

    if (matches) {
      return { fixtureId: f.id, outcome: "pass", oracleId: authoritative.id };
    } else {
      // Map the oracle kind to the stage where the failure was caught.
      const caughtAtStage = oracleKindToStage(authoritative.kind);
      return {
        fixtureId: f.id,
        outcome: "fail",
        caughtAtStage,
        oracleId: authoritative.id,
      };
    }
  }

  // --- Judge-only case (advisory → abstain) --------------------------------
  if (judgeOracles.length > 0) {
    // Judge verdicts are recorded but never decide pass/fail alone.
    const judge = judgeOracles[0];
    return {
      fixtureId: f.id,
      outcome: "abstain",
      oracleId: judge.id,
    };
  }

  // No oracles at all — abstain.
  return { fixtureId: f.id, outcome: "abstain", oracleId: "none" };
}

/**
 * Map an oracle kind to the FailureStage taxonomy.  Used by gradeFixture to
 * record where in the pipeline a failure was caught.
 */
function oracleKindToStage(kind: Oracle["kind"]): FailureStage {
  switch (kind) {
    case "test-suite":
      return "tests";
    case "schema-validator":
      return "schema";
    case "snapshot-diff":
      return "tests";
    case "static-analyzer":
      return "preflight";
    case "judge-model":
      // Should not reach here (judge is advisory), but handle defensively.
      return "grader";
  }
}

// ---------------------------------------------------------------------------
// Full suite runner
// ---------------------------------------------------------------------------

/**
 * Run all four fixture kinds in the eval suite, grade each using `gradeFixture`,
 * and aggregate into `CalibratedMetrics` + `perFixtureResults`.
 *
 * @param suite        The parsed and validated EvalSuite.
 * @param runFixture   Injected executor: given a fixture (Fixture or
 *                     RetrievalFixture), returns the model/cell output.
 *                     For retrieval fixtures, the output should be a boolean
 *                     indicating whether the skill was selected.
 *                     This injection point is what makes the runner testable
 *                     without a real model.
 *
 * The caller is responsible for assembling the full ValidationRun (issue #79
 * schema) — this function only produces the metrics + perFixtureResults portion.
 */
export async function runEvalSuite(
  suite: EvalSuite,
  runFixture: (fixture: Fixture | RetrievalFixture) => Promise<unknown>,
): Promise<EvalSuiteRunResult> {
  // Runtime anti-Goodhart guard (mirrors schema .refine).
  assertIndependentOracle(suite);

  const perFixtureResults: PerFixtureResult[] = [];
  const durations: number[] = [];

  // Helper: run a Fixture and grade it.
  async function runAndGrade(f: Fixture): Promise<void> {
    const start = Date.now();
    const output = await runFixture(f);
    durations.push((Date.now() - start) / 1000);
    perFixtureResults.push(gradeFixture(f, output, suite.oracles));
  }

  // Helper: run a RetrievalFixture and grade it.
  async function runAndGradeRetrieval(rf: RetrievalFixture): Promise<void> {
    const start = Date.now();
    const output = await runFixture(rf);
    durations.push((Date.now() - start) / 1000);

    // Retrieval fixture: output is expected to be a boolean (selected / not selected).
    const selected = Boolean(output);
    const pass = selected === rf.shouldSelect;

    // Find the appropriate oracle for the verdict.
    const nonJudgeOracles = suite.oracles.filter((o) => o.kind !== "judge-model");
    const oracleId =
      (nonJudgeOracles.find((o) => o.independent) ?? nonJudgeOracles[0])?.id ??
      "none";

    if (pass) {
      perFixtureResults.push({ fixtureId: rf.id, outcome: "pass", oracleId });
    } else {
      perFixtureResults.push({
        fixtureId: rf.id,
        outcome: "fail",
        caughtAtStage: "retrieval",
        oracleId,
      });
    }
  }

  // Run all four fixture kinds sequentially (offline harness; no parallelism).
  for (const f of suite.fixtures.positive) {
    await runAndGrade(f);
  }
  for (const f of suite.fixtures.negative) {
    await runAndGrade(f);
  }
  for (const rf of suite.fixtures.retrieval) {
    await runAndGradeRetrieval(rf);
  }
  for (const f of suite.fixtures.mutation) {
    await runAndGrade(f);
  }

  // Aggregate metrics.
  const total = perFixtureResults.length;
  const passCount = perFixtureResults.filter((r) => r.outcome === "pass").length;
  const abstainCount = perFixtureResults.filter((r) => r.outcome === "abstain").length;
  const failResults = perFixtureResults.filter((r) => r.outcome === "fail");

  // Build failure-kind histogram.  Zod v4 z.record(enumSchema, ...) requires all
  // enum keys to be present — initialise every FailureKind to 0 first.
  const failureKindHistogram: Record<string, number> = {
    "retrieval-miss": 0,
    "classification-wrong": 0,
    preflight: 0,
    parser: 0,
    schema: 0,
    tests: 0,
    timeout: 0,
    grader: 0,
    delivery: 0,
    infra: 0,
  };
  for (const r of failResults) {
    // Map FailureStage → FailureKind (the two enums overlap partially but are
    // distinct).  FailureStage "retrieval" maps to FailureKind "retrieval-miss".
    const kind = stageToFailureKind(r.caughtAtStage ?? "grader");
    failureKindHistogram[kind] = (failureKindHistogram[kind] ?? 0) + 1;
  }

  // Duration percentiles (over all fixtures).
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const p50 = percentile(sortedDurations, 0.5);
  const p95 = percentile(sortedDurations, 0.95);

  const metrics = calibratedMetricsSchema.parse({
    passRate: total > 0 ? passCount / total : 0,
    sampleSize: total,
    p50DurationSeconds: p50,
    p95DurationSeconds: p95,
    failureKindHistogram,
    abstentionRate: total > 0 ? abstainCount / total : 0,
  });

  return { metrics, perFixtureResults };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Map a FailureStage value to the closest FailureKind for the metrics
 * histogram.  The two enums overlap but are distinct: FailureStage records
 * *where* a failure was caught in the pipeline; FailureKind labels the
 * category for routing/policy decisions.
 */
function stageToFailureKind(stage: FailureStage): string {
  switch (stage) {
    case "retrieval":
      return "retrieval-miss";
    case "classification":
      return "classification-wrong";
    case "preflight":
      return "preflight";
    case "parser":
      return "parser";
    case "schema":
      return "schema";
    case "tests":
      return "tests";
    case "timeout":
      return "timeout";
    case "grader":
      return "grader";
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[idx] ?? 0;
}
