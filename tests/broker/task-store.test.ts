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
  /** Optional per-call override, keyed by the requested tags — lets a test
   * make the two tag-scoped queries in listCanonical diverge instead of
   * always sharing queryReturn. */
  queryByTags?: (tags: string[]) => { results: unknown[]; total: number };

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
    if (this.queryByTags) return this.queryByTags(opts.tags ?? []);
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

  // #181: hugin_list under-counted real broker tasks. A tag-scoped Munin query
  // (`broker:mcp-v2`) matches every key sharing that tag — status, feedback,
  // and await-observation alike — and the query is capped server-side. Once a
  // task is rated (writeFeedback) or polled (recordAwait), its co-tagged
  // sibling entries compete with its own `status` entry for the same limited
  // result window. The old code discarded any raw result whose `key` wasn't
  // `status` instead of using it to learn the task's namespace, so a task
  // whose status entry fell out of the window (crowded out by its own or
  // another task's feedback/await-observation entry) vanished from the list
  // even though its canonical status entry was untouched and still readable.
  it("still lists a task whose status entry is crowded out of the raw query window by a co-tagged feedback entry", async () => {
    const munin = new FakeMunin();
    munin.readReturn["tasks/t1/status"] = {
      content: serializeEnvelope(envelope("t1")),
      tags: ["completed", "broker:mcp-v2", "runtime:homeserver"],
    };
    // Simulates a Munin-side query result window that, after hugin_rate wrote
    // the co-tagged `feedback` entry, no longer contains the `status` entry
    // for this task — only the newer sibling entry survived the cap.
    munin.queryReturn = {
      results: [{ namespace: "tasks/t1", key: "feedback", tags: ["broker:mcp-v2", "feedback"] }],
      total: 1,
    };
    const rows = await new BrokerTaskStore(munin as unknown as MuninClient)
      .listCanonical("claude-code");
    expect(rows).toEqual([expect.objectContaining({ task_id: "t1", outcome: "completed" })]);
  });

  it("still lists a task whose status entry is crowded out by an await-observation entry", async () => {
    const munin = new FakeMunin();
    munin.readReturn["tasks/t2/status"] = {
      content: serializeEnvelope(envelope("t2")),
      tags: ["running", "broker:mcp-v2", "runtime:homeserver"],
    };
    munin.queryReturn = {
      results: [
        { namespace: "tasks/t2", key: "await-observation", tags: ["broker:mcp-v2", "await-observation"] },
      ],
      total: 1,
    };
    const rows = await new BrokerTaskStore(munin as unknown as MuninClient)
      .listCanonical("claude-code");
    expect(rows).toEqual([expect.objectContaining({ task_id: "t2", outcome: "running" })]);
  });

  it("forwards sinceTs as the since field on both munin.query calls", async () => {
    const munin = new FakeMunin();

    await new BrokerTaskStore(munin as unknown as MuninClient)
      .listCanonical("claude-code", "2026-07-12T13:03:00Z");

    expect(munin.queries).toHaveLength(2);
    for (const query of munin.queries) {
      expect(query).toHaveProperty("since", "2026-07-12T13:03:00Z");
    }
  });

  // Codex review of #181/PR182: a caller-requested small output limit must
  // never narrow the raw Munin candidate window below the server's real
  // per-query cap (50) — doing so reintroduces the exact crowding-out risk
  // this PR fixes, just triggered by a small `?limit=` instead of a rating
  // event. The final row count is already enforced downstream by the
  // handler's own slice(), so listCanonical has no reason to accept (or be
  // shrunk by) an output-size hint at all.
  it("always queries Munin at its real per-query cap, independent of the caller's desired row count", async () => {
    const munin = new FakeMunin();

    await new BrokerTaskStore(munin as unknown as MuninClient).listCanonical("claude-code");

    expect(munin.queries).toHaveLength(2);
    for (const query of munin.queries) {
      expect(query.limit).toBe(50);
    }
  });

  // Codex review of #181/PR182: the earlier crowd-out tests above share one
  // `queryReturn` fixture for both tag queries, so they cannot distinguish
  // "found via the broker:mcp-v2 channel" from "found via the runtime:homeserver
  // union" — a reverted union would still pass them. This test makes the two
  // channels diverge: the mcp-v2 query returns only unrelated/polluting
  // namespaces, and only the runtime:homeserver query returns the target's
  // status entry, proving the union is what surfaces it.
  it("surfaces a task found only via the runtime:homeserver union when the broker:mcp-v2 channel is fully crowded out", async () => {
    const munin = new FakeMunin();
    munin.readReturn["tasks/t3/status"] = {
      content: serializeEnvelope(envelope("t3")),
      tags: ["completed", "broker:mcp-v2", "runtime:homeserver"],
    };
    munin.queryByTags = (tags) =>
      tags.includes("broker:mcp-v2")
        ? { results: [{ namespace: "tasks/unrelated-1", key: "feedback" }, { namespace: "tasks/unrelated-2", key: "await-observation" }], total: 2 }
        : { results: [{ namespace: "tasks/t3", key: "status" }], total: 1 };

    const rows = await new BrokerTaskStore(munin as unknown as MuninClient)
      .listCanonical("claude-code");
    expect(rows).toEqual([expect.objectContaining({ task_id: "t3", outcome: "completed" })]);
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

// Codex review of #164: the observation write is a read-modify-write. Without
// CAS, two overlapping writers (a deploy/restart overlap, or concurrent polls)
// can have a later writer holding a stale `durableHandoff:false` fold clobber an
// earlier `true` — permanently ERASING proven trial evidence. The in-memory fold
// is monotonic; persistence has to be too.
describe("BrokerTaskStore.recordAwait — durable-handoff evidence (#164)", () => {
  const ENVELOPE_CONTENT = `## Task\n\n### Broker envelope\n\`\`\`json\n${JSON.stringify({
    envelope_version: 2,
    orchestrator_submitter: "claude-code",
    orchestrator_session_id: "session-A",
    sensitivity: "internal",
  })}\n\`\`\`\n`;

  function makeMunin(overrides: Partial<Record<string, unknown>> = {}) {
    const writes: WriteCall[] = [];
    const store: Record<string, { content: string; updated_at: string }> = {};
    const munin = {
      writes,
      store,
      read: async (ns: string, key: string) => store[`${ns}/${key}`] ?? null,
      write: async (
        namespace: string,
        key: string,
        content: string,
        tags?: string[],
        expectedUpdatedAt?: string,
      ) => {
        const existing = store[`${namespace}/${key}`];
        if (existing && existing.updated_at !== expectedUpdatedAt) {
          throw new Error("CAS conflict: entry was modified");
        }
        writes.push({ namespace, key, content, tags, expectedUpdatedAt });
        store[`${namespace}/${key}`] = {
          content,
          updated_at: `v${writes.length}`,
        };
        return { ok: true };
      },
      ...overrides,
    };
    return munin;
  }

  it("sends the CAS token so a concurrent writer cannot silently clobber evidence", async () => {
    const munin = makeMunin();
    munin.store["tasks/t1/status"] = { content: ENVELOPE_CONTENT, updated_at: "s1" };
    const store = new BrokerTaskStore(munin as unknown as MuninClient);

    // First await: same session, still running — records a baseline observation.
    await store.recordAwait("t1", {
      sessionId: "session-A", at: "2026-07-12T10:00:00Z", lifecycle: "running",
    });
    // Second await: a LATER session collects the completed result.
    await store.recordAwait("t1", {
      sessionId: "session-B", at: "2026-07-12T11:00:00Z", lifecycle: "completed",
    });

    const obs = munin.writes.filter((w) => w.key === "await-observation");
    expect(obs).toHaveLength(2);
    // The second write must be CAS-guarded against the first's version.
    expect(obs[1]!.expectedUpdatedAt).toBe("v1");
    expect(JSON.parse(obs[1]!.content).durableHandoff).toBe(true);
  });

  it("re-folds and preserves a proven handoff after losing a CAS race", async () => {
    const munin = makeMunin();
    munin.store["tasks/t1/status"] = { content: ENVELOPE_CONTENT, updated_at: "s1" };
    const store = new BrokerTaskStore(munin as unknown as MuninClient);

    // Another writer has already proven the handoff.
    munin.store["tasks/t1/await-observation"] = {
      content: JSON.stringify({
        schemaVersion: 1, submitSessionId: "session-A", awaitSessionIds: ["session-B"],
        firstAwaitAt: "x", lastAwaitAt: "x", terminalCollected: true, durableHandoff: true,
      }),
      updated_at: "v9",
    };

    let firstTry = true;
    const realWrite = munin.write;
    munin.write = async (...args: Parameters<typeof realWrite>) => {
      if (firstTry && args[1] === "await-observation") {
        firstTry = false;
        // Simulate the doc moving under us mid-write.
        munin.store["tasks/t1/await-observation"]!.updated_at = "v10";
        throw new Error("CAS conflict: entry was modified");
      }
      return realWrite(...args);
    };

    // A different session polls; on its own it would prove nothing.
    await store.recordAwait("t1", {
      sessionId: "session-C", at: "2026-07-12T12:00:00Z", lifecycle: "running",
    });

    const obs = munin.writes.filter((w) => w.key === "await-observation");
    expect(obs).toHaveLength(1);
    // The retry re-read and re-folded: the earlier proof SURVIVES.
    expect(JSON.parse(obs[0]!.content).durableHandoff).toBe(true);
  });

  it("skips the write entirely when a re-poll reveals nothing new (hot path)", async () => {
    const munin = makeMunin();
    munin.store["tasks/t1/status"] = { content: ENVELOPE_CONTENT, updated_at: "s1" };
    const store = new BrokerTaskStore(munin as unknown as MuninClient);

    for (let i = 0; i < 5; i++) {
      await store.recordAwait("t1", {
        sessionId: "session-A", at: `2026-07-12T10:0${i}:00Z`, lifecycle: "running",
      });
    }

    // Five polls, ONE write: only the first carried new evidence.
    expect(munin.writes.filter((w) => w.key === "await-observation")).toHaveLength(1);
  });
});
