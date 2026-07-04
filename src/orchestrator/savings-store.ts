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

    const totals = sanitizeTotals(parsedObj.totals);
    const byModel: Record<string, SavingsModelBucket> = {};
    if (parsedObj.byModel && typeof parsedObj.byModel === "object" && !Array.isArray(parsedObj.byModel)) {
      for (const [key, value] of Object.entries(parsedObj.byModel as Record<string, unknown>)) {
        const sanitized = sanitizeModelBucket(value);
        if (sanitized) byModel[key] = sanitized;
        // else: malformed row — drop silently, don't corrupt the aggregate.
      }
    }
    return { doc: { schemaVersion: 1, totals, byModel }, readOnly: false };
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
    try {
      await this.attemptRecord(summary);
    } catch (err) {
      this.onLog?.(
        `savings-store: failed to record a run's savings: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async attemptRecord(summary: SavingsSummary): Promise<void> {
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
        applySavingsRun(doc, summary);
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
