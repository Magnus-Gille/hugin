import { describe, expect, it, vi } from "vitest";
import { LearningLoopCollector } from "../src/learning-loop-collector.js";
import type { MuninClient } from "../src/munin-client.js";
import type { Ledger, LedgerClientLike } from "../src/orchestrator/ledger-client.js";

const ENVELOPE = (submitter: string) =>
  `## Task\n\n### Broker envelope\n\`\`\`json\n${JSON.stringify({
    envelope_version: 2,
    orchestrator_submitter: submitter,
    orchestrator_session_id: "session-A",
  })}\n\`\`\`\n`;

function fakeMunin(entries: Record<string, { content: string; tags?: string[] }>): MuninClient {
  return {
    query: vi.fn(async () => ({
      results: Object.keys(entries)
        .filter((k) => k.endsWith("/status"))
        .map((k) => ({ namespace: k.replace(/\/status$/, ""), key: "status" })),
      total: 0,
    })),
    read: vi.fn(async (ns: string, key: string) => entries[`${ns}/${key}`] ?? null),
  } as unknown as MuninClient;
}

const okLedger: Ledger = {
  report: [
    {
      taskType: "extract", modelId: "mellum", verdict: "viable", attempts: 10,
      passes: 9, fails: 1, errors: 0, successRate: 0.9, frozen: false,
      recommendation: "delegate-local",
    },
  ],
};
const fakeLedgerClient = (ledger: Ledger | null): LedgerClientLike => ({
  getLedger: vi.fn(async () => ledger),
});

describe("LearningLoopCollector", () => {
  it("collects rating, durable-handoff and route-policy provenance for a broker task", async () => {
    const munin = fakeMunin({
      "tasks/mcp-m5-1/status": { content: ENVELOPE("claude-code"), tags: ["completed", "broker:mcp-v2"] },
      "tasks/mcp-m5-1/feedback": {
        content: JSON.stringify({ rating: "pass", verification_outcome: "accepted_unchanged" }),
      },
      "tasks/mcp-m5-1/await-observation": {
        content: JSON.stringify({ durableHandoff: true, terminalCollected: true }),
      },
      "tasks/mcp-m5-1/result-structured": {
        content: JSON.stringify({
          runtimeMetadata: {
            delegation: { policyMode: "shadow", policyAction: "shadow", priceCatalogVersion: "2026-07-08" },
          },
        }),
      },
    });

    const evidence = await new LearningLoopCollector({
      munin, ledgerClient: fakeLedgerClient(okLedger),
    }).refresh();

    expect(evidence.tasks).toHaveLength(1);
    const t = evidence.tasks[0]!;
    expect(t.taskId).toBe("mcp-m5-1");
    expect(t.submitter).toBe("claude-code");
    expect(t.rating).toBe("pass");
    expect(t.durableHandoff).toBe(true);
    expect(t.delegation?.policyMode).toBe("shadow");
    expect(evidence.ledger).toEqual(okLedger);
  });

  // Caught against REAL production data: the one existing broker task predates
  // PR #173, so its terminal status tags are ["completed","runtime:homeserver"]
  // with NO `broker:mcp-v2` marker (that tag-dropping seam is exactly what #173
  // fixed). Keying the corpus walk off the tag alone under-counts the trial —
  // reporting 0 tasks when there is 1. The embedded broker envelope is the
  // definitive marker, so identify tasks by envelope, not by tag.
  it("finds a pre-#173 broker task whose status lost the broker:mcp-v2 tag", async () => {
    const entries: Record<string, { content: string; tags?: string[] }> = {
      "tasks/mcp-m5-old/status": {
        content: ENVELOPE("claude-code"),
        tags: ["completed", "runtime:homeserver"], // no broker:mcp-v2
      },
      "tasks/mcp-m5-old/feedback": { content: JSON.stringify({ rating: "pass" }) },
    };
    const munin = {
      // The tag query only ever surfaces the explicitly-tagged feedback doc.
      query: vi.fn(async (q: { tags?: string[] }) =>
        q.tags?.includes("broker:mcp-v2")
          ? { results: [{ namespace: "tasks/mcp-m5-old", key: "feedback" }], total: 1 }
          : { results: [{ namespace: "tasks/mcp-m5-old", key: "status" }], total: 1 }
      ),
      read: vi.fn(async (ns: string, key: string) => entries[`${ns}/${key}`] ?? null),
    } as unknown as MuninClient;

    const evidence = await new LearningLoopCollector({
      munin, ledgerClient: fakeLedgerClient(null),
    }).refresh();

    expect(evidence.tasks).toHaveLength(1);
    expect(evidence.tasks[0]!.taskId).toBe("mcp-m5-old");
    expect(evidence.tasks[0]!.rating).toBe("pass");
    expect(evidence.tasks[0]!.submitter).toBe("claude-code");
  });

  it("ignores a non-broker task that carries no envelope", async () => {
    const munin = {
      query: vi.fn(async () => ({
        results: [{ namespace: "tasks/20260101-plain", key: "status" }],
        total: 1,
      })),
      read: vi.fn(async (ns: string, key: string) =>
        key === "status" ? { content: "## Task: ordinary\n\n### Prompt\nhi", tags: ["completed"] } : null
      ),
    } as unknown as MuninClient;

    const evidence = await new LearningLoopCollector({
      munin, ledgerClient: fakeLedgerClient(null),
    }).refresh();

    // Product evidence is about the BROKER path under test (#165), not the
    // general dispatcher corpus.
    expect(evidence.tasks).toEqual([]);
  });

  it("degrades to no-evidence rather than throwing when Munin is down", async () => {
    const munin = {
      query: vi.fn(async () => {
        throw new Error("munin down");
      }),
      read: vi.fn(async () => null),
    } as unknown as MuninClient;

    const evidence = await new LearningLoopCollector({
      munin, ledgerClient: fakeLedgerClient(okLedger),
    }).refresh();

    // /heimdall.json must never break because evidence collection failed.
    // Codex review: a failed query must NOT read as a measured-empty corpus.
    expect(evidence.available).toBe(false);
    expect(evidence.tasks).toEqual([]);
    expect(evidence.ledger).toEqual(okLedger); // the ledger half still works
  });

  it("degrades to a null ledger when the gateway is unreachable", async () => {
    const munin = fakeMunin({
      "tasks/mcp-m5-1/status": { content: ENVELOPE("claude-code"), tags: ["completed"] },
    });
    const evidence = await new LearningLoopCollector({
      munin,
      ledgerClient: { getLedger: vi.fn(async () => { throw new Error("gateway down"); }) },
    }).refresh();

    expect(evidence.ledger).toBeNull(); // "unavailable", not a fabricated zero
    expect(evidence.tasks).toHaveLength(1);
  });

  it("caches — a 60s dashboard poll must not re-walk the corpus every time", async () => {
    const munin = fakeMunin({
      "tasks/mcp-m5-1/status": { content: ENVELOPE("claude-code"), tags: ["completed"] },
    });
    const collector = new LearningLoopCollector({
      munin, ledgerClient: fakeLedgerClient(okLedger), ttlMs: 300_000, now: () => 1000,
    });

    await collector.refresh(); // prime the cache
    collector.collect();
    collector.collect();
    collector.collect();

    // Cached reads do no further corpus walks (one walk = two queries).
    expect(munin.query).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent collections into a single corpus walk", async () => {
    const munin = fakeMunin({
      "tasks/mcp-m5-1/status": { content: ENVELOPE("claude-code"), tags: ["completed"] },
    });
    const collector = new LearningLoopCollector({ munin, ledgerClient: fakeLedgerClient(okLedger) });

    await Promise.all([collector.refresh(), collector.refresh(), collector.refresh()]);

    // One corpus walk (two queries), not three.
    expect(munin.query).toHaveBeenCalledTimes(2);
  });

  it("survives a corrupt feedback document without losing the whole task", async () => {
    const munin = fakeMunin({
      "tasks/mcp-m5-1/status": { content: ENVELOPE("claude-code"), tags: ["completed"] },
      "tasks/mcp-m5-1/feedback": { content: "{not json" },
    });
    const evidence = await new LearningLoopCollector({
      munin, ledgerClient: fakeLedgerClient(null),
    }).refresh();

    expect(evidence.tasks).toHaveLength(1);
    expect(evidence.tasks[0]!.rating).toBeNull(); // one lost data point, not a crash
  });

  // Codex review: awaiting a cold corpus walk on /heimdall.json (up to 200 tasks
  // × several serialized Munin reads) can hang the descriptor for ~a minute and
  // blank Hugin's Heimdall page — the #135 regression, no exception needed.
  it("returns immediately on a cold cache instead of blocking on the walk", () => {
    const munin = {
      query: vi.fn(() => new Promise(() => {})), // a walk that never resolves
      read: vi.fn(() => new Promise(() => {})),
    } as unknown as MuninClient;

    const collector = new LearningLoopCollector({
      munin, ledgerClient: { getLedger: () => new Promise(() => {}) },
    });

    // Synchronous — no await. Must not hang, and must say "unavailable" rather
    // than invent an empty corpus.
    const evidence = collector.collect();
    expect(evidence.available).toBe(false);
    expect(evidence.tasks).toEqual([]);
  });

  it("serves stale evidence rather than blocking while it refreshes", async () => {
    let clock = 1000;
    const munin = fakeMunin({
      "tasks/mcp-m5-1/status": { content: ENVELOPE("claude-code"), tags: ["completed"] },
    });
    const collector = new LearningLoopCollector({
      munin, ledgerClient: fakeLedgerClient(okLedger), ttlMs: 100, now: () => clock,
    });

    await collector.refresh();
    clock += 10_000; // cache is now stale

    const evidence = collector.collect(); // still instant, stale but honest
    expect(evidence.available).toBe(true);
    expect(evidence.tasks).toHaveLength(1);
  });

  it("does not cache a failed collection — the next tick retries", async () => {
    let fail = true;
    const munin = {
      query: vi.fn(async () => {
        if (fail) throw new Error("munin down");
        return { results: [{ namespace: "tasks/mcp-m5-1", key: "status" }], total: 1 };
      }),
      read: vi.fn(async (_ns: string, key: string) =>
        key === "status" ? { content: ENVELOPE("claude-code"), tags: ["completed"] } : null
      ),
    } as unknown as MuninClient;

    const collector = new LearningLoopCollector({ munin, ledgerClient: fakeLedgerClient(null) });

    expect((await collector.refresh()).available).toBe(false);
    fail = false;
    expect((await collector.refresh()).available).toBe(true); // recovers
  });
});
