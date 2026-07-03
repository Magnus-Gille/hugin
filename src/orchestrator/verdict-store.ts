/**
 * Orchestrator cloud-worker verdict store (verdict layer V4).
 *
 * A single Munin doc at `tasks/_verdicts` / `report`, updated via a
 * task-claim-style CAS read-modify-write. The doc holds only small per-
 * (modelId × taskType) counters — verdict/success-rate/recommendation are
 * DERIVED at read time (deriveVerdict / deriveRecommendation), mirroring the
 * M5 gateway's own `/ledger` semantics (V1 — shape convergence by
 * construction) so the two stores can merge later without a migration.
 *
 * Recording is fire-and-forget: any failure (including a CAS conflict that
 * survives one retry) is logged and dropped — losing one event is
 * acceptable, corrupting the doc or failing the task is not.
 */

import type { ConfidenceRecommendation } from "./engine.js";

export const VERDICT_NAMESPACE = "tasks/_verdicts";
export const VERDICT_KEY = "report";

/** Minimal client surface this store needs — MuninClient satisfies it structurally. */
export interface VerdictStoreClient {
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

export interface VerdictRow {
  attempts: number;
  passes: number;
  fails: number;
  errors: number;
  totalLatencyMs: number;
  /**
   * Verified/unverified separation (Fix #1 — confidence-poisoning fix): a
   * running streak of successful-but-NEVER-VERIFIED worker outcomes recorded
   * since the last VERIFIED pass or fail for this row. Reset to 0 whenever a
   * "pass" or "fail" (i.e. an actually-verified) event is recorded; NOT
   * touched by "error" events. Drives the re-probe gate in
   * orchestrator-executor.ts's buildConfidenceFn — once this streak crosses
   * HUGIN_ORCH_REPROBE_UNVERIFIED, the adaptive gate forces one more verify
   * so a "delegate-local" recommendation can never become a permanently
   * unverified absorbing state. Sanitize-default 0 when absent from a
   * persisted doc (schemaVersion stays 1 — no deployed data to migrate).
   */
  unverifiedPasses: number;
}

export interface VerdictDoc {
  schemaVersion: 1;
  rows: Record<string, VerdictRow>;
}

export type DerivedVerdict = "unknown" | "viable" | "marginal" | "not_viable";
/**
 * "unverified" (Fix #1): a successful worker outcome that was NEVER checked
 * by a verifier (verdict undefined) — recorded separately from "pass" so an
 * unverified run can never masquerade as quality signal.
 */
export type VerdictEvent = "pass" | "fail" | "error" | "unverified";

export interface VerdictBatchEvent {
  modelId: string;
  taskType: string;
  event: VerdictEvent;
  latencyMs: number;
}

/** Per-row confidence signal returned by loadRecommendations (Fix #1). */
export interface ConfidenceRow {
  recommendation: ConfidenceRecommendation;
  unverifiedPasses: number;
}

/**
 * Structural interface for dependency injection (orchestrator-executor.ts
 * deps bag / tests) — `VerdictStore` satisfies this without an explicit
 * `implements` clause.
 */
export interface VerdictStoreLike {
  record(
    modelId: string,
    taskType: string,
    event: VerdictEvent,
    latencyMs: number,
  ): Promise<void>;
  /**
   * Apply an entire run's worth of events in ONE read-modify-write (Fix #2)
   * instead of one CAS round-trip per outcome — bounds worst-case Munin
   * traffic per task to a single read + single write regardless of subtask
   * count.
   */
  recordBatch(events: VerdictBatchEvent[]): Promise<void>;
  loadRecommendations(): Promise<Map<string, ConfidenceRow>>;
}

const EMPTY_ROW: VerdictRow = {
  attempts: 0,
  passes: 0,
  fails: 0,
  errors: 0,
  totalLatencyMs: 0,
  unverifiedPasses: 0,
};

/**
 * Derive a coarse verdict from raw counters. Thresholds per
 * docs/orchestrator-verdict-layer.md V4 (Fix #1 — rate excludes errors):
 *   - fewer than 3 (passes + fails) → "unknown" (not enough VERIFIED signal yet)
 *   - passes / (passes + fails) >= 0.8 → "viable"
 *   - passes / (passes + fails) >= 0.5 → "marginal"
 *   - else → "not_viable"
 *
 * Infra errors (and raw attempts, which also counts unverified passes) have
 * NO bearing on the rate — they are attempts, not quality signal, matching
 * the gateway's own semantics.
 *
 * Pure function — no I/O, no clock.
 */
export function deriveVerdict(row: Pick<VerdictRow, "passes" | "fails">): DerivedVerdict {
  const total = row.passes + row.fails;
  if (total < 3) return "unknown";
  const rate = row.passes / total;
  if (rate >= 0.8) return "viable";
  if (rate >= 0.5) return "marginal";
  return "not_viable";
}

/**
 * Map a derived verdict to an actionable recommendation, mirroring gateway
 * semantics: viable → trust locally, not_viable → escalate to a stronger
 * tier, everything else (marginal / unknown) → explore (verify).
 */
export function deriveRecommendation(verdict: DerivedVerdict): ConfidenceRecommendation {
  if (verdict === "viable") return "delegate-local";
  if (verdict === "not_viable") return "escalate-frontier";
  return "explore";
}

/** Result of parsing a persisted verdict doc (Fix #8). */
interface ParsedVerdictDoc {
  doc: VerdictDoc;
  /**
   * True when the doc carries a `schemaVersion` other than the one this
   * store understands. The doc is treated as read-only for the current
   * operation: no rows are trusted, no write is attempted, and the caller
   * logs once so an operator notices a version skew instead of silently
   * corrupting or discarding data.
   */
  readOnly: boolean;
}

function isFiniteNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

/**
 * Sanitize one persisted row (Fix #8): every counter must be a finite
 * nonnegative integer or the WHOLE row is dropped (arithmetic on a
 * malformed row — e.g. a string, array, or null — would silently corrupt
 * the derived verdict). `unverifiedPasses` is the exception: it is the
 * newest field, so a MISSING (undefined) value sanitize-defaults to 0
 * rather than dropping an otherwise-valid row; a PRESENT-but-invalid value
 * still drops the row like any other counter.
 */
function sanitizeRow(raw: unknown): VerdictRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const unverifiedPassesRaw = r.unverifiedPasses === undefined ? 0 : r.unverifiedPasses;

  if (
    !isFiniteNonNegativeInt(r.attempts) ||
    !isFiniteNonNegativeInt(r.passes) ||
    !isFiniteNonNegativeInt(r.fails) ||
    !isFiniteNonNegativeInt(r.errors) ||
    !isFiniteNonNegativeInt(r.totalLatencyMs) ||
    !isFiniteNonNegativeInt(unverifiedPassesRaw)
  ) {
    return null;
  }

  return {
    attempts: r.attempts as number,
    passes: r.passes as number,
    fails: r.fails as number,
    errors: r.errors as number,
    totalLatencyMs: r.totalLatencyMs as number,
    unverifiedPasses: unverifiedPassesRaw as number,
  };
}

function parseVerdictDoc(raw: string | undefined | null): ParsedVerdictDoc {
  const empty: ParsedVerdictDoc = { doc: { schemaVersion: 1, rows: {} }, readOnly: false };
  if (!raw) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("rows" in parsed) ||
      typeof (parsed as { rows: unknown }).rows !== "object" ||
      (parsed as { rows: unknown }).rows === null
    ) {
      return empty;
    }

    const parsedObj = parsed as { schemaVersion?: unknown; rows: Record<string, unknown> };
    if (parsedObj.schemaVersion !== undefined && parsedObj.schemaVersion !== 1) {
      // Unknown schema version (Fix #8): don't touch it — read-only for this run.
      return { doc: empty.doc, readOnly: true };
    }

    const rows: Record<string, VerdictRow> = {};
    for (const [key, value] of Object.entries(parsedObj.rows)) {
      const sanitized = sanitizeRow(value);
      if (sanitized) rows[key] = sanitized;
      // else: malformed row — drop silently, don't corrupt derived stats.
    }
    return { doc: { schemaVersion: 1, rows }, readOnly: false };
  } catch {
    // fall through — malformed doc, start fresh
  }
  return empty;
}

function rowKey(modelId: string, taskType: string): string {
  return `${modelId}|${taskType}`;
}

function applyVerdictEvent(
  doc: VerdictDoc,
  modelId: string,
  taskType: string,
  event: VerdictEvent,
  latencyMs: number,
): void {
  const key = rowKey(modelId, taskType);
  const existing = doc.rows[key] ?? EMPTY_ROW;
  // A VERIFIED event (pass or fail) is fresh signal — reset the unverified
  // streak (Fix #1). "error" leaves the streak untouched (infra noise, not a
  // verification result). "unverified" grows the streak by one.
  const verified = event === "pass" || event === "fail";
  doc.rows = {
    ...doc.rows,
    [key]: {
      attempts: existing.attempts + 1,
      passes: existing.passes + (event === "pass" ? 1 : 0),
      fails: existing.fails + (event === "fail" ? 1 : 0),
      errors: existing.errors + (event === "error" ? 1 : 0),
      totalLatencyMs: existing.totalLatencyMs + latencyMs,
      unverifiedPasses: verified
        ? 0
        : existing.unverifiedPasses + (event === "unverified" ? 1 : 0),
    },
  };
}

export class VerdictStore implements VerdictStoreLike {
  constructor(
    private readonly client: VerdictStoreClient,
    private readonly onLog?: (line: string) => void,
  ) {}

  /**
   * Record exactly one verdict event for (modelId × taskType). Never throws —
   * a Munin failure (including an unrecoverable CAS conflict) is logged and
   * dropped so a verdict-store outage can never fail a task.
   */
  async record(
    modelId: string,
    taskType: string,
    event: VerdictEvent,
    latencyMs: number,
  ): Promise<void> {
    try {
      await this.attemptRecord(modelId, taskType, event, latencyMs);
    } catch (err) {
      this.onLog?.(
        `verdict-store: failed to record event for ${modelId}|${taskType}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async attemptRecord(
    modelId: string,
    taskType: string,
    event: VerdictEvent,
    latencyMs: number,
  ): Promise<void> {
    let lastErr: unknown;
    // read -> modify -> write(expected_updated_at); on ANY throw, re-read and
    // retry once, then give up (caller logs and drops).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const entry = await this.client.read(VERDICT_NAMESPACE, VERDICT_KEY);
        const parsed = parseVerdictDoc(entry?.content);
        if (parsed.readOnly) {
          // Fix #8: unrecognized schemaVersion — don't touch the doc. Log
          // once and skip (not an error: nothing was corrupted or lost that
          // wasn't already unreadable).
          this.onLog?.(
            `verdict-store: doc has an unrecognized schemaVersion — treating the store as read-only and skipping this record (${modelId}|${taskType})`,
          );
          return;
        }
        const doc = parsed.doc;
        applyVerdictEvent(doc, modelId, taskType, event, latencyMs);
        await this.client.write(
          VERDICT_NAMESPACE,
          VERDICT_KEY,
          JSON.stringify(doc),
          ["orchestrator", "verdict-store"],
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

  /**
   * Apply an entire run's worth of verdict events in ONE read-modify-write
   * (Fix #2) — bounds worst-case Munin traffic per task (a degraded Munin
   * with slow/serial CAS retries could otherwise stall minutes on a run with
   * many subtasks, one round-trip per outcome). Never throws — same
   * fire-and-forget contract as `record`.
   */
  async recordBatch(events: VerdictBatchEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.attemptRecordBatch(events);
    } catch (err) {
      this.onLog?.(
        `verdict-store: failed to record a batch of ${events.length} event(s): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async attemptRecordBatch(events: VerdictBatchEvent[]): Promise<void> {
    let lastErr: unknown;
    // Same read -> modify(all events) -> write(expected_updated_at) shape as
    // attemptRecord, but ALL events are folded into the single doc read here
    // before the single write — retry-once-then-drop unchanged.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const entry = await this.client.read(VERDICT_NAMESPACE, VERDICT_KEY);
        const parsed = parseVerdictDoc(entry?.content);
        if (parsed.readOnly) {
          this.onLog?.(
            `verdict-store: doc has an unrecognized schemaVersion — treating the store as read-only and skipping this batch of ${events.length} event(s)`,
          );
          return;
        }
        const doc = parsed.doc;
        for (const e of events) {
          applyVerdictEvent(doc, e.modelId, e.taskType, e.event, e.latencyMs);
        }
        await this.client.write(
          VERDICT_NAMESPACE,
          VERDICT_KEY,
          JSON.stringify(doc),
          ["orchestrator", "verdict-store"],
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

  /**
   * Load the full verdict doc and derive a recommendation + unverified-streak
   * per row. Used to build the engine's synchronous `confidence` lookup for
   * cloud-provider workers (V5) — the executor fetches this ONCE per task and
   * wraps it in a plain closure so the pure engine never does I/O of its own.
   *
   * Fails open: any read error, or an unrecognized schemaVersion, returns an
   * empty map (callers treat a missing key as "explore"/unknown, never as a
   * hard block).
   */
  async loadRecommendations(): Promise<Map<string, ConfidenceRow>> {
    const map = new Map<string, ConfidenceRow>();
    try {
      const entry = await this.client.read(VERDICT_NAMESPACE, VERDICT_KEY);
      const parsed = parseVerdictDoc(entry?.content);
      if (parsed.readOnly) return map;
      for (const [key, row] of Object.entries(parsed.doc.rows)) {
        map.set(key, {
          recommendation: deriveRecommendation(deriveVerdict(row)),
          unverifiedPasses: row.unverifiedPasses,
        });
      }
    } catch {
      // fail open — empty map
    }
    return map;
  }
}
