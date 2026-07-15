/**
 * HTTP client for the Pi-side orchestrator broker.
 *
 * Used by the hugin-mcp server (laptop-side). Wraps the delegation and
 * learning-loop endpoints with typed methods, bearer-token auth,
 * and bounded timeouts.
 *
 * The broker is exposed only on the Tailscale interface (per
 * docs/orchestrator-v1-data-model.md §1) so connection failures here
 * almost always mean: Pi is asleep, Tailscale is down, or
 * `HUGIN_BROKER_URL` is misconfigured. Errors carry enough context for
 * the skill to render a useful message to the user.
 */
export interface BrokerClientConfig {
  baseUrl: string;
  bearerToken: string;
  /**
   * Per-request timeout. Independent of `hugin_await`'s `max_wait_s`,
   * which is enforced server-side. Default 60s — high enough for slow
   * journals, low enough to surface a stuck Tailscale promptly.
   */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class BrokerHttpError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "BrokerHttpError";
  }
}

export class BrokerNetworkError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "BrokerNetworkError";
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class BrokerClient {
  private readonly baseUrl: URL;
  private readonly bearerToken: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: BrokerClientConfig) {
    let parsed: URL;
    try {
      parsed = new URL(config.baseUrl);
    } catch {
      throw new Error(`hugin-mcp: HUGIN_BROKER_URL is not a valid URL: ${config.baseUrl}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `hugin-mcp: HUGIN_BROKER_URL must be http(s); got ${parsed.protocol}`,
      );
    }
    if (parsed.username || parsed.password) {
      throw new Error(
        "hugin-mcp: HUGIN_BROKER_URL must not contain userinfo; pass credentials via HUGIN_BROKER_TOKEN",
      );
    }
    if (parsed.search || parsed.hash) {
      throw new Error("hugin-mcp: HUGIN_BROKER_URL must not contain a query string or fragment");
    }
    if (parsed.pathname !== "/" && parsed.pathname !== "") {
      throw new Error(
        `hugin-mcp: HUGIN_BROKER_URL must not contain a path prefix; got ${parsed.pathname}`,
      );
    }
    this.baseUrl = parsed;
    this.bearerToken = config.bearerToken;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async submit(payload: Record<string, unknown>): Promise<unknown> {
    return this.post("/v1/delegate/submit", payload);
  }

  async await_(payload: {
    task_id: string;
    max_wait_s?: number;
    orchestrator_session_id?: string;
  }): Promise<unknown> {
    return this.post("/v1/delegate/await", payload);
  }

  async rate(payload: Record<string, unknown>): Promise<unknown> {
    return this.post("/v1/delegate/rate", payload);
  }

  async reportFriction(payload: Record<string, unknown>): Promise<unknown> {
    return this.post("/v1/friction/report", payload);
  }

  async list(payload: Record<string, unknown>): Promise<unknown> {
    return this.post("/v1/delegate/list", payload);
  }

  async models(): Promise<unknown> {
    return this.get("/v1/delegate/models");
  }

  async experimentCreate(payload: Record<string, unknown>): Promise<unknown> {
    return this.post("/v1/learning/experiments/create", payload);
  }

  async experimentObserve(payload: Record<string, unknown>): Promise<unknown> {
    return this.post("/v1/learning/experiments/observe", payload);
  }

  async experimentRate(payload: Record<string, unknown>): Promise<unknown> {
    return this.post("/v1/learning/experiments/rate", payload);
  }

  async experimentStatus(payload: Record<string, unknown>): Promise<unknown> {
    return this.post("/v1/learning/experiments/status", payload);
  }

  async experimentPromote(payload: Record<string, unknown>): Promise<unknown> {
    return this.post("/v1/learning/experiments/promote", payload);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, "POST", body);
  }

  private async get(path: string): Promise<unknown> {
    return this.request(path, "GET");
  }

  private async request(path: string, method: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const url = new URL(path, this.baseUrl).toString();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new BrokerNetworkError(
          `request to ${path} timed out after ${this.requestTimeoutMs}ms`,
          err,
        );
      }
      throw new BrokerNetworkError(
        `request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    // 204 No Content (e.g. /rate) — return empty object.
    if (response.status === 204) return {};

    let parsed: unknown;
    const text = await response.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    if (!response.ok) {
      throw new BrokerHttpError(
        `broker ${method} ${path} returned HTTP ${response.status}`,
        response.status,
        parsed,
      );
    }
    return parsed;
  }
}
