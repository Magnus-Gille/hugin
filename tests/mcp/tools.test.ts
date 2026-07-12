import { describe, expect, it, vi } from "vitest";
import {
  ALIAS_MAP_VERSION,
  ENVELOPE_VERSION,
  buildTools,
} from "../../src/mcp/tools.js";
import {
  BrokerHttpError,
  BrokerNetworkError,
  type BrokerClient,
} from "../../src/mcp/broker-client.js";

function fakeBroker(overrides: Partial<BrokerClient> = {}): BrokerClient {
  const noop = vi.fn(async () => ({}));
  return {
    submit: noop,
    await_: noop,
    rate: noop,
    list: noop,
    models: noop,
    ...overrides,
  } as unknown as BrokerClient;
}

function parseResult(result: { content: { text: string }[]; isError?: boolean }): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe("buildTools — hugin_submit", () => {
  it("forwards a one-shot envelope with auto-generated idempotency key", async () => {
    const submit = vi.fn(async () => ({ task_id: "t1", state: "pending" }));
    const broker = fakeBroker({ submit });
    const tools = buildTools({
      broker,
      sessionId: "sess-fixed",
      submitter: "claude-code",
      newId: () => "11111111-1111-4111-8111-111111111111",
    });

    const result = await tools.submit.handler({
      task_type: "summarize",
      prompt: "Summarize this.",
      alias_requested: "m5",
    });

    expect(result.isError).toBeUndefined();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({
      envelope_version: ENVELOPE_VERSION,
      idempotency_key: "11111111-1111-4111-8111-111111111111",
      orchestrator_session_id: "sess-fixed",
      orchestrator_submitter: "claude-code",
      parent_task_id: undefined,
      task_type: "summarize",
      prompt: "Summarize this.",
      alias_requested: "m5",
      alias_map_version: ALIAS_MAP_VERSION,
      worktree: undefined,
      sensitivity: "internal",
      timeout_ms: 300_000,
      max_output_tokens: 4_096,
      acceptance: { mode: "l1_review" },
      allowed_destinations: ["m5"],
      tool_policy: { mode: "none" },
      budget: { max_attempts: 1, max_cost_usd: 0 },
      durability: "required",
      delivery: { mode: "munin" },
      escalation: { mode: "return_to_l1" },
    });
    expect(parseResult(result)).toEqual({
      task_id: "t1",
      state: "pending",
      idempotency_key: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("uses ToolDeps.aliasMapVersion when provided (F1 — broker-discovered version)", async () => {
    const submit = vi.fn(async () => ({ task_id: "t1" }));
    const broker = fakeBroker({ submit });
    const tools = buildTools({
      broker,
      sessionId: "sess",
      submitter: "claude-code",
      newId: () => "11111111-1111-4111-8111-111111111111",
      aliasMapVersion: 7,
    });

    await tools.submit.handler({
      task_type: "summarize",
      prompt: "p",
      alias_requested: "m5",
    });

    expect(submit.mock.calls[0]![0]).toMatchObject({ alias_map_version: 7 });
  });

  it("falls back to ALIAS_MAP_VERSION when ToolDeps.aliasMapVersion is omitted (F1)", async () => {
    const submit = vi.fn(async () => ({ task_id: "t1" }));
    const broker = fakeBroker({ submit });
    const tools = buildTools({
      broker,
      sessionId: "sess",
      submitter: "claude-code",
      newId: () => "11111111-1111-4111-8111-111111111111",
    });

    await tools.submit.handler({
      task_type: "summarize",
      prompt: "p",
      alias_requested: "m5",
    });

    expect(submit.mock.calls[0]![0]).toMatchObject({
      alias_map_version: ALIAS_MAP_VERSION,
    });
  });

  it("echoes the auto-generated idempotency_key in error responses (F2)", async () => {
    const submit = vi.fn(async () => {
      throw new BrokerNetworkError("connection refused");
    });
    const broker = fakeBroker({ submit });
    const tools = buildTools({
      broker,
      sessionId: "sess",
      submitter: "claude-code",
      newId: () => "99999999-9999-4999-8999-999999999999",
    });

    const result = await tools.submit.handler({
      task_type: "summarize",
      prompt: "p",
      alias_requested: "m5",
    });

    expect(result.isError).toBe(true);
    const payload = parseResult(result) as {
      idempotency_key: string;
      error: { kind: string };
    };
    expect(payload.idempotency_key).toBe("99999999-9999-4999-8999-999999999999");
    expect(payload.error.kind).toBe("broker_network_error");
  });

  it("does not overwrite an idempotency_key the broker echoed back (F2)", async () => {
    const submit = vi.fn(async () => ({
      task_id: "t1",
      idempotency_key: "broker-echoed-key",
    }));
    const broker = fakeBroker({ submit });
    const tools = buildTools({
      broker,
      sessionId: "sess",
      submitter: "claude-code",
      newId: () => "should-not-replace",
    });

    const result = await tools.submit.handler({
      task_type: "summarize",
      prompt: "p",
      alias_requested: "m5",
    });

    expect(parseResult(result)).toMatchObject({
      idempotency_key: "broker-echoed-key",
    });
  });

  it("uses the caller-supplied idempotency_key when provided", async () => {
    const submit = vi.fn(async () => ({ task_id: "t2" }));
    const broker = fakeBroker({ submit });
    const tools = buildTools({
      broker,
      sessionId: "sess",
      submitter: "claude-code",
      newId: () => "should-not-be-used",
    });

    await tools.submit.handler({
      task_type: "summarize",
      prompt: "p",
      alias_requested: "m5",
      idempotency_key: "22222222-2222-4222-8222-222222222222",
    });

    expect(submit.mock.calls[0]![0]).toMatchObject({
      idempotency_key: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("does not advertise or submit aliases without a live Broker executor", async () => {
    const submit = vi.fn(async () => ({ task_id: "should-not-call" }));
    const broker = fakeBroker({ submit });
    const tools = buildTools({
      broker,
      sessionId: "sess",
      submitter: "claude-code",
      newId: () => "33333333-3333-4333-8333-333333333333",
    });

    const result = await tools.submit.handler({
      task_type: "code-edit",
      prompt: "Edit src/foo.ts",
      alias_requested: "pi-large-coder",
      worktree: { repo: "hugin", base_ref: "main" },
      sensitivity: "internal",
      timeout_ms: 600_000,
    } as unknown as Parameters<typeof tools.submit.handler>[0]);

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({
      error: { kind: "input_validation" },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("fails closed when Broker discovery found zero executable aliases", async () => {
    const submit = vi.fn(async () => ({ task_id: "should-not-call" }));
    const tools = buildTools({
      broker: fakeBroker({ submit }),
      sessionId: "sess",
      submitter: "claude-code",
      executableAliases: [],
    });

    const result = await tools.submit.handler({
      task_type: "summarize",
      prompt: "p",
      alias_requested: "m5",
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result)).toMatchObject({
      error: { kind: "input_validation" },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("returns an isError result with input_validation kind when input is invalid", async () => {
    const submit = vi.fn(async () => ({ task_id: "should-not-call" }));
    const broker = fakeBroker({ submit });
    const tools = buildTools({
      broker,
      sessionId: "sess",
      submitter: "claude-code",
    });

    const result = await tools.submit.handler({
      task_type: "summarize",
      prompt: "",
      alias_requested: "m5",
    } as unknown as Parameters<typeof tools.submit.handler>[0]);

    expect(result.isError).toBe(true);
    const payload = parseResult(result) as { error: { kind: string } };
    expect(payload.error.kind).toBe("input_validation");
    expect(submit).not.toHaveBeenCalled();
  });

  it("maps BrokerHttpError into a structured error result", async () => {
    const submit = vi.fn(async () => {
      throw new BrokerHttpError("HTTP 503", 503, { error: "upstream" });
    });
    const broker = fakeBroker({ submit });
    const tools = buildTools({
      broker,
      sessionId: "sess",
      submitter: "claude-code",
      newId: () => "44444444-4444-4444-8444-444444444444",
    });

    const result = await tools.submit.handler({
      task_type: "summarize",
      prompt: "p",
      alias_requested: "m5",
    });

    expect(result.isError).toBe(true);
    const payload = parseResult(result) as {
      error: { kind: string; http_status: number; body: unknown };
    };
    expect(payload.error.kind).toBe("broker_http_error");
    expect(payload.error.http_status).toBe(503);
    expect(payload.error.body).toEqual({ error: "upstream" });
  });

  it("maps BrokerNetworkError into a structured error result", async () => {
    const submit = vi.fn(async () => {
      throw new BrokerNetworkError("connection refused");
    });
    const broker = fakeBroker({ submit });
    const tools = buildTools({
      broker,
      sessionId: "sess",
      submitter: "claude-code",
      newId: () => "55555555-5555-4555-8555-555555555555",
    });

    const result = await tools.submit.handler({
      task_type: "summarize",
      prompt: "p",
      alias_requested: "m5",
    });

    expect(result.isError).toBe(true);
    const payload = parseResult(result) as { error: { kind: string } };
    expect(payload.error.kind).toBe("broker_network_error");
  });
});

describe("buildTools — hugin_await", () => {
  it("forwards task_id to broker.await_", async () => {
    const await_ = vi.fn(async () => ({ state: "completed" }));
    const broker = fakeBroker({ await_ });
    const tools = buildTools({ broker, sessionId: "sess", submitter: "claude-code" });

    const result = await tools.await_.handler({ task_id: "t-123" });

    // #164: the awaiting session id is autofilled from the envelope, so the
    // broker can distinguish a durable handoff from an ordinary same-session poll.
    expect(await_).toHaveBeenCalledWith({
      task_id: "t-123",
      orchestrator_session_id: "sess",
    });
    expect(parseResult(result)).toEqual({ state: "completed" });
  });
});

describe("buildTools — hugin_rate", () => {
  it("forwards full rating payload", async () => {
    const rate = vi.fn(async () => ({}));
    const broker = fakeBroker({ rate });
    const tools = buildTools({ broker, sessionId: "sess", submitter: "claude-code" });

    const result = await tools.rate.handler({
      task_id: "t-1",
      rating: "pass",
      rating_reason: "looked correct",
      verification_outcome: "accepted_unchanged",
    });

    expect(result.isError).toBeUndefined();
    expect(rate).toHaveBeenCalledWith({
      task_id: "t-1",
      rating: "pass",
      rating_reason: "looked correct",
      verification_outcome: "accepted_unchanged",
    });
  });
});

describe("buildTools — hugin_list", () => {
  it("forwards filters and serialises results", async () => {
    const list = vi.fn(async () => ({ tasks: [{ task_id: "t1" }] }));
    const broker = fakeBroker({ list });
    const tools = buildTools({ broker, sessionId: "sess", submitter: "claude-code" });

    const result = await tools.list.handler({ limit: 10, outcome: "completed", alias: "tiny" });

    expect(list).toHaveBeenCalledWith({ limit: 10, outcome: "completed", alias: "tiny" });
    expect(parseResult(result)).toEqual({ tasks: [{ task_id: "t1" }] });
  });
});

describe("buildTools — hugin_models", () => {
  it("calls broker.models with no arguments", async () => {
    const models = vi.fn(async () => ({ alias_map: { tiny: "ollama-pi" }, runtimes: [] }));
    const broker = fakeBroker({ models });
    const tools = buildTools({ broker, sessionId: "sess", submitter: "claude-code" });

    const result = await tools.models.handler({});

    expect(models).toHaveBeenCalledTimes(1);
    expect(parseResult(result)).toEqual({
      alias_map: { tiny: "ollama-pi" },
      runtimes: [],
    });
  });
});
