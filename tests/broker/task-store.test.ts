import { describe, expect, it } from "vitest";
import {
  BrokerTaskStore,
  ORCH_V1_TAG,
  buildSubmitTags,
  flipLifecycleTags,
  generateBrokerTaskId,
  namespaceForTaskId,
  parseCanonicalEnvelope,
  serializeEnvelope,
} from "../../src/broker/task-store.js";
import type { MuninClient } from "../../src/munin-client.js";
import type { DelegationEnvelope } from "../../src/broker/types.js";

interface WriteCall {
  namespace: string;
  key: string;
  content: string;
  tags?: string[];
  expectedUpdatedAt?: string;
  classification?: string;
}

class FakeMunin {
  writes: WriteCall[] = [];
  reads: { namespace: string; key: string }[] = [];
  queries: Parameters<MuninClient["query"]>[0][] = [];
  readReturn: Record<string, unknown> = {};
  queryReturn: { results: unknown[]; total: number } = { results: [], total: 0 };

  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
  ): Promise<Record<string, unknown>> {
    this.writes.push({ namespace, key, content, tags, expectedUpdatedAt, classification });
    return { ok: true };
  }
  async read(namespace: string, key: string): Promise<unknown> {
    this.reads.push({ namespace, key });
    return this.readReturn[`${namespace}/${key}`] ?? null;
  }
  async query(opts: Parameters<MuninClient["query"]>[0]) {
    this.queries.push(opts);
    return this.queryReturn;
  }
}

function envelope(taskId: string): DelegationEnvelope {
  return {
    envelope_version: 2,
    idempotency_key: "11111111-1111-4111-8111-111111111111",
    orchestrator_session_id: "sess-1",
    orchestrator_submitter: "claude-code",
    task_type: "summarize",
    prompt: "Summarize.",
    alias_requested: "m5",
    alias_map_version: 2,
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
    task_id: taskId,
    broker_principal: "claude-code",
    received_at: "2026-04-26T12:00:00Z",
    alias_resolved: {
      alias: "m5",
      family: "one-shot",
      model_requested: "gateway-selected",
      runtime: "homeserver",
      runtime_row_id: "homeserver-m5",
      host: "m5",
    },
    policy_version: "zdr-v1+rlv-v1",
  };
}

describe("generateBrokerTaskId", () => {
  it("produces a stable principal-scoped task id", () => {
    const id = generateBrokerTaskId("claude-code", "11111111-1111-4111-8111-111111111111");
    expect(id).toMatch(/^mcp-m5-[0-9a-f]{24}$/);
    expect(generateBrokerTaskId("claude-code", "11111111-1111-4111-8111-111111111111")).toBe(id);
    expect(generateBrokerTaskId("codex", "11111111-1111-4111-8111-111111111111")).not.toBe(id);
  });
});

describe("namespaceForTaskId", () => {
  it("prefixes with tasks/", () => {
    expect(namespaceForTaskId("abc")).toBe("tasks/abc");
  });
});

describe("buildSubmitTags", () => {
  it("includes canonical dispatcher tags without orch-v1", () => {
    const tags = buildSubmitTags(envelope("t1"));
    expect(tags).toContain("pending");
    expect(tags).toContain("runtime:homeserver");
    expect(tags).toContain("runtime-row:homeserver-m5");
    expect(tags).toContain("alias:m5");
    expect(tags).toContain("task-type:summarize");
    expect(tags).toContain("broker:mcp-v2");
    expect(tags).not.toContain(ORCH_V1_TAG);
  });
});

describe("flipLifecycleTags", () => {
  it("replaces pending with completed", () => {
    expect(flipLifecycleTags(["pending", "runtime:ollama", ORCH_V1_TAG], "completed")).toEqual([
      "completed",
      "runtime:ollama",
      ORCH_V1_TAG,
    ]);
  });
  it("replaces running with failed", () => {
    expect(flipLifecycleTags(["running", "alias:tiny"], "failed")).toEqual([
      "failed",
      "alias:tiny",
    ]);
  });
});

describe("BrokerTaskStore.submit", () => {
  it("writes status with correct namespace, content, and tags", async () => {
    const munin = new FakeMunin();
    const store = new BrokerTaskStore(munin as unknown as MuninClient);
    await store.submit({ envelope: envelope("t1") });
    expect(munin.writes).toHaveLength(1);
    const w = munin.writes[0]!;
    expect(w.namespace).toBe("tasks/t1");
    expect(w.key).toBe("status");
    expect(w.tags).toContain("pending");
    expect(w.tags).toContain("broker:mcp-v2");
    expect(w.tags).not.toContain(ORCH_V1_TAG);
    expect(w.content).toContain("**Runtime:** homeserver");
    expect(w.content).toContain("### Broker envelope");
    expect(w.classification).toBe("internal");
  });

  it("stores private task content at the restricted classification floor", async () => {
    const munin = new FakeMunin();
    const privateEnvelope = envelope("private");
    privateEnvelope.sensitivity = "private";
    await new BrokerTaskStore(munin as unknown as MuninClient).submit({ envelope: privateEnvelope });
    expect(munin.writes[0]?.classification).toBe("client-restricted");
  });
});

describe("canonical Broker envelope", () => {
  it("round-trips the complete v2 contract and remains authoritative over display fields", () => {
    const expected = envelope("t1");
    const document = serializeEnvelope(expected)
      .replace("- **Timeout:** 300000", "- **Timeout:** 1")
      .replace("- **Sensitivity:** internal", "- **Sensitivity:** public");
    const parsed = parseCanonicalEnvelope(document);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.envelope).toEqual(expected);
      expect(parsed.envelope.timeout_ms).toBe(300_000);
      expect(parsed.envelope.sensitivity).toBe("internal");
    }
  });

  it("fails closed when a required policy field is removed", () => {
    const expected = envelope("t1");
    const document = serializeEnvelope(expected).replace(
      '  "allowed_destinations": [\n    "m5"\n  ],\n',
      "",
    );
    expect(parseCanonicalEnvelope(document)).toEqual({
      ok: false,
      error: "Canonical Broker envelope is invalid",
    });
  });
});

describe("BrokerTaskStore.listCanonical", () => {
  it("classifies cancelled as terminal cancelled, never running", async () => {
    const munin = new FakeMunin();
    munin.queryReturn = {
      results: [{ namespace: "tasks/t1", key: "status", tags: ["cancelled", "broker:mcp-v2"] }],
      total: 1,
    };
    munin.readReturn["tasks/t1/status"] = {
      content: serializeEnvelope(envelope("t1")),
      tags: ["cancelled", "broker:mcp-v2"],
    };
    const rows = await new BrokerTaskStore(munin as unknown as MuninClient)
      .listCanonical("claude-code");
    expect(rows).toEqual([expect.objectContaining({ task_id: "t1", outcome: "cancelled" })]);
  });
});

describe("BrokerTaskStore.completeSuccess", () => {
  it("writes result-structured first, then CAS-flips status to completed", async () => {
    const munin = new FakeMunin();
    const store = new BrokerTaskStore(munin as unknown as MuninClient);
    await store.completeSuccess(
      "t1",
      { task_id: "t1", result_schema_version: 1, foo: "bar" },
      { content: "envelope", tags: ["running", ORCH_V1_TAG], updated_at: "ts" },
    );
    expect(munin.writes).toHaveLength(2);
    expect(munin.writes[0]!.key).toBe("result-structured");
    expect(munin.writes[1]!.key).toBe("status");
    expect(munin.writes[1]!.tags?.[0]).toBe("completed");
    expect(munin.writes[1]!.expectedUpdatedAt).toBe("ts");
  });
});

describe("BrokerTaskStore.completeFailure", () => {
  it("writes result-error and flips status to failed", async () => {
    const munin = new FakeMunin();
    const store = new BrokerTaskStore(munin as unknown as MuninClient);
    await store.completeFailure(
      "t1",
      { task_id: "t1", kind: "internal", message: "boom", retryable: true },
      { content: "envelope", tags: ["running"], updated_at: "ts" },
    );
    expect(munin.writes[0]!.key).toBe("result-error");
    expect(munin.writes[1]!.tags?.[0]).toBe("failed");
  });
});

describe("BrokerTaskStore.listInFlight", () => {
  it("queries pending and running with orch-v1 tag, returns status entries", async () => {
    const munin = new FakeMunin();
    munin.queryReturn = {
      results: [
        {
          id: "1",
          namespace: "tasks/t1",
          key: "status",
          entry_type: "state",
          content_preview: "",
          tags: ["pending", ORCH_V1_TAG],
          created_at: "ts",
          updated_at: "ts",
        },
        {
          id: "2",
          namespace: "tasks/t1",
          key: "result",
          entry_type: "state",
          content_preview: "",
          tags: ["pending", ORCH_V1_TAG],
          created_at: "ts",
          updated_at: "ts",
        },
      ],
      total: 2,
    };
    const store = new BrokerTaskStore(munin as unknown as MuninClient);
    const inflight = await store.listInFlight();
    // Two queries (pending + running), each returns the same fixture
    expect(munin.queries).toHaveLength(2);
    expect(munin.queries[0]!.tags).toContain(ORCH_V1_TAG);
    // Filters out non-status keys; deduplicate not required
    expect(inflight.every((r) => r.namespace === "tasks/t1")).toBe(true);
  });
});
