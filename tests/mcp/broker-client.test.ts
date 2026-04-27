import { describe, expect, it, vi } from "vitest";
import {
  BrokerClient,
  BrokerHttpError,
  BrokerNetworkError,
} from "../../src/mcp/broker-client.js";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("BrokerClient", () => {
  it("posts JSON with bearer token to /v1/delegate/submit", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ task_id: "t1" }),
    );
    const client = new BrokerClient({
      baseUrl: "http://broker.test:3033/",
      bearerToken: "secret-xyz",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.submit({ envelope_version: 1, prompt: "hi" });

    expect(result).toEqual({ task_id: "t1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://broker.test:3033/v1/delegate/submit");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-xyz");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({
      envelope_version: 1,
      prompt: "hi",
    });
  });

  it("issues GET on /v1/delegate/models without a body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ alias_map: {}, runtimes: [] }),
    );
    const client = new BrokerClient({
      baseUrl: "http://broker.test:3033",
      bearerToken: "tk",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.models();

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://broker.test:3033/v1/delegate/models");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
  });

  it("returns {} for 204 No Content", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 204 }),
    );
    const client = new BrokerClient({
      baseUrl: "http://broker.test:3033",
      bearerToken: "tk",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.rate({ task_id: "t1", rating: "pass" });
    expect(result).toEqual({});
  });

  it("throws BrokerHttpError with parsed body on non-2xx responses", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "bad-request", detail: "missing field" }, { status: 400 }),
    );
    const client = new BrokerClient({
      baseUrl: "http://broker.test:3033",
      bearerToken: "tk",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.submit({})).rejects.toMatchObject({
      name: "BrokerHttpError",
      httpStatus: 400,
      body: { error: "bad-request", detail: "missing field" },
    });
  });

  it("falls back to {raw: text} when error body is not JSON", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("upstream timeout", {
          status: 503,
          headers: { "content-type": "text/plain" },
        }),
    );
    const client = new BrokerClient({
      baseUrl: "http://broker.test:3033",
      bearerToken: "tk",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    try {
      await client.submit({});
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BrokerHttpError);
      const httpErr = err as BrokerHttpError;
      expect(httpErr.httpStatus).toBe(503);
      expect(httpErr.body).toEqual({ raw: "upstream timeout" });
    }
  });

  it("wraps fetch errors in BrokerNetworkError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = new BrokerClient({
      baseUrl: "http://broker.test:3033",
      bearerToken: "tk",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.submit({})).rejects.toBeInstanceOf(BrokerNetworkError);
  });

  it("converts AbortError into BrokerNetworkError with timeout context", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const client = new BrokerClient({
      baseUrl: "http://broker.test:3033",
      bearerToken: "tk",
      requestTimeoutMs: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.submit({})).rejects.toMatchObject({
      name: "BrokerNetworkError",
      message: expect.stringContaining("timed out"),
    });
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = new BrokerClient({
      baseUrl: "http://broker.test:3033/",
      bearerToken: "tk",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.models();
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://broker.test:3033/v1/delegate/models");
  });
});
