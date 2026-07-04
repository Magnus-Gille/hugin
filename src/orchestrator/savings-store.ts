/**
 * Orchestrator savings store (PR3, S3 — docs/orchestrator-savings-tracker.md).
 *
 * A single Munin doc at `tasks/_savings` / `report`, updated via the SAME
 * task-claim-style CAS read-modify-write mechanics as verdict-store.ts: one
 * read + one write per run, retry-once-then-drop, detached fire-and-forget
 * from the caller. The doc holds only small aggregate counters (totals +
 * per-model buckets); `savedUsd` and any ratio are derived at read time, not
 * stored.
 *
 * Recording is fire-and-forget: any failure (including a CAS conflict that
 * survives one retry) is logged and dropped — losing one run's numbers is
 * acceptable, corrupting the doc or failing the task is not.
 */

import { randomUUID } from "node:crypto";
import type { SavingsSummary } from "./savings.js";

export const SAVINGS_NAMESPACE = "tasks/_savings";
export const SAVINGS_KEY = "report";

/** Minimal client surface this store needs — MuninClient satisfies it structurally. */
export interface SavingsStoreClient {
  read(
    namespace: string,
    key: string,
  ): Promise<{ content: string; updated_at: string } | null>;
  write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
  ): Promise<unknown>;
}

export interface SavingsTotals {
  runs: number;
  coveredCalls: number;
  uncoveredCalls: number;
  inputTokens: number;
  outputTokens: number;
  actualCostUsd: number;
  baselineCostUsd: number;
}

export interface SavingsModelBucket {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  actualCostUsd: number;
  baselineCostUsd: number;
}

export interface SavingsDoc {
  schemaVersion: 1;
  totals: SavingsTotals;
  byModel: Record<string, SavingsModelBucket>;
  /**
   * Nonce of the last applied run — makes the CAS retry idempotent: a write
   * that commits server-side but throws client-side (lost response) is
   * detected on the retry's re-read and not applied twice (monetary counters
   * must not double-count).
   */
  lastRunNonce?: string;
}

export interface SavingsStoreLike {
  /** Apply one run's computed SavingsSummary into the aggregate doc. */
  record(summary: SavingsSummary): Promise<void>;
}

const EMPTY_TOTALS: SavingsTotals = {
  runs: 0,
  coveredCalls: 0,
  uncoveredCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  actualCostUsd: 0,
  baselineCostUsd: 0,
};

const EMPTY_MODEL_BUCKET: SavingsModelBucket = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  actualCostUsd: 0,
  baselineCostUsd: 0,
};

const EMPTY_DOC: SavingsDoc = { schemaVersion: 1, totals: EMPTY_TOTALS, byModel: {} };

function isFiniteNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

/** Cost fields are USD floats — finite and nonnegative, but NOT required to be integers. */
function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Sanitize the persisted totals object. Every counter field must be a finite
 * nonnegative integer and every cost field a finite nonnegative number, or
 * the WHOLE totals object is dropped (reset to EMPTY_TOTALS) rather than risk
 * corrupting the aggregate with a malformed value.
 */
function sanitizeTotals(raw: unknown): SavingsTotals {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_TOTALS };
  const r = raw as Record<string, unknown>;
  if (
    !isFiniteNonNegativeInt(r.runs) ||
    !isFiniteNonNegativeInt(r.coveredCalls) ||
    !isFiniteNonNegativeInt(r.uncoveredCalls) ||
    !isFiniteNonNegativeInt(r.inputTokens) ||
    !isFiniteNonNegativeInt(r.outputTokens) ||
    !isFiniteNonNegativeNumber(r.actualCostUsd) ||
    !isFiniteNonNegativeNumber(r.baselineCostUsd)
  ) {
    return { ...EMPTY_TOTALS };
  }
  return {
    runs: r.runs as number,
    coveredCalls: r.coveredCalls as number,
    uncoveredCalls: r.uncoveredCalls as number,
    inputTokens: r.inputTokens as number,
    outputTokens: r.outputTokens as number,
    actualCostUsd: r.actualCostUsd as number,
    baselineCostUsd: r.baselineCostUsd as number,
  };
}

/** Sanitize one persisted byModel row; malformed rows are dropped individually. */
function sanitizeModelBucket(raw: unknown): SavingsModelBucket | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isFiniteNonNegativeInt(r.calls) ||
    !isFiniteNonNegativeInt(r.inputTokens) ||
    !isFiniteNonNegativeInt(r.outputTokens) ||
    !isFiniteNonNegativeNumber(r.actualCostUsd) ||
    !isFiniteNonNegativeNumber(r.baselineCostUsd)
  ) {
    return null;
  }
  return {
    calls: r.calls as number,
    inputTokens: r.inputTokens as number,
    outputTokens: r.outputTokens as number,
    actualCostUsd: r.actualCostUsd as number,
    baselineCostUsd: r.baselineCostUsd as number,
  };
}

/**
 * Write-path validation: the same predicates the read path enforces, applied
 * to an incoming SavingsSummary BEFORE it is merged (a fractional token count
 * from a misbehaving provider must be rejected here, not persisted and then
 * wiped by the next read's sanitizer).
 */
function isValidSummary(summary: SavingsSummary): boolean {
  if (
    !isFiniteNonNegativeInt(summary.coveredCalls) ||
    !isFiniteNonNegativeInt(summary.uncoveredCalls) ||
    !isFiniteNonNegativeInt(summary.inputTokens) ||
    !isFiniteNonNegativeInt(summary.outputTokens) ||
    !isFiniteNonNegativeNumber(summary.actualCostUsd) ||
    !isFiniteNonNegativeNumber(summary.baselineCostUsd)
  ) {
    return false;
  }
  for (const bucket of Object.values(summary.byModel)) {
    if (
      !isFiniteNonNegativeInt(bucket.calls) ||
      !isFiniteNonNegativeInt(bucket.inputTokens) ||
      !isFiniteNonNegativeInt(bucket.outputTokens) ||
      !isFiniteNonNegativeNumber(bucket.actualCostUsd) ||
      !isFiniteNonNegativeNumber(bucket.baselineCostUsd)
    ) {
      return false;
    }
  }
  return true;
}

interface ParsedSavingsDoc {
  doc: SavingsDoc;
  /** Unrecognized schemaVersion — treat the store as read-only for this call. */
  readOnly: boolean;
}

function parseSavingsDoc(raw: string | undefined | null): ParsedSavingsDoc {
  const empty: ParsedSavingsDoc = { doc: { ...EMPTY_DOC, byModel: {} }, readOnly: false };
  if (!raw) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return empty;

    const parsedObj = parsed as { schemaVersion?: unknown; totals?: unknown; byModel?: unknown };
    if (parsedObj.schemaVersion !== undefined && parsedObj.schemaVersion !== 1) {
      // Unknown schema version — don't touch it — read-only for this run.
      return { doc: empty.doc, readOnly: true };
    }

    const lastRunNonce =
      typeof (parsedObj as { lastRunNonce?: unknown }).lastRunNonce === "string"
        ? ((parsedObj as { lastRunNonce?: string }).lastRunNonce as string)
        : undefined;
    const totals = sanitizeTotals(parsedObj.totals);
    const byModel: Record<string, SavingsModelBucket> = {};
    if (parsedObj.byModel && typeof parsedObj.byModel === "object" && !Array.isArray(parsedObj.byModel)) {
      for (const [key, value] of Object.entries(parsedObj.byModel as Record<string, unknown>)) {
        const sanitized = sanitizeModelBucket(value);
        if (sanitized) byModel[key] = sanitized;
        // else: malformed row — drop silently, don't corrupt the aggregate.
      }
    }
    return { doc: { schemaVersion: 1, totals, byModel, lastRunNonce }, readOnly: false };
  } catch {
    // fall through — malformed doc, start fresh
  }
  return empty;
}

/** Merge one run's SavingsSummary into the doc's totals + byModel buckets. */
function applySavingsRun(doc: SavingsDoc, summary: SavingsSummary): void {
  doc.totals = {
    runs: doc.totals.runs + 1,
    coveredCalls: doc.totals.coveredCalls + summary.coveredCalls,
    uncoveredCalls: doc.totals.uncoveredCalls + summary.uncoveredCalls,
    inputTokens: doc.totals.inputTokens + summary.inputTokens,
    outputTokens: doc.totals.outputTokens + summary.outputTokens,
    actualCostUsd: doc.totals.actualCostUsd + summary.actualCostUsd,
    baselineCostUsd: doc.totals.baselineCostUsd + summary.baselineCostUsd,
  };

  const byModel = { ...doc.byModel };
  for (const [key, bucket] of Object.entries(summary.byModel)) {
    const existing = byModel[key] ?? EMPTY_MODEL_BUCKET;
    byModel[key] = {
      calls: existing.calls + bucket.calls,
      inputTokens: existing.inputTokens + bucket.inputTokens,
      outputTokens: existing.outputTokens + bucket.outputTokens,
      actualCostUsd: existing.actualCostUsd + bucket.actualCostUsd,
      baselineCostUsd: existing.baselineCostUsd + bucket.baselineCostUsd,
    };
  }
  doc.byModel = byModel;
}

export class SavingsStore implements SavingsStoreLike {
  constructor(
    private readonly client: SavingsStoreClient,
    private readonly onLog?: (line: string) => void,
  ) {}

  /**
   * Apply one run's SavingsSummary into the aggregate doc. Never throws — a
   * Munin failure (including an unrecoverable CAS conflict) is logged and
   * dropped so a savings-store outage can never fail a task.
   */
  async record(summary: SavingsSummary): Promise<void> {
    // The WRITE path enforces the same invariants the read path does: an
    // out-of-range summary must never be merged, or the next read's
    // sanitizer would classify the persisted totals as malformed and
    // silently reset the lifetime aggregate.
    if (!isValidSummary(summary)) {
      this.onLog?.(
        "savings-store: skipping a run with an out-of-range SavingsSummary (would corrupt the aggregate)",
      );
      return;
    }
    try {
      await this.attemptRecord(summary, randomUUID());
    } catch (err) {
      this.onLog?.(
        `savings-store: failed to record a run's savings: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async attemptRecord(summary: SavingsSummary, runNonce: string): Promise<void> {
    let lastErr: unknown;
    // read -> modify -> write(expected_updated_at); on ANY throw, re-read and
    // retry once, then give up (caller logs and drops).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const entry = await this.client.read(SAVINGS_NAMESPACE, SAVINGS_KEY);
        const parsed = parseSavingsDoc(entry?.content);
        if (parsed.readOnly) {
          this.onLog?.(
            "savings-store: doc has an unrecognized schemaVersion — treating the store as read-only and skipping this run",
          );
          return;
        }
        const doc = parsed.doc;
        if (doc.lastRunNonce === runNonce) {
          // The previous attempt's write committed but its response was lost
          // — the run is already in the aggregate; do not double-count.
          return;
        }
        applySavingsRun(doc, summary);
        doc.lastRunNonce = runNonce;
        await this.client.write(
          SAVINGS_NAMESPACE,
          SAVINGS_KEY,
          JSON.stringify(doc),
          ["orchestrator", "savings-store"],
          entry?.updated_at,
        );
        return;
      } catch (err) {
        lastErr = err;
        // fall through to retry once more
      }
    }
    throw lastErr;
  }
}
