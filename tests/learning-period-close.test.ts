import { describe, expect, it } from "vitest";
import { MuninWriteRejectedError, type MuninClient } from "../src/munin-client.js";
import { LearningRegistryStore } from "../src/learning-registry-store.js";
import {
  LearningPeriodCloseStore,
  PRIMARY_ACCOUNTING_COUNTERS,
  type GilleBasisSource,
  type GilleBasisReference,
} from "../src/learning-period-close.js";

interface StoredEntry {
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  classification?: string;
  created_at: string;
  updated_at: string;
}

/** Same in-memory Munin double idiom as tests/learning-registry-store.test.ts:
 * atomic create-if-absent and CAS-by-expected-updated_at, so the store's real
 * concurrency contract is exercised rather than a stub. */
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

  /** Test-only: simulate a lost/corrupted high-water document, exactly the
   * fixture the #232 suite uses to force a "partial" proof. */
  remove(namespace: string, key: string): void {
    this.entries = this.entries.filter((e) => !(e.namespace === namespace && e.key === key));
  }
}

function munin(): InMemoryMunin & MuninClient {
  return new InMemoryMunin() as unknown as InMemoryMunin & MuninClient;
}

function ref(namespace: string, key: string) {
  return { namespace, key };
}

/** Seed one full lifecycle (submission/attempt-reference/terminal-outcome/
 * publication) for a task inside the given occurrence month, so all four
 * accounting counters have exactly one member each. */
async function seedFullLifecycle(
  store: LearningRegistryStore,
  taskId: string,
  monthPrefix: string,
): Promise<void> {
  const attemptId = `hugin-attempt:${taskId}`;
  const taskOutcomeRef = ref(`tasks/${taskId}`, "result-structured");
  await store.recordSubmission({ taskId, taskOutcomeRef, occurredAt: `${monthPrefix}-01T00:00:00.000Z` });
  await store.recordAttemptReference({
    taskId, attemptId,
    attemptStartRef: ref(`tasks/${taskId}`, `learning-attempt-${taskId}`),
    taskOutcomeRef, occurredAt: `${monthPrefix}-01T00:01:00.000Z`,
  });
  await store.recordTerminalOutcome({
    taskId, attemptId, outcome: "completed", taskOutcomeRef, occurredAt: `${monthPrefix}-01T00:02:00.000Z`,
  });
  await store.recordPublication({
    taskId, attemptId, publicationRef: `pr-${taskId}`, label: "pr-published",
    evidenceRef: taskOutcomeRef, occurredAt: `${monthPrefix}-01T00:03:00.000Z`,
  });
}

describe("LearningPeriodCloseStore — full certification", () => {
  it("certifies a full-period close over all-verified partitions with denominators bound to their exact partition proof", async () => {
    const client = munin();
    const registry = new LearningRegistryStore(client);
    await seedFullLifecycle(registry, "task-1", "2026-07");
    await seedFullLifecycle(registry, "task-2", "2026-07");

    const closes = new LearningPeriodCloseStore(client, registry);
    const { statement, created } = await closes.close("2026-07", { closedAt: "2026-08-01T00:10:00.000Z" });

    expect(created).toBe(true);
    expect(statement.status).toBe("certified");
    expect(statement.blockedCounters).toEqual([]);
    expect(statement.counters.map((c) => c.counter).sort()).toEqual([...PRIMARY_ACCOUNTING_COUNTERS].sort());

    for (const counter of statement.counters) {
      expect(counter.totalEvents).toBe(2);
      expect(counter.correctedEvents).toBe(0);
      expect(counter.excludedEvents).toBe(0);
      expect(counter.effectiveCount).toBe(2);
      // The denominator is bound to the exact partition/high-water proof it came from.
      expect(counter.proof.counter).toBe(counter.counter);
      expect(counter.proof.occurrencePeriodUtc).toBe("2026-07");
      expect(counter.proof.status).toBe("complete");
      expect(counter.proof.highWaterSeq).toBe(2);
    }
  });

  it("certifies a legitimate zero-event month as a true empty period, not a missing one", async () => {
    const client = munin();
    const registry = new LearningRegistryStore(client);
    const closes = new LearningPeriodCloseStore(client, registry);

    const { statement } = await closes.close("2026-07", { closedAt: "2026-08-01T00:10:00.000Z" });
    expect(statement.status).toBe("certified");
    for (const counter of statement.counters) {
      expect(counter.proof.status).toBe("empty-confirmed");
      expect(counter.totalEvents).toBe(0);
    }
  });
});

describe("LearningPeriodCloseStore — fail-closed partial statements", () => {
  it("never certifies over a caller-supplied counters subset, even when every requested counter succeeds", async () => {
    const client = munin();
    const registry = new LearningRegistryStore(client);
    await seedFullLifecycle(registry, "task-1", "2026-07");
    const closes = new LearningPeriodCloseStore(client, registry);

    const { statement } = await closes.close("2026-07", {
      counters: ["submission"],
      closedAt: "2026-08-01T00:10:00.000Z",
    });

    expect(statement.status).toBe("partial");
    expect(statement.counters.map((c) => c.counter)).toEqual(["submission"]);
    expect(statement.blockedCounters.map((b) => b.counter).sort()).toEqual(
      ["attempt-reference", "publication", "terminal-outcome"],
    );
    for (const blocked of statement.blockedCounters) {
      expect(blocked.reason).toMatch(/excluded from this close by the caller's counters option/);
    }
  });

  it("degrades to a PARTIAL statement naming exactly the blocked counter when one partition's high-water record is corrupted", async () => {
    const client = munin();
    const registry = new LearningRegistryStore(client);
    await seedFullLifecycle(registry, "task-1", "2026-07");

    // Corrupt only the terminal-outcome partition's high-water doc, exactly
    // like the #232 suite's "missing high-water doc" fixture.
    client.remove("learning-registry/partitions", "terminal-outcome-2026-07");

    const closes = new LearningPeriodCloseStore(client, registry);
    const { statement } = await closes.close("2026-07", { closedAt: "2026-08-01T00:10:00.000Z" });

    expect(statement.status).toBe("partial");
    expect(statement.blockedCounters).toHaveLength(1);
    expect(statement.blockedCounters[0].counter).toBe("terminal-outcome");
    expect(statement.blockedCounters[0].reason).toMatch(/missing/);
    // The three healthy counters still certify individually and are still reported.
    expect(statement.counters.map((c) => c.counter).sort()).toEqual(
      ["attempt-reference", "publication", "submission"],
    );
  });

  it("degrades to PARTIAL and names the blocker when a partition has a durably-written event never folded into its high-water record", async () => {
    const client = munin();
    const registry = new LearningRegistryStore(client);
    await seedFullLifecycle(registry, "task-1", "2026-07");

    // Reproduce the exact "crash between event write and bumpHighWater" gap
    // covered in tests/learning-registry-store.test.ts: a durably-tagged
    // event exists but was never folded into the partition's own high-water
    // document. `issuePartitionProof`'s reverse orphan check is what turns
    // this into "partial" rather than a silently short "complete" proof, and
    // close() must propagate that as a named blocker rather than certifying.
    const naturalKey = {
      recordKind: "publication" as const,
      taskId: "task-2",
      attemptId: "hugin-attempt:task-2",
      publicationRef: "pr-task-2",
    };
    const { deriveEventId, buildMembership, publicationEventSchema, LEARNING_REGISTRY_SCHEMA_VERSION } =
      await import("../src/learning-registry-schema.js");
    const orphanEventId = deriveEventId(naturalKey);
    const orphanEvent = publicationEventSchema.parse({
      schemaVersion: LEARNING_REGISTRY_SCHEMA_VERSION,
      eventId: orphanEventId,
      taskId: "task-2",
      recordKind: "publication",
      attemptId: "hugin-attempt:task-2",
      membership: buildMembership({ naturalKey, issuedAt: "2026-07-02T00:00:00.000Z" }),
      occurredAt: "2026-07-02T00:00:00.000Z",
      recordedAt: "2026-07-02T00:00:00.000Z",
      payload: { publicationRef: "pr-task-2", label: "pr-published", evidenceRef: ref("tasks/task-2", "result-structured") },
    });
    await client.write(
      "tasks/task-2",
      orphanEventId,
      JSON.stringify(orphanEvent),
      ["learning-registry", "registry-kind:publication", "learning-registry-partition:hugin:publication:2026-07"],
      undefined,
      "internal",
      true,
    );

    const closes = new LearningPeriodCloseStore(client, registry);
    const { statement } = await closes.close("2026-07", { closedAt: "2026-08-01T00:10:00.000Z" });

    expect(statement.status).toBe("partial");
    const blocked = statement.blockedCounters.find((b) => b.counter === "publication");
    expect(blocked).toBeDefined();
    expect(blocked?.reason).toMatch(/not present in the high-water record|truncat|missing/);
  });
});

describe("LearningPeriodCloseStore — idempotency and supersession", () => {
  it("re-closing the same period with unchanged registry state is a no-op returning the identical statement", async () => {
    const client = munin();
    const registry = new LearningRegistryStore(client);
    await seedFullLifecycle(registry, "task-1", "2026-07");
    const closes = new LearningPeriodCloseStore(client, registry);

    const first = await closes.close("2026-07", { closedAt: "2026-08-01T00:10:00.000Z" });
    expect(first.created).toBe(true);

    const second = await closes.close("2026-07", { closedAt: "2026-08-01T09:00:00.000Z" }); // different wall clock
    expect(second.created).toBe(false);
    expect(second.statement.statementId).toBe(first.statement.statementId);
    // closedAt is call-observed metadata; the persisted (first-writer) value wins.
    expect(second.statement.closedAt).toBe(first.statement.closedAt);

    const latest = await closes.getLatest("2026-07");
    expect(latest?.statementId).toBe(first.statement.statementId);
  });

  it("a correction recorded after the first close produces a NEW superseding statement, retaining the old one", async () => {
    const client = munin();
    const registry = new LearningRegistryStore(client);
    await seedFullLifecycle(registry, "task-1", "2026-07");
    const closes = new LearningPeriodCloseStore(client, registry);

    const first = await closes.close("2026-07", { closedAt: "2026-08-01T00:10:00.000Z" });
    expect(first.statement.counters.find((c) => c.counter === "terminal-outcome")?.correctedEvents).toBe(0);

    const timeline = await registry.listEventsForTask("task-1");
    const terminalOutcomeEvent = timeline.events.find((e) => e.recordKind === "terminal-outcome");
    if (!terminalOutcomeEvent) throw new Error("test fixture missing terminal-outcome event");
    await registry.writeCorrection({
      taskId: "task-1",
      predecessorEventId: terminalOutcomeEvent.eventId,
      reason: "late receipt reclassified the outcome",
      occurredAt: "2026-07-15T00:00:00.000Z",
    });

    const second = await closes.close("2026-07", { closedAt: "2026-08-02T00:00:00.000Z" });
    expect(second.created).toBe(true);
    expect(second.statement.statementId).not.toBe(first.statement.statementId);
    expect(second.statement.supersedes).toBe(first.statement.statementId);
    expect(second.statement.status).toBe("certified");
    expect(second.statement.counters.find((c) => c.counter === "terminal-outcome")?.correctedEvents).toBe(1);
    // The partition's own denominator (highWaterSeq) never shrinks from a correction.
    expect(second.statement.counters.find((c) => c.counter === "terminal-outcome")?.totalEvents).toBe(1);

    // The old statement is retained byte-for-byte, not rewritten.
    const oldStatement = await closes.getStatement(first.statement.statementId);
    expect(oldStatement).toEqual(first.statement);

    const latest = await closes.getLatest("2026-07");
    expect(latest?.statementId).toBe(second.statement.statementId);
  });

  it("an erasure adjustment recorded after the first close likewise produces a superseding statement", async () => {
    const client = munin();
    const registry = new LearningRegistryStore(client);
    await seedFullLifecycle(registry, "task-1", "2026-07");
    const closes = new LearningPeriodCloseStore(client, registry);

    const first = await closes.close("2026-07", { closedAt: "2026-08-01T00:10:00.000Z" });

    const timeline = await registry.listEventsForTask("task-1");
    const attemptReferenceEvent = timeline.events.find((e) => e.recordKind === "attempt-reference");
    if (!attemptReferenceEvent) throw new Error("test fixture missing attempt-reference event");
    await registry.writeExclusionAdjustment({
      taskId: "task-1",
      targetEventId: attemptReferenceEvent.eventId,
      adjustmentReason: "erasure",
      note: "upstream content erased on request",
      occurredAt: "2026-07-20T00:00:00.000Z",
    });

    const second = await closes.close("2026-07", { closedAt: "2026-08-03T00:00:00.000Z" });
    expect(second.statement.statementId).not.toBe(first.statement.statementId);
    expect(second.statement.supersedes).toBe(first.statement.statementId);
    const attemptCounter = second.statement.counters.find((c) => c.counter === "attempt-reference");
    expect(attemptCounter?.excludedEvents).toBe(1);
    expect(attemptCounter?.erasureAdjustments).toBe(1);
    // The denominator itself is untouched by erasure.
    expect(attemptCounter?.totalEvents).toBe(1);
    expect(attemptCounter?.effectiveCount).toBe(0);
  });
});

describe("LearningPeriodCloseStore — cross-owner accounting", () => {
  it("references gille's owner-issued basis when a source is supplied, without fabricating it", async () => {
    const client = munin();
    const registry = new LearningRegistryStore(client);
    await seedFullLifecycle(registry, "task-1", "2026-07");
    const closes = new LearningPeriodCloseStore(client, registry);

    const gilleBasisRef = ref("gille-inference/accounting", "period-close-2026-07");
    const mockGille: GilleBasisSource = {
      fetchBasis: async (period): Promise<GilleBasisReference> => ({
        ownerComponent: "gille-inference",
        period,
        status: "referenced",
        basisRef: gilleBasisRef,
      }),
    };

    const { statement } = await closes.close("2026-07", {
      closedAt: "2026-08-01T00:10:00.000Z",
      gilleBasisSource: mockGille,
    });

    expect(statement.crossOwner).toEqual({
      ownerComponent: "gille-inference",
      period: "2026-07",
      status: "referenced",
      basisRef: gilleBasisRef,
    });
    // Hugin's own certification is unaffected by the presence of a cross-owner reference.
    expect(statement.status).toBe("certified");
  });

  it("honestly records gille basis unavailability instead of inventing a number, without blocking Hugin's own counters", async () => {
    const client = munin();
    const registry = new LearningRegistryStore(client);
    await seedFullLifecycle(registry, "task-1", "2026-07");
    const closes = new LearningPeriodCloseStore(client, registry);

    const unavailableGille: GilleBasisSource = {
      fetchBasis: async (period): Promise<GilleBasisReference> => ({
        ownerComponent: "gille-inference",
        period,
        status: "unavailable",
        reason: "gille-inference#3 period close not yet implemented",
      }),
    };

    const { statement } = await closes.close("2026-07", {
      closedAt: "2026-08-01T00:10:00.000Z",
      gilleBasisSource: unavailableGille,
    });

    expect(statement.crossOwner?.status).toBe("unavailable");
    expect(statement.crossOwner?.basisRef).toBeUndefined();
    expect(statement.status).toBe("certified"); // Hugin owns Hugin counters independently
  });

  it("leaves crossOwner null (never a fabricated default) when no gille source is configured", async () => {
    const client = munin();
    const registry = new LearningRegistryStore(client);
    await seedFullLifecycle(registry, "task-1", "2026-07");
    const closes = new LearningPeriodCloseStore(client, registry);

    const { statement } = await closes.close("2026-07", { closedAt: "2026-08-01T00:10:00.000Z" });
    expect(statement.crossOwner).toBeNull();
  });
});
