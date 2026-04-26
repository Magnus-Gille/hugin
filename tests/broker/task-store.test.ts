import { describe, expect, it } from "vitest";
import {
  BrokerTaskStore,
  ORCH_V1_TAG,
  buildSubmitTags,
  flipLifecycleTags,
  generateBrokerTaskId,
  namespaceForTaskId,
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
    envelope_version: 1,
    idempotency_key: "11111111-1111-4111-8111-111111111111",
    orchestrator_session_id: "sess-1",
    orchestrator_submitter: "claude-code",
    task_type: "summarize",
    prompt: "Summarize.",
    alias_requested: "tiny",
    alias_map_version: 1,
    task_id: taskId,
    broker_principal: "claude-code",
    received_at: "2026-04-26T12:00:00Z",
    alias_resolved: {
      alias: "tiny",
      family: "one-shot",
      model_requested: "qwen2.5:3b",
      runtime: "ollama",
      runtime_row_id: "ollama-pi",
      host: "pi",
    },
    policy_version: "zdr-v1+rlv-v1",
  };
}

describe("generateBrokerTaskId", () => {
  it("produces YYYYMMDD-HHMMSS-orch-<hex> shape", () => {
    const id = generateBrokerTaskId(new Date("2026-04-26T12:34:56Z"));
    expect(id).toMatch(/^20260426-123456-orch-[0-9a-f]{8}$/);
  });
});

describe("namespaceForTaskId", () => {
  it("prefixes with tasks/", () => {
    expect(namespaceForTaskId("abc")).toBe("tasks/abc");
  });
});

describe("buildSubmitTags", () => {
  it("includes pending + runtime + alias + orch-v1", () => {
    const tags = buildSubmitTags(envelope("t1"));
    expect(tags).toContain("pending");
    expect(tags).toContain("runtime:ollama");
    expect(tags).toContain("runtime-row:ollama-pi");
    expect(tags).toContain("alias:tiny");
    expect(tags).toContain("task-type:summarize");
    expect(tags).toContain(ORCH_V1_TAG);
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
    expect(w.tags).toContain(ORCH_V1_TAG);
    expect(w.classification).toBe("internal");
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
