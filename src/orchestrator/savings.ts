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
  /** baselineCostUsd - actualCostUsd, summed over covered calls only. */
  savedUsd: number;
  byModel: Record<string, ModelSavingsBucket>;
}

const EMPTY_BUCKET: ModelSavingsBucket = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  actualCostUsd: 0,
  baselineCostUsd: 0,
};

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
 *
 * Pure function — no I/O, no clock.
 */
export function computeSavings(
  calls: ModelCallRecord[],
  baselineModelId: string,
): SavingsSummary | null {
  if (!getModelPrice(baselineModelId)) return null;

  let coveredCalls = 0;
  let uncoveredCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let actualCostUsd = 0;
  let baselineCostUsd = 0;
  const byModel: Record<string, ModelSavingsBucket> = {};

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
    byModel,
  };
}
