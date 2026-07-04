import { describe, it, expect, vi } from "vitest";
import {
  SavingsStore,
  SAVINGS_NAMESPACE,
  SAVINGS_KEY,
  type SavingsStoreClient,
} from "../../src/orchestrator/savings-store.js";
import type { SavingsSummary } from "../../src/orchestrator/savings.js";

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

function makeSummary(overrides: Partial<SavingsSummary> = {}): SavingsSummary {
  return {
    baselineModelId: "claude-sonnet-4-6",
    coveredCalls: 2,
    uncoveredCalls: 1,
    inputTokens: 2_000_000,
    outputTokens: 2_000_000,
    actualCostUsd: 0.54,
    baselineCostUsd: 36.0,
    savedUsd: 35.46,
    byModel: {
      "openrouter|deepseek/deepseek-v4-flash": {
        calls: 2,
        inputTokens: 2_000_000,
        outputTokens: 2_000_000,
        actualCostUsd: 0.54,
        baselineCostUsd: 36.0,
      },
    },
    ...overrides,
  };
}

describe("SavingsStore.record — CAS read-modify-write", () => {
  it("creates the doc on first write (no prior entry, no CAS)", async () => {
    const client = makeClient();
    const store = new SavingsStore(client as SavingsStoreClient);

    await store.record(makeSummary());

    expect(client.write).toHaveBeenCalledTimes(1);
    const [ns, key, content] = client.write.mock.calls[0];
    expect(ns).toBe(SAVINGS_NAMESPACE);
    expect(key).toBe(SAVINGS_KEY);
    const parsed = JSON.parse(content as string);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.totals.runs).toBe(1);
    expect(parsed.totals.coveredCalls).toBe(2);
    expect(parsed.totals.uncoveredCalls).toBe(1);
    expect(parsed.totals.actualCostUsd).toBeCloseTo(0.54, 6);
    expect(parsed.totals.baselineCostUsd).toBeCloseTo(36.0, 6);
    expect(parsed.byModel["openrouter|deepseek/deepseek-v4-flash"].calls).toBe(2);
  });

  it("accumulates totals + byModel across multiple runs", async () => {
    const client = makeClient();
    const store = new SavingsStore(client as SavingsStoreClient);

    await store.record(makeSummary());
    await store.record(makeSummary());

    const doc = JSON.parse(client.getDoc()!.content);
    expect(doc.totals.runs).toBe(2);
    expect(doc.totals.coveredCalls).toBe(4);
    expect(doc.totals.actualCostUsd).toBeCloseTo(1.08, 6);
    expect(doc.byModel["openrouter|deepseek/deepseek-v4-flash"].calls).toBe(4);
  });

  it("passes expected_updated_at on the second write once a doc exists", async () => {
    const client = makeClient();
    const store = new SavingsStore(client as SavingsStoreClient);

    await store.record(makeSummary());
    await store.record(makeSummary());

    const secondCallArgs = client.write.mock.calls[1];
    expect(secondCallArgs[4]).toBe("v1");
  });

  it("on a CAS conflict, re-reads and retries once, then succeeds", async () => {
    const client = makeClient();
    const store = new SavingsStore(client as SavingsStoreClient);
    await store.record(makeSummary()); // seed a doc

    let failNext = true;
    const originalWrite = client.write.getMockImplementation()!;
    client.write.mockImplementation(async (...args: Parameters<typeof originalWrite>) => {
      if (failNext) {
        failNext = false;
        throw new Error("simulated CAS conflict");
      }
      return originalWrite(...args);
    });

    await store.record(makeSummary());

    // read: 1 (seed) + 1 (attempt) + 1 (retry re-read) = 3
    expect(client.read).toHaveBeenCalledTimes(3);
    const doc = JSON.parse(client.getDoc()!.content);
    expect(doc.totals.runs).toBe(2);
  });

  it("never throws — drops silently after the retry also fails", async () => {
    const client = makeClient();
    client.write.mockRejectedValue(new Error("Munin is down"));
    const store = new SavingsStore(client as SavingsStoreClient);

    await expect(store.record(makeSummary())).resolves.toBeUndefined();
  });

  it("logs (via onLog) rather than throwing when recording ultimately fails", async () => {
    const client = makeClient();
    client.write.mockRejectedValue(new Error("Munin is down"));
    const logs: string[] = [];
    const store = new SavingsStore(client as SavingsStoreClient, (line) => logs.push(line));

    await store.record(makeSummary());

    expect(logs.some((l) => l.toLowerCase().includes("savings"))).toBe(true);
  });

  it("tolerates a malformed existing doc (falls back to empty totals/byModel)", async () => {
    const client = makeClient({ content: "not json at all", updated_at: "v1" });
    const store = new SavingsStore(client as SavingsStoreClient);

    await store.record(makeSummary());

    const doc = JSON.parse(client.getDoc()!.content);
    expect(doc.totals.runs).toBe(1);
  });

  it("a never-resolving client.read() does not reject record's promise prematurely (caller may fire-and-forget)", async () => {
    const client = {
      read: vi.fn(() => new Promise(() => {})),
      write: vi.fn(),
    };
    const store = new SavingsStore(client as unknown as SavingsStoreClient);

    const p = store.record(makeSummary());
    expect(p).toBeInstanceOf(Promise);
  });
});

describe("SavingsStore — row sanitation", () => {
  it("drops malformed totals (non-finite/negative) and starts fresh rather than crashing", async () => {
    const doc = {
      schemaVersion: 1,
      totals: { runs: -1, coveredCalls: 1, uncoveredCalls: 0, inputTokens: 1, outputTokens: 1, actualCostUsd: 0.1, baselineCostUsd: 1 },
      byModel: {},
    };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const store = new SavingsStore(client as SavingsStoreClient);

    await store.record(makeSummary());

    const written = JSON.parse(client.getDoc()!.content);
    expect(written.totals.runs).toBe(1); // fresh totals + this run, not -1+1
  });

  it("drops a malformed byModel row but keeps other valid rows", async () => {
    const doc = {
      schemaVersion: 1,
      totals: { runs: 1, coveredCalls: 1, uncoveredCalls: 0, inputTokens: 1, outputTokens: 1, actualCostUsd: 0.1, baselineCostUsd: 1 },
      byModel: {
        "good|model": { calls: 1, inputTokens: 10, outputTokens: 10, actualCostUsd: 0.01, baselineCostUsd: 0.1 },
        "bad|model": { calls: "not-a-number", inputTokens: 10, outputTokens: 10, actualCostUsd: 0.01, baselineCostUsd: 0.1 },
      },
    };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const store = new SavingsStore(client as SavingsStoreClient);

    await store.record(makeSummary({ byModel: {} }));

    const written = JSON.parse(client.getDoc()!.content);
    expect(written.byModel["good|model"]).toBeDefined();
    expect(written.byModel["bad|model"]).toBeUndefined();
  });

  it("accepts non-integer (float) USD cost fields — costs are floats, not required to be integers", async () => {
    const summary = makeSummary({ actualCostUsd: 0.123456, baselineCostUsd: 12.345678 });
    const client = makeClient();
    const store = new SavingsStore(client as SavingsStoreClient);

    await store.record(summary);

    const written = JSON.parse(client.getDoc()!.content);
    expect(written.totals.actualCostUsd).toBeCloseTo(0.123456, 6);
    expect(written.totals.baselineCostUsd).toBeCloseTo(12.345678, 6);
  });
});

describe("SavingsStore — unknown schemaVersion → read-only", () => {
  it("skips recording (no write) and logs once when the doc's schemaVersion is not 1", async () => {
    const doc = {
      schemaVersion: 2,
      totals: { runs: 1, coveredCalls: 1, uncoveredCalls: 0, inputTokens: 1, outputTokens: 1, actualCostUsd: 0.1, baselineCostUsd: 1 },
      byModel: {},
    };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const logs: string[] = [];
    const store = new SavingsStore(client as SavingsStoreClient, (line) => logs.push(line));

    await store.record(makeSummary());

    expect(client.write).not.toHaveBeenCalled();
    expect(logs.some((l) => l.toLowerCase().includes("schema"))).toBe(true);
  });
});
