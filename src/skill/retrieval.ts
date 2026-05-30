/**
 * Procedural retrieval with a fail-closed abstention contract (A4 / #81).
 *
 * Security contract — the default is NEVER run local:
 *
 *   1. Munin unreachable (health() false OR any read/query throws)
 *      → kind: "unavailable", reason: "munin-down"
 *
 *   2. A candidate's hardNegatives contains the task promptDigest
 *      → candidate DROPPED before scoring (not just penalised).
 *
 *   3. Top candidate score < confidenceThreshold
 *      → kind: "abstain", reason: "below-threshold"
 *
 *   4. (top1 score) − (top2 score) < topTwoMarginThreshold
 *      → kind: "abstain", reason: "ambiguous-top-two"
 *
 *   5. Selected row's bindingState !== "active"
 *      → kind: "not-selectable", reason: "stale-or-quarantined"
 *
 *   6. Otherwise → kind: "selected"
 *
 * Scoring (documented):
 *   Retrieval rows are scored by the Munin query relevance score when the
 *   server provides it (non-zero `score` field on `MuninQueryResult`).
 *   When the score is absent or zero, a deterministic trigger-phrase match
 *   score is used: (number of triggerPhrases that appear as substrings of
 *   the lowercased promptDigest) / (total triggerPhrases).  This gives a
 *   score in [0, 1] with the same semantics as the Munin score; it is
 *   intentionally simple and deterministic so that tests do not depend on
 *   Munin's internal ranking.  `evalConfidence` is NOT used as a score
 *   tiebreaker — it is a per-row quality gate applied later (step 3 above
 *   compares against it).
 *
 * All outcomes (including abstentions) should be recorded in the
 * RouteDecision by the caller.
 */

import type { MuninClient, MuninQueryResult } from "../munin-client.js";
import {
  proceduralRetrievalRowSchema,
  type ProceduralRetrievalRow,
} from "./retrieval-schema.js";
import type { Sensitivity } from "./refs.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface RetrievalConfig {
  /** Minimum score for the top candidate to be selected. Default: abstain. */
  confidenceThreshold: number;
  /**
   * Minimum required gap between the top-1 and top-2 scores.
   * If top1 − top2 < topTwoMarginThreshold the result is ambiguous.
   */
  topTwoMarginThreshold: number;
}

export type RetrievalOutcome =
  | { kind: "selected"; row: ProceduralRetrievalRow; score: number }
  | { kind: "abstain"; reason: "below-threshold" | "ambiguous-top-two" }
  | { kind: "unavailable"; reason: "munin-down" }
  | { kind: "not-selectable"; reason: "stale-or-quarantined" };

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Parse a Munin query result into a ProceduralRetrievalRow.
 * Returns null if the content cannot be parsed or fails schema validation.
 */
function parseRow(result: MuninQueryResult): ProceduralRetrievalRow | null {
  try {
    const parsed = JSON.parse(result.content_preview);
    const validation = proceduralRetrievalRowSchema.safeParse(parsed);
    return validation.success ? validation.data : null;
  } catch {
    return null;
  }
}

/**
 * Compute a deterministic trigger-phrase match score in [0, 1].
 *
 * The promptDigest is lowercased and each trigger phrase is checked as a
 * substring.  score = matched / total.  Returns 0 when triggerPhrases is
 * empty (which the schema prevents in practice).
 */
function triggerPhraseScore(
  promptDigest: string,
  triggerPhrases: readonly string[],
): number {
  if (triggerPhrases.length === 0) return 0;
  const lower = promptDigest.toLowerCase();
  let matched = 0;
  for (const phrase of triggerPhrases) {
    if (lower.includes(phrase.toLowerCase())) {
      matched++;
    }
  }
  return matched / triggerPhrases.length;
}

/**
 * Score a candidate row.  Uses the Munin-provided query score when non-zero;
 * falls back to trigger-phrase matching otherwise.
 */
function scoreCandidate(
  result: MuninQueryResult,
  row: ProceduralRetrievalRow,
  promptDigest: string,
): number {
  // Munin query results carry a relevance score.  Use it when available.
  // The score field is not part of the documented MuninQueryResult interface
  // but Munin may include it as an extra property.
  const muninScore = (result as MuninQueryResult & { score?: number }).score;
  if (typeof muninScore === "number" && muninScore > 0) {
    return muninScore;
  }
  return triggerPhraseScore(promptDigest, row.triggerPhrases);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Retrieve the best procedural skill for `task`, applying the fail-closed
 * abstention contract.
 *
 * @param task         The incoming task's digest + class + sensitivity.
 * @param munin        Munin client (injected; tests use a fake).
 * @param cfg          Confidence and margin thresholds.
 */
export async function retrieveProcedure(
  task: {
    promptDigest: string;
    taskClassId: string;
    sensitivity: Sensitivity;
  },
  munin: MuninClient,
  cfg: RetrievalConfig,
): Promise<RetrievalOutcome> {

  // ── Step 1: Check Munin health ─────────────────────────────────────────────
  // Fail-closed: any infrastructure issue → munin-down.
  let healthy: boolean;
  try {
    healthy = await munin.health();
  } catch {
    return { kind: "unavailable", reason: "munin-down" };
  }
  if (!healthy) {
    return { kind: "unavailable", reason: "munin-down" };
  }

  // ── Step 2: Query retrieval rows for this task class ───────────────────────
  // Server-side tag filter keeps the candidate set small.
  let queryResult: { results: MuninQueryResult[]; total: number };
  try {
    queryResult = await munin.query({
      query: task.promptDigest,
      namespace: "skills",
      tags: [`task-class:${task.taskClassId}`, "procedural-retrieval"],
    });
  } catch {
    return { kind: "unavailable", reason: "munin-down" };
  }

  // ── Step 3: Parse rows and apply hard-negative exclusion ──────────────────
  // A candidate whose hardNegatives contains the promptDigest is DROPPED
  // entirely — not penalised in score, completely removed from the set.
  type ScoredCandidate = { row: ProceduralRetrievalRow; score: number };
  const candidates: ScoredCandidate[] = [];

  for (const result of queryResult.results) {
    const row = parseRow(result);
    if (row === null) continue;

    // Hard-negative exclusion (security-load-bearing).
    const isHardNegative = row.hardNegatives.some(
      (neg) => neg === task.promptDigest,
    );
    if (isHardNegative) continue;

    const score = scoreCandidate(result, row, task.promptDigest);
    candidates.push({ row, score });
  }

  // ── Step 4: No candidates → below-threshold ───────────────────────────────
  if (candidates.length === 0) {
    return { kind: "abstain", reason: "below-threshold" };
  }

  // ── Step 5: Sort descending by score ──────────────────────────────────────
  candidates.sort((a, b) => b.score - a.score);
  const top1 = candidates[0]!;
  const top2 = candidates[1];

  // ── Step 6: Confidence threshold check ────────────────────────────────────
  if (top1.score < cfg.confidenceThreshold) {
    return { kind: "abstain", reason: "below-threshold" };
  }

  // ── Step 7: Top-two margin check ──────────────────────────────────────────
  if (top2 !== undefined) {
    const margin = top1.score - top2.score;
    if (margin < cfg.topTwoMarginThreshold) {
      return { kind: "abstain", reason: "ambiguous-top-two" };
    }
  }

  // ── Step 8: Binding state check (fail-closed) ─────────────────────────────
  if (top1.row.bindingState !== "active") {
    return { kind: "not-selectable", reason: "stale-or-quarantined" };
  }

  // ── Step 9: Selected ──────────────────────────────────────────────────────
  return { kind: "selected", row: top1.row, score: top1.score };
}
