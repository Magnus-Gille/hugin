import { describe, expect, it, vi, afterEach } from "vitest";
import { MuninClient } from "../src/munin-client.js";

function rpcResponse(payload: unknown): Response {
  return new Response(
    `data: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ text: JSON.stringify(payload) }] },
    })}\n\n`,
    { status: 200 }
  );
}

describe("MuninClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries 429 responses before succeeding", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response('{"error":"Too many requests"}', { status: 429 })
      )
      .mockResolvedValueOnce(
        rpcResponse({ found: false, namespace: "tasks/demo", key: "status" })
      );

    const client = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "test-key",
      retryBaseDelayMs: 1,
    });

    const entry = await client.read("tasks/demo", "status");

    expect(entry).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries timeout errors before succeeding", async () => {
    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(
        rpcResponse({ found: false, namespace: "tasks/demo", key: "status" })
      );

    const client = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "test-key",
      retryBaseDelayMs: 1,
    });

    const entry = await client.read("tasks/demo", "status");

    expect(entry).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
