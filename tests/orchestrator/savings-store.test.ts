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
    qaBaselineCreditUsd: 18.0,
    qualityAdjustedSavedUsd: 18.0 - 0.54,
    byModel: {
      "openrouter|deepseek/deepseek-v4-flash": {
        calls: 2,
        inputTokens: 2_000_000,
        outputTokens: 2_000_000,
        actualCostUsd: 0.54,
        baselineCostUsd: 36.0,
      },
    },
    byOutcome: {
      pass: { calls: 1, actualCostUsd: 0.27, baselineCostUsd: 18.0, qaBaselineCreditUsd: 18.0 },
      fail: { calls: 1, actualCostUsd: 0.27, baselineCostUsd: 18.0, qaBaselineCreditUsd: 0 },
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

describe("SavingsStore — quality-adjusted counters (issue #144)", () => {
  it("persists qaBaselineCreditUsd in totals and byOutcome buckets on first write", async () => {
    const client = makeClient();
    const store = new SavingsStore(client as SavingsStoreClient);

    await store.record(makeSummary());

    const doc = JSON.parse(client.getDoc()!.content);
    expect(doc.totals.qaBaselineCreditUsd).toBeCloseTo(18.0, 6);
    expect(doc.byOutcome.pass.calls).toBe(1);
    expect(doc.byOutcome.pass.qaBaselineCreditUsd).toBeCloseTo(18.0, 6);
    expect(doc.byOutcome.fail.qaBaselineCreditUsd).toBe(0);
    // Lifetime quality-adjusted savings derive at read time:
    // qaBaselineCreditUsd − actualCostUsd (here 18.0 − 0.54).
    expect(doc.totals.qaBaselineCreditUsd - doc.totals.actualCostUsd).toBeCloseTo(17.46, 6);
  });

  it("accumulates byOutcome buckets across runs", async () => {
    const client = makeClient();
    const store = new SavingsStore(client as SavingsStoreClient);

    await store.record(makeSummary());
    await store.record(makeSummary());

    const doc = JSON.parse(client.getDoc()!.content);
    expect(doc.totals.qaBaselineCreditUsd).toBeCloseTo(36.0, 6);
    expect(doc.byOutcome.pass.calls).toBe(2);
    expect(doc.byOutcome.fail.calls).toBe(2);
    expect(doc.byOutcome.fail.actualCostUsd).toBeCloseTo(0.54, 6);
  });

  it("a pre-#144 doc (no qa fields) is NOT reset — totals preserved, qa counters default to 0", async () => {
    const oldDoc = {
      schemaVersion: 1,
      totals: { runs: 5, coveredCalls: 10, uncoveredCalls: 2, inputTokens: 100, outputTokens: 100, actualCostUsd: 1.0, baselineCostUsd: 50.0 },
      byModel: {},
    };
    const client = makeClient({ content: JSON.stringify(oldDoc), updated_at: "v1" });
    const store = new SavingsStore(client as SavingsStoreClient);

    await store.record(makeSummary());

    const doc = JSON.parse(client.getDoc()!.content);
    expect(doc.totals.runs).toBe(6); // preserved 5 + this run — never reset
    expect(doc.totals.baselineCostUsd).toBeCloseTo(86.0, 6);
    expect(doc.totals.qaBaselineCreditUsd).toBeCloseTo(18.0, 6); // 0 default + this run
    expect(doc.byOutcome.pass.calls).toBe(1);
  });

  it("drops a malformed byOutcome row but keeps valid ones", async () => {
    const doc = {
      schemaVersion: 1,
      totals: { runs: 1, coveredCalls: 1, uncoveredCalls: 0, inputTokens: 1, outputTokens: 1, actualCostUsd: 0.1, baselineCostUsd: 1, qaBaselineCreditUsd: 1 },
      byModel: {},
      byOutcome: {
        pass: { calls: 1, actualCostUsd: 0.1, baselineCostUsd: 1, qaBaselineCreditUsd: 1 },
        fail: { calls: "corrupt", actualCostUsd: 0.1, baselineCostUsd: 1, qaBaselineCreditUsd: 0 },
      },
    };
    const client = makeClient({ content: JSON.stringify(doc), updated_at: "v1" });
    const store = new SavingsStore(client as SavingsStoreClient);

    await store.record(makeSummary({ byOutcome: {} }));

    const written = JSON.parse(client.getDoc()!.content);
    expect(written.byOutcome.pass).toBeDefined();
    expect(written.byOutcome.fail).toBeUndefined();
  });

  it("write-path validation rejects a summary with negative qaBaselineCreditUsd or non-finite qualityAdjustedSavedUsd", async () => {
    const client = makeClient();
    const store = new SavingsStore(client as unknown as SavingsStoreClient);
    await store.record(makeSummary({ qaBaselineCreditUsd: -1 }));
    await store.record(makeSummary({ qualityAdjustedSavedUsd: Number.NaN }));
    await store.record(
      makeSummary({
        byOutcome: { pass: { calls: 0.5, actualCostUsd: 0, baselineCostUsd: 0, qaBaselineCreditUsd: 0 } },
      }),
    );
    expect(client.getDoc()).toBeNull(); // no write ever happened
  });

  it("accepts a NEGATIVE qualityAdjustedSavedUsd (a losing run is valid data, not corruption)", async () => {
    const client = makeClient();
    const store = new SavingsStore(client as SavingsStoreClient);

    await store.record(
      makeSummary({ qaBaselineCreditUsd: 0, qualityAdjustedSavedUsd: -0.54 }),
    );

    const doc = JSON.parse(client.getDoc()!.content);
    expect(doc.totals.runs).toBe(1);
    expect(doc.totals.qaBaselineCreditUsd).toBe(0);
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

describe("SavingsStore — write-path validation (review fix)", () => {
  it("skips a summary with fractional token counts instead of poisoning the doc", async () => {
    const client = makeClient();
    const logs: string[] = [];
    const store = new SavingsStore(client as unknown as SavingsStoreClient, (l) => logs.push(l));
    await store.record(makeSummary()); // healthy baseline run
    const healthy = client.getDoc()!.content;

    await store.record(makeSummary({ inputTokens: 1000.5 }));
    expect(client.getDoc()!.content).toBe(healthy); // nothing merged
    expect(logs.some((l) => l.includes("out-of-range"))).toBe(true);

    // a later healthy run still accumulates on top of the preserved doc
    await store.record(makeSummary());
    const totals = JSON.parse(client.getDoc()!.content).totals;
    expect(totals.runs).toBe(2);
  });

  it("skips NaN/negative cost and malformed byModel buckets", async () => {
    const client = makeClient();
    const store = new SavingsStore(client as unknown as SavingsStoreClient);
    await store.record(makeSummary({ actualCostUsd: Number.NaN }));
    await store.record(makeSummary({ baselineCostUsd: -1 }));
    await store.record(
      makeSummary({
        byModel: {
          x: { calls: 0.5, inputTokens: 0, outputTokens: 0, actualCostUsd: 0, baselineCostUsd: 0 },
        },
      }),
    );
    expect(client.getDoc()).toBeNull(); // no write ever happened
  });
});

describe("SavingsStore — idempotent CAS retry (review fix)", () => {
  it("does not double-count when a committed write throws before returning", async () => {
    const client = makeClient();
    // First write commits server-side, then the response is 'lost'.
    let failedOnce = false;
    const origWrite = client.write.getMockImplementation()!;
    client.write.mockImplementation(async (...args: Parameters<typeof origWrite>) => {
      const result = await origWrite(...args);
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("socket reset after commit");
      }
      return result;
    });

    const store = new SavingsStore(client as unknown as SavingsStoreClient);
    await store.record(makeSummary());

    const totals = JSON.parse(client.getDoc()!.content).totals;
    expect(totals.runs).toBe(1); // applied exactly once, not twice
    expect(totals.coveredCalls).toBe(2);
  });
});
