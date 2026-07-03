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
}

export interface VerdictDoc {
  schemaVersion: 1;
  rows: Record<string, VerdictRow>;
}

export type DerivedVerdict = "unknown" | "viable" | "marginal" | "not_viable";
export type VerdictEvent = "pass" | "fail" | "error";

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
  loadRecommendations(): Promise<Map<string, ConfidenceRecommendation>>;
}

const EMPTY_ROW: VerdictRow = { attempts: 0, passes: 0, fails: 0, errors: 0, totalLatencyMs: 0 };

/**
 * Derive a coarse verdict from raw counters. Thresholds per
 * docs/orchestrator-verdict-layer.md V4:
 *   - fewer than 3 attempts → "unknown" (not enough signal yet)
 *   - success rate >= 0.8 → "viable"
 *   - success rate >= 0.5 → "marginal"
 *   - else → "not_viable"
 *
 * Pure function — no I/O, no clock.
 */
export function deriveVerdict(row: Pick<VerdictRow, "attempts" | "passes">): DerivedVerdict {
  if (row.attempts < 3) return "unknown";
  const rate = row.passes / row.attempts;
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

function parseVerdictDoc(raw: string | undefined | null): VerdictDoc {
  if (!raw) return { schemaVersion: 1, rows: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "rows" in parsed &&
      typeof (parsed as { rows: unknown }).rows === "object" &&
      (parsed as { rows: unknown }).rows !== null
    ) {
      return { schemaVersion: 1, rows: { ...(parsed as VerdictDoc).rows } };
    }
  } catch {
    // fall through — malformed doc, start fresh
  }
  return { schemaVersion: 1, rows: {} };
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
  doc.rows = {
    ...doc.rows,
    [key]: {
      attempts: existing.attempts + 1,
      passes: existing.passes + (event === "pass" ? 1 : 0),
      fails: existing.fails + (event === "fail" ? 1 : 0),
      errors: existing.errors + (event === "error" ? 1 : 0),
      totalLatencyMs: existing.totalLatencyMs + latencyMs,
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
        const doc = parseVerdictDoc(entry?.content);
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
   * Load the full verdict doc and derive a recommendation per row. Used to
   * build the engine's synchronous `confidence` lookup for cloud-provider
   * workers (V5) — the executor fetches this ONCE per task and wraps it in a
   * plain closure so the pure engine never does I/O of its own.
   *
   * Fails open: any read error returns an empty map (callers treat a missing
   * key as "explore"/unknown, never as a hard block).
   */
  async loadRecommendations(): Promise<Map<string, ConfidenceRecommendation>> {
    const map = new Map<string, ConfidenceRecommendation>();
    try {
      const entry = await this.client.read(VERDICT_NAMESPACE, VERDICT_KEY);
      const doc = parseVerdictDoc(entry?.content);
      for (const [key, row] of Object.entries(doc.rows)) {
        map.set(key, deriveRecommendation(deriveVerdict(row)));
      }
    } catch {
      // fail open — empty map
    }
    return map;
  }
}
