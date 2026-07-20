import { describe, expect, it } from "vitest";
import { MuninWriteRejectedError, type MuninClient, type MuninQueryResult } from "../src/munin-client.js";
import { LearningRegistryStore } from "../src/learning-registry-store.js";
import {
  runHarnessLaneSampledAttempt,
  type HarnessLaneExecutors,
  type LaneAttemptOutcome,
} from "../src/harness-lane-executor.js";
import { HARNESS_LANE_FRACTION_ENV } from "../src/harness-lane-sampler.js";
import {
  buildHarnessLaneComparisonReport,
  computeHarnessLaneComparison,
  formatHarnessLaneComparisonReport,
} from "../src/harness-lane-comparison-report.js";
import type { TerminalOutcomeEvent } from "../src/learning-registry-schema.js";

interface StoredEntry {
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  classification?: string;
  created_at: string;
  updated_at: string;
}

class InMemoryMunin {
  private entries: StoredEntry[] = [];
  private seq = 0;

  private clock(): string {
    this.seq += 1;
    return new Date(Date.UTC(2026, 6, 1, 0, 0, 0, 0) + this.seq).toISOString();
  }

  private find(namespace: string, key: string): StoredEntry | undefined {
    return this.entries.find((e) => e.namespace === namespace && e.key === key);
  }

  async read(namespace: string, key: string) {
    const entry = this.find(namespace, key);
    if (!entry) return null;
    return { ...entry, found: true } as unknown as (MuninQueryResult & { found: true });
  }

  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
    createIfAbsent?: boolean,
  ) {
    const existing = this.find(namespace, key);
    if (createIfAbsent && existing) {
      throw new MuninWriteRejectedError(namespace, key, {
        error: "conflict",
        message: "Entry already exists.",
        conflict_reason: "already_exists",
        current_updated_at: existing.updated_at,
      });
    }
    if (expectedUpdatedAt !== undefined && (!existing || existing.updated_at !== expectedUpdatedAt)) {
      throw new MuninWriteRejectedError(namespace, key, {
        error: "conflict",
        message: "Entry version changed.",
        conflict_reason: "version_mismatch",
        current_updated_at: existing?.updated_at,
      });
    }
    const updated_at = this.clock();
    const created_at = existing?.created_at ?? updated_at;
    const next: StoredEntry = { namespace, key, content, tags: tags ?? [], classification, created_at, updated_at };
    if (existing) {
      Object.assign(existing, next);
    } else {
      this.entries.push(next);
    }
    return { ok: true, status: existing ? "updated" : "created", updated_at };
  }

  async query(opts: { namespace?: string; tags?: string[]; limit?: number; since?: string; until?: string }) {
    let rows = this.entries.filter((e) =>
      (!opts.namespace || e.namespace.startsWith(opts.namespace))
      && (opts.tags ?? []).every((tag) => e.tags.includes(tag)));
    if (opts.since) rows = rows.filter((e) => e.updated_at >= opts.since!);
    if (opts.until) rows = rows.filter((e) => e.updated_at <= opts.until!);
    rows = [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const limited = rows.slice(0, opts.limit ?? 50);
    return {
      results: limited.map((e) => ({
        id: `${e.namespace}/${e.key}`,
        namespace: e.namespace,
        key: e.key,
        entry_type: "state",
        content_preview: e.content.slice(0, 80),
        tags: e.tags,
        classification: e.classification,
        created_at: e.created_at,
        updated_at: e.updated_at,
      })),
      total: rows.length,
    };
  }
}

function munin(): InMemoryMunin & MuninClient {
  return new InMemoryMunin() as unknown as InMemoryMunin & MuninClient;
}

function ref(taskId: string, key: string) {
  return { namespace: `tasks/${taskId}`, key };
}

function outcome(overrides: Partial<LaneAttemptOutcome> & { taskOutcomeRef: LaneAttemptOutcome["taskOutcomeRef"] }): LaneAttemptOutcome {
  return {
    outcome: "completed",
    verifierKind: "mechanical",
    verdict: "pass",
    ...overrides,
  };
}

function fixedExecutors(result: LaneAttemptOutcome): HarnessLaneExecutors {
  return { oneShot: async () => result, harness: async () => result };
}

const OCCURRED_AT = "2026-07-20T10:00:00.000Z";

describe("computeHarnessLaneComparison — pure aggregation", () => {
  it("computes per-(taskType, lane) attempts/verified/passed/escalated and rates", async () => {
    const store = new LearningRegistryStore(munin());
    // Build directly via the store's own terminal-outcome writer so this test
    // exercises the exact persisted event shape, not a hand-rolled fixture.
    const events: TerminalOutcomeEvent[] = [];

    async function record(taskId: string, taskType: string, lane: "one-shot" | "harness", verdict: "pass" | "fail" | "unverified", escalated = false) {
      const result = await store.recordTerminalOutcome({
        taskId,
        attemptId: "attempt-1",
        outcome: verdict === "fail" ? "failed" : "completed",
        taskOutcomeRef: ref(taskId, "result-structured"),
        occurredAt: OCCURRED_AT,
        delegation: { lane, taskType, outcome: verdict, escalated },
      });
      events.push(result.event);
    }

    await record("t1", "code-edit", "one-shot", "pass");
    await record("t2", "code-edit", "one-shot", "pass");
    await record("t3", "code-edit", "one-shot", "fail");
    await record("t4", "code-edit", "harness", "pass");
    await record("t5", "code-edit", "harness", "fail", true);
    await record("t6", "code-implement", "harness", "unverified");

    const rows = computeHarnessLaneComparison(events);
    const codeEditOneShot = rows.find((r) => r.taskType === "code-edit" && r.lane === "one-shot")!;
    expect(codeEditOneShot.attempts).toBe(3);
    expect(codeEditOneShot.verifiedAttempts).toBe(3);
    expect(codeEditOneShot.passed).toBe(2);
    expect(codeEditOneShot.verifiedPassRate).toBeCloseTo(2 / 3);
    expect(codeEditOneShot.escalationRate).toBe(0);

    const codeEditHarness = rows.find((r) => r.taskType === "code-edit" && r.lane === "harness")!;
    expect(codeEditHarness.attempts).toBe(2);
    expect(codeEditHarness.verifiedAttempts).toBe(2);
    expect(codeEditHarness.passed).toBe(1);
    expect(codeEditHarness.verifiedPassRate).toBeCloseTo(0.5);
    expect(codeEditHarness.escalationRate).toBeCloseTo(0.5);

    const codeImplementHarness = rows.find((r) => r.taskType === "code-implement" && r.lane === "harness")!;
    expect(codeImplementHarness.attempts).toBe(1);
    expect(codeImplementHarness.verifiedAttempts).toBe(0);
    expect(codeImplementHarness.verifiedPassRate).toBeNull();
  });

  it("skips terminal outcomes with no sampler-stamped lane", async () => {
    const store = new LearningRegistryStore(munin());
    const result = await store.recordTerminalOutcome({
      taskId: "t-legacy",
      attemptId: "attempt-1",
      outcome: "completed",
      taskOutcomeRef: ref("t-legacy", "result-structured"),
      occurredAt: OCCURRED_AT,
      // no `delegation` at all — a pre-#267 or externally-ingested row.
    });
    const rows = computeHarnessLaneComparison([result.event]);
    expect(rows).toHaveLength(0);
  });
});

describe("buildHarnessLaneComparisonReport — end-to-end from a fixture registry", () => {
  it("reads across the queried periods and reports content-blind rows", async () => {
    const store = new LearningRegistryStore(munin());
    const executors = fixedExecutors(outcome({ taskOutcomeRef: ref("dummy", "result-structured"), verdict: "pass" }));

    // Two harness-lane attempts and one one-shot for the same task type, all
    // via the real wiring, in the same UTC month as OCCURRED_AT.
    await runHarnessLaneSampledAttempt(
      store,
      { taskId: "cmp-1", attemptId: "a1", taskType: "unit-test-gen", occurredAt: OCCURRED_AT },
      { oneShot: executors.oneShot, harness: async () => outcome({ taskOutcomeRef: ref("cmp-1", "r"), verdict: "pass" }) },
      { env: { [HARNESS_LANE_FRACTION_ENV]: "1" } },
    );
    await runHarnessLaneSampledAttempt(
      store,
      { taskId: "cmp-2", attemptId: "a1", taskType: "unit-test-gen", occurredAt: OCCURRED_AT },
      { oneShot: executors.oneShot, harness: async () => outcome({ taskOutcomeRef: ref("cmp-2", "r"), verdict: "fail" }) },
      { env: { [HARNESS_LANE_FRACTION_ENV]: "1" } },
    );
    await runHarnessLaneSampledAttempt(
      store,
      { taskId: "cmp-3", attemptId: "a1", taskType: "unit-test-gen", occurredAt: OCCURRED_AT },
      { oneShot: async () => outcome({ taskOutcomeRef: ref("cmp-3", "r"), verdict: "pass" }), harness: executors.harness },
      { env: {} }, // off -> one-shot
    );

    const report = await buildHarnessLaneComparisonReport(store, ["2026-07"]);
    expect(report.truncated).toBe(false);
    expect(report.periodsQueried).toEqual(["2026-07"]);

    const harnessRow = report.rows.find((r) => r.taskType === "unit-test-gen" && r.lane === "harness")!;
    expect(harnessRow.attempts).toBe(2);
    expect(harnessRow.passed).toBe(1);
    expect(harnessRow.verifiedPassRate).toBeCloseTo(0.5);

    const oneShotRow = report.rows.find((r) => r.taskType === "unit-test-gen" && r.lane === "one-shot")!;
    expect(oneShotRow.attempts).toBe(1);
    expect(oneShotRow.passed).toBe(1);

    const text = formatHarnessLaneComparisonReport(report);
    expect(text).toContain("unit-test-gen");
    expect(text).toContain("harness");
    expect(text).toContain("one-shot");
    // Content-blind: never echoes anything task-specific beyond type/lane/counts.
    expect(text).not.toContain("cmp-1");
  });

  it("queries only the requested period and does not leak other months' evidence", async () => {
    const store = new LearningRegistryStore(munin());
    await store.recordTerminalOutcome({
      taskId: "other-month",
      attemptId: "attempt-1",
      outcome: "completed",
      taskOutcomeRef: ref("other-month", "result-structured"),
      occurredAt: "2026-06-15T00:00:00.000Z",
      delegation: { lane: "harness", taskType: "code-edit", outcome: "pass" },
    });

    const julyReport = await buildHarnessLaneComparisonReport(store, ["2026-07"]);
    expect(julyReport.rows).toHaveLength(0);

    const juneReport = await buildHarnessLaneComparisonReport(store, ["2026-06"]);
    expect(juneReport.rows).toHaveLength(1);
  });
});
