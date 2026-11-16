/**
 * Munin Memory HTTP client.
 * Talks to Munin's JSON-RPC 2.0 API over HTTP (stateless mode — no handshake needed).
 */

import { z } from "zod";
import type { CodeHealthAppendRequest } from "./friction/outbox.js";

// Keep the client dependency one-way: importing the outbox schema here would
// make MuninClient -> outbox -> friction modules part of the legacy friction
// startup graph. This local fixed-API shape check avoids that runtime cycle.
const codeHealthAppendRequestSchema = z.object({
  action: z.literal("append"),
  namespace: z.string().min(1).max(200),
  idempotency_key: z.string().uuid(),
  record: z.record(z.string(), z.unknown()),
  classification: z.enum(["public", "internal", "client-confidential", "client-restricted"]).optional(),
  expected_updated_at: z.string().datetime().optional(),
}).strict();

export interface MuninEntry {
  id: string;
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  classification?: string;
  created_at: string;
  updated_at: string;
}

export interface MuninQueryResult {
  id: string;
  namespace: string;
  key: string | null;
  entry_type: string;
  content_preview: string;
  tags: string[];
  classification?: string;
  created_at: string;
  updated_at: string;
}

export interface MuninClientConfig {
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  minRequestSpacingMs?: number;
  maxBatchReads?: number;
  /** Low-cardinality caller label used only in aggregate call statistics. */
  label?: string;
}

export interface MuninReadRequest {
  namespace: string;
  key: string;
}

export interface MuninRequestOptions {
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

export interface MuninHealthOptions {
  requestTimeoutMs?: number;
}

export type MuninReadResult =
  | (MuninEntry & { found: true })
  | { namespace: string; key: string; found: false };

export type MuninWriteConflictReason = "already_exists" | "version_mismatch";

export interface MuninWriteRejection {
  error: string;
  message?: string;
  conflict_reason?: unknown;
  current_updated_at?: unknown;
  [key: string]: unknown;
}

/** Typed application-level rejection returned by Munin's memory_write tool. */
export class MuninWriteRejectedError extends Error {
  readonly errorCode: string;
  readonly conflictReason?: MuninWriteConflictReason;
  readonly currentUpdatedAt?: string;

  constructor(namespace: string, key: string, rejection: MuninWriteRejection) {
    const detail = rejection.message ?? JSON.stringify(rejection);
    super(`Munin write rejected for ${namespace}/${key}: ${rejection.error} — ${detail}`);
    this.name = "MuninWriteRejectedError";
    this.errorCode = rejection.error;
    this.conflictReason = rejection.conflict_reason === "already_exists" ||
      rejection.conflict_reason === "version_mismatch"
      ? rejection.conflict_reason
      : undefined;
    this.currentUpdatedAt = typeof rejection.current_updated_at === "string"
      ? rejection.current_updated_at
      : undefined;
  }
}

/** Explicit application-level refusal from memory_code_health. */
export class MuninCodeHealthRejectedError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string) {
    super("Munin code-health append was explicitly rejected.");
    this.name = "MuninCodeHealthRejectedError";
    this.errorCode = errorCode;
  }
}

let rpcId = 0;

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Munin request aborted");
  error.name = "AbortError";
  return error;
}

export function composeAbortSignals(signals: readonly AbortSignal[]): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([...signals]), cleanup: () => {} };
  }

  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const cleanup = (): void => {
    for (const { signal, listener } of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.length = 0;
  };

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      cleanup();
      break;
    }
    const listener = (): void => {
      controller.abort(signal.reason);
      cleanup();
    };
    listeners.push({ signal, listener });
    signal.addEventListener("abort", listener, { once: true });
  }

  return { signal: controller.signal, cleanup };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForRequestSlot(
  previous: Promise<void>,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (acquired: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(acquired);
    };
    const onAbort = (): void => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    previous.then(() => finish(true));
  });
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(headerValue);
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return null;
}

function isRetryableFetchError(err: unknown): boolean {
  return err instanceof Error && (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    err instanceof TypeError
  );
}

interface MuninCallStat {
  calls: number;
  rateLimited: number;
}

/** Aggregate per-process Munin call counts (label, tool, namespace bucket). */
const muninCallStats = new Map<string, MuninCallStat>();

/**
 * Reduce a namespace to a low-cardinality, content-blind bucket: the first
 * segment plus `*`, except Hugin's reserved `tasks/_<name>` singletons.
 */
export function muninNamespaceBucket(namespace: unknown): string {
  if (typeof namespace !== "string" || namespace.length === 0) return "-";
  const [first, second] = namespace.split("/");
  if (first === "tasks" && second?.startsWith("_")) return `tasks/${second}`;
  return second === undefined || second === "" ? `${first}/` : `${first}/*`;
}

export interface MuninCallStatRow {
  label: string;
  tool: string;
  namespace: string;
  calls: number;
  rateLimited: number;
}

/** Return the call counts gathered since the last drain, busiest first, and reset them. */
export function drainMuninCallStats(): MuninCallStatRow[] {
  const rows: MuninCallStatRow[] = [];
  for (const [key, stat] of muninCallStats) {
    const [label, tool, namespace] = key.split("\0");
    rows.push({ label, tool, namespace, ...stat });
  }
  muninCallStats.clear();
  return rows.sort((a, b) => b.calls - a.calls || a.label.localeCompare(b.label));
}

/** One log line summarising the busiest call buckets, or null when idle. */
export function formatMuninCallStats(rows: MuninCallStatRow[], limit = 15): string | null {
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, row) => sum + row.calls, 0);
  const limited = rows.reduce((sum, row) => sum + row.rateLimited, 0);
  const top = rows
    .slice(0, limit)
    .map((row) => `${row.label}:${row.tool}:${row.namespace}=${row.calls}` +
      (row.rateLimited > 0 ? `(429x${row.rateLimited})` : ""))
    .join(" ");
  const more = rows.length > limit ? ` +${rows.length - limit} more` : "";
  return `total=${total} rate_limited=${limited} ${top}${more}`;
}

function recordMuninCall(label: string, tool: string, namespace: unknown, rateLimited: boolean): void {
  const key = [label, tool, muninNamespaceBucket(namespace)].join("\0");
  const stat = muninCallStats.get(key) ?? { calls: 0, rateLimited: 0 };
  stat.calls += 1;
  if (rateLimited) stat.rateLimited += 1;
  muninCallStats.set(key, stat);
}

/**
 * Earliest time (epoch ms) at which any client may call a given Munin base URL.
 *
 * Munin's rate limiter counts per credential, and the dispatcher runs several
 * MuninClient instances (main loop, lease, cancel watch, reaper) on the same
 * bearer. A 429 seen by one of them must therefore slow all of them, not only
 * the request that was refused (HUGIN-414).
 */
const sharedNextRequestAt = new Map<string, number>();
const MAX_SHARED_BACKOFF_MS = 60_000;

/** Test-only: forget all shared rate-limit backoff. */
export function resetSharedMuninBackoffForTests(): void {
  sharedNextRequestAt.clear();
}

export class MuninClient {
  private baseUrl: string;
  private apiKey: string;
  private sessionId: string;
  private requestTimeoutMs: number;
  private maxRetries: number;
  private retryBaseDelayMs: number;
  private minRequestSpacingMs: number;
  private maxBatchReads: number;
  private requestQueue: Promise<void>;
  private nextRequestAt: number;
  private label: string;

  constructor(config: MuninClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.sessionId = crypto.randomUUID();
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 250;
    this.minRequestSpacingMs = config.minRequestSpacingMs ?? 75;
    this.maxBatchReads = config.maxBatchReads ?? 20;
    this.requestQueue = Promise.resolve();
    this.nextRequestAt = 0;
    this.label = config.label ?? "unlabeled";
  }

  /**
   * Override the current mcp-session-id header value. Used by the dispatcher to
   * scope a session to a single task execution so Munin's correlation window
   * can associate queries with their outcomes.
   */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /** Return the currently active session ID (for logging/tests). */
  getSessionId(): string {
    return this.sessionId;
  }

  private deferNextRequest(delayMs: number): void {
    this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + Math.max(0, delayMs));
  }

  /** Back off every client of this Munin after a rate-limit response. */
  private deferSharedRequests(delayMs: number): void {
    // Cap so a malformed Retry-After cannot stall the dispatcher for long.
    const cappedMs = Math.min(Math.max(0, delayMs), MAX_SHARED_BACKOFF_MS);
    const until = Date.now() + cappedMs;
    const current = sharedNextRequestAt.get(this.baseUrl) ?? 0;
    if (until > current) sharedNextRequestAt.set(this.baseUrl, until);
    this.deferNextRequest(cappedMs);
  }

  private getRetryDelayMs(attempt: number, retryAfterHeader: string | null): number {
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    if (retryAfterMs !== null) {
      return retryAfterMs;
    }
    return this.retryBaseDelayMs * 2 ** attempt;
  }

  private async withRequestSlot<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.requestQueue;
    let release!: () => void;
    this.requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    let acquired = true;
    if (signal) acquired = await waitForRequestSlot(previous, signal);
    else await previous;
    if (!acquired) {
      // Preserve queue ordering even though this canceled caller returns now.
      void previous.then(release);
      throw abortReason(signal!);
    }

    try {
      // Re-check after each sleep: a sibling client's 429 may have pushed the
      // shared deadline further out while this one was waiting.
      while (true) {
        const sharedAt = sharedNextRequestAt.get(this.baseUrl) ?? 0;
        const waitMs = Math.max(this.nextRequestAt, sharedAt) - Date.now();
        if (waitMs <= 0) break;
        await sleep(waitMs, signal);
      }
      return await fn();
    } finally {
      this.deferNextRequest(this.minRequestSpacingMs);
      release();
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    options: MuninRequestOptions = {},
  ): Promise<unknown> {
    return this.withRequestSlot(async () => {
      const body = {
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      };

      let attempt = 0;
      const maxRetries = options.maxRetries ?? this.maxRetries;
      const requestTimeoutMs = options.requestTimeoutMs ?? this.requestTimeoutMs;

      while (true) {
        let cleanupRequestSignal = (): void => {};
        try {
          if (options.signal?.aborted) throw abortReason(options.signal);
          const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
          const requestAbort = options.signal
            ? composeAbortSignals([options.signal, timeoutSignal])
            : { signal: timeoutSignal, cleanup: () => {} };
          cleanupRequestSignal = requestAbort.cleanup;
          const res = await fetch(`${this.baseUrl}/mcp`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "mcp-session-id": this.sessionId,
            },
            body: JSON.stringify(body),
            signal: requestAbort.signal,
          });

          recordMuninCall(this.label, name, args.namespace, res.status === 429);
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            const shouldRetry =
              (res.status === 429 || res.status >= 500) &&
              attempt < maxRetries;
            const retryDelayMs = this.getRetryDelayMs(
              attempt,
              res.headers.get("retry-after")
            );
            if (res.status === 429) {
              // Honour Munin's wait even when this request gives up, and
              // across every client sharing this Munin and credential.
              this.deferSharedRequests(retryDelayMs);
            }
            if (shouldRetry) {
              this.deferNextRequest(retryDelayMs);
              await sleep(retryDelayMs, options.signal);
              attempt++;
              continue;
            }
            throw new Error(`Munin ${res.status}: ${text}`);
          }

          // Parse SSE response — extract the last data line with a JSON-RPC result
          const text = await res.text();
          const lines = text.split("\n");
          let lastData = "";
          for (const line of lines) {
            if (line.startsWith("data:")) {
              lastData = line.slice(5).trimStart();
            }
          }

          if (!lastData) {
            // Maybe it's a plain JSON response
            const parsed = JSON.parse(text);
            if (parsed.result?.content?.[0]?.text) {
              return JSON.parse(parsed.result.content[0].text);
            }
            return parsed;
          }

          const rpc = JSON.parse(lastData);
          if (rpc.error) {
            throw new Error(`Munin RPC error: ${JSON.stringify(rpc.error)}`);
          }
          const content = rpc.result?.content?.[0]?.text;
          if (content) {
            return JSON.parse(content);
          }
          return rpc.result;
        } catch (err) {
          if (options.signal?.aborted) throw abortReason(options.signal);
          if (attempt < maxRetries && isRetryableFetchError(err)) {
            const retryDelayMs = this.getRetryDelayMs(attempt, null);
            this.deferNextRequest(retryDelayMs);
            await sleep(retryDelayMs, options.signal);
            attempt++;
            continue;
          }
          if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
            throw new Error(`Munin request timed out after ${requestTimeoutMs}ms`);
          }
          throw err;
        } finally {
          cleanupRequestSignal();
        }
      }
    }, options.signal);
  }

  async read(
    namespace: string,
    key: string,
    options: MuninRequestOptions = {},
  ): Promise<(MuninEntry & { found: true }) | null> {
    const result = (await this.callTool("memory_read", {
      namespace,
      key,
    }, options)) as { found: boolean } & MuninEntry;
    return result.found ? (result as MuninEntry & { found: true }) : null;
  }

  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
    createIfAbsent?: boolean,
    options: MuninRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    if (createIfAbsent === true && expectedUpdatedAt !== undefined) {
      throw new Error("Munin write preconditions createIfAbsent and expectedUpdatedAt are mutually exclusive");
    }
    const args: Record<string, unknown> = { namespace, key, content };
    if (tags) args.tags = tags;
    if (expectedUpdatedAt) args.expected_updated_at = expectedUpdatedAt;
    if (classification) args.classification = classification;
    if (createIfAbsent === true) args.create_if_absent = true;
    const result = (await this.callTool("memory_write", args, options)) as
      | Record<string, unknown>
      | undefined
      | null;
    if (result && result.ok === false) {
      const error = typeof result.error === "string" ? result.error : "unknown";
      throw new MuninWriteRejectedError(namespace, key, {
        ...result,
        error,
        ...(typeof result.message === "string" ? { message: result.message } : {}),
      });
    }
    return (result ?? {}) as Record<string, unknown>;
  }

  /** Fixed append adapter; callers cannot select a Munin tool or endpoint. */
  async codeHealthAppend(request: CodeHealthAppendRequest): Promise<unknown> {
    const parsed = codeHealthAppendRequestSchema.parse(request);
    const args: Record<string, unknown> = {
      action: "append",
      namespace: parsed.namespace,
      idempotency_key: parsed.idempotency_key,
      record: parsed.record,
    };
    if (parsed.classification !== undefined) args.classification = parsed.classification;
    if (parsed.expected_updated_at !== undefined) args.expected_updated_at = parsed.expected_updated_at;
    const result = await this.callTool("memory_code_health", args, {
      signal: AbortSignal.timeout(2_000),
      requestTimeoutMs: 2_000,
      maxRetries: 0,
    });
    if (
      typeof result === "object" && result !== null
      && "ok" in result && result.ok === false
      && "action" in result && result.action === "code_health"
      && "error" in result && typeof result.error === "string"
    ) {
      throw new MuninCodeHealthRejectedError(result.error);
    }
    return result;
  }

  async readBatch(reads: MuninReadRequest[]): Promise<MuninReadResult[]> {
    if (reads.length === 0) return [];
    const combinedResults: MuninReadResult[] = [];

    for (let index = 0; index < reads.length; index += this.maxBatchReads) {
      const chunk = reads.slice(index, index + this.maxBatchReads);
      const rawResult = await this.callTool("memory_read_batch", {
        reads: chunk,
      });
      const results = Array.isArray(rawResult)
        ? (rawResult as Array<Partial<MuninReadResult>>)
        : (rawResult as { results?: Array<Partial<MuninReadResult>> }).results;
      if (!results) {
        throw new Error("Munin readBatch returned an unexpected response shape");
      }
      if (results.length !== chunk.length) {
        throw new Error(
          `Munin readBatch returned ${results.length} result(s) for ${chunk.length} request(s)`
        );
      }

      combinedResults.push(
        ...results.map((entry, chunkIndex) => {
          const expected = chunk[chunkIndex]!;
          if (
            entry.namespace !== expected.namespace ||
            entry.key !== expected.key
          ) {
            throw new Error(
              `Munin readBatch result mismatch at index ${chunkIndex}: expected ${expected.namespace}/${expected.key}, got ${entry.namespace || "unknown"}/${entry.key || "unknown"}`
            );
          }

          if (entry.found) {
            return entry as MuninEntry & { found: true };
          }
          return {
            namespace: expected.namespace,
            key: expected.key,
            found: false as const,
          };
        })
      );
    }

    return combinedResults;
  }

  async query(opts: {
    /**
     * Omit for filter-only browsing. Munin orders filter-only results by
     * updated_at DESC, which is the ordering required by the capped-window
     * paginator. Supplying a search query switches to relevance ordering.
     */
    query?: string;
    tags?: string[];
    namespace?: string;
    limit?: number;
    entry_type?: string;
    since?: string;
    until?: string;
  }, options: MuninRequestOptions = {}): Promise<{ results: MuninQueryResult[]; total: number }> {
    const args: Record<string, unknown> = {};
    if (opts.query) args.query = opts.query;
    if (opts.tags) args.tags = opts.tags;
    if (opts.namespace) args.namespace = opts.namespace;
    if (opts.limit) args.limit = opts.limit;
    if (opts.entry_type) args.entry_type = opts.entry_type;
    if (opts.since) args.since = opts.since;
    if (opts.until) args.until = opts.until;
    return (await this.callTool("memory_query", args, options)) as {
      results: MuninQueryResult[];
      total: number;
    };
  }

  async log(
    namespace: string,
    content: string,
    tags?: string[]
  ): Promise<void> {
    const args: Record<string, unknown> = { namespace, content };
    if (tags) args.tags = tags;
    await this.callTool("memory_log", args);
  }

  async health(options: MuninHealthOptions = {}): Promise<boolean> {
    const timeoutMs = options.requestTimeoutMs ?? this.requestTimeoutMs;
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
