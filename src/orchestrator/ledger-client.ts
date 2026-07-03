/**
 * M5 gateway ledger client (verdict layer V7).
 *
 * Reads `GET {gatewayRoot}/ledger` — the same aggregate the orchestrator's
 * own verdict store computes (V1: shapes adopted verbatim), already
 * pre-derived (verdict/recommendation) by the gateway for its local-inference
 * lane. Used as the adaptive-verify confidence source for
 * `homeserver`-bound workers (V5).
 *
 * Fail-open by design: ANY failure (bad/missing gateway URL, missing API key,
 * network error, non-2xx, unexpected body shape) returns `null` — the caller
 * degrades to "no signal" (treated as verify), never blocks execution.
 */

import { resolveGatewayRootUrl } from "./provider-config.js";
import { parseIntEnv } from "./config.js";

export interface LedgerRow {
  taskType: string;
  modelId: string;
  verdict: "viable" | "marginal" | "not_viable" | "unknown";
  attempts: number;
  passes: number;
  fails: number;
  errors: number;
  successRate: number;
  frozen: boolean;
  recommendation: "delegate-local" | "escalate-frontier" | "explore";
  avgLatencyMs?: number;
  avgTokPerSec?: number;
  partials?: number;
}

export interface Ledger {
  report: LedgerRow[];
}

/**
 * Structural interface for dependency injection (orchestrator-executor.ts
 * deps bag / tests) — `LedgerClient` satisfies this without an explicit
 * `implements` clause.
 */
export interface LedgerClientLike {
  getLedger(): Promise<Ledger | null>;
}

/** Default ledger cache TTL (HUGIN_ORCH_LEDGER_TTL_MS) — 10 minutes. */
export const DEFAULT_LEDGER_TTL_MS = 600_000;

/**
 * Default NEGATIVE cache TTL (Fix #5) — deliberately much shorter than the
 * positive TTL. A down/unreachable gateway would otherwise cost every task a
 * full REQUEST_TIMEOUT_MS stall (10s) on the confidence-source read; caching
 * "no signal" for a minute bounds that cost without staying stale for long.
 */
export const DEFAULT_LEDGER_NEGATIVE_TTL_MS = 60_000;

const REQUEST_TIMEOUT_MS = 10_000;

export interface LedgerClientOptions {
  /** In-process cache TTL in ms. Defaults to HUGIN_ORCH_LEDGER_TTL_MS or 600000. */
  ttlMs?: number;
  /** Negative-cache TTL in ms (Fix #5). Defaults to DEFAULT_LEDGER_NEGATIVE_TTL_MS. */
  negativeTtlMs?: number;
  /** Clock injection for testability — never Date.now() hardcoded in logic paths. */
  now?: () => number;
  /** fetch injection for testability. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const VALID_RECOMMENDATIONS: ReadonlySet<string> = new Set([
  "delegate-local",
  "escalate-frontier",
  "explore",
]);

/**
 * Validate a single ledger row (Fix #5): a malformed entry (e.g. `null`, a
 * non-string modelId/taskType, or a recommendation outside the known enum)
 * must be DROPPED, not blindly trusted — the old `isLedgerShape` only
 * checked that `report` was an array, so `{"report":[null]}` passed
 * validation, got cached for the full positive TTL, and was dereferenced
 * downstream.
 */
function isValidLedgerRow(value: unknown): value is LedgerRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.modelId !== "string") return false;
  if (typeof r.taskType !== "string") return false;
  if (typeof r.recommendation !== "string" || !VALID_RECOMMENDATIONS.has(r.recommendation)) {
    return false;
  }
  return true;
}

/**
 * Extract the valid rows from a parsed ledger body. Returns `null` when the
 * body isn't even the right overall shape (no `report` array at all — a
 * fundamentally wrong response, not just some bad rows within it); otherwise
 * returns the ORIGINAL array with invalid entries filtered out (an all-drop
 * result is a legitimate empty ledger, not a failure).
 */
function extractValidRows(value: unknown): LedgerRow[] | null {
  if (!value || typeof value !== "object") return null;
  const report = (value as { report?: unknown }).report;
  if (!Array.isArray(report)) return null;
  return report.filter(isValidLedgerRow);
}

export class LedgerClient implements LedgerClientLike {
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private cache: { data: Ledger; fetchedAt: number } | null = null;
  /** Fix #5: negative cache — set on any fetch/HTTP/shape failure. */
  private negativeCache: { fetchedAt: number } | null = null;

  constructor(opts: LedgerClientOptions = {}) {
    this.env = opts.env ?? process.env;
    this.ttlMs = opts.ttlMs ?? parseIntEnv(this.env.HUGIN_ORCH_LEDGER_TTL_MS, DEFAULT_LEDGER_TTL_MS);
    this.negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_LEDGER_NEGATIVE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Fetch (or return the cached) ledger. Never throws — any failure resolves
   * to `null`.
   */
  async getLedger(): Promise<Ledger | null> {
    const nowMs = this.now();
    if (this.cache && nowMs - this.cache.fetchedAt < this.ttlMs) {
      return this.cache.data;
    }
    if (this.negativeCache && nowMs - this.negativeCache.fetchedAt < this.negativeTtlMs) {
      return null;
    }

    const resolved = resolveGatewayRootUrl(this.env);
    if (!resolved.ok) return null;

    const apiKey = this.env["HOMESERVER_GATEWAY_API_KEY"];
    if (!apiKey) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${resolved.baseUrl}/ledger`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        // Release the keep-alive socket before negative-caching (Fix #5).
        await res.text().catch(() => {});
        this.negativeCache = { fetchedAt: nowMs };
        return null;
      }

      const parsed: unknown = await res.json();
      const rows = extractValidRows(parsed);
      if (rows === null) {
        this.negativeCache = { fetchedAt: nowMs };
        return null;
      }

      const ledger: Ledger = { report: rows };
      this.cache = { data: ledger, fetchedAt: nowMs };
      this.negativeCache = null;
      return ledger;
    } catch {
      this.negativeCache = { fetchedAt: nowMs };
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
