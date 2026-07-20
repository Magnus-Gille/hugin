import { describe, expect, it } from "vitest";
import { MuninWriteRejectedError, type MuninClient, type MuninQueryResult } from "../src/munin-client.js";
import { LearningRegistryStore } from "../src/learning-registry-store.js";
import {
  runHarnessLaneSampledAttempt,
  type HarnessLaneExecutors,
  type LaneAttemptOutcome,
} from "../src/harness-lane-executor.js";
import { HARNESS_LANE_FRACTION_ENV } from "../src/harness-lane-sampler.js";

interface StoredEntry {
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  classification?: string;
  created_at: string;
  updated_at: string;
}

/** Same in-memory create-if-absent / CAS Munin double used across the
 * registry test suite (tests/learning-registry-store.test.ts,
 * tests/external-receipt-intake.test.ts). */
class InMemoryMunin {
  private entries: StoredEntry[] = [];
  private seq = 0;

  private clock(): string {
    this.seq += 1;
    return new Date(Date.UTC(2026, 6, 20, 0, 0, 0, 0) + this.seq).toISOString();
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

function passOutcome(overrides: Partial<LaneAttemptOutcome> = {}): LaneAttemptOutcome {
  return {
    outcome: "completed",
    taskOutcomeRef: ref("task-x", "result-structured"),
    verifierKind: "mechanical",
    verdict: "pass",
    ...overrides,
  };
}

interface RecordingExecutors extends HarnessLaneExecutors {
  oneShotCalls: number;
  harnessCalls: number;
}

function makeExecutors(opts: {
  oneShot?: () => Promise<LaneAttemptOutcome>;
  harness?: () => Promise<LaneAttemptOutcome>;
} = {}): RecordingExecutors {
  const recorder: RecordingExecutors = {
    oneShotCalls: 0,
    harnessCalls: 0,
    oneShot: async () => {
      recorder.oneShotCalls += 1;
      return (opts.oneShot ?? (async () => passOutcome({ modelId: "claude-sdk", nodeId: "claude-sdk" })))();
    },
    harness: async () => {
      recorder.harnessCalls += 1;
      return (opts.harness ?? (async () => passOutcome({ modelId: "qwen3-coder-next-80b", nodeId: "opencode-m5", iterations: 4 })))();
    },
  };
  return recorder;
}

const OCCURRED_AT = "2026-07-20T10:00:00.000Z";

describe("runHarnessLaneSampledAttempt — harness lane recording", () => {
  it("records a sampled harness attempt into #232 with harness identity, graded like one-shot", async () => {
    const store = new LearningRegistryStore(munin());
    const executors = makeExecutors({
      harness: async () => passOutcome({
        modelId: "qwen3-coder-next-80b",
        nodeId: "opencode-m5",
        iterations: 5,
        taskOutcomeRef: ref("task-h1", "result-structured"),
      }),
    });

    const result = await runHarnessLaneSampledAttempt(
      store,
      { taskId: "task-h1", attemptId: "attempt-1", taskType: "code-edit", occurredAt: OCCURRED_AT },
      executors,
      { env: { [HARNESS_LANE_FRACTION_ENV]: "1" } },
    );

    expect(result.lane).toBe("harness");
    expect(executors.harnessCalls).toBe(1);
    expect(executors.oneShotCalls).toBe(0);

    const delegation = result.registry.terminalOutcome.event.payload.delegation;
    expect(delegation?.lane).toBe("harness");
    expect(delegation?.taskType).toBe("code-edit");
    expect(delegation?.outcome).toBe("pass");
    expect(delegation?.verifier).toBe("mechanical");
    expect(delegation?.modelId).toBe("qwen3-coder-next-80b");
    expect(delegation?.nodeId).toBe("opencode-m5");
    // hugin#192's rating discipline: iterations/rounds is "the harness-
    // specific signal we have none of" from a one-shot lane — verify it
    // actually lands in the durable evidence, not just the in-memory result.
    expect(delegation?.verifierNotes).toContain("iterations=5");

    const { events } = await store.listEventsForTask("task-h1");
    expect(events.map((e) => e.recordKind).sort()).toEqual(
      ["attempt-reference", "submission", "terminal-outcome"].sort(),
    );
  });

  it("records a not-sampled attempt as one-shot, graded the same way", async () => {
    const store = new LearningRegistryStore(munin());
    const executors = makeExecutors();

    const result = await runHarnessLaneSampledAttempt(
      store,
      { taskId: "task-o1", attemptId: "attempt-1", taskType: "code-edit", occurredAt: OCCURRED_AT },
      executors,
      { env: {} }, // absent fraction -> off
    );

    expect(result.lane).toBe("one-shot");
    expect(executors.oneShotCalls).toBe(1);
    expect(executors.harnessCalls).toBe(0);
    expect(result.registry.terminalOutcome.event.payload.delegation?.lane).toBe("one-shot");
  });

  it("routes an ineligible task type to one-shot regardless of fraction", async () => {
    const store = new LearningRegistryStore(munin());
    const executors = makeExecutors();

    const result = await runHarnessLaneSampledAttempt(
      store,
      { taskId: "task-extract-1", attemptId: "attempt-1", taskType: "extract", occurredAt: OCCURRED_AT },
      executors,
      { env: { [HARNESS_LANE_FRACTION_ENV]: "1" } },
    );

    expect(result.lane).toBe("one-shot");
    expect(executors.harnessCalls).toBe(0);
    expect(result.decision.eligible).toBe(false);
  });
});

describe("runHarnessLaneSampledAttempt — sampler malfunction", () => {
  it("falls back to one-shot and records the malfunction, without ever touching the harness executor", async () => {
    const store = new LearningRegistryStore(munin());
    const executors = makeExecutors();

    const result = await runHarnessLaneSampledAttempt(
      store,
      { taskId: "task-malfunction-1", attemptId: "attempt-1", taskType: "code-edit", occurredAt: OCCURRED_AT },
      executors,
      { env: { [HARNESS_LANE_FRACTION_ENV]: "not-a-number" } },
    );

    expect(result.lane).toBe("one-shot");
    expect(executors.oneShotCalls).toBe(1);
    expect(executors.harnessCalls).toBe(0);
    expect(result.decision.reason).toBe("sampler-malfunction");

    const delegation = result.registry.terminalOutcome.event.payload.delegation;
    expect(delegation?.policyMode).toBe("harness-lane-sampler");
    expect(delegation?.policyAction).toBe("sampler-malfunction");
    expect(delegation?.policyReason).toMatch(/not a finite number/);
  });
});

describe("runHarnessLaneSampledAttempt — fail-closed harness failure", () => {
  it("records a harness-lane failure AS the harness lane, never silently as one-shot", async () => {
    const store = new LearningRegistryStore(munin());
    const executors = makeExecutors({
      harness: async () => ({
        outcome: "failed",
        taskOutcomeRef: ref("task-fail-1", "result-structured"),
        verifierKind: "mechanical",
        verdict: "fail",
        escalated: true,
        escalationReason: "check_cmd failed after 3 rounds; escalated to frontier",
      }),
    });

    const result = await runHarnessLaneSampledAttempt(
      store,
      { taskId: "task-fail-1", attemptId: "attempt-1", taskType: "code-edit", occurredAt: OCCURRED_AT },
      executors,
      { env: { [HARNESS_LANE_FRACTION_ENV]: "1" } },
    );

    expect(result.lane).toBe("harness");
    expect(executors.harnessCalls).toBe(1);
    expect(executors.oneShotCalls).toBe(0); // never silently rerouted

    const delegation = result.registry.terminalOutcome.event.payload.delegation;
    expect(delegation?.lane).toBe("harness");
    expect(delegation?.outcome).toBe("fail");
    expect(delegation?.escalated).toBe(true);
    expect(result.registry.terminalOutcome.event.payload.outcome).toBe("failed");
  });

  it("never fabricates registry evidence when the harness executor breaks contract and throws", async () => {
    const store = new LearningRegistryStore(munin());
    const executors = makeExecutors({
      harness: async () => {
        throw new Error("opencode process crashed unexpectedly");
      },
    });

    await expect(
      runHarnessLaneSampledAttempt(
        store,
        { taskId: "task-crash-1", attemptId: "attempt-1", taskType: "code-edit", occurredAt: OCCURRED_AT },
        executors,
        { env: { [HARNESS_LANE_FRACTION_ENV]: "1" } },
      ),
    ).rejects.toThrow(/opencode process crashed/);

    expect(executors.oneShotCalls).toBe(0); // never silently rerouted into one-shot
    const { events } = await store.listEventsForTask("task-crash-1");
    expect(events).toHaveLength(0); // nothing fabricated, nothing lost-and-hidden
  });
});

describe("runHarnessLaneSampledAttempt — no duplicate/lost tasks", () => {
  it("replaying the same attempt is idempotent: no duplicate events, nothing lost", async () => {
    const store = new LearningRegistryStore(munin());
    const executors = makeExecutors({
      harness: async () => passOutcome({
        modelId: "qwen3-coder-next-80b",
        nodeId: "opencode-m5",
        taskOutcomeRef: ref("task-replay-1", "result-structured"),
      }),
    });

    const input = { taskId: "task-replay-1", attemptId: "attempt-1", taskType: "code-edit" as const, occurredAt: OCCURRED_AT };
    const samplerDeps = { env: { [HARNESS_LANE_FRACTION_ENV]: "1" } };

    const first = await runHarnessLaneSampledAttempt(store, input, executors, samplerDeps);
    const second = await runHarnessLaneSampledAttempt(store, input, executors, samplerDeps);

    expect(first.registry.submission.status).toBe("created");
    expect(second.registry.submission.status).toBe("exact-existing");
    expect(first.registry.terminalOutcome.event.eventId).toBe(second.registry.terminalOutcome.event.eventId);

    const { events } = await store.listEventsForTask("task-replay-1");
    expect(events).toHaveLength(3); // submission + attempt-reference + terminal-outcome, no duplicates
  });
});
