import { describe, expect, it } from "vitest";
import { MuninWriteRejectedError, type MuninClient } from "../src/munin-client.js";
import { LearningRegistryStore } from "../src/learning-registry-store.js";
import { buildTaskLifecycleTimeline } from "../src/learning-registry-view.js";

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
    return new Date(Date.UTC(2024, 2, 1, 0, 0, 0, 0) + this.seq).toISOString();
  }

  private find(namespace: string, key: string): StoredEntry | undefined {
    return this.entries.find((e) => e.namespace === namespace && e.key === key);
  }

  async read(namespace: string, key: string) {
    const entry = this.find(namespace, key);
    return entry ? ({ ...entry, found: true } as unknown as Record<string, unknown>) : null;
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
        conflict_reason: "already_exists",
        current_updated_at: existing.updated_at,
      });
    }
    if (expectedUpdatedAt !== undefined && (!existing || existing.updated_at !== expectedUpdatedAt)) {
      throw new MuninWriteRejectedError(namespace, key, {
        error: "conflict",
        conflict_reason: "version_mismatch",
        current_updated_at: existing?.updated_at,
      });
    }
    const updated_at = this.clock();
    const created_at = existing?.created_at ?? updated_at;
    const next: StoredEntry = { namespace, key, content, tags: tags ?? [], classification, created_at, updated_at };
    if (existing) Object.assign(existing, next); else this.entries.push(next);
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

function ref(namespace: string, key: string) {
  return { namespace, key };
}

describe("buildTaskLifecycleTimeline", () => {
  it("joins submission, attempt-reference, terminal-outcome and publication into one ordered timeline referencing the real attempt-evidence rows", async () => {
    const store = new LearningRegistryStore(munin());
    const taskId = "task-1";
    const attemptId = "hugin-attempt:11111111-1111-4111-8111-111111111111";
    // These are exactly the durable LearningTask rows the handshake module
    // (src/learning-task-handshake.ts) writes — the registry only points at
    // them, per docs/learning-task-handshake.md's key list.
    const attemptStartRef = ref("tasks/task-1", "learning-attempt-11111111-1111-4111-8111-111111111111");
    const taskOutcomeRef = ref("tasks/task-1", "result-structured");

    await store.recordSubmission({ taskId, taskOutcomeRef, occurredAt: "2024-03-01T00:00:00.000Z" });
    await store.recordAttemptReference({
      taskId, attemptId, attemptStartRef, taskOutcomeRef, occurredAt: "2024-03-01T00:01:00.000Z",
    });
    await store.recordTerminalOutcome({
      taskId, attemptId, outcome: "completed", taskOutcomeRef, occurredAt: "2024-03-01T00:05:00.000Z",
    });
    await store.recordPublication({
      taskId, attemptId, publicationRef: "pr-742", label: "pr-published",
      evidenceRef: ref("tasks/task-1", "result-structured"), occurredAt: "2024-03-01T00:06:00.000Z",
    });

    const timeline = await buildTaskLifecycleTimeline(store, taskId);
    expect(timeline.truncated).toBe(false);
    expect(timeline.entries.map((e) => e.event.recordKind)).toEqual([
      "submission", "attempt-reference", "terminal-outcome", "publication",
    ]);
    expect(timeline.entries.every((e) => !e.superseded && !e.excluded)).toBe(true);

    const attemptEntry = timeline.entries.find((e) => e.event.recordKind === "attempt-reference");
    expect(attemptEntry?.event.recordKind === "attempt-reference"
      && attemptEntry.event.payload.attemptStartRef).toEqual(attemptStartRef);
  });

  it("resolves a corrected terminal outcome to its effective leaf and marks the predecessor superseded", async () => {
    const store = new LearningRegistryStore(munin());
    const taskId = "task-1";
    const attemptId = "hugin-attempt:1";
    const taskOutcomeRef = ref("tasks/task-1", "result-structured");

    const created = await store.recordTerminalOutcome({
      taskId, attemptId, outcome: "failed", taskOutcomeRef, occurredAt: "2024-03-01T00:00:00.000Z",
    });
    const correction = await store.writeCorrection({
      taskId, predecessorEventId: created.event.eventId,
      reason: "late receipt reclassified as completed", occurredAt: "2024-03-02T00:00:00.000Z",
    });

    const timeline = await buildTaskLifecycleTimeline(store, taskId);
    const outcomeEntry = timeline.entries.find((e) => e.event.recordKind === "terminal-outcome");
    expect(outcomeEntry?.superseded).toBe(true);
    expect(outcomeEntry?.effectiveEventId).toBe(correction.event.eventId);
    expect(timeline.corrections.map((c) => c.eventId)).toEqual([correction.event.eventId]);
  });

  it("surfaces exclusion state on the affected entry without removing it from the timeline", async () => {
    const store = new LearningRegistryStore(munin());
    const taskId = "task-1";
    const attemptId = "hugin-attempt:1";
    const attemptStartRef = ref("tasks/task-1", "learning-attempt-1");
    const taskOutcomeRef = ref("tasks/task-1", "result-structured");

    const attempt = await store.recordAttemptReference({
      taskId, attemptId, attemptStartRef, taskOutcomeRef, occurredAt: "2024-03-01T00:00:00.000Z",
    });
    await store.writeExclusionAdjustment({
      taskId, targetEventId: attempt.event.eventId, adjustmentReason: "erasure",
      note: "upstream replay payload erased", occurredAt: "2024-03-05T00:00:00.000Z",
    });

    const timeline = await buildTaskLifecycleTimeline(store, taskId);
    const entry = timeline.entries.find((e) => e.event.recordKind === "attempt-reference");
    expect(entry?.excluded).toBe(true);
    expect(entry?.excludedReasons).toEqual(["erasure"]);
    // The event itself is still present and unmutated in the timeline.
    expect(entry?.event.eventId).toBe(attempt.event.eventId);
    expect(timeline.exclusionAdjustments).toHaveLength(1);
  });

  it("orders a multi-attempt task's events chronologically across attempts", async () => {
    const store = new LearningRegistryStore(munin());
    const taskId = "task-1";
    const taskOutcomeRef = ref("tasks/task-1", "result-structured");

    await store.recordSubmission({ taskId, taskOutcomeRef, occurredAt: "2024-03-01T00:00:00.000Z" });
    await store.recordAttemptReference({
      taskId, attemptId: "hugin-attempt:1",
      attemptStartRef: ref("tasks/task-1", "learning-attempt-1"), taskOutcomeRef,
      occurredAt: "2024-03-01T00:01:00.000Z",
    });
    await store.recordTerminalOutcome({
      taskId, attemptId: "hugin-attempt:1", outcome: "failed", taskOutcomeRef,
      occurredAt: "2024-03-01T00:02:00.000Z",
    });
    await store.recordAttemptReference({
      taskId, attemptId: "hugin-attempt:2",
      attemptStartRef: ref("tasks/task-1", "learning-attempt-2"), taskOutcomeRef,
      occurredAt: "2024-03-01T00:03:00.000Z",
    });
    await store.recordTerminalOutcome({
      taskId, attemptId: "hugin-attempt:2", outcome: "completed", taskOutcomeRef,
      occurredAt: "2024-03-01T00:04:00.000Z",
    });

    const timeline = await buildTaskLifecycleTimeline(store, taskId);
    expect(timeline.entries.map((e) => e.event.occurredAt)).toEqual([
      "2024-03-01T00:00:00.000Z",
      "2024-03-01T00:01:00.000Z",
      "2024-03-01T00:02:00.000Z",
      "2024-03-01T00:03:00.000Z",
      "2024-03-01T00:04:00.000Z",
    ]);
  });
});
