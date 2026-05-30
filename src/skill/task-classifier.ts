/**
 * TaskClassifier runtime logic — pure, deterministic-first.
 *
 * This module implements the A5 / #82 task-classification contract from the
 * skill-distillation design spec. Classification is SECURITY-LOAD-BEARING:
 * the class assigned to a task is the key into routing, sensitivity policy,
 * and local-cell dispatch. See the "Security interaction (must hold)" section
 * of docs/design/skill-distillation-implementation.md for the invariants.
 */

import { taskClassifierSchema, type TaskClassifier, type ClassifyResult } from "./task-classifier-schema.js";
import { contentHash } from "./refs.js";
import type { Sensitivity } from "./refs.js";
import type { MuninClient } from "../munin-client.js";

// Sensitivity ordering for min() computation.
const SENSITIVITY_ORDER: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  private: 2,
};

const ORDER_TO_SENSITIVITY: Sensitivity[] = ["public", "internal", "private"];

function sensitivityMin(a: Sensitivity, b: Sensitivity): Sensitivity {
  return ORDER_TO_SENSITIVITY[Math.min(SENSITIVITY_ORDER[a], SENSITIVITY_ORDER[b])];
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a hard-negative or contraindication matches the prompt.
 * Uses the same case-insensitive substring strategy as the rule engine so
 * the exclusion contract is symmetric with the scoring contract.
 */
function anySubstringMatch(prompt: string, patterns: string[]): boolean {
  const lower = prompt.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

/**
 * Score a single classifier against a prompt.
 *
 * Algorithm (deterministic-first):
 * 1. Check hard negatives: if any `hardNegative.input` is a case-insensitive
 *    substring of the prompt → score is 0 (classifier is excluded).
 * 2. Check contraindications: if any contraindication phrase is a case-insensitive
 *    substring of the prompt → score is 0.
 * 3. Sum weights of rules whose `match` is a case-insensitive substring of the
 *    prompt. Normalize to 0..1 by dividing by the sum of all rule weights.
 *    If total weight is 0 (no rules at all) → score is 0.
 *
 * Match strategy: **case-insensitive substring** (not regex). Documented in
 * task-classifier-schema.ts. Deterministic, auditable, no external deps.
 */
function scoreClassifier(prompt: string, classifier: TaskClassifier): number {
  // Hard-negative exclusion (takes priority over any rule match)
  const hardNegativeInputs = classifier.hardNegatives.map((hn) => hn.input);
  if (anySubstringMatch(prompt, hardNegativeInputs)) {
    return 0;
  }

  // Contraindication exclusion
  if (classifier.contraindications.length > 0 &&
      anySubstringMatch(prompt, classifier.contraindications)) {
    return 0;
  }

  // Rule scoring: sum matching weights, normalize by total weight
  const totalWeight = classifier.predicate.rules.reduce((sum, r) => sum + r.weight, 0);
  if (totalWeight === 0) return 0;

  const lowerPrompt = prompt.toLowerCase();
  const matchedWeight = classifier.predicate.rules.reduce((sum, r) => {
    return lowerPrompt.includes(r.match.toLowerCase()) ? sum + r.weight : sum;
  }, 0);

  return matchedWeight / totalWeight;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a prompt against a set of classifiers. Pure and deterministic.
 *
 * Fail-closed: any ambiguity or insufficient confidence returns an `abstain`
 * result. The caller (the router) must treat `abstain` as "no local route" and
 * fall through to the existing cloud auto-router.
 *
 * Decision procedure:
 * 1. Score every classifier (0..1).
 * 2. Sort descending by score; pick top-1 and top-2.
 * 3. If top-1 score < top-1 classifier's `confidenceThreshold` → abstain
 *    with reason "below-threshold".
 * 4. If top-1 and top-2 both exist and (top1 − top2) < top-1's `topTwoMargin`
 *    → abstain with reason "ambiguous-top-two".
 * 5. Otherwise emit `classified` with top-1's classId and confidence.
 */
export function classifyTask(
  prompt: string,
  classifiers: TaskClassifier[],
): ClassifyResult {
  if (classifiers.length === 0) {
    return { kind: "abstain", reason: "below-threshold" };
  }

  // Score all classifiers
  const scores = classifiers.map((c) => ({
    classId: c.classId,
    confidence: scoreClassifier(prompt, c),
    threshold: c.predicate.confidenceThreshold,
    margin: c.predicate.topTwoMargin,
  }));

  // Sort descending by confidence
  scores.sort((a, b) => b.confidence - a.confidence);

  const top = scores[0];
  const second = scores[1];

  // Below-threshold check
  if (top.confidence < top.threshold) {
    return { kind: "abstain", reason: "below-threshold" };
  }

  // Ambiguous-top-two check (only when a second candidate exists with score > 0)
  if (second !== undefined && second.confidence > 0) {
    const gap = top.confidence - second.confidence;
    if (gap < top.margin) {
      return { kind: "abstain", reason: "ambiguous-top-two" };
    }
  }

  return { kind: "classified", classId: top.classId, confidence: top.confidence };
}

/**
 * Compute the content hash (sha256 hex) for a classifier object.
 * Uses canonical JSON (key-sorted, no whitespace) so the hash is stable
 * regardless of property insertion order in the caller's object literal.
 *
 * This value is stored in the Munin active pointer; the router checks it on
 * every poll cycle to detect drift between the live classifier and the cached
 * version. Any change to the classifier body produces a different hash →
 * the router fail-closes the binding to `stale`.
 */
export function classifierHash(c: TaskClassifier): string {
  return contentHash(c);
}

/**
 * Compute the effective sensitivity ceiling for a local-cell route attempt.
 *
 * SECURITY INVARIANT: This function can only CONSTRAIN, never raise.
 * It returns `min(classifierCeiling, cellTrustCeiling, taskEffectiveSensitivity)`
 * on the public < internal < private lattice.
 *
 * Why this matters:
 * - The classifier selects *which procedure* the task follows. It does NOT get
 *   to override the sensitivity lattice.
 * - A misclassification (e.g. classifier incorrectly lowers apparent sensitivity)
 *   is caught by this function: the task's independently-computed
 *   `taskEffectiveSensitivity` (from `sensitivity.ts`) is always in the AND.
 * - Cloud cells that are `internal`-trust cannot receive `private` tasks even if
 *   the classifier declares its ceiling as `private`.
 *
 * The three inputs are kept as separate parameters (not a single array) to make
 * their origin explicit at the call site — callers cannot accidentally omit the
 * task-level sensitivity by passing a short array.
 */
export function effectiveSensitivityCeiling(
  classifierCeiling: Sensitivity,
  cellTrustCeiling: Sensitivity,
  taskEffectiveSensitivity: Sensitivity,
): Sensitivity {
  return sensitivityMin(
    sensitivityMin(classifierCeiling, cellTrustCeiling),
    taskEffectiveSensitivity,
  );
}

/**
 * Load active classifiers from Munin.
 *
 * Reads all entries in the `routes/_classifier/` namespace tagged `active`,
 * fetches full content for each via `readBatch`, parses as a `TaskClassifier`,
 * and returns the valid ones. Invalid entries (schema parse failure) are skipped
 * with a warning — a single malformed classifier must not block all routing.
 *
 * Munin `query` returns only `content_preview`; full content requires a
 * separate `readBatch` call using the (namespace, key) pairs.
 *
 * Munin key convention: `routes/_classifier/<classId>/active`
 */
export async function loadActiveClassifiers(
  munin: MuninClient,
): Promise<TaskClassifier[]> {
  let queryResults;
  try {
    const resp = await munin.query({
      query: "",
      namespace: "routes/_classifier",
      tags: ["active"],
    });
    queryResults = resp.results;
  } catch (err) {
    // Munin unreachable: fail-closed (no classifiers → no local route)
    console.warn("[task-classifier] loadActiveClassifiers: Munin query failed:", err);
    return [];
  }

  if (queryResults.length === 0) return [];

  // Fetch full content for each result (query only returns content_preview).
  const keyed = queryResults.filter((r) => r.key !== null);
  let fullEntries;
  try {
    fullEntries = await munin.readBatch(
      keyed.map((r) => ({ namespace: r.namespace, key: r.key as string })),
    );
  } catch (err) {
    console.warn("[task-classifier] loadActiveClassifiers: Munin readBatch failed:", err);
    return [];
  }

  const classifiers: TaskClassifier[] = [];
  for (const entry of fullEntries) {
    if (!entry.found) {
      console.warn(
        `[task-classifier] Classifier entry not found: ${entry.namespace}/${entry.key}`,
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.content);
    } catch {
      console.warn(
        `[task-classifier] Skipping unparseable entry ${entry.namespace}/${entry.key}`,
      );
      continue;
    }

    const result = taskClassifierSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(
        `[task-classifier] Skipping invalid classifier at ${entry.namespace}/${entry.key}:`,
        result.error.issues.map((i) => i.message).join("; "),
      );
      continue;
    }

    classifiers.push(result.data);
  }

  return classifiers;
}
