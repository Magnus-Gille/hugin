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
// Pure derivation functions (V4, rate excludes errors — Fix #1)
// ---------------------------------------------------------------------------

describe("deriveVerdict", () => {
  it("returns 'unknown' when passes+fails < 3", () => {
    expect(deriveVerdict({ passes: 0, fails: 0 })).toBe("unknown");
    expect(deriveVerdict({ passes: 2, fails: 0 })).toBe("unknown");
    expect(deriveVerdict({ passes: 1, fails: 1 })).toBe("unknown");
  });

  it("returns 'viable' when passes/(passes+fails) >= 0.8", () => {
    expect(deriveVerdict({ passes: 4, fails: 1 })).toBe("viable"); // 0.8
    expect(deriveVerdict({ passes: 10, fails: 0 })).toBe("viable");
  });

  it("returns 'marginal' when the rate is between 0.5 and 0.8", () => {
    expect(deriveVerdict({ passes: 2, fails: 2 })).toBe("marginal"); // 0.5
    expect(deriveVerdict({ passes: 7, fails: 3 })).toBe("marginal"); // 0.7
  });

  it("returns 'not_viable' when the rate is < 0.5", () => {
    expect(deriveVerdict({ passes: 1, fails: 3 })).toBe("not_viable");
    expect(deriveVerdict({ passes: 0, fails: 10 })).toBe("not_viable");
  });

  it("EXCLUDES errors from the rate — attempts/errors have no bearing (Fix #1)", () => {
    // 9 passes, 1 fail, but 50 infra errors — rate must stay 0.9 (viable),
    // matching gateway semantics: errors are attempts, not quality signal.
    expect(deriveVerdict({ passes: 9, fails: 1 })).toBe("viable");
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
      unverifiedPasses: 0,
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
      unverifiedPasses: 0,
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

// ---------------------------------------------------------------------------
// VERIFIED/UNVERIFIED separation (Fix #1 — confidence-poisoning fix)
// ---------------------------------------------------------------------------

describe("VerdictStore.record — 'unverified' event (Fix #1)", () => {
  it("an 'unverified' event increments attempts + unverifiedPasses only, never passes", async () => {
    const client = makeClient();
    const store = new VerdictStore(client as VerdictStoreClient);

    await store.record("m", "t", "unverified", 10);

    const parsed = JSON.parse(client.getDoc()!.content);
    expect(parsed.rows["m|t"]).toEqual({
      attempts: 1,
      passes: 0,
      fails: 0,
      errors: 0,
      totalLatencyMs: 10,
      unverifiedPasses: 1,
    });
  });

  it("unverifiedPasses accumulates across repeated unverified events", async () => {
    const client = makeClient();
    const store = new VerdictStore(client as VerdictStoreClient);

    await store.record("m", "t", "unverified", 10);
    await store.record("m", "t", "unverified", 10);
    await store.record("m", "t", "unverified", 10);

    const parsed = JSON.parse(client.getDoc()!.content);
    expect(parsed.rows["m|t"].unverifiedPasses).toBe(3);
    expect(parsed.rows["m|t"].attempts).toBe(3);
    expect(parsed.rows["m|t"].passes).toBe(0);
  });

  it("a VERIFIED pass resets unverifiedPasses to 0 (fresh signal)", async () => {
    const client = makeClient();
    const store = new VerdictStore(client as VerdictStoreClient);

    await store.record("m", "t", "unverified", 10);
    await store.record("m", "t", "unverified", 10);
    await store.record("m", "t", "pass", 10);

    const parsed = JSON.parse(client.getDoc()!.content);
    expect(parsed.rows["m|t"].unverifiedPasses).toBe(0);
    expect(parsed.rows["m|t"].passes).toBe(1);
  });

  it("a VERIFIED fail also resets unverifiedPasses to 0", async () => {
    const client = makeClient();
    const store = new VerdictStore(client as VerdictStoreClient);

    await store.record("m", "t", "unverified", 10);
    await store.record("m", "t", "fail", 10);

    const parsed = JSON.parse(client.getDoc()!.content);
    expect(parsed.rows["m|t"].unverifiedPasses).toBe(0);
    expect(parsed.rows["m|t"].fails).toBe(1);
  });

  it("an 'error' event neither increments nor resets unverifiedPasses", async () => {
    const client = makeClient();
    const store = new VerdictStore(client as VerdictStoreClient);

    await store.record("m", "t", "unverified", 10);
    await store.record("m", "t", "error", 10);

    const parsed = JSON.parse(client.getDoc()!.content);
    expect(parsed.rows["m|t"].unverifiedPasses).toBe(1);
    expect(parsed.rows["m|t"].errors).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// VerdictStore.recordBatch — single read-modify-write for many events (Fix #2)
// ---------------------------------------------------------------------------

describe("VerdictStore.recordBatch", () => {
  it("applies ALL events in exactly one read and one write", async () => {
    const client = makeClient();
    const store = new VerdictStore(client as VerdictStoreClient);

    await store.recordBatch([
      { modelId: "m1", taskType: "summarize", event: "pass", latencyMs: 10 },
      { modelId: "m1", taskType: "summarize", event: "pass", latencyMs: 10 },
      { modelId: "m2", taskType: "code-review", event: "error", latencyMs: 5 },
    ]);

    expect(client.read).toHaveBeenCalledTimes(1);
    expect(client.write).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(client.getDoc()!.content);
    expect(parsed.rows["m1|summarize"].passes).toBe(2);
    expect(parsed.rows["m2|code-review"].errors).toBe(1);
  });

  it("is a no-op (no read, no write) for an empty batch", async () => {
    const client = makeClient();
    const store = new VerdictStore(client as VerdictStoreClient);

    await store.recordBatch([]);

    expect(client.read).not.toHaveBeenCalled();
    expect(client.write).not.toHaveBeenCalled();
  });

  it("on a CAS conflict, re-reads and retries the WHOLE batch once, then succeeds", async () => {
    const client = makeClient();
    const store = new VerdictStore(client as VerdictStoreClient);
    await store.record("m", "t", "pass", 1); // seed a doc so a CAS check applies

    let failNext = true;
    const originalWrite = client.write.getMockImplementation()!;
    client.write.mockImplementation(async (...args: Parameters<typeof originalWrite>) => {
      if (failNext) {
        failNext = false;
        throw new Error("simulated CAS conflict");
      }
      return originalWrite(...args);
    });

    await store.recordBatch([
      { modelId: "m", taskType: "t", event: "pass", latencyMs: 1 },
      { modelId: "m", taskType: "t", event: "pass", latencyMs: 1 },
    ]);

    // read: 1 (seed) + 1 (batch attempt) + 1 (retry re-read) = 3
    expect(client.read).toHaveBeenCalledTimes(3);
    const parsed = JSON.parse(client.getDoc()!.content);
    expect(parsed.rows["m|t"].passes).toBe(3); // 1 seed + 2 batched
  });

  it("never throws — drops the whole batch silently after the retry also fails", async () => {
    const client = makeClient();
    client.write.mockRejectedValue(new Error("Munin is down"));
    const store = new VerdictStore(client as VerdictStoreClient);

    await expect(
      store.recordBatch([{ modelId: "m", taskType: "t", event: "pass", latencyMs: 1 }]),
    ).resolves.toBeUndefined();
  });

  it("a never-resolving client.read() does not reject recordBatch's promise prematurely (caller may fire-and-forget)", async () => {
    const client = {
      read: vi.fn(() => new Promise(() => {})),
      write: vi.fn(),
    };
    const store = new VerdictStore(client as unknown as VerdictStoreClient);

    // Fire-and-forget: the returned promise simply never settles; it must not
    // throw synchronously and must not be awaited by a caller that chooses
    // not to await it (see orchestrator-executor.test.ts for the real
    // regression test against runOrchestratorTask).
    const p = store.recordBatch([{ modelId: "m", taskType: "t", event: "pass", latencyMs: 1 }]);
    expect(p).toBeInstanceOf(Promise);
  });
});

// ---------------------------------------------------------------------------
// Row sanitation (Fix #8) — malformed rows are dropped, not blindly cast
// ---------------------------------------------------------------------------

describe("VerdictStore — malformed row sanitation (Fix #8)", () => {
  it("drops a null row among otherwise-valid rows", async () => {
    const doc = {
      schemaVersion: 1,
      rows: {
        "good|t": { attempts: 5, passes: 4, fails: 1, errors: 0, totalLatencyMs: 10, unverifiedPasses: 0 },
        "bad|t": null,
      },
    };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const store = new VerdictStore(client as VerdictStoreClient);

    const map = await store.loadRecommendations();
    expect(map.has("good|t")).toBe(true);
    expect(map.has("bad|t")).toBe(false);
  });

  it("drops a row with string counters instead of numbers", async () => {
    const doc = {
      schemaVersion: 1,
      rows: {
        "good|t": { attempts: 5, passes: 4, fails: 1, errors: 0, totalLatencyMs: 10, unverifiedPasses: 0 },
        "bad|t": { attempts: "5", passes: "4", fails: "1", errors: "0", totalLatencyMs: "10" },
      },
    };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const store = new VerdictStore(client as VerdictStoreClient);

    const map = await store.loadRecommendations();
    expect(map.has("good|t")).toBe(true);
    expect(map.has("bad|t")).toBe(false);
  });

  it("drops a row whose value is an array", async () => {
    const doc = {
      schemaVersion: 1,
      rows: { "bad|t": [1, 2, 3] },
    };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const store = new VerdictStore(client as VerdictStoreClient);

    const map = await store.loadRecommendations();
    expect(map.size).toBe(0);
  });

  it("sanitize-defaults a missing unverifiedPasses to 0 rather than dropping the row", async () => {
    const doc = {
      schemaVersion: 1,
      rows: {
        "m|t": { attempts: 5, passes: 4, fails: 1, errors: 0, totalLatencyMs: 10 }, // no unverifiedPasses field
      },
    };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const store = new VerdictStore(client as VerdictStoreClient);

    const map = await store.loadRecommendations();
    expect(map.get("m|t")?.unverifiedPasses).toBe(0);
  });

  it("a recordBatch on a doc with one malformed row alongside valid rows preserves the valid row and drops the malformed one", async () => {
    const doc = {
      schemaVersion: 1,
      rows: {
        "good|t": { attempts: 1, passes: 1, fails: 0, errors: 0, totalLatencyMs: 10, unverifiedPasses: 0 },
        "bad|t": { attempts: -1, passes: 1, fails: 0, errors: 0, totalLatencyMs: 10 },
      },
    };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const store = new VerdictStore(client as VerdictStoreClient);

    await store.recordBatch([{ modelId: "good", taskType: "t", event: "pass", latencyMs: 1 }]);

    const parsed = JSON.parse(client.getDoc()!.content);
    expect(parsed.rows["good|t"].passes).toBe(2);
    expect(parsed.rows["bad|t"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unknown schemaVersion → read-only for this run (Fix #8)
// ---------------------------------------------------------------------------

describe("VerdictStore — unknown schemaVersion (Fix #8)", () => {
  it("skips recording (no write) and logs once when the doc's schemaVersion is not 1", async () => {
    const doc = { schemaVersion: 2, rows: { "m|t": { attempts: 1, passes: 1, fails: 0, errors: 0, totalLatencyMs: 1, unverifiedPasses: 0 } } };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const logs: string[] = [];
    const store = new VerdictStore(client as VerdictStoreClient, (line) => logs.push(line));

    await store.record("m", "t", "pass", 10);

    expect(client.write).not.toHaveBeenCalled();
    expect(logs.some((l) => l.toLowerCase().includes("schema"))).toBe(true);
  });

  it("loadRecommendations returns an empty map for an unknown schemaVersion (does not misread rows)", async () => {
    const doc = { schemaVersion: 2, rows: { "m|t": { attempts: 10, passes: 10, fails: 0, errors: 0, totalLatencyMs: 1, unverifiedPasses: 0 } } };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const store = new VerdictStore(client as VerdictStoreClient);

    const map = await store.loadRecommendations();
    expect(map.size).toBe(0);
  });

  it("recordBatch also skips (no write) for an unknown schemaVersion", async () => {
    const doc = { schemaVersion: 2, rows: {} };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const store = new VerdictStore(client as VerdictStoreClient);

    await store.recordBatch([{ modelId: "m", taskType: "t", event: "pass", latencyMs: 1 }]);

    expect(client.write).not.toHaveBeenCalled();
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
        "goodModel|summarize": { attempts: 10, passes: 9, fails: 1, errors: 0, totalLatencyMs: 100, unverifiedPasses: 0 },
        "badModel|summarize": { attempts: 10, passes: 1, fails: 9, errors: 0, totalLatencyMs: 100, unverifiedPasses: 0 },
      },
    };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const store = new VerdictStore(client as VerdictStoreClient);

    const map = await store.loadRecommendations();
    expect(map.get("goodModel|summarize")?.recommendation).toBe("delegate-local");
    expect(map.get("badModel|summarize")?.recommendation).toBe("escalate-frontier");
  });

  it("carries unverifiedPasses through per row (feeds the re-probe gate)", async () => {
    const doc = {
      schemaVersion: 1,
      rows: {
        "m|t": { attempts: 20, passes: 10, fails: 0, errors: 0, totalLatencyMs: 100, unverifiedPasses: 12 },
      },
    };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const store = new VerdictStore(client as VerdictStoreClient);

    const map = await store.loadRecommendations();
    expect(map.get("m|t")?.unverifiedPasses).toBe(12);
  });

  it("fails open to an empty map when the read throws", async () => {
    const client = makeClient();
    client.read.mockRejectedValue(new Error("network down"));
    const store = new VerdictStore(client as VerdictStoreClient);

    const map = await store.loadRecommendations();
    expect(map.size).toBe(0);
  });
});
