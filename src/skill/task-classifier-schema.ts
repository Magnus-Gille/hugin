import { z } from "zod";
import { sha256HexSchema, sensitivitySchema } from "./refs.js";
import type { Sensitivity } from "./refs.js";

// Re-export Sensitivity so callers don't need two imports.
export type { Sensitivity };

/**
 * A single classification rule.
 *
 * `match` is treated as a **case-insensitive substring** against the prompt
 * text. This is deterministic, auditable, and requires no external dependencies.
 * Regex support is intentionally deferred (substring rules are sufficient for
 * slice-one and easier to author/review in YAML). The choice is documented here
 * so future authors know the contract: if you need regex, extend `kind` to
 * "regex" alongside "substring".
 */
export const ruleSchema = z.object({
  match: z.string().min(1),
  weight: z.number(),
});
export type Rule = z.infer<typeof ruleSchema>;

/**
 * The scoring predicate for a `TaskClassifier`.
 *
 * Design rationale — deterministic-first:
 * - `rule` predicates are fully deterministic (substring match, weighted sum).
 * - `llm-advisory+rule-floor` means an LLM judge may be consulted but the
 *   final decision still depends on at least one rule floor passing. The LLM
 *   is never the sole decision-maker (mirrors the A6 oracle rule in the eval
 *   suite: judge is advisory only).
 */
export const predicateSchema = z.object({
  kind: z.enum(["rule", "llm-advisory+rule-floor"]),
  rules: z.array(ruleSchema),
  /**
   * Minimum confidence (0..1) required to emit a `classified` result.
   * Below this → abstain with reason "below-threshold".
   */
  confidenceThreshold: z.number().min(0).max(1),
  /**
   * Minimum gap between top-1 and top-2 confidence scores required to
   * avoid "ambiguous-top-two" abstain. A task that fits two classes equally
   * well should never be silently assigned to either.
   */
  topTwoMargin: z.number().min(0).max(1),
});
export type Predicate = z.infer<typeof predicateSchema>;

/**
 * A `TaskClassifier` describes a single task class (e.g. "coding-task",
 * "documentation-task") and the predicate used to decide whether an incoming
 * task prompt belongs to it.
 *
 * Classifier artifacts are versioned, content-addressed, and stored in git at
 * `skills/_classifier/<classId>.yaml`. The runtime active pointer lives in
 * Munin at `routes/_classifier/<classId>/active`.
 *
 * SECURITY NOTE: `sensitivityCeiling` constrains, never raises. The router
 * ANDs this value with the cell trust ceiling and the task's independently-
 * computed effective sensitivity. See `effectiveSensitivityCeiling` in
 * `task-classifier.ts` for the enforcement point.
 */
export const taskClassifierSchema = z.object({
  schemaVersion: z.literal(1),
  classId: z.string().min(1),
  version: z.number().int().nonnegative(),
  /**
   * Content hash (sha256 hex, 64 chars) of the classifier body. Stored in the
   * Munin active pointer so the router can detect drift without re-fetching the
   * full object. Computed by `classifierHash()` in `task-classifier.ts`.
   */
  classifierHash: sha256HexSchema,
  predicate: predicateSchema,
  /**
   * Hard-negative examples: prompts that superficially look like they belong to
   * this class but must NOT be classified to it. Any matching hard-negative
   * zeroes the classifier's score for that prompt.
   *
   * At least one is required — a classifier with no hard negatives has not
   * thought about its own failure modes.
   */
  hardNegatives: z.array(
    z.object({ input: z.string(), why: z.string() })
  ).min(1),
  /**
   * Free-text contraindications: phrases whose presence in the prompt disqualify
   * the classifier (e.g. "read-only analysis", "do not write code").
   * Unlike hardNegatives, contraindications are simple substrings with no `why`.
   */
  contraindications: z.array(z.string()),
  /** Positive examples — at least one prompt that MUST classify to this class. */
  shouldClassify: z.array(z.object({ input: z.string() })).min(1),
  /** Negative examples — at least one prompt that must NOT classify to this class. */
  shouldNotClassify: z.array(z.object({ input: z.string() })).min(1),
  /**
   * Maximum sensitivity level this class may carry to the local cell.
   * The router takes min(this, cellTrustCeiling, taskEffectiveSensitivity).
   * A classifier can only restrict what the bound cell receives — it can never
   * widen the sensitivity lattice.
   */
  sensitivityCeiling: sensitivitySchema,
});
export type TaskClassifier = z.infer<typeof taskClassifierSchema>;

/**
 * The result of `classifyTask`.
 *
 * `classified` — a confident, unambiguous match to exactly one class.
 * `abstain`    — no class was selected; reason tells the router why:
 *   - `below-threshold`: top score is below the winning classifier's threshold.
 *   - `ambiguous-top-two`: top-2 scores are within `topTwoMargin` of each other.
 *
 * Abstain is **fail-closed**: no class → no local route → fall through to the
 * existing cloud auto-router.
 */
export type ClassifyResult =
  | { kind: "classified"; classId: string; confidence: number }
  | { kind: "abstain"; reason: "below-threshold" | "ambiguous-top-two" };
