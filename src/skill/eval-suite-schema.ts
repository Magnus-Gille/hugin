/**
 * eval-suite-schema.ts — EvalSuite, Oracle, Fixture, RetrievalFixture Zod
 * schemas for issue #83 (A6: eval-suite format with independent oracle +
 * immutable validation runs).
 *
 * Anti-Goodhart rules enforced here:
 *   1. At least one oracle must have `independent: true` (schema .refine).
 *   2. `judgeIsAdvisoryOnly` is z.literal(true) — a plain boolean would let
 *      a false value through at parse time.
 *   3. All four fixture kinds require .min(1): positive, negative, retrieval,
 *      mutation.  A missing kind is a parse error, not a runtime warn.
 */

import { z } from "zod";
import {
  sha256HexSchema,
  failureStageSchema,    // re-exported for callers that only import eval-suite
} from "./refs.js";

export { failureStageSchema };

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

export const oracleSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "test-suite",
    "schema-validator",
    "snapshot-diff",
    "static-analyzer",
    "judge-model",
  ]),
  /**
   * true  = this oracle was NOT authored by the skill author and is NOT the
   *         skill's own grader — it provides independent evidence.
   * false = the oracle is authored by the same party that wrote the skill.
   *
   * At least one oracle with independent: true is required by the evalSuiteSchema
   * .refine so that a frontier-authored skill+grader cannot become a rubber stamp.
   */
  independent: z.boolean(),
  /** Path, command, or module reference that locates the oracle implementation. */
  ref: z.string().min(1),
});
export type Oracle = z.infer<typeof oracleSchema>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const fixtureSchema = z.object({
  id: z.string().min(1),
  input: z.unknown(),
  expected: z.unknown(),
  /**
   * List of field paths or aspects the grader is allowed to ignore due to
   * known non-determinism (e.g. timestamps, UUIDs).  Defaults to [].
   */
  allowedNondeterminism: z.array(z.string()).default([]),
});
export type Fixture = z.infer<typeof fixtureSchema>;

export const retrievalFixtureSchema = z.object({
  id: z.string().min(1),
  input: z.string(),
  /**
   * true  = the retrieval step SHOULD select this skill for this input.
   * false = hard-negative: the retrieval step must NOT select this skill.
   */
  shouldSelect: z.boolean(),
});
export type RetrievalFixture = z.infer<typeof retrievalFixtureSchema>;

// ---------------------------------------------------------------------------
// EvalSuite
// ---------------------------------------------------------------------------

export const evalSuiteSchema = z
  .object({
    schemaVersion: z.literal(1),
    evalSuiteId: z.string().min(1),
    /** SHA-256 content hash of this eval suite (content-addressed). */
    evalSuiteHash: sha256HexSchema,
    skillId: z.string().min(1),
    taskClassId: z.string().min(1),
    /**
     * Anti-Goodhart rule 1: at least one oracle must have independent: true.
     * Enforced via .refine so that a suite authored entirely by the skill
     * author cannot be used as standalone validation evidence.
     */
    oracles: z.array(oracleSchema).refine(
      (oracles) => oracles.some((o) => o.independent),
      { message: "at least one independent oracle required" },
    ),
    /**
     * Anti-Goodhart rule 2: LLM-judge results are recorded but never decide
     * pass/fail alone.  z.literal(true) makes it impossible to parse a suite
     * where this safety invariant is false.
     */
    judgeIsAdvisoryOnly: z.literal(true),
    fixtures: z.object({
      /** In-class inputs that must pass. */
      positive: z.array(fixtureSchema).min(1),
      /** In-class inputs the skill should fail or abort cleanly on. */
      negative: z.array(fixtureSchema).min(1),
      /**
       * Retrieval fixtures: should/should-not be selected by the retrieval
       * step.  Hard-negative cases catch overfit retrieval.
       */
      retrieval: z.array(retrievalFixtureSchema).min(1),
      /**
       * Perturbed inputs that catch overfit graders.  A grader that can't
       * distinguish a mutation from a clean pass is not testing the skill.
       */
      mutation: z.array(fixtureSchema).min(1),
    }),
  })
  .strict();

export type EvalSuite = z.infer<typeof evalSuiteSchema>;
