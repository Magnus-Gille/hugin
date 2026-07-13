import { describe, expect, it, vi } from "vitest";
import { M5CodeLoopClient, M5CodeLoopError } from "../src/learning/m5-code-loop-client.js";

function rpcResult(value: unknown, isError = false): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(value) }],
      ...(isError ? { isError: true } : {}),
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("M5CodeLoopClient", () => {
  it("calls the owner-gated tool without leaking the token into the body", async () => {
    const fetchImpl = vi.fn(async () => rpcResult({ work_id: "cl-1", status: "running" }));
    const client = new M5CodeLoopClient({
      endpoint: "http://m5.test:8080/mcp",
      bearerToken: "owner-secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await client.start({ instruction: "fix", files: [{ path: "a.ts", content: "x" }] }))
      .toEqual({ work_id: "cl-1", status: "running" });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer owner-secret");
    expect(String(init?.body)).not.toContain("owner-secret");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      method: "tools/call",
      params: { name: "code_loop_start" },
    });
  });

  it("surfaces structured tool refusals without credential content", async () => {
    const client = new M5CodeLoopClient({
      endpoint: "http://m5.test:8080/mcp",
      bearerToken: "owner-secret",
      fetchImpl: (async () => rpcResult({ refusal: "busy" }, true)) as typeof fetch,
    });
    await expect(client.start({ instruction: "fix", files: [{ path: "a", content: "b" }] }))
      .rejects.toMatchObject({
        name: "M5CodeLoopError",
        detail: { refusal: "busy" },
        ambiguousOutcome: false,
      });
  });

  it("marks transport failures as ambiguous for mutating calls", async () => {
    const client = new M5CodeLoopClient({
      endpoint: "http://m5.test:8080/mcp",
      bearerToken: "x",
      fetchImpl: (async () => {
        throw new TypeError("connection reset");
      }) as typeof fetch,
    });
    await expect(client.start({ instruction: "fix", files: [{ path: "a", content: "b" }] }))
      .rejects.toMatchObject({
        name: "M5CodeLoopError",
        ambiguousOutcome: true,
      });
  });

  it("rejects unsafe or wrong-path endpoints", () => {
    expect(() => new M5CodeLoopClient({
      endpoint: "http://secret@m5.test:8080/mcp",
      bearerToken: "x",
    })).toThrow(/credentials/);
    expect(() => new M5CodeLoopClient({
      endpoint: "http://m5.test:8080/v1",
      bearerToken: "x",
    })).toThrow(/\/mcp/);
  });

  it("uses a typed error for malformed tool content", async () => {
    const client = new M5CodeLoopClient({
      endpoint: "http://m5.test:8080/mcp",
      bearerToken: "x",
      fetchImpl: (async () => new Response(JSON.stringify({
        jsonrpc: "2.0", id: 1, result: { content: [] },
      }), { status: 200 })) as typeof fetch,
    });
    await expect(client.status("cl-1")).rejects.toBeInstanceOf(M5CodeLoopError);
  });
});
