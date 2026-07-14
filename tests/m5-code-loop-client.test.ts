import { describe, expect, it, vi } from "vitest";
import {
  M5CodeLoopClient,
  M5CodeLoopError,
  m5ClientRunId,
  startM5CodeLoopDurably,
  supportsM5CodeLoopContract,
  type M5CodeLoopRequest,
} from "../src/learning/m5-code-loop-client.js";

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

function startResult(overrides: Record<string, unknown> = {}) {
  return {
    work_id: "cl-1",
    status: "running",
    client_run_id: "hugin:run-1",
    request_fingerprint: `sha256:${"a".repeat(64)}`,
    recovered: false,
    capabilities: {
      start_idempotency: "client-run-id-v1",
      agent_checks: "pi-bash-events-v3",
    },
    ...overrides,
  };
}

function terminalResult() {
  return {
    status: "completed",
    diff: "",
    diff_truncated: false,
    changed_files: [],
    protected_violations: [],
    summary: "",
    check: { ran: false, exit_code: null, output_tail: "" },
    usage: { turns: 1, wall_ms: 2, prompt_tokens: 3, completion_tokens: 4 },
    work_id: "cl-1",
    detail: "",
  };
}

describe("M5CodeLoopClient", () => {
  it("calls the owner-gated tool without leaking the token into the body", async () => {
    const fetchImpl = vi.fn(async () => rpcResult(startResult()));
    const client = new M5CodeLoopClient({
      endpoint: "http://m5.test:8080/mcp",
      bearerToken: "owner-secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await client.start({
      client_run_id: "hugin:run-1",
      instruction: "fix",
      files: [{ path: "a.ts", content: "x" }],
    })).toEqual(startResult());
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer owner-secret");
    expect(String(init?.body)).not.toContain("owner-secret");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      method: "tools/call",
      params: {
        name: "code_loop_start",
        arguments: { client_run_id: "hugin:run-1" },
      },
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

  it("does not label read-only transport failures as ambiguous mutations", async () => {
    const client = new M5CodeLoopClient({
      endpoint: "http://m5.test:8080/mcp",
      bearerToken: "x",
      fetchImpl: (async () => {
        throw new TypeError("connection reset");
      }) as typeof fetch,
    });
    await expect(client.status("cl-1")).rejects.toMatchObject({
      name: "M5CodeLoopError",
      ambiguousOutcome: false,
    });
  });

  it("marks an invalid start envelope ambiguous after the mutating call reached M5", async () => {
    const client = new M5CodeLoopClient({
      endpoint: "http://m5.test:8080/mcp",
      bearerToken: "x",
      fetchImpl: (async () => rpcResult(startResult({
        capabilities: {
          start_idempotency: "client-run-id-v1",
          agent_checks: "pi-bash-events-v2",
        },
      }))) as typeof fetch,
    });
    await expect(client.start({
      client_run_id: "hugin:run-1",
      instruction: "fix",
      files: [{ path: "a", content: "b" }],
    })).rejects.toMatchObject({
      name: "M5CodeLoopError",
      ambiguousOutcome: true,
    });
  });

  it("recovers a schema-valid start that omitted its durable binding", async () => {
    let calls = 0;
    const request: M5CodeLoopRequest & { client_run_id: string } = {
      client_run_id: "hugin:run-1",
      instruction: "fix",
      files: [{ path: "a", content: "b" }],
    };
    const client = {
      start: async () => {
        calls += 1;
        return calls === 1
          ? startResult({ client_run_id: null, request_fingerprint: null })
          : startResult({ recovered: true });
      },
    };
    const result = await startM5CodeLoopDurably(client, request, {
      maxAttempts: 2,
      sleep: async () => {},
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ client_run_id: request.client_run_id, recovered: true });
  });

  it("parses a recovered terminal result without requiring a second result call", async () => {
    const recovered = startResult({
      status: "completed",
      recovered: true,
      result: terminalResult(),
    });
    const client = new M5CodeLoopClient({
      endpoint: "http://m5.test:8080/mcp",
      bearerToken: "x",
      fetchImpl: (async () => rpcResult(recovered)) as typeof fetch,
    });
    expect((await client.start({
      client_run_id: "hugin:run-1",
      instruction: "fix",
      files: [{ path: "a", content: "b" }],
    })).result).toEqual(terminalResult());
  });

  it("retries the byte-identical durable request after ambiguity and an admission busy", async () => {
    const request: M5CodeLoopRequest & { client_run_id: string } = {
      client_run_id: "hugin:run-1",
      instruction: "fix",
      files: [{ path: "a", content: "b" }],
    };
    const start = vi.fn()
      .mockRejectedValueOnce(new M5CodeLoopError("lost", undefined, true))
      .mockRejectedValueOnce(new M5CodeLoopError("busy", { refusal: "busy" }))
      .mockResolvedValueOnce(startResult());
    const sleeps: number[] = [];
    const recovered = await startM5CodeLoopDurably({ start }, request, {
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(recovered.work_id).toBe("cl-1");
    expect(start).toHaveBeenCalledTimes(3);
    expect(start.mock.calls.every(([actual]) => actual === request)).toBe(true);
    expect(sleeps).toEqual([500, 1_000]);
  });

  it("derives a stable bounded client id without embedding the experiment run id", () => {
    const runId = "experiment:sample:challenger:abcdef";
    expect(m5ClientRunId(runId)).toMatch(/^hugin:[a-f0-9]{64}$/);
    expect(m5ClientRunId(runId)).toBe(m5ClientRunId(runId));
    expect(m5ClientRunId(runId)).not.toContain("sample");
  });

  it("preflights the exact advertised producer contract before a paid start", () => {
    const tool = {
      name: "code_loop_start",
      description: "Start work. contract[harness=code-loop-pi-2026-07-14-v6;agent_checks=pi-bash-events-v3;schema=3;max_attempts=1000]",
      inputSchema: { properties: { client_run_id: {}, caps: { properties: { edit_deadline_turn: {} } } } },
    };
    expect(supportsM5CodeLoopContract([tool])).toBe(true);
    expect(supportsM5CodeLoopContract([{ ...tool, description: tool.description.replace("v3", "v2") }])).toBe(false);
    expect(supportsM5CodeLoopContract([{ ...tool, inputSchema: { properties: { caps: { properties: { edit_deadline_turn: {} } } } } }])).toBe(false);
    expect(supportsM5CodeLoopContract([{ ...tool, inputSchema: { properties: { client_run_id: {} } } }])).toBe(false);
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
