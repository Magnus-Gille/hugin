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
  created_at: string;
  updated_at: string;
}

export interface MuninClientConfig {
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

let rpcId = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  constructor(config: MuninClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.sessionId = crypto.randomUUID();
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 250;
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
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
            await sleep(this.retryBaseDelayMs * (attempt + 1));
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
          if (line.startsWith("data: ")) {
            lastData = line.slice(6);
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
          await sleep(this.retryBaseDelayMs * (attempt + 1));
          attempt++;
          continue;
        }
        if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
          throw new Error(`Munin request timed out after ${this.requestTimeoutMs}ms`);
        }
        throw err;
      }
    }
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
    expectedUpdatedAt?: string
  ): Promise<unknown> {
    const args: Record<string, unknown> = { namespace, key, content };
    if (tags) args.tags = tags;
    if (expectedUpdatedAt) args.expected_updated_at = expectedUpdatedAt;
    return this.callTool("memory_write", args);
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
