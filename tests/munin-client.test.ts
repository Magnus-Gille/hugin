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

function rpcResponseNoSpace(payload: unknown): Response {
  return new Response(
    `event: message\ndata:${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ text: JSON.stringify(payload) }] },
    })}\n\n`,
    { status: 200 }
  );
}

describe("MuninClient", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("supports batch reads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      rpcResponse({
        results: [
          {
            found: true,
            id: "entry-1",
            namespace: "tasks/demo",
            key: "status",
            content: "hello",
            tags: ["pending"],
            created_at: "2026-04-02T10:00:00Z",
            updated_at: "2026-04-02T10:00:01Z",
          },
          {
            found: false,
            namespace: "tasks/missing",
            key: "status",
          },
        ],
      })
    );

    const client = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "test-key",
      minRequestSpacingMs: 0,
    });

    const results = await client.readBatch([
      { namespace: "tasks/demo", key: "status" },
      { namespace: "tasks/missing", key: "status" },
    ]);

    expect(results[0]).toMatchObject({
      found: true,
      namespace: "tasks/demo",
      key: "status",
      tags: ["pending"],
    });
    expect(results[1]).toEqual({
      found: false,
      namespace: "tasks/missing",
      key: "status",
    });
  });

  it("passes classification through memory_write", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(rpcResponse({ ok: true }));

    const client = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "test-key",
      minRequestSpacingMs: 0,
    });

    await client.write(
      "tasks/demo",
      "result",
      "hello",
      ["type:test"],
      undefined,
      "private",
    );

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const body = JSON.parse(String((request as RequestInit).body));
    expect(body.params.arguments.classification).toBe("private");
  });

  it("supports bare-array batch-read responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      rpcResponseNoSpace([
        {
          found: true,
          id: "entry-1",
          namespace: "tasks/demo",
          key: "status",
          content: "hello",
          tags: ["pending"],
          created_at: "2026-04-02T10:00:00Z",
          updated_at: "2026-04-02T10:00:01Z",
        },
      ])
    );

    const client = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "test-key",
      minRequestSpacingMs: 0,
    });

    const results = await client.readBatch([
      { namespace: "tasks/demo", key: "status" },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      found: true,
      namespace: "tasks/demo",
      key: "status",
    });
  });

  it("serializes concurrent requests through one request slot", async () => {
    let resolveFirst!: (value: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(
        rpcResponse({ found: false, namespace: "tasks/b", key: "status" })
      );

    const client = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "test-key",
      minRequestSpacingMs: 0,
    });

    const first = client.read("tasks/a", "status");
    const second = client.read("tasks/b", "status");

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirst(
      rpcResponse({ found: false, namespace: "tasks/a", key: "status" })
    );

    await first;
    await second;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors retry-after when retrying 429 responses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response('{"error":"Too many requests"}', {
          status: 429,
          headers: {
            "retry-after": "1",
          },
        })
      )
      .mockResolvedValueOnce(
        rpcResponse({ found: false, namespace: "tasks/demo", key: "status" })
      );

    const client = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "test-key",
      retryBaseDelayMs: 1,
      minRequestSpacingMs: 0,
    });

    const entryPromise = client.read("tasks/demo", "status");

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(900);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    const entry = await entryPromise;

    expect(entry).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("chunks oversized batch reads to the server limit", async () => {
    const firstChunk = Array.from({ length: 20 }, (_, index) => ({
      found: false,
      namespace: `tasks/demo-${index}`,
      key: "status",
    }));
    const secondChunk = [
      {
        found: false,
        namespace: "tasks/demo-20",
        key: "status",
      },
    ];

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(rpcResponse({ ok: true, action: "read_batch", results: firstChunk }))
      .mockResolvedValueOnce(rpcResponse({ ok: true, action: "read_batch", results: secondChunk }));

    const client = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "test-key",
      minRequestSpacingMs: 0,
      maxBatchReads: 20,
    });

    const results = await client.readBatch(
      Array.from({ length: 21 }, (_, index) => ({
        namespace: `tasks/demo-${index}`,
        key: "status",
      }))
    );

    expect(results).toHaveLength(21);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when batch cardinality does not match the request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      rpcResponse({
        ok: true,
        action: "read_batch",
        results: [
          {
            found: false,
            namespace: "tasks/demo-0",
            key: "status",
          },
        ],
      })
    );

    const client = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "test-key",
      minRequestSpacingMs: 0,
    });

    await expect(
      client.readBatch([
        { namespace: "tasks/demo-0", key: "status" },
        { namespace: "tasks/demo-1", key: "status" },
      ])
    ).rejects.toThrow("returned 1 result(s) for 2 request(s)");
  });

  it("fails closed when batch results are returned out of order", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      rpcResponse({
        ok: true,
        action: "read_batch",
        results: [
          {
            found: false,
            namespace: "tasks/demo-1",
            key: "status",
          },
          {
            found: false,
            namespace: "tasks/demo-0",
            key: "status",
          },
        ],
      })
    );

    const client = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "test-key",
      minRequestSpacingMs: 0,
    });

    await expect(
      client.readBatch([
        { namespace: "tasks/demo-0", key: "status" },
        { namespace: "tasks/demo-1", key: "status" },
      ])
    ).rejects.toThrow("Munin readBatch result mismatch");
  });

  it("sends a stable mcp-session-id header by default and rotates on setSessionId", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        rpcResponse({ found: false, namespace: "tasks/a", key: "status" })
      );

    const client = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "test-key",
      minRequestSpacingMs: 0,
    });

    const initialSession = client.getSessionId();
    expect(initialSession).toMatch(/^[0-9a-f-]{36}$/);

    await client.read("tasks/a", "status");
    await client.read("tasks/a", "status");

    const headers1 = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    const headers2 = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers1["mcp-session-id"]).toBe(initialSession);
    expect(headers2["mcp-session-id"]).toBe(initialSession);

    client.setSessionId("task-scoped-session");
    expect(client.getSessionId()).toBe("task-scoped-session");

    await client.read("tasks/a", "status");
    const headers3 = (fetchMock.mock.calls[2]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers3["mcp-session-id"]).toBe("task-scoped-session");
  });

  it("does not serialize requests across separate client instances", async () => {
    let resolveFirst!: (value: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(
        rpcResponse({ found: false, namespace: "tasks/b", key: "status" })
      );

    const backgroundClient = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "test-key",
      minRequestSpacingMs: 0,
    });
    const controlClient = new MuninClient({
      baseUrl: "http://munin.test",
      apiKey: "test-key",
      minRequestSpacingMs: 0,
    });

    const first = backgroundClient.read("tasks/a", "status");
    const second = controlClient.read("tasks/b", "status");

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveFirst(
      rpcResponse({ found: false, namespace: "tasks/a", key: "status" })
    );

    await first;
    await second;
  });
});
