/**
 * Span-level scoring for the OPF evaluation harness (#56).
 *
 * Given gold (labelled) spans and predicted spans for a set of examples,
 * compute precision / recall / F1 under three matching regimes:
 *
 *   - "exact"     — same label AND identical [start, end).
 *   - "relaxed"   — same label AND any character overlap (≥1 char).
 *   - "detection" — label-agnostic: any character overlap. Answers the
 *                   leak-prevention question "did we notice PII is here at
 *                   all?", which is the metric that matters most before a
 *                   cloud call (a missed span = a leak, regardless of type).
 *
 * Matching is greedy 1:1 (each gold span consumes at most one predicted span
 * and vice-versa) so overlapping predictions can't inflate recall.
 *
 * Also reports false-positive load on *clean* examples (no gold spans): the
 * fraction of clean examples that get any prediction, and the total spurious
 * span count. Over-redaction on clean technical content (code, logs) is the
 * other side of the accuracy story — see the design doc's decision criteria.
 *
 * Pure functions, no I/O.
 */

import type { LabelledExample, PiiLabel, PiiSpan } from "./pii-types.js";
import { PII_LABELS } from "./pii-types.js";

export type MatchMode = "exact" | "relaxed" | "detection";

export interface PrfCounts {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

export interface PrfMetrics extends PrfCounts {
  precision: number;
  recall: number;
  f1: number;
}

export interface PerLabelMetrics {
  label: PiiLabel;
  metrics: PrfMetrics;
}

export interface FalsePositiveLoad {
  /** Number of examples with zero gold spans. */
  cleanExamples: number;
  /** Clean examples that received ≥1 predicted span. */
  cleanExamplesWithPredictions: number;
  /** Total predicted spans across all clean examples. */
  spuriousSpans: number;
  /** spuriousSpans normalized per clean example. */
  spuriousSpansPerExample: number;
  /** cleanExamplesWithPredictions / cleanExamples. */
  contaminationRate: number;
}

export interface ScoreReport {
  detector: string;
  examples: number;
  /** Micro-averaged P/R/F1 over all spans, per match mode. */
  micro: Record<MatchMode, PrfMetrics>;
  /** Macro-averaged F1 (unweighted mean of per-label F1) for the typed modes. */
  macro: Record<"exact" | "relaxed", { f1: number }>;
  /** Per-label metrics under relaxed matching (the fair typed view). */
  perLabel: PerLabelMetrics[];
  falsePositives: FalsePositiveLoad;
}

/** A detector's spans for a single example, paired with that example. */
export interface ExamplePrediction {
  example: LabelledExample;
  predicted: PiiSpan[];
}

function overlaps(a: PiiSpan, b: PiiSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

function sameSpan(a: PiiSpan, b: PiiSpan): boolean {
  return a.start === b.start && a.end === b.end;
}

function matches(gold: PiiSpan, pred: PiiSpan, mode: MatchMode): boolean {
  switch (mode) {
    case "exact":
      return gold.label === pred.label && sameSpan(gold, pred);
    case "relaxed":
      return gold.label === pred.label && overlaps(gold, pred);
    case "detection":
      return overlaps(gold, pred);
  }
}

/**
 * Greedy 1:1 matching of predicted spans to gold spans for one example.
 * Returns the TP/FP/FN counts. Gold spans are matched in ascending offset
 * order; the first unconsumed predicted span that satisfies `matches` wins.
 */
function countExample(
  gold: PiiSpan[],
  predicted: PiiSpan[],
  mode: MatchMode,
): PrfCounts {
  const goldSorted = [...gold].sort((a, b) => a.start - b.start || a.end - b.end);
  const predSorted = [...predicted].sort((a, b) => a.start - b.start || a.end - b.end);
  const predConsumed = new Array<boolean>(predSorted.length).fill(false);

  let tp = 0;
  for (const g of goldSorted) {
    for (let i = 0; i < predSorted.length; i++) {
      if (predConsumed[i]) continue;
      if (matches(g, predSorted[i], mode)) {
        predConsumed[i] = true;
        tp++;
        break;
      }
    }
  }

  const fn = goldSorted.length - tp;
  const fp = predConsumed.filter((c) => !c).length;
  return { truePositives: tp, falsePositives: fp, falseNegatives: fn };
}

function toPrf(counts: PrfCounts): PrfMetrics {
  const { truePositives: tp, falsePositives: fp, falseNegatives: fn } = counts;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { ...counts, precision, recall, f1 };
}

function addCounts(a: PrfCounts, b: PrfCounts): PrfCounts {
  return {
    truePositives: a.truePositives + b.truePositives,
    falsePositives: a.falsePositives + b.falsePositives,
    falseNegatives: a.falseNegatives + b.falseNegatives,
  };
}

const ZERO: PrfCounts = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };

function microCounts(preds: ExamplePrediction[], mode: MatchMode): PrfCounts {
  return preds.reduce(
    (acc, p) => addCounts(acc, countExample(p.example.spans, p.predicted, mode)),
    ZERO,
  );
}

function perLabelRelaxed(preds: ExamplePrediction[]): PerLabelMetrics[] {
  return PII_LABELS.map((label) => {
    const counts = preds.reduce((acc, p) => {
      const gold = p.example.spans.filter((s) => s.label === label);
      const pred = p.predicted.filter((s) => s.label === label);
      // Skip labels absent from both sides for this example — they contribute
      // nothing, and counting them keeps the math honest (no phantom TPs).
      if (gold.length === 0 && pred.length === 0) return acc;
      return addCounts(acc, countExample(gold, pred, "relaxed"));
    }, ZERO);
    return { label, metrics: toPrf(counts) };
  });
}

function falsePositiveLoad(preds: ExamplePrediction[]): FalsePositiveLoad {
  const clean = preds.filter((p) => p.example.spans.length === 0);
  const withPred = clean.filter((p) => p.predicted.length > 0);
  const spurious = clean.reduce((n, p) => n + p.predicted.length, 0);
  return {
    cleanExamples: clean.length,
    cleanExamplesWithPredictions: withPred.length,
    spuriousSpans: spurious,
    spuriousSpansPerExample: clean.length === 0 ? 0 : spurious / clean.length,
    contaminationRate: clean.length === 0 ? 0 : withPred.length / clean.length,
  };
}

/** Score a detector's predictions across all examples. */
export function scoreDetector(
  detector: string,
  preds: ExamplePrediction[],
): ScoreReport {
  const perLabel = perLabelRelaxed(preds);
  const macroF1 = (mode: "exact" | "relaxed"): number => {
    const labelF1s = PII_LABELS.map((label) => {
      const counts = preds.reduce((acc, p) => {
        const gold = p.example.spans.filter((s) => s.label === label);
        const pred = p.predicted.filter((s) => s.label === label);
        if (gold.length === 0 && pred.length === 0) return acc;
        return addCounts(acc, countExample(gold, pred, mode));
      }, ZERO);
      // Only labels that appear in the gold set contribute to the macro mean,
      // so labels we never test don't drag the average to zero.
      const goldPresent = preds.some((p) =>
        p.example.spans.some((s) => s.label === label),
      );
      return goldPresent ? toPrf(counts).f1 : null;
    }).filter((v): v is number => v !== null);
    return labelF1s.length === 0
      ? 0
      : labelF1s.reduce((a, b) => a + b, 0) / labelF1s.length;
  };

  return {
    detector,
    examples: preds.length,
    micro: {
      exact: toPrf(microCounts(preds, "exact")),
      relaxed: toPrf(microCounts(preds, "relaxed")),
      detection: toPrf(microCounts(preds, "detection")),
    },
    macro: {
      exact: { f1: macroF1("exact") },
      relaxed: { f1: macroF1("relaxed") },
    },
    perLabel,
    falsePositives: falsePositiveLoad(preds),
  };
}

/** Round a 0..1 metric to a percentage with one decimal, for display. */
export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
