import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
import {
  createHuginMcpServer,
  discoverBrokerContract,
} from "../../src/mcp/server-factory.js";
import { HUGIN_MCP_SERVER_INSTRUCTIONS } from "../../src/mcp/server-instructions.js";
import { makeExperimentInput, makeObservation } from "../fixtures/learning.js";

const ISSUE_318_WIRE_MODELS_RESPONSE = {
  alias_map_version: ALIAS_MAP_VERSION,
  effective_at: "2026-07-28T00:00:00.000Z",
  aliases: [{
    alias: "m5",
    runtime_row_id: "homeserver-m5",
  }],
  runtime_rows: [{
    id: "homeserver-m5",
    runtime: "homeserver",
    provider: "m5",
    egress: "loopback-only",
    family: "one-shot",
    auto_eligible: false,
    zdr_required: true,
  }],
  policy_version: "zdr-v1+rlv-v1",
} as const;
// Reproducible discovery gate:
// `byteLength(client.getInstructions()) + byteLength(JSON.stringify(await client.listTools()))`
// measured through the production `discoverBrokerContract()` + `createHuginMcpServer()` path.
// Parent `20f2cef` measured 30_361 bytes through its equivalent inline server construction.
// This source tree measures 28_632 bytes,
// so the ratchet allows only a 96-byte slack to 28_728 bytes.
const ISSUE_318_PARENT_DISCOVERY_BYTES = 30_361;
const ISSUE_318_CURRENT_DISCOVERY_BYTES = 28_632;
const ISSUE_318_DISCOVERY_SLACK_BYTES = 96;
const ISSUE_318_DISCOVERY_CEILING_BYTES =
  ISSUE_318_CURRENT_DISCOVERY_BYTES + ISSUE_318_DISCOVERY_SLACK_BYTES;
const M5_BOUNDARY_PHRASE =
  "M5 owns model/capability evidence; Hugin owns durable task, delivery, and review state.";
const M5_BOUNDED_LEAF_PHRASE =
  "Each `hugin_submit` is one bounded M5 `/delegate` leaf.";

function fakeBroker(overrides: Partial<BrokerClient> = {}): BrokerClient {
  const noop = vi.fn(async () => ({}));
  return {
    submit: noop,
    await_: noop,
    rate: noop,
    reportFriction: noop,
    list: noop,
    models: noop,
    experimentCreate: noop,
    experimentObserve: noop,
    experimentRate: noop,
    experimentStatus: noop,
    experimentPromote: noop,
    ...overrides,
  } as unknown as BrokerClient;
}

function parseResult(result: { content: { text: string }[]; isError?: boolean }): unknown {
  return JSON.parse(result.content[0]!.text);
}

async function connectWireClient(
  overrides: Partial<BrokerClient> = {},
): Promise<{
  client: Client;
  models: ReturnType<typeof vi.fn>;
  close: () => Promise<void>;
}> {
  const models = "models" in overrides && overrides.models
    ? overrides.models as ReturnType<typeof vi.fn>
    : vi.fn(async () => ISSUE_318_WIRE_MODELS_RESPONSE);
  const broker = fakeBroker({
    models,
    ...overrides,
  });
  const brokerContract = await discoverBrokerContract(broker);
  const server = createHuginMcpServer({
    broker,
    sessionId: "sess",
    submitter: "claude-code",
    brokerContract,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "wire-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    models,
    close: async () => {
      await client.close();
    },
  };
}

async function readWireDiscovery(client: Client): Promise<{
  instructions: string;
  listToolsResult: Awaited<ReturnType<Client["listTools"]>>;
  instructionsBytes: number;
  listResultBytes: number;
  combinedBytes: number;
}> {
  const listToolsResult = await client.listTools();
  const instructions = client.getInstructions() ?? "";
  const instructionsBytes = Buffer.byteLength(instructions, "utf8");
  const listResultBytes = Buffer.byteLength(JSON.stringify(listToolsResult), "utf8");
  return {
    instructions,
    listToolsResult,
    instructionsBytes,
    listResultBytes,
    combinedBytes: instructionsBytes + listResultBytes,
  };
}

function schemaPath(
  value: unknown,
  path: ReadonlyArray<string | number>,
): unknown {
  return path.reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === "number") {
      return Array.isArray(current) ? current[segment] : undefined;
    }
    return typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined;
  }, value);
}

function findToolDefinition(
  listToolsResult: Awaited<ReturnType<Client["listTools"]>>,
  name: string,
): Record<string, unknown> {
  const tool = listToolsResult.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool as Record<string, unknown>;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("hugin-mcp discovery wire surface", () => {
  it("emits InitializeResult.instructions and closed vocabularies through the real MCP client", async () => {
    const harness = await connectWireClient();
    try {
      const discovery = await readWireDiscovery(harness.client);
      const submitSchema = schemaPath(
        findToolDefinition(discovery.listToolsResult, "hugin_submit"),
        ["inputSchema"],
      );
      const rateSchema = schemaPath(
        findToolDefinition(discovery.listToolsResult, "hugin_rate"),
        ["inputSchema"],
      );
      const listSchema = schemaPath(
        findToolDefinition(discovery.listToolsResult, "hugin_list"),
        ["inputSchema"],
      );
      const createSchema = schemaPath(
        findToolDefinition(discovery.listToolsResult, "hugin_experiment_create"),
        ["inputSchema"],
      );
      const observeSchema = schemaPath(
        findToolDefinition(discovery.listToolsResult, "hugin_experiment_observe"),
        ["inputSchema"],
      );
      const experimentRateSchema = schemaPath(
        findToolDefinition(discovery.listToolsResult, "hugin_experiment_rate"),
        ["inputSchema"],
      );

      expect(harness.models).toHaveBeenCalledTimes(1);
      expect(discovery.instructions).toBe(HUGIN_MCP_SERVER_INSTRUCTIONS);
      expect(schemaPath(submitSchema, ["properties", "task_type", "enum"])).toEqual([
        "draft",
        "code-implement",
        "code-edit",
        "code-review",
        "unit-test-gen",
        "summarize",
        "extract",
        "classify",
        "data-transform",
        "regex",
        "sql",
        "reason-math",
        "reason-hard",
        "rewrite",
        "translate",
        "plan-decompose",
        "qa-factual",
        "triage",
        "memory-decision",
        "research-plan",
        "source-distill",
        "claim-verify",
        "gap-check",
        "synthesis",
        "conversation",
        "other",
      ]);
      expect(schemaPath(submitSchema, ["properties", "alias_requested", "enum"])).toEqual(["m5"]);
      expect(schemaPath(submitSchema, ["properties", "acceptance", "oneOf", 0, "properties", "mode", "const"])).toBe("l1_review");
      expect(schemaPath(submitSchema, ["properties", "acceptance", "oneOf", 1, "properties", "mode", "const"])).toBe("verifier");

      expect(schemaPath(rateSchema, ["properties", "rating", "enum"])).toEqual([
        "pass",
        "partial",
        "redo",
        "wrong",
      ]);
      expect(schemaPath(rateSchema, ["properties", "verification_outcome", "enum"])).toEqual([
        "accepted_unchanged",
        "minor_edit",
        "major_rewrite",
        "discarded",
        "escalated_to_claude",
      ]);
      expect(schemaPath(rateSchema, ["properties", "reviewer_role", "enum"])).toEqual([
        "independent",
        "self",
      ]);

      expect(schemaPath(listSchema, ["properties", "outcome", "enum"])).toEqual([
        "completed",
        "failed",
        "running",
        "any",
      ]);
      expect(schemaPath(createSchema, ["properties", "change_axis", "enum"])).toEqual([
        "logging",
        "test-harness",
        "agent-prompt",
        "agent-harness",
        "model",
        "model-config",
        "routing",
      ]);
      expect(schemaPath(createSchema, ["properties", "gates", "properties", "primaryMetric", "enum"])).toEqual([
        "quality-rate",
        "useful-rate",
        "rescue-rate",
        "latency-ms",
        "cost-usd",
        "human-review-seconds",
        "edit-start-ms",
        "observability-coverage",
        "verifier-score",
      ]);
      expect(schemaPath(createSchema, ["properties", "champion", "properties", "model", "properties", "config", "properties", "reasoning", "enum"])).toEqual([
        "off",
        "low",
        "medium",
        "high",
      ]);
      expect(schemaPath(observeSchema, ["properties", "arm", "enum"])).toEqual([
        "champion",
        "challenger",
      ]);
      expect(schemaPath(observeSchema, ["properties", "quality_outcome", "enum"])).toEqual([
        "pass",
        "fail",
        "unverified",
        "infra-error",
      ]);
      expect(schemaPath(observeSchema, ["properties", "product_outcome", "enum"])).toEqual([
        "accepted-unchanged",
        "minor-edit",
        "major-rewrite",
        "discarded",
        "unrated",
      ]);
      expect(schemaPath(observeSchema, ["properties", "verifier", "properties", "kind", "enum"])).toEqual([
        "mechanical",
        "human",
        "judge",
        "none",
      ]);
      expect(schemaPath(observeSchema, ["properties", "agent_checks", "properties", "state", "enum"])).toEqual([
        "none",
        "attempted",
        "unobservable",
        "partial",
      ]);
      expect(schemaPath(observeSchema, ["properties", "agent_checks", "properties", "attempts", "items", "properties", "kind", "enum"])).toEqual([
        "typescript",
        "test",
        "lint",
        "build",
        "validation",
      ]);
      expect(schemaPath(observeSchema, ["properties", "agent_checks", "properties", "attempts", "items", "properties", "status", "enum"])).toEqual([
        "passed",
        "failed",
        "execution-error",
      ]);
      expect(schemaPath(experimentRateSchema, ["properties", "product_outcome", "enum"])).toEqual([
        "accepted-unchanged",
        "minor-edit",
        "major-rewrite",
        "discarded",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("records the current discovery payload and ratchets it below the parent with small slack", async () => {
    const harness = await connectWireClient();
    try {
      const discovery = await readWireDiscovery(harness.client);
      expect(discovery.combinedBytes).toBe(ISSUE_318_CURRENT_DISCOVERY_BYTES);
      expect(discovery.combinedBytes).toBeLessThan(ISSUE_318_PARENT_DISCOVERY_BYTES);
      expect(discovery.combinedBytes).toBeLessThanOrEqual(ISSUE_318_DISCOVERY_CEILING_BYTES);
    } finally {
      await harness.close();
    }
  });

  it("preserves the M5/Hugin boundary exactly once and keeps await polling semantics discoverable", async () => {
    const harness = await connectWireClient();
    try {
      const discovery = await readWireDiscovery(harness.client);
      const awaitDescription = findToolDefinition(
        discovery.listToolsResult,
        "hugin_await",
      ).description;
      const toolDescriptions = discovery.listToolsResult.tools
        .map((tool) => tool.description)
        .filter((description): description is string => typeof description === "string");

      expect(discovery.instructions).toContain(M5_BOUNDED_LEAF_PHRASE);
      expect(discovery.instructions).toContain(M5_BOUNDARY_PHRASE);
      expect(countOccurrences(discovery.instructions, M5_BOUNDED_LEAF_PHRASE)).toBe(1);
      expect(countOccurrences(discovery.instructions, M5_BOUNDARY_PHRASE)).toBe(1);
      expect(toolDescriptions.filter((description) => description.includes(M5_BOUNDED_LEAF_PHRASE))).toEqual([]);
      expect(toolDescriptions.filter((description) => description.includes(M5_BOUNDARY_PHRASE))).toEqual([]);
      expect(awaitDescription).toContain("Returns immediately");
      expect(awaitDescription).toContain("safe to poll");
      expect(awaitDescription).toContain("`running` / `completed` / `failed`");
      expect(awaitDescription).toContain("`orphan_suspected`");
      expect(awaitDescription).toContain("once the lease has expired without completion");
    } finally {
      await harness.close();
    }
  });

  it("supports a naive schema-only caller submit and await sequence", async () => {
    const models = vi.fn(async () => ({
      ...ISSUE_318_WIRE_MODELS_RESPONSE,
      alias_map_version: 7,
    }));
    const submit = vi.fn(async () => ({ task_id: "t-wire", state: "pending" }));
    const await_ = vi.fn(async () => ({
      status: "completed",
      result: {
        outcome: "completed",
        exitCode: 0,
        bodyText: "done",
      },
    }));
    const harness = await connectWireClient({ models, submit, await_ });
    try {
      const discovery = await readWireDiscovery(harness.client);
      const aliasRequested = schemaPath(
        findToolDefinition(discovery.listToolsResult, "hugin_submit"),
        ["inputSchema", "properties", "alias_requested", "enum", 0],
      );

      const submitResult = await harness.client.callTool({
        name: "hugin_submit",
        arguments: {
          task_type: "summarize",
          prompt: "Summarize this.",
          alias_requested: aliasRequested,
        },
      });
      const submitPayload = parseResult(submitResult);
      expect(submitPayload).toMatchObject({
        task_id: "t-wire",
      });
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({
        alias_map_version: 7,
        alias_requested: "m5",
      }));

      const awaitResult = await harness.client.callTool({
        name: "hugin_await",
        arguments: {
          task_id: "t-wire",
          verbosity: "summary",
        },
      });
      expect(parseResult(awaitResult)).toEqual({
        task_id: "t-wire",
        status: "completed",
        outcome: "completed",
        exitCode: 0,
        bodyText: "done",
        refs: {
          status: { namespace: "tasks/t-wire", key: "status" },
          fullResult: { namespace: "tasks/t-wire", key: "result-structured" },
        },
      });
    } finally {
      await harness.close();
    }
  });
});

describe("buildTools — hugin_submit", () => {
  it.each(["draft", "conversation"] as const)(
    "accepts the additive M5 task type %s",
    async (taskType) => {
      const submit = vi.fn(async () => ({ task_id: `t-${taskType}`, state: "pending" }));
      const tools = buildTools({
        broker: fakeBroker({ submit }),
        sessionId: "sess-fixed",
        submitter: "claude-code",
        newId: () => "11111111-1111-4111-8111-111111111111",
      });

      const result = await tools.submit.handler({
        task_type: taskType,
        prompt: `Handle this ${taskType} task.`,
        alias_requested: "m5",
      });

      expect(result.isError).toBeUndefined();
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ task_type: taskType }));
    },
  );

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

  it("passes through a judgment-task warnings array from the broker response unchanged (#184)", async () => {
    const submit = vi.fn(async () => ({
      task_id: "t1",
      warnings: [
        "judgment-type task submitted without verifier or rubric — capability evidence will be weak",
      ],
    }));
    const broker = fakeBroker({ submit });
    const tools = buildTools({
      broker,
      sessionId: "sess",
      submitter: "claude-code",
      newId: () => "44444444-4444-4444-8444-444444444444",
    });

    const result = await tools.submit.handler({
      task_type: "classify",
      prompt: "Classify this ticket.",
      alias_requested: "m5",
    });

    expect(parseResult(result)).toMatchObject({
      task_id: "t1",
      warnings: [
        "judgment-type task submitted without verifier or rubric — capability evidence will be weak",
      ],
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

  it("returns the canonical response unchanged when full verbosity is explicit", async () => {
    const canonical = {
      status: "completed",
      result: {
        bodyText: "done",
        runtimeMetadata: { learningTask: { durable: "full provenance" } },
      },
    };
    const await_ = vi.fn(async () => canonical);
    const tools = buildTools({
      broker: fakeBroker({ await_ }),
      sessionId: "sess",
      submitter: "claude-code",
    });

    const result = await tools.await_.handler({ task_id: "t-full", verbosity: "full" });

    expect(await_).toHaveBeenCalledWith({
      task_id: "t-full",
      orchestrator_session_id: "sess",
    });
    expect(parseResult(result)).toEqual(canonical);
  });

  it("projects a compact terminal summary without forwarding verbosity", async () => {
    const await_ = vi.fn(async () => ({
      status: "completed",
      result: {
        schemaVersion: 1,
        taskId: "t-compact",
        outcome: "completed",
        exitCode: 0,
        bodyText: "done",
        runtimeMetadata: {
          effectiveModel: "qwen3-coder-next-80b",
          effectiveHost: "m5",
          delegation: {
            decisionReason: "Selected the strongest available local coding model.",
            verifierNotes: "large provenance field that must not be inlined",
          },
          learningTask: {
            gatewayEcho: { request: "large provenance field that must not be inlined" },
          },
        },
        sensitivity: {
          declared: "internal",
          effective: "internal",
          mismatch: false,
        },
      },
    }));
    const tools = buildTools({
      broker: fakeBroker({ await_ }),
      sessionId: "sess",
      submitter: "claude-code",
    });

    const result = await tools.await_.handler({
      task_id: "t-compact",
      verbosity: "summary",
    });

    expect(await_).toHaveBeenCalledWith({
      task_id: "t-compact",
      orchestrator_session_id: "sess",
    });
    expect(parseResult(result)).toEqual({
      task_id: "t-compact",
      status: "completed",
      outcome: "completed",
      exitCode: 0,
      bodyText: "done",
      effectiveModel: "qwen3-coder-next-80b",
      effectiveHost: "m5",
      delegationDecision: "Selected the strongest available local coding model.",
      sensitivity: {
        declared: "internal",
        effective: "internal",
        mismatch: false,
      },
      refs: {
        status: { namespace: "tasks/t-compact", key: "status" },
        fullResult: { namespace: "tasks/t-compact", key: "result-structured" },
      },
    });
  });

  it("preserves content-blind mismatch evidence in a compact terminal summary", async () => {
    const await_ = vi.fn(async () => ({
      status: "completed",
      result: {
        outcome: "completed",
        exitCode: 0,
        bodyText: "done",
        sensitivity: {
          declared: "internal",
          effective: "internal",
          mismatch: true,
          detectorMax: "private",
          reasons: [
            "declared:internal",
            "prompt:private",
            "owner-override:internal<private",
          ],
          override: { applied: true, detectorMax: "private" },
        },
      },
    }));
    const tools = buildTools({
      broker: fakeBroker({ await_ }),
      sessionId: "sess",
      submitter: "claude-code",
    });

    const result = await tools.await_.handler({
      task_id: "t-mismatch",
      verbosity: "summary",
    });

    expect(parseResult(result)).toMatchObject({
      sensitivity: {
        declared: "internal",
        effective: "internal",
        mismatch: true,
        detectorMax: "private",
        reasons: [
          "declared:internal",
          "prompt:private",
          "owner-override:internal<private",
        ],
        override: { applied: true, detectorMax: "private" },
      },
    });
  });

  it("keeps polling evidence in a compact running summary", async () => {
    const await_ = vi.fn(async () => ({
      status: "running",
      lease: { claimed_by: "worker-1", lease_expires_at: "2026-07-22T20:00:00Z" },
      orphan_suspected: false,
    }));
    const tools = buildTools({
      broker: fakeBroker({ await_ }),
      sessionId: "sess",
      submitter: "claude-code",
    });

    const result = await tools.await_.handler({
      task_id: "t-running",
      verbosity: "summary",
    });

    expect(parseResult(result)).toEqual({
      task_id: "t-running",
      status: "running",
      lease: { claimed_by: "worker-1", lease_expires_at: "2026-07-22T20:00:00Z" },
      orphan_suspected: false,
      refs: {
        status: { namespace: "tasks/t-running", key: "status" },
      },
    });
  });

  it("keeps terminal error details while compacting a failed structured result", async () => {
    const await_ = vi.fn(async () => ({
      status: "failed",
      result: {
        outcome: "failed",
        exitCode: 1,
        bodyText: "executor failed",
        runtimeMetadata: { learningTask: { durable: "full provenance" } },
      },
      error: {
        task_id: "t-failed",
        kind: "executor_failed",
        message: "executor failed",
        retryable: false,
      },
    }));
    const tools = buildTools({
      broker: fakeBroker({ await_ }),
      sessionId: "sess",
      submitter: "claude-code",
    });

    const result = await tools.await_.handler({
      task_id: "t-failed",
      verbosity: "summary",
    });

    expect(parseResult(result)).toEqual({
      task_id: "t-failed",
      status: "failed",
      outcome: "failed",
      exitCode: 1,
      bodyText: "executor failed",
      error: {
        task_id: "t-failed",
        kind: "executor_failed",
        message: "executor failed",
        retryable: false,
      },
      refs: {
        status: { namespace: "tasks/t-failed", key: "status" },
        fullResult: { namespace: "tasks/t-failed", key: "result-structured" },
      },
    });
  });

  it("returns a compact unknown response with only the reachable status ref", async () => {
    const await_ = vi.fn(async () => ({
      status: "unknown",
      reason: "task_id_not_found",
    }));
    const tools = buildTools({
      broker: fakeBroker({ await_ }),
      sessionId: "sess",
      submitter: "claude-code",
    });

    const result = await tools.await_.handler({
      task_id: "t-missing",
      verbosity: "summary",
    });

    expect(parseResult(result)).toEqual({
      task_id: "t-missing",
      status: "unknown",
      reason: "task_id_not_found",
      refs: {
        status: { namespace: "tasks/t-missing", key: "status" },
      },
    });
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

  it("forwards native v2 correction provenance", async () => {
    const rate = vi.fn(async () => ({}));
    const broker = fakeBroker({ rate });
    const tools = buildTools({ broker, sessionId: "sess", submitter: "claude-code" });
    const correction = {
      predecessor_receipt_id: "qr-" + "a".repeat(24),
      rubric: {
        id: "code-review",
        version: "2",
        config_digest: {
          algorithm: "sha256" as const,
          canonicalization: "jcs-rfc8785-utf8-v1" as const,
          source_ref: "source-doc:rubric/code-review-2",
          source_type: "rubric-config" as const,
          source_version: "rubric-source-2",
          digest: "b".repeat(64),
        },
      },
      verifier: { id: "claude-opus", version: "2026-07-19" },
      failure: {
        taxonomy: { id: "hugin-quality-failure", version: "1" },
        code: "incorrect-answer" as const,
      },
      references: {
        corrected_successor: {
          task_id: "t-2",
          structured_result_sha256: "c".repeat(64),
        },
      },
    };

    const result = await tools.rate.handler({
      task_id: "t-1",
      rating: "wrong",
      rating_reason: "The correction is required.",
      verification_outcome: "discarded",
      correction,
    });

    expect(result.isError).toBeUndefined();
    expect(rate).toHaveBeenCalledWith(expect.objectContaining({ correction }));
  });
});

describe("buildTools — hugin_report_friction", () => {
  it("validates and forwards the shared friction payload", async () => {
    const reportFriction = vi.fn(async () => ({
      ok: true,
      dropped: false,
      namespace: "signals/friction",
      key: "t-1-stamp",
    }));
    const broker = fakeBroker({ reportFriction });
    const tools = buildTools({ broker, sessionId: "sess", submitter: "codex" });

    const result = await tools.friction.handler({
      friction_type: "tool_failure",
      severity: "blocking",
      summary: "bubblewrap could not start",
      detail: "AF_NETLINK was blocked by the outer service sandbox",
      task_id: "t-1",
      tool_name: "codex-exec",
      tags: ["repo:cassette-ai"],
    });

    expect(result.isError).toBeUndefined();
    expect(reportFriction).toHaveBeenCalledWith({
      friction_type: "tool_failure",
      severity: "blocking",
      summary: "bubblewrap could not start",
      detail: "AF_NETLINK was blocked by the outer service sandbox",
      task_id: "t-1",
      tool_name: "codex-exec",
      tags: ["repo:cassette-ai"],
    });
    expect(parseResult(result)).toMatchObject({
      ok: true,
      namespace: "signals/friction",
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

describe("buildTools — continuous learning loop", () => {
  it("forwards a validated one-axis experiment contract", async () => {
    const experimentCreate = vi.fn(async () => ({ state: { status: "running" } }));
    const tools = buildTools({
      broker: fakeBroker({ experimentCreate }),
      sessionId: "sess",
      submitter: "codex",
    });
    const input = makeExperimentInput();

    const result = await tools.experimentCreate.handler(input);

    expect(result.isError).toBeUndefined();
    expect(experimentCreate).toHaveBeenCalledWith(input);
  });

  it("forwards observations and reads the resulting promotion state", async () => {
    const experimentObserve = vi.fn(async () => ({ state: { status: "running" } }));
    const experimentStatus = vi.fn(async () => ({ state: { status: "promotion-ready" } }));
    const tools = buildTools({
      broker: fakeBroker({ experimentObserve, experimentStatus }),
      sessionId: "sess",
      submitter: "codex",
    });
    const observation = makeObservation("case-1", "challenger");

    await tools.experimentObserve.handler(observation);
    const status = await tools.experimentStatus.handler({
      experiment_id: "wave-six-edit-deadline",
    });

    expect(experimentObserve).toHaveBeenCalledWith(observation);
    expect(experimentStatus).toHaveBeenCalledWith({
      experiment_id: "wave-six-edit-deadline",
    });
    expect(parseResult(status)).toMatchObject({ state: { status: "promotion-ready" } });
  });

  it("forwards one-way product rating enrichment", async () => {
    const experimentRate = vi.fn(async () => ({ state: { status: "running" } }));
    const tools = buildTools({
      broker: fakeBroker({ experimentRate }),
      sessionId: "sess",
      submitter: "codex",
    });
    const input = {
      experiment_id: "wave-six-edit-deadline",
      run_id: "case-1-champion",
      product_outcome: "minor-edit" as const,
      human_review_seconds: 30,
    };

    const result = await tools.experimentRate.handler(input);

    expect(result.isError).toBeUndefined();
    expect(experimentRate).toHaveBeenCalledWith(input);
  });

  it("forwards an explicit reviewed promotion reference", async () => {
    const experimentPromote = vi.fn(async () => ({ state: { status: "promoted" } }));
    const tools = buildTools({
      broker: fakeBroker({ experimentPromote }),
      sessionId: "sess",
      submitter: "codex",
    });
    const input = {
      experiment_id: "wave-six-edit-deadline",
      configuration_fingerprint: "b".repeat(64),
      applied_ref: "gille-inference@abc123",
    };

    const result = await tools.experimentPromote.handler(input);

    expect(result.isError).toBeUndefined();
    expect(experimentPromote).toHaveBeenCalledWith(input);
  });
});
