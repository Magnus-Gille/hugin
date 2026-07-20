/**
 * Rolling one-shot-vs-harness comparison report (hugin#267).
 *
 * Reads terminal-outcome events straight out of the durable #232 registry —
 * no separate index, no denormalized cache — and aggregates the ones the
 * standing harness-lane sampler stamped (`payload.delegation.lane` present)
 * by task type and lane. This is the queryable evidence the ticket asks for:
 * per task type, one-shot vs harness attempts, verified pass rates,
 * escalation rates, and `n`.
 *
 * Content-blind throughout: this only ever reads opaque registry event
 * fields (task type string, lane, verdict enum, booleans, counts) — never
 * prompt/response bytes, which the registry never stored to begin with.
 */

import type { LearningRegistryStore } from "./learning-registry-store.js";
import type { TerminalOutcomeEvent } from "./learning-registry-schema.js";
import type { LaneKind } from "./harness-lane-sampler.js";

export interface HarnessLaneComparisonRow {
  taskType: string;
  lane: LaneKind;
  /** Total attempts recorded for this (taskType, lane) — includes
   * unverified/failed/escalated attempts, never just the successes. */
  attempts: number;
  /** Attempts where a verifier actually ran (`outcome` present and not
   * `"unverified"`). */
  verifiedAttempts: number;
  /** Attempts whose verifier verdict was `"pass"`. */
  passed: number;
  /** Attempts flagged `escalated`. */
  escalated: number;
  /** `passed / verifiedAttempts`, or `null` when nothing was ever verified —
   * never silently reported as 0, which would misread as "verified and
   * failed every time" instead of "no verified evidence yet". */
  verifiedPassRate: number | null;
  /** `escalated / attempts`, or `null` when there were no attempts at all. */
  escalationRate: number | null;
}

/**
 * Aggregate a flat list of terminal-outcome events into per-(taskType, lane)
 * comparison rows. Events without sampler-stamped `delegation.lane` (i.e.
 * every terminal outcome recorded before hugin#267, or recorded by something
 * other than the standing lane) are skipped — they carry no lane signal to
 * compare.
 */
export function computeHarnessLaneComparison(
  events: readonly TerminalOutcomeEvent[],
): HarnessLaneComparisonRow[] {
  interface Bucket {
    taskType: string;
    lane: LaneKind;
    attempts: number;
    verified: number;
    passed: number;
    escalated: number;
  }
  const buckets = new Map<string, Bucket>();

  for (const event of events) {
    const delegation = event.payload.delegation;
    const lane = delegation?.lane;
    const taskType = delegation?.taskType;
    if (!lane || !taskType) continue;

    const bucketKey = `${taskType}\0${lane}`;
    const bucket = buckets.get(bucketKey) ?? {
      taskType,
      lane,
      attempts: 0,
      verified: 0,
      passed: 0,
      escalated: 0,
    };
    bucket.attempts += 1;
    if (delegation.outcome !== undefined && delegation.outcome !== "unverified") bucket.verified += 1;
    if (delegation.outcome === "pass") bucket.passed += 1;
    if (delegation.escalated === true) bucket.escalated += 1;
    buckets.set(bucketKey, bucket);
  }

  return [...buckets.values()]
    .map((bucket): HarnessLaneComparisonRow => ({
      taskType: bucket.taskType,
      lane: bucket.lane,
      attempts: bucket.attempts,
      verifiedAttempts: bucket.verified,
      passed: bucket.passed,
      escalated: bucket.escalated,
      verifiedPassRate: bucket.verified > 0 ? bucket.passed / bucket.verified : null,
      escalationRate: bucket.attempts > 0 ? bucket.escalated / bucket.attempts : null,
    }))
    .sort((a, b) => a.taskType.localeCompare(b.taskType) || a.lane.localeCompare(b.lane));
}

export interface HarnessLaneComparisonReport {
  periodsQueried: string[];
  rows: HarnessLaneComparisonRow[];
  /** True when any queried period's underlying registry read could not prove
   * completeness (Munin pagination budget exhausted) — treat the report as a
   * lower bound, not a final count. */
  truncated: boolean;
}

/**
 * Build the full report across one or more UTC occurrence periods
 * (`"YYYY-MM"`), reading directly from the live #232 registry.
 */
export async function buildHarnessLaneComparisonReport(
  registry: Pick<LearningRegistryStore, "listTerminalOutcomesForPeriod">,
  occurrencePeriodsUtc: readonly string[],
): Promise<HarnessLaneComparisonReport> {
  const allEvents: TerminalOutcomeEvent[] = [];
  let truncated = false;
  for (const period of occurrencePeriodsUtc) {
    const { events, truncated: periodTruncated } = await registry.listTerminalOutcomesForPeriod(period);
    allEvents.push(...events);
    truncated = truncated || periodTruncated;
  }
  return {
    periodsQueried: [...occurrencePeriodsUtc],
    rows: computeHarnessLaneComparison(allEvents),
    truncated,
  };
}

/** Render the report as a simple, fixed-width, content-blind text table. */
export function formatHarnessLaneComparisonReport(report: HarnessLaneComparisonReport): string {
  const header = ["task_type", "lane", "n", "verified_n", "verified_pass_rate", "escalation_rate"];
  const formatRate = (value: number | null): string => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  const rows = report.rows.map((row) => [
    row.taskType,
    row.lane,
    String(row.attempts),
    String(row.verifiedAttempts),
    formatRate(row.verifiedPassRate),
    formatRate(row.escalationRate),
  ]);
  const widths = header.map((title, col) =>
    Math.max(title.length, ...rows.map((row) => row[col]?.length ?? 0)));
  const renderRow = (cells: string[]): string =>
    cells.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join("  ");

  const lines = [
    `Harness-lane comparison — periods: ${report.periodsQueried.join(", ") || "(none)"}`,
    renderRow(header),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(renderRow),
  ];
  if (report.rows.length === 0) {
    lines.push("(no sampler-stamped terminal outcomes found for the queried period(s))");
  }
  if (report.truncated) {
    lines.push("");
    lines.push("WARNING: at least one queried period's registry read was truncated; counts are a lower bound.");
  }
  return lines.join("\n");
}
