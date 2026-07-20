/**
 * Bounded-retry bind wrapper for the broker HTTP listener (issue #252).
 *
 * `startBroker()` (server.ts) is a single-shot bind: it resolves once the
 * given host:port accepts connections, or rejects. In production the host is
 * a Tailscale interface IP (`HUGIN_BROKER_HOST`); user-scope systemd ordering
 * cannot reliably guarantee tailscaled has assigned that address before
 * `hugin.service` starts (After=/Wants= against a user-scope tailscaled unit
 * is not authoritative for interface-address assignment). A `listen()` on a
 * not-yet-assigned local address fails with `EADDRNOTAVAIL` — an expected
 * transient at boot, not a real outage.
 *
 * The previous behavior was one shot: `startBroker(...).catch(err =>
 * console.error(...))`. That silently degraded to "dispatcher without
 * broker" and left `/health` reporting fully-ok while every `/v1/delegate/*`
 * client saw bare connection failures (observed live 2026-07-20, issue #252).
 *
 * This module:
 *  - retries a transient bind failure with bounded exponential backoff
 *    (bounded by both attempt count and total wall-clock duration, so it
 *    degrades to a clearly-reported failed state rather than retrying
 *    forever or crash-looping the process);
 *  - fails fast on a permanent bind error (`EADDRINUSE`: something else
 *    already holds the port; `EACCES`: no permission to bind it) — these
 *    will never resolve by waiting;
 *  - reports every state transition through `onStatus`, so a caller (the
 *    dispatcher's `/health` handler) can expose live broker state instead of
 *    only learning about success after the fact; and
 *  - is cancellable via `signal`, so dispatcher shutdown does not leave a
 *    dangling retry timer or bind an orphaned listener after the process has
 *    already begun exiting.
 */

import type { BrokerServerConfig, RunningBroker } from "./server.js";
import { startBroker } from "./server.js";

export type BrokerBindState =
  | "disabled"
  | "starting"
  | "retrying"
  | "listening"
  | "failed";

export interface BrokerBindStatus {
  state: BrokerBindState;
  host: string;
  port: number;
  /** Bind attempts made so far (starts at 1 for the first attempt). */
  attempts: number;
  lastError?: string;
  lastErrorCode?: string;
  /** ISO timestamp of the successful bind, once state === "listening". */
  boundAt?: string;
  /** ISO timestamp of the next scheduled retry, while state === "retrying". */
  nextRetryAt?: string;
  /** ISO timestamp of the first failure in the current failure streak. */
  degradedSince?: string;
}

/** node:net/http error codes that will never resolve by waiting. */
const PERMANENT_BIND_CODES = new Set(["EADDRINUSE", "EACCES"]);

export function isPermanentBindError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && PERMANENT_BIND_CODES.has(code);
}

function bindErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function bindErrorCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export interface BrokerBindRetryOptions {
  /** Safety cap on retry attempts even if the duration budget allows more. Default 1000. */
  maxAttempts?: number;
  /** Total wall-clock retry budget from the first failure. Default 5 minutes. */
  maxDurationMs?: number;
  /** First retry delay. Default 2s. */
  baseDelayMs?: number;
  /** Retry delay ceiling. Default 30s. */
  maxDelayMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable delay for deterministic tests; receives the computed delay in ms. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable bind implementation; defaults to server.ts's startBroker. */
  bind?: (config: BrokerServerConfig) => Promise<RunningBroker>;
  /** Called synchronously on every state transition. */
  onStatus?: (status: BrokerBindStatus) => void;
  /** Called for each loggable event; wire to console.warn/error/log. */
  onLog?: (level: "warn" | "error" | "info", message: string) => void;
  /**
   * Cancels the retry loop (e.g. on dispatcher shutdown). Checked before each
   * attempt and races the in-flight backoff sleep. A bind already in flight
   * when the signal fires is not aborted (Node has no cancellable listen());
   * the caller is responsible for closing a broker that resolves after
   * shutdown was requested — see the double-bind note in index.ts.
   */
  signal?: AbortSignal;
}

const DEFAULT_MAX_ATTEMPTS = 1000; // effectively unbounded; maxDurationMs is the real ceiling
const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000; // 5 minutes — see PR design notes
const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter on the upper half, capped at maxDelayMs. */
function computeDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

/**
 * Wait `ms`, or return early as `"aborted"` if `signal` fires first. Uses the
 * injected `sleep` so tests can make the delay itself instant while still
 * exercising the abort race.
 */
function waitOrAbort(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<"slept" | "aborted"> {
  // Both branches treat a rejected `sleep` as "slept" (proceed immediately)
  // rather than propagating — an injected test sleep or future alternate
  // implementation must not turn into an unhandled rejection that breaks
  // this function's "never throws" contract (see startBrokerWithRetry doc).
  if (!signal) {
    return sleep(ms).then(
      () => "slept" as const,
      () => "slept" as const,
    );
  }
  if (signal.aborted) return Promise.resolve("aborted" as const);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: "slept" | "aborted") => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(
      () => finish("slept"),
      () => finish("slept"),
    );
  });
}

/**
 * Attempt to bind the broker, retrying bounded transient failures.
 *
 * Resolves with the running broker once bound, or `null` once retries are
 * exhausted — permanent error, attempt/duration budget elapsed, or the
 * caller's `signal` fired. The dispatcher keeps running without a broker in
 * every `null` case, but `onStatus` will have reported a terminal, visible
 * state rather than degrading silently. Never throws.
 */
export async function startBrokerWithRetry(
  config: BrokerServerConfig,
  opts: BrokerBindRetryOptions = {},
): Promise<RunningBroker | null> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const bind = opts.bind ?? startBroker;
  const log = opts.onLog ?? (() => {});
  const emit = (status: BrokerBindStatus) => opts.onStatus?.(status);
  const signal = opts.signal;

  const startedAt = now();
  let attempts = 0;
  let degradedSince: string | undefined;

  emit({ state: "starting", host: config.host, port: config.port, attempts: 0 });

  for (;;) {
    if (signal?.aborted) {
      log("info", `Broker bind to ${config.host}:${config.port} cancelled (shutdown)`);
      return null;
    }

    attempts++;
    try {
      const running = await bind(config);
      emit({
        state: "listening",
        host: config.host,
        port: config.port,
        attempts,
        boundAt: new Date(now()).toISOString(),
      });
      log(
        "info",
        `Broker bound to ${config.host}:${config.port} after ${attempts} attempt(s)`,
      );
      return running;
    } catch (err) {
      const message = bindErrorMessage(err);
      const code = bindErrorCode(err);
      degradedSince ??= new Date(now()).toISOString();

      if (isPermanentBindError(err)) {
        log(
          "error",
          `Broker bind to ${config.host}:${config.port} failed permanently (${code}): ${message} — not retrying`,
        );
        emit({
          state: "failed",
          host: config.host,
          port: config.port,
          attempts,
          lastError: message,
          lastErrorCode: code,
          degradedSince,
        });
        return null;
      }

      const elapsed = now() - startedAt;
      const exhausted = attempts >= maxAttempts || elapsed >= maxDurationMs;
      if (exhausted) {
        log(
          "error",
          `Broker bind to ${config.host}:${config.port} gave up after ${attempts} attempt(s)/${elapsed}ms (${code ?? "unknown"}): ${message}`,
        );
        emit({
          state: "failed",
          host: config.host,
          port: config.port,
          attempts,
          lastError: message,
          lastErrorCode: code,
          degradedSince,
        });
        return null;
      }

      const delayMs = computeDelayMs(attempts, baseDelayMs, maxDelayMs);
      const nextRetryAt = new Date(now() + delayMs).toISOString();
      log(
        "warn",
        `Broker bind to ${config.host}:${config.port} failed (${code ?? "unknown"}): ${message} — retrying in ${delayMs}ms (attempt ${attempts})`,
      );
      emit({
        state: "retrying",
        host: config.host,
        port: config.port,
        attempts,
        lastError: message,
        lastErrorCode: code,
        nextRetryAt,
        degradedSince,
      });

      const outcome = await waitOrAbort(delayMs, sleep, signal);
      if (outcome === "aborted") {
        log("info", `Broker bind to ${config.host}:${config.port} cancelled (shutdown)`);
        return null;
      }
    }
  }
}

/** Health payload shape for the broker sub-object (see index.ts's /health). */
export interface BrokerHealthField {
  /** Whether HUGIN_BROKER_KEYS/_FILE is set at all. */
  configured: boolean;
  state: BrokerBindState;
  host?: string;
  port?: number;
  /** True only when the broker is actually accepting connections. */
  listening: boolean;
  /**
   * True when the broker is configured but not currently listening
   * (retrying or permanently failed). False when disabled-by-design or
   * listening. This is the flag monitors should key off — see PR notes on
   * why the top-level `status` field is left unchanged.
   */
  degraded: boolean;
  attempts?: number;
  lastError?: string;
  lastErrorCode?: string;
  boundAt?: string;
  nextRetryAt?: string;
  degradedSince?: string;
}

/**
 * Pure projection from bind status to the `/health` broker field. `enabled`
 * comes from `readBrokerEnv(...).enabled` (keys configured or not);
 * `status` is the live status last reported by `startBrokerWithRetry`'s
 * `onStatus`, or `null` before the first callback fires.
 */
export function computeBrokerHealthField(
  enabled: boolean,
  status: BrokerBindStatus | null,
): BrokerHealthField {
  if (!enabled) {
    return { configured: false, state: "disabled", listening: false, degraded: false };
  }
  const s = status ?? { state: "starting" as const, host: "", port: 0, attempts: 0 };
  return {
    configured: true,
    state: s.state,
    host: s.host,
    port: s.port,
    listening: s.state === "listening",
    degraded: s.state === "retrying" || s.state === "failed",
    attempts: s.attempts,
    lastError: s.lastError,
    lastErrorCode: s.lastErrorCode,
    boundAt: s.boundAt,
    nextRetryAt: s.nextRetryAt,
    degradedSince: s.degradedSince,
  };
}
