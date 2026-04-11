/**
 * Munin Memory HTTP client.
 * Talks to Munin's JSON-RPC 2.0 API over HTTP (stateless mode — no handshake needed).
 */

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
}

export interface MuninReadRequest {
  namespace: string;
  key: string;
}

export type MuninReadResult =
  | (MuninEntry & { found: true })
  | { namespace: string; key: string; found: false };

let rpcId = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  private getRetryDelayMs(attempt: number, retryAfterHeader: string | null): number {
    const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
    if (retryAfterMs !== null) {
      return retryAfterMs;
    }
    return this.retryBaseDelayMs * 2 ** attempt;
  }

  private async withRequestSlot<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.requestQueue;
    let release!: () => void;
    this.requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      const waitMs = this.nextRequestAt - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      return await fn();
    } finally {
      this.deferNextRequest(this.minRequestSpacingMs);
      release();
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    return this.withRequestSlot(async () => {
      const body = {
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      };

      let attempt = 0;

      while (true) {
        try {
          const res = await fetch(`${this.baseUrl}/mcp`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "mcp-session-id": this.sessionId,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          });

          if (!res.ok) {
            const text = await res.text().catch(() => "");
            const shouldRetry =
              (res.status === 429 || res.status >= 500) &&
              attempt < this.maxRetries;
            if (shouldRetry) {
              const retryDelayMs = this.getRetryDelayMs(
                attempt,
                res.headers.get("retry-after")
              );
              this.deferNextRequest(retryDelayMs);
              await sleep(retryDelayMs);
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
          if (attempt < this.maxRetries && isRetryableFetchError(err)) {
            const retryDelayMs = this.getRetryDelayMs(attempt, null);
            this.deferNextRequest(retryDelayMs);
            await sleep(retryDelayMs);
            attempt++;
            continue;
          }
          if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
            throw new Error(`Munin request timed out after ${this.requestTimeoutMs}ms`);
          }
          throw err;
        }
      }
    });
  }

  async read(
    namespace: string,
    key: string
  ): Promise<(MuninEntry & { found: true }) | null> {
    const result = (await this.callTool("memory_read", {
      namespace,
      key,
    })) as { found: boolean } & MuninEntry;
    return result.found ? (result as MuninEntry & { found: true }) : null;
  }

  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { namespace, key, content };
    if (tags) args.tags = tags;
    if (expectedUpdatedAt) args.expected_updated_at = expectedUpdatedAt;
    if (classification) args.classification = classification;
    const result = (await this.callTool("memory_write", args)) as
      | Record<string, unknown>
      | undefined
      | null;
    if (result && result.ok === false) {
      const error = typeof result.error === "string" ? result.error : "unknown";
      const message =
        typeof result.message === "string" ? result.message : JSON.stringify(result);
      throw new Error(
        `Munin write rejected for ${namespace}/${key}: ${error} — ${message}`,
      );
    }
    return (result ?? {}) as Record<string, unknown>;
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
    query: string;
    tags?: string[];
    namespace?: string;
    limit?: number;
    entry_type?: string;
  }): Promise<{ results: MuninQueryResult[]; total: number }> {
    const args: Record<string, unknown> = { query: opts.query };
    if (opts.tags) args.tags = opts.tags;
    if (opts.namespace) args.namespace = opts.namespace;
    if (opts.limit) args.limit = opts.limit;
    if (opts.entry_type) args.entry_type = opts.entry_type;
    return (await this.callTool("memory_query", args)) as {
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

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
