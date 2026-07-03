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

const REQUEST_TIMEOUT_MS = 10_000;

export interface LedgerClientOptions {
  /** In-process cache TTL in ms. Defaults to HUGIN_ORCH_LEDGER_TTL_MS or 600000. */
  ttlMs?: number;
  /** Clock injection for testability — never Date.now() hardcoded in logic paths. */
  now?: () => number;
  /** fetch injection for testability. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

function isLedgerShape(value: unknown): value is Ledger {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { report?: unknown }).report)
  );
}

export class LedgerClient implements LedgerClientLike {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private cache: { data: Ledger; fetchedAt: number } | null = null;

  constructor(opts: LedgerClientOptions = {}) {
    this.env = opts.env ?? process.env;
    this.ttlMs = opts.ttlMs ?? parseIntEnv(this.env.HUGIN_ORCH_LEDGER_TTL_MS, DEFAULT_LEDGER_TTL_MS);
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
      if (!res.ok) return null;

      const parsed: unknown = await res.json();
      if (!isLedgerShape(parsed)) return null;

      this.cache = { data: parsed, fetchedAt: nowMs };
      return parsed;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
