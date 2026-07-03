import { describe, it, expect, vi } from "vitest";
import {
  deriveVerdict,
  deriveRecommendation,
  VerdictStore,
  VERDICT_NAMESPACE,
  VERDICT_KEY,
  type VerdictStoreClient,
} from "../../src/orchestrator/verdict-store.js";

// ---------------------------------------------------------------------------
// Pure derivation functions (V4)
// ---------------------------------------------------------------------------

describe("deriveVerdict", () => {
  it("returns 'unknown' when attempts < 3", () => {
    expect(deriveVerdict({ attempts: 0, passes: 0 })).toBe("unknown");
    expect(deriveVerdict({ attempts: 2, passes: 2 })).toBe("unknown");
  });

  it("returns 'viable' when success rate >= 0.8", () => {
    expect(deriveVerdict({ attempts: 5, passes: 4 })).toBe("viable"); // 0.8
    expect(deriveVerdict({ attempts: 10, passes: 10 })).toBe("viable");
  });

  it("returns 'marginal' when success rate is between 0.5 and 0.8", () => {
    expect(deriveVerdict({ attempts: 4, passes: 2 })).toBe("marginal"); // 0.5
    expect(deriveVerdict({ attempts: 10, passes: 7 })).toBe("marginal"); // 0.7
  });

  it("returns 'not_viable' when success rate < 0.5", () => {
    expect(deriveVerdict({ attempts: 4, passes: 1 })).toBe("not_viable");
    expect(deriveVerdict({ attempts: 10, passes: 0 })).toBe("not_viable");
  });
});

describe("deriveRecommendation", () => {
  it("maps viable → delegate-local", () => {
    expect(deriveRecommendation("viable")).toBe("delegate-local");
  });
  it("maps not_viable → escalate-frontier", () => {
    expect(deriveRecommendation("not_viable")).toBe("escalate-frontier");
  });
  it("maps marginal → explore", () => {
    expect(deriveRecommendation("marginal")).toBe("explore");
  });
  it("maps unknown → explore", () => {
    expect(deriveRecommendation("unknown")).toBe("explore");
  });
});

// ---------------------------------------------------------------------------
// VerdictStore — CAS read-modify-write
// ---------------------------------------------------------------------------

function makeClient(initial?: { content: string; updated_at: string }) {
  let doc = initial ?? null;
  const read = vi.fn(async (_ns: string, _key: string) => (doc ? { ...doc } : null));
  const write = vi.fn(
    async (
      _ns: string,
      _key: string,
      content: string,
      _tags?: string[],
      expectedUpdatedAt?: string,
    ) => {
      if (doc && expectedUpdatedAt !== doc.updated_at) {
        throw new Error("CAS conflict: expected_updated_at mismatch");
      }
      doc = { content, updated_at: `v${(doc ? Number(doc.updated_at.slice(1)) : 0) + 1}` };
      return { ok: true };
    },
  );
  return { read, write, getDoc: () => doc };
}

describe("VerdictStore.record", () => {
  it("creates the doc on first write (no prior entry, no CAS)", async () => {
    const client = makeClient();
    const store = new VerdictStore(client as VerdictStoreClient);

    await store.record("deepseek/deepseek-v4-flash", "summarize", "pass", 120);

    expect(client.write).toHaveBeenCalledTimes(1);
    const [ns, key, content] = client.write.mock.calls[0];
    expect(ns).toBe(VERDICT_NAMESPACE);
    expect(key).toBe(VERDICT_KEY);
    const parsed = JSON.parse(content as string);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.rows["deepseek/deepseek-v4-flash|summarize"]).toEqual({
      attempts: 1,
      passes: 1,
      fails: 0,
      errors: 0,
      totalLatencyMs: 120,
    });
  });

  it("accumulates attempts/passes/fails/errors across multiple events for the same key", async () => {
    const client = makeClient();
    const store = new VerdictStore(client as VerdictStoreClient);

    await store.record("m", "t", "pass", 100);
    await store.record("m", "t", "fail", 200);
    await store.record("m", "t", "error", 50);

    const doc = client.getDoc();
    const parsed = JSON.parse(doc!.content);
    expect(parsed.rows["m|t"]).toEqual({
      attempts: 3,
      passes: 1,
      fails: 1,
      errors: 1,
      totalLatencyMs: 350,
    });
  });

  it("keeps separate rows per (modelId × taskType) key", async () => {
    const client = makeClient();
    const store = new VerdictStore(client as VerdictStoreClient);

    await store.record("modelA", "summarize", "pass", 10);
    await store.record("modelA", "code-review", "pass", 10);
    await store.record("modelB", "summarize", "pass", 10);

    const parsed = JSON.parse(client.getDoc()!.content);
    expect(Object.keys(parsed.rows).sort()).toEqual([
      "modelA|code-review",
      "modelA|summarize",
      "modelB|summarize",
    ]);
  });

  it("passes expected_updated_at on the second write once a doc exists", async () => {
    const client = makeClient();
    const store = new VerdictStore(client as VerdictStoreClient);

    await store.record("m", "t", "pass", 10);
    await store.record("m", "t", "pass", 10);

    const secondCallArgs = client.write.mock.calls[1];
    expect(secondCallArgs[4]).toBe("v1"); // expectedUpdatedAt from the first write's result
  });

  it("on a CAS conflict, re-reads and retries once, then succeeds", async () => {
    const client = makeClient();
    const store = new VerdictStore(client as VerdictStoreClient);

    // Seed one event so a doc exists.
    await store.record("m", "t", "pass", 10);

    // Force exactly one CAS failure on the next write.
    let failNext = true;
    const originalWrite = client.write.getMockImplementation()!;
    client.write.mockImplementation(async (...args: Parameters<typeof originalWrite>) => {
      if (failNext) {
        failNext = false;
        throw new Error("simulated CAS conflict");
      }
      return originalWrite(...args);
    });

    await store.record("m", "t", "fail", 20);

    // read called: 1 (seed) + 1 (record attempt#1) + 1 (retry re-read) = 3
    expect(client.read).toHaveBeenCalledTimes(3);
    const parsed = JSON.parse(client.getDoc()!.content);
    expect(parsed.rows["m|t"].attempts).toBe(2);
  });

  it("never throws to the caller — gives up silently after the retry also fails", async () => {
    const client = makeClient();
    client.write.mockRejectedValue(new Error("Munin is down"));
    const store = new VerdictStore(client as VerdictStoreClient);

    await expect(store.record("m", "t", "pass", 10)).resolves.toBeUndefined();
  });

  it("logs (via onLog) rather than throwing when recording ultimately fails", async () => {
    const client = makeClient();
    client.write.mockRejectedValue(new Error("Munin is down"));
    const logs: string[] = [];
    const store = new VerdictStore(client as VerdictStoreClient, (line) => logs.push(line));

    await store.record("m", "t", "pass", 10);

    expect(logs.some((l) => l.toLowerCase().includes("verdict"))).toBe(true);
  });

  it("tolerates a malformed existing doc (falls back to an empty rows object)", async () => {
    const client = makeClient({ content: "not json at all", updated_at: "v1" });
    const store = new VerdictStore(client as VerdictStoreClient);

    await store.record("m", "t", "pass", 10);

    const parsed = JSON.parse(client.getDoc()!.content);
    expect(parsed.rows["m|t"].attempts).toBe(1);
  });
});

describe("VerdictStore.loadRecommendations", () => {
  it("returns an empty map when no doc exists", async () => {
    const client = makeClient();
    const store = new VerdictStore(client as VerdictStoreClient);

    const map = await store.loadRecommendations();
    expect(map.size).toBe(0);
  });

  it("derives a recommendation per row from the persisted counters", async () => {
    const doc = {
      schemaVersion: 1,
      rows: {
        "goodModel|summarize": { attempts: 10, passes: 9, fails: 1, errors: 0, totalLatencyMs: 100 },
        "badModel|summarize": { attempts: 10, passes: 1, fails: 9, errors: 0, totalLatencyMs: 100 },
      },
    };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const store = new VerdictStore(client as VerdictStoreClient);

    const map = await store.loadRecommendations();
    expect(map.get("goodModel|summarize")).toBe("delegate-local");
    expect(map.get("badModel|summarize")).toBe("escalate-frontier");
  });

  it("fails open to an empty map when the read throws", async () => {
    const client = makeClient();
    client.read.mockRejectedValue(new Error("network down"));
    const store = new VerdictStore(client as VerdictStoreClient);

    const map = await store.loadRecommendations();
    expect(map.size).toBe(0);
  });
});
