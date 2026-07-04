/**
 * Orchestrator savings tracker — pure computation layer (PR3, S2).
 *
 * See docs/orchestrator-savings-tracker.md. Computes, for one run's worth of
 * ModelCallRecords (engine.ts), what that run would have cost on an all-Claude
 * baseline vs what it actually cost — apples-to-apples, per call, never from
 * `totalCostUsd` (which is all-or-nothing-null: one unknown-cost call nulls
 * the whole run total, which would skip savings on any run with a failed
 * worker). No I/O — this module is pure.
 */

import type { ModelCallRecord } from "./engine.js";
import { estimateCostUsd, getModelPrice } from "../model-pricing.js";

/** Per-model aggregate bucket, keyed `provider|model` in SavingsSummary.byModel. */
export interface ModelSavingsBucket {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  actualCostUsd: number;
  baselineCostUsd: number;
}

/**
 * Verdict outcome joined onto a subtask's savings (issue #144). Mirrors the
 * verdict layer's VerdictEvent taxonomy, viewed from the savings side:
 *   - "pass"      — worker output VERIFIED as correct.
 *   - "fail"      — worker output verified as WRONG.
 *   - "unknown"   — worker succeeded but was never verified (adaptive-verify
 *                   skip, verifier call failure, or unparseable verdict).
 *   - "error"     — the worker call itself failed (infra).
 *   - "escalated" — the subtask was re-run on a stronger tier because the
 *                   local attempt failed. The engine has no escalation path
 *                   yet; the outcome exists so escalation costs land here
 *                   (attributed to the causing local attempt via subtaskId)
 *                   the day it does, instead of forcing a schema change.
 */
export type SavingsVerdictOutcome = "pass" | "fail" | "unknown" | "error" | "escalated";

/**
 * Per-verdict-outcome aggregate over COVERED subtask-attributed calls
 * (worker + verifier calls carrying a `subtaskId`; planner/synthesizer calls
 * are run-level and never appear here). `qaBaselineCreditUsd` is the baseline
 * credit granted under the quality-adjusted rules — see computeSavings.
 */
export interface OutcomeSavingsBucket {
  calls: number;
  actualCostUsd: number;
  baselineCostUsd: number;
  qaBaselineCreditUsd: number;
}

export interface SavingsSummary {
  baselineModelId: string;
  /** Calls with both token counts known AND a resolvable actual price. */
  coveredCalls: number;
  /** Calls missing tokens or an actual price — counted, never guessed. */
  uncoveredCalls: number;
  /** Token totals across COVERED calls only. */
  inputTokens: number;
  outputTokens: number;
  /** Sum of actual cost across COVERED calls only. */
  actualCostUsd: number;
  /** Sum of the baseline-priced cost (same token volume) across COVERED calls. */
  baselineCostUsd: number;
  /** baselineCostUsd - actualCostUsd, summed over covered calls only. RAW series — see qualityAdjustedSavedUsd. */
  savedUsd: number;
  /**
   * Baseline credit actually EARNED under the quality-adjusted rules (issue
   * #144), summed over covered calls. Always >= 0; equals baselineCostUsd
   * when every subtask passed (or was trusted-unverified) and nothing was
   * verified. See computeSavings for the per-call credit rules.
   */
  qaBaselineCreditUsd: number;
  /**
   * The HEADLINE savings number (issue #144): qaBaselineCreditUsd −
   * actualCostUsd. Unlike `savedUsd` (the raw series, kept for
   * comparability), this cannot reward cheap-but-wrong: a subtask that
   * failed verification earns no baseline credit — its spend (worker AND
   * verifier) books as a loss — and verification cost is attributed back to
   * the local attempt that caused it. Can be negative. Any consumer using
   * savings for DECISIONS must read this series, never `savedUsd` (see
   * src/orchestrator/README.md).
   */
  qualityAdjustedSavedUsd: number;
  byModel: Record<string, ModelSavingsBucket>;
  /**
   * Covered subtask-attributed calls grouped by their subtask's verdict
   * outcome (issue #144). Sparse — only outcomes that occurred appear.
   */
  byOutcome: Partial<Record<SavingsVerdictOutcome, OutcomeSavingsBucket>>;
}

const EMPTY_BUCKET: ModelSavingsBucket = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  actualCostUsd: 0,
  baselineCostUsd: 0,
};

/**
 * Quality-adjusted baseline credit for one covered call (issue #144).
 *
 * The raw series grants every covered call `baseline` credit — which is what
 * lets cheap-but-wrong book as savings. The quality-adjusted series grants
 * credit only where the baseline cost was ACTUALLY avoided:
 *
 *   - Run-level calls (no subtaskId — planner/synthesizer): full baseline
 *     credit, same as raw. Their output is used regardless of any subtask's
 *     verdict.
 *   - Verifier calls: ZERO credit, always. The all-Claude counterfactual
 *     doesn't verify — verification is overhead CAUSED by delegating to a
 *     cheap model, so its full cost is attributed back to the local attempt
 *     (never booked as neutral independent frontier spend).
 *   - A call that itself failed (ok: false): zero credit — spend with no
 *     usable output.
 *   - Worker calls whose subtask verdict is "fail" / "error" / "escalated":
 *     zero credit. The work still has to be done at the frontier, so no
 *     baseline cost was avoided; the local spend books as a loss.
 *   - Worker calls whose subtask verdict is "pass" or "unknown": full
 *     baseline credit. "unknown" (unverified) is trusted here because the
 *     adaptive-verify gate only skips verification for rows with an
 *     evidence-based "delegate-local" recommendation (and re-probes them) —
 *     but it is surfaced separately in byOutcome so consumers can discount it.
 */
function qaCreditForCall(
  call: ModelCallRecord,
  baseline: number,
  outcome: SavingsVerdictOutcome | null,
): number {
  if (!call.ok) return 0;
  if (call.role === "verifier") return 0;
  if (outcome === null) return baseline; // run-level (planner/synthesizer)
  if (outcome === "pass" || outcome === "unknown") return baseline;
  return 0; // fail | error | escalated
}

/**
 * Compute a run's savings vs `baselineModelId` from its per-call ledger.
 *
 * Returns `null` when the baseline model itself isn't in MODEL_PRICING —
 * savings tracking is disabled for the run rather than guessing at a price
 * (S2/S5). Callers should log this once, not per call.
 *
 * For each call:
 *   - Missing either token count → uncovered (never guessed).
 *   - `actual = call.costUsd ?? estimateCostUsd(call.model, in, out)`; if that
 *     is still null (call.model unpriced AND call.costUsd absent) → uncovered.
 *   - `baseline = estimateCostUsd(baselineModelId, in, out)` — priced on the
 *     SAME token volume the call actually used (a conservative, honest
 *     counterfactual; no attempt to model that Claude might have used fewer
 *     tokens).
 *   - `savedUsd += baseline - actual`, accumulated only over covered calls.
 *   - `qualityAdjustedSavedUsd += qaCredit - actual` where qaCredit joins the
 *     call to its subtask's verdict outcome via `verdictBySubtask` (issue
 *     #144 — see qaCreditForCall). A subtask-attributed call whose id is
 *     missing from the map counts as "unknown"; when no map is supplied at
 *     all, every subtask outcome is "unknown" (verifier calls still earn
 *     zero credit).
 *
 * Pure function — no I/O, no clock.
 */
export function computeSavings(
  calls: ModelCallRecord[],
  baselineModelId: string,
  verdictBySubtask?: Record<string, SavingsVerdictOutcome>,
): SavingsSummary | null {
  if (!getModelPrice(baselineModelId)) return null;

  let coveredCalls = 0;
  let uncoveredCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let actualCostUsd = 0;
  let baselineCostUsd = 0;
  let qaBaselineCreditUsd = 0;
  const byModel: Record<string, ModelSavingsBucket> = {};
  const byOutcome: Partial<Record<SavingsVerdictOutcome, OutcomeSavingsBucket>> = {};

  for (const call of calls) {
    // Guard against `undefined` as well as `null`: some WorkerResult call
    // sites (and older/partial test doubles) omit these fields entirely
    // rather than setting them to null. Token counts must be nonnegative
    // INTEGERS (the store and structured-result schema both require it) —
    // anything else is uncovered, never guessed.
    const inTok = call.inputTokens;
    const outTok = call.outputTokens;
    if (
      typeof inTok !== "number" ||
      !Number.isInteger(inTok) ||
      inTok < 0 ||
      typeof outTok !== "number" ||
      !Number.isInteger(outTok) ||
      outTok < 0
    ) {
      uncoveredCalls++;
      continue;
    }

    const actual = call.costUsd ?? estimateCostUsd(call.model, inTok, outTok);
    if (actual === null) {
      uncoveredCalls++;
      continue;
    }

    const baseline = estimateCostUsd(baselineModelId, inTok, outTok);
    if (baseline === null) {
      // Shouldn't happen (baseline price was checked above), but stay honest
      // rather than silently trusting an unpriced baseline.
      uncoveredCalls++;
      continue;
    }

    coveredCalls++;
    inputTokens += inTok;
    outputTokens += outTok;
    actualCostUsd += actual;
    baselineCostUsd += baseline;

    // Quality-adjusted join (issue #144): resolve the call's subtask verdict
    // outcome, grant credit per qaCreditForCall, and bucket subtask-attributed
    // calls by outcome.
    const outcome: SavingsVerdictOutcome | null =
      call.subtaskId !== undefined
        ? (verdictBySubtask?.[call.subtaskId] ?? "unknown")
        : null;
    const qaCredit = qaCreditForCall(call, baseline, outcome);
    qaBaselineCreditUsd += qaCredit;
    if (outcome !== null) {
      const existing = byOutcome[outcome] ?? {
        calls: 0,
        actualCostUsd: 0,
        baselineCostUsd: 0,
        qaBaselineCreditUsd: 0,
      };
      byOutcome[outcome] = {
        calls: existing.calls + 1,
        actualCostUsd: existing.actualCostUsd + actual,
        baselineCostUsd: existing.baselineCostUsd + baseline,
        qaBaselineCreditUsd: existing.qaBaselineCreditUsd + qaCredit,
      };
    }

    const key = `${call.provider}|${call.model}`;
    const bucket = byModel[key] ?? { ...EMPTY_BUCKET };
    byModel[key] = {
      calls: bucket.calls + 1,
      inputTokens: bucket.inputTokens + inTok,
      outputTokens: bucket.outputTokens + outTok,
      actualCostUsd: bucket.actualCostUsd + actual,
      baselineCostUsd: bucket.baselineCostUsd + baseline,
    };
  }

  return {
    baselineModelId,
    coveredCalls,
    uncoveredCalls,
    inputTokens,
    outputTokens,
    actualCostUsd,
    baselineCostUsd,
    savedUsd: baselineCostUsd - actualCostUsd,
    qaBaselineCreditUsd,
    qualityAdjustedSavedUsd: qaBaselineCreditUsd - actualCostUsd,
    byModel,
    byOutcome,
  };
}
