import { describe, expect, it } from "vitest";
import { MuninWriteRejectedError, type MuninClient, type MuninQueryResult } from "../src/munin-client.js";
import {
  LearningRegistryStore,
  RegistryNaturalKeyConflictError,
  isEligibleForCertification,
} from "../src/learning-registry-store.js";

interface StoredEntry {
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  classification?: string;
  created_at: string;
  updated_at: string;
}

/**
 * In-memory Munin double with the same create-if-absent / CAS contract as the
 * real service: `create_if_absent` atomically fails when a row exists, and an
 * `expected_updated_at` mismatch atomically fails. `beforeWrite` lets a test
 * interleave two logically concurrent callers around that atomic boundary.
 */
class InMemoryMunin {
  private entries: StoredEntry[] = [];
  private seq = 0;
  public writeCount = 0;
  public beforeWrite?: (namespace: string, key: string) => Promise<void> | void;

  private clock(): string {
    this.seq += 1;
    return new Date(Date.UTC(2026, 6, 1, 0, 0, 0, 0) + this.seq).toISOString();
  }

  private find(namespace: string, key: string): StoredEntry | undefined {
    return this.entries.find((e) => e.namespace === namespace && e.key === key);
  }

  /** Test-only: simulate a lost/corrupted high-water document. */
  remove(namespace: string, key: string): void {
    this.entries = this.entries.filter((e) => !(e.namespace === namespace && e.key === key));
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
    if (this.beforeWrite) await this.beforeWrite(namespace, key);
    this.writeCount += 1;
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

function ref(namespace: string, key: string) {
  return { namespace, key };
}

describe("LearningRegistryStore — natural-key idempotency", () => {
  it("treats a duplicate submission delivery as a no-op, not a second event", async () => {
    const store = new LearningRegistryStore(munin());
    const occurredAt = "2024-03-10T08:00:00.000Z";
    const a = await store.recordSubmission({
      taskId: "task-1",
      taskOutcomeRef: ref("tasks/task-1", "result-structured"),
      occurredAt,
    });
    const b = await store.recordSubmission({
      taskId: "task-1",
      taskOutcomeRef: ref("tasks/task-1", "result-structured"),
      occurredAt,
    });
    expect(a.status).toBe("created");
    expect(b.status).toBe("exact-existing");
    expect(a.event.eventId).toBe(b.event.eventId);

    const { events } = await store.listEventsForTask("task-1");
    expect(events).toHaveLength(1);
  });

  it("rejects a divergent payload colliding on the same natural key", async () => {
    const store = new LearningRegistryStore(munin());
    await store.recordTerminalOutcome({
      taskId: "task-1",
      attemptId: "hugin-attempt:1",
      outcome: "completed",
      taskOutcomeRef: ref("tasks/task-1", "result-structured"),
      occurredAt: "2024-03-10T08:00:00.000Z",
    });
    await expect(store.recordTerminalOutcome({
      taskId: "task-1",
      attemptId: "hugin-attempt:1",
      outcome: "failed", // different terminal fact, same natural key
      taskOutcomeRef: ref("tasks/task-1", "result-structured"),
      occurredAt: "2024-03-10T08:00:00.000Z",
    })).rejects.toThrow(RegistryNaturalKeyConflictError);
  });

  it("is idempotent even though recordedAt differs between the retry and the original", async () => {
    let tick = 0;
    const clockValues = ["2024-03-10T09:00:00.000Z", "2024-03-10T09:05:00.000Z"];
    const store = new LearningRegistryStore(munin(), { now: () => clockValues[tick++] });
    const occurredAt = "2024-03-10T08:00:00.000Z";
    const first = await store.recordSubmission({
      taskId: "task-1",
      taskOutcomeRef: ref("tasks/task-1", "result-structured"),
      occurredAt,
    });
    const second = await store.recordSubmission({
      taskId: "task-1",
      taskOutcomeRef: ref("tasks/task-1", "result-structured"),
      occurredAt,
    });
    // Sanity: the two calls really did observe different wall-clock times.
    expect(first.event.recordedAt).toBe(clockValues[0]);
    // The retry must report the *actually persisted* (first) recordedAt, not
    // fabricate its own — a reader must never see two different truths for
    // the same natural key.
    expect(second.event.recordedAt).toBe(first.event.recordedAt);
    expect(second.event.recordedAt).not.toBe(clockValues[1]);
  });
});

describe("LearningRegistryStore — concurrent-writer safety", () => {
  it("cannot lose either of two attempt-reference events racing in the same partition", async () => {
    const client = munin();
    const store = new LearningRegistryStore(client);
    const occurredAt = "2024-03-10T08:00:00.000Z";

    const results = await Promise.all([
      store.recordAttemptReference({
        taskId: "task-1",
        attemptId: "hugin-attempt:aaaa",
        attemptStartRef: ref("tasks/task-1", "learning-attempt-aaaa"),
        taskOutcomeRef: ref("tasks/task-1", "result-structured"),
        occurredAt,
      }),
      store.recordAttemptReference({
        taskId: "task-1",
        attemptId: "hugin-attempt:bbbb",
        attemptStartRef: ref("tasks/task-1", "learning-attempt-bbbb"),
        taskOutcomeRef: ref("tasks/task-1", "result-structured"),
        occurredAt,
      }),
    ]);
    expect(results.every((r) => r.status === "created")).toBe(true);

    const { events } = await store.listEventsForTask("task-1");
    expect(events).toHaveLength(2);

    const proof = await store.issuePartitionProof("attempt-reference", "2024-03");
    expect(proof.status).toBe("complete");
    expect(proof.highWaterSeq).toBe(2);
    expect(new Set(proof.members.map((m) => m.eventId)).size).toBe(2);
  });

  it("resolves a true duplicate-delivery race to exactly one winner with no data loss", async () => {
    const client = munin();
    const store = new LearningRegistryStore(client);
    const occurredAt = "2024-03-10T08:00:00.000Z";

    // Force both writers to observe "does not exist yet" before either
    // commits, then let both attempt the atomic create — this is the
    // adversarial ordering a real network race can produce.
    let inFlight = 0;
    let release: (() => void) | undefined;
    const bothArrived = new Promise<void>((resolve) => { release = resolve; });
    client.beforeWrite = async (namespace, key) => {
      if (!key.startsWith("reg-")) return;
      inFlight += 1;
      if (inFlight === 2) release?.();
      await bothArrived;
    };

    const results = await Promise.all([
      store.recordSubmission({ taskId: "task-1", taskOutcomeRef: ref("tasks/task-1", "result-structured"), occurredAt }),
      store.recordSubmission({ taskId: "task-1", taskOutcomeRef: ref("tasks/task-1", "result-structured"), occurredAt }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(["created", "exact-existing"]);
    expect(results[0].event.eventId).toBe(results[1].event.eventId);

    const { events } = await store.listEventsForTask("task-1");
    expect(events).toHaveLength(1);
    const proof = await store.issuePartitionProof("submission", "2024-03");
    expect(proof.highWaterSeq).toBe(1); // never double-counted despite the race
  });

  it("serializes concurrent high-water updates across different partitions members without loss", async () => {
    const client = munin();
    const store = new LearningRegistryStore(client);
    const occurredAt = "2024-03-10T08:00:00.000Z";
    const attempts = Array.from({ length: 6 }, (_, i) => `hugin-attempt:${i}`);

    await Promise.all(attempts.map((attemptId) => store.recordAttemptReference({
      taskId: "task-1",
      attemptId,
      attemptStartRef: ref("tasks/task-1", `learning-attempt-${attemptId}`),
      taskOutcomeRef: ref("tasks/task-1", "result-structured"),
      occurredAt,
    })));

    const proof = await store.issuePartitionProof("attempt-reference", "2024-03");
    expect(proof.status).toBe("complete");
    expect(proof.highWaterSeq).toBe(6);
    expect(new Set(proof.members.map((m) => m.eventId)).size).toBe(6);
  });
});

describe("LearningRegistryStore — correction chains", () => {
  it("chains a new immutable identity to the predecessor without rewriting it", async () => {
    const store = new LearningRegistryStore(munin());
    const created = await store.recordTerminalOutcome({
      taskId: "task-1",
      attemptId: "hugin-attempt:1",
      outcome: "failed",
      taskOutcomeRef: ref("tasks/task-1", "result-structured"),
      occurredAt: "2024-03-10T08:00:00.000Z",
    });
    const before = await store.getEvent("task-1", created.event.eventId);

    const correction = await store.writeCorrection({
      taskId: "task-1",
      predecessorEventId: created.event.eventId,
      reason: "late receipt reclassified the outcome as completed",
      occurredAt: "2024-03-11T08:00:00.000Z",
    });

    expect(correction.event.eventId).not.toBe(created.event.eventId);
    expect(correction.event.payload.predecessorEventId).toBe(created.event.eventId);

    const after = await store.getEvent("task-1", created.event.eventId);
    expect(after).toEqual(before); // predecessor is byte-for-byte unchanged

    const leaf = await store.findEffectiveLeaf("task-1", created.event.eventId);
    expect(leaf).toBe(correction.event.eventId);
  });

  it("refuses a fork: a second different correction on the same predecessor collides", async () => {
    const store = new LearningRegistryStore(munin());
    const created = await store.recordTerminalOutcome({
      taskId: "task-1",
      attemptId: "hugin-attempt:1",
      outcome: "failed",
      taskOutcomeRef: ref("tasks/task-1", "result-structured"),
      occurredAt: "2024-03-10T08:00:00.000Z",
    });
    await store.writeCorrection({
      taskId: "task-1",
      predecessorEventId: created.event.eventId,
      reason: "first correction",
      occurredAt: "2024-03-11T08:00:00.000Z",
    });
    await expect(store.writeCorrection({
      taskId: "task-1",
      predecessorEventId: created.event.eventId,
      reason: "a different, conflicting correction",
      occurredAt: "2024-03-12T08:00:00.000Z",
    })).rejects.toThrow(RegistryNaturalKeyConflictError);
  });

  it("supports chaining a correction onto a correction (multi-hop leaf resolution)", async () => {
    const store = new LearningRegistryStore(munin());
    const created = await store.recordTerminalOutcome({
      taskId: "task-1",
      attemptId: "hugin-attempt:1",
      outcome: "failed",
      taskOutcomeRef: ref("tasks/task-1", "result-structured"),
      occurredAt: "2024-03-10T08:00:00.000Z",
    });
    const first = await store.writeCorrection({
      taskId: "task-1",
      predecessorEventId: created.event.eventId,
      reason: "first correction",
      occurredAt: "2024-03-11T08:00:00.000Z",
    });
    const second = await store.writeCorrection({
      taskId: "task-1",
      predecessorEventId: first.event.eventId,
      reason: "second correction, correcting the first",
      occurredAt: "2024-03-12T08:00:00.000Z",
    });
    const leaf = await store.findEffectiveLeaf("task-1", created.event.eventId);
    expect(leaf).toBe(second.event.eventId);
  });

  it("rejects a correction that does not strictly time-advance past its predecessor", async () => {
    const store = new LearningRegistryStore(munin());
    const created = await store.recordTerminalOutcome({
      taskId: "task-1",
      attemptId: "hugin-attempt:1",
      outcome: "failed",
      taskOutcomeRef: ref("tasks/task-1", "result-structured"),
      occurredAt: "2024-03-10T08:00:00.000Z",
    });
    await expect(store.writeCorrection({
      taskId: "task-1",
      predecessorEventId: created.event.eventId,
      reason: "back-dated correction",
      occurredAt: "2024-03-09T08:00:00.000Z",
    })).rejects.toThrow(/strictly time-advance/);
  });

  it("rejects correcting an unknown predecessor", async () => {
    const store = new LearningRegistryStore(munin());
    await expect(store.writeCorrection({
      taskId: "task-1",
      predecessorEventId: "reg-00000000000000000000000000000000",
      reason: "no such event",
      occurredAt: "2024-03-11T08:00:00.000Z",
    })).rejects.toThrow(/unknown predecessor/);
  });
});

describe("LearningRegistryStore — exclusion/erasure adjustments", () => {
  it("preserves the target's counter membership without resurrecting content", async () => {
    const store = new LearningRegistryStore(munin());
    const created = await store.recordAttemptReference({
      taskId: "task-1",
      attemptId: "hugin-attempt:1",
      attemptStartRef: ref("tasks/task-1", "learning-attempt-1"),
      taskOutcomeRef: ref("tasks/task-1", "result-structured"),
      occurredAt: "2024-03-10T08:00:00.000Z",
    });
    const beforeProof = await store.issuePartitionProof("attempt-reference", "2024-03");
    expect(beforeProof.highWaterSeq).toBe(1);

    const before = await store.getEvent("task-1", created.event.eventId);
    const adjustment = await store.writeExclusionAdjustment({
      taskId: "task-1",
      targetEventId: created.event.eventId,
      adjustmentReason: "erasure",
      note: "upstream replay payload erased on request",
      occurredAt: "2024-03-15T08:00:00.000Z",
    });
    const after = await store.getEvent("task-1", created.event.eventId);

    // The original event's natural key / period / counter / owner is untouched.
    expect(after).toEqual(before);
    expect(after?.membership.occurrencePeriodUtc).toBe("2024-03");
    expect(after?.membership.counter).toBe("attempt-reference");

    // The target's own partition membership count never shrinks.
    const afterProof = await store.issuePartitionProof("attempt-reference", "2024-03");
    expect(afterProof.highWaterSeq).toBe(1);
    expect(afterProof.chainDigest).toBe(beforeProof.chainDigest);

    // The adjustment itself is separately, honestly counted in its own partition.
    const adjustmentProof = await store.issuePartitionProof("exclusion-adjustment", "2024-03");
    expect(adjustmentProof.highWaterSeq).toBe(1);
    expect(adjustment.event.payload.adjustmentReason).toBe("erasure");
  });

  it("rejects adjusting an unknown target", async () => {
    const store = new LearningRegistryStore(munin());
    await expect(store.writeExclusionAdjustment({
      taskId: "task-1",
      targetEventId: "reg-00000000000000000000000000000000",
      adjustmentReason: "erasure",
      occurredAt: "2024-03-11T08:00:00.000Z",
    })).rejects.toThrow(/unknown target/);
  });
});

describe("LearningRegistryStore — partition/high-water proofs", () => {
  it("confirms a legitimate zero-event partition as empty-confirmed, not partial", async () => {
    const store = new LearningRegistryStore(munin());
    const proof = await store.issuePartitionProof("submission", "2024-03");
    expect(proof.status).toBe("empty-confirmed");
    expect(isEligibleForCertification(proof)).toBe(true);
    const verdict = await store.verifyPartitionProof(proof);
    expect(verdict.valid).toBe(true);
  });

  it("issues a complete proof that verifies against the authoritative store state", async () => {
    const store = new LearningRegistryStore(munin());
    await store.recordSubmission({ taskId: "task-1", taskOutcomeRef: ref("tasks/task-1", "result-structured"), occurredAt: "2024-03-01T00:00:00.000Z" });
    await store.recordSubmission({ taskId: "task-2", taskOutcomeRef: ref("tasks/task-2", "result-structured"), occurredAt: "2024-03-02T00:00:00.000Z" });

    const proof = await store.issuePartitionProof("submission", "2024-03");
    expect(proof.status).toBe("complete");
    expect(proof.highWaterSeq).toBe(2);
    expect(isEligibleForCertification(proof)).toBe(true);

    const verdict = await store.verifyPartitionProof(proof);
    expect(verdict.valid).toBe(true);
  });

  it("rejects a forged proof whose chain digest does not match any real state", async () => {
    const store = new LearningRegistryStore(munin());
    await store.recordSubmission({ taskId: "task-1", taskOutcomeRef: ref("tasks/task-1", "result-structured"), occurredAt: "2024-03-01T00:00:00.000Z" });
    const real = await store.issuePartitionProof("submission", "2024-03");

    const forged = {
      ...real,
      chainDigest: "f".repeat(64),
    };
    const verdict = await store.verifyPartitionProof(forged);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/does not recompute|stale|forged/);
  });

  it("rejects a forged empty-confirmed proof once real events exist", async () => {
    const store = new LearningRegistryStore(munin());
    const fabricatedEmpty = await store.issuePartitionProof("submission", "2024-04"); // legitimately empty first
    expect(fabricatedEmpty.status).toBe("empty-confirmed");

    await store.recordSubmission({ taskId: "task-1", taskOutcomeRef: ref("tasks/task-1", "result-structured"), occurredAt: "2024-04-01T00:00:00.000Z" });

    const verdict = await store.verifyPartitionProof(fabricatedEmpty);
    expect(verdict.valid).toBe(false);
  });

  it("rejects a stale proof once the partition has advanced, when requireCurrent is set", async () => {
    const store = new LearningRegistryStore(munin());
    await store.recordSubmission({ taskId: "task-1", taskOutcomeRef: ref("tasks/task-1", "result-structured"), occurredAt: "2024-03-01T00:00:00.000Z" });
    const stale = await store.issuePartitionProof("submission", "2024-03");

    await store.recordSubmission({ taskId: "task-2", taskOutcomeRef: ref("tasks/task-2", "result-structured"), occurredAt: "2024-03-02T00:00:00.000Z" });

    const verdict = await store.verifyPartitionProof(stale, { requireCurrent: true });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/stale/);

    // The same proof was honestly complete "as of" its own high-water mark.
    const verdictAsOf = await store.verifyPartitionProof(stale, { requireCurrent: false });
    expect(verdictAsOf.valid).toBe(true);
  });

  it("marks a proof partial, and ineligible for certification, when the high-water doc is missing but tagged events exist", async () => {
    const client = munin();
    const store = new LearningRegistryStore(client);
    await store.recordSubmission({ taskId: "task-1", taskOutcomeRef: ref("tasks/task-1", "result-structured"), occurredAt: "2024-03-01T00:00:00.000Z" });

    // Simulate a corrupted/lost high-water document despite a real tagged
    // event still existing — exactly the situation the acceptance criteria
    // call out: recomputing a digest over whatever subset happens to be
    // visible must never silently certify as complete.
    client.remove("learning-registry/partitions", "submission-2024-03");

    const proof = await store.issuePartitionProof("submission", "2024-03");
    expect(proof.status).toBe("partial");
    expect(proof.partialReason).toMatch(/missing/);
    expect(isEligibleForCertification(proof)).toBe(false);
  });

  it("marks a proof partial when a recorded member cannot be read back (missing event)", async () => {
    const client = munin();
    const store = new LearningRegistryStore(client);
    const created = await store.recordSubmission({
      taskId: "task-1",
      taskOutcomeRef: ref("tasks/task-1", "result-structured"),
      occurredAt: "2024-03-01T00:00:00.000Z",
    });

    // The high-water doc still claims this member, but its event row is gone.
    client.remove("tasks/task-1", created.event.eventId);

    const proof = await store.issuePartitionProof("submission", "2024-03");
    expect(proof.status).toBe("partial");
    expect(proof.partialReason).toMatch(/missing from the event store/);
    expect(isEligibleForCertification(proof)).toBe(false);
  });

  it("never lets a caller self-certify a subset as complete: a hand-built partial proof is always ineligible", async () => {
    const store = new LearningRegistryStore(munin());
    await store.recordSubmission({ taskId: "task-1", taskOutcomeRef: ref("tasks/task-1", "result-structured"), occurredAt: "2024-03-01T00:00:00.000Z" });
    await store.recordSubmission({ taskId: "task-2", taskOutcomeRef: ref("tasks/task-2", "result-structured"), occurredAt: "2024-03-02T00:00:00.000Z" });
    const real = await store.issuePartitionProof("submission", "2024-03");

    const selfAssembledSubset = {
      ...real,
      status: "partial" as const,
      highWaterSeq: 1,
      members: real.members.slice(0, 1),
      partialReason: "caller only loaded one of the two events",
    };
    expect(isEligibleForCertification(selfAssembledSubset)).toBe(false);
    const verdict = await store.verifyPartitionProof(selfAssembledSubset);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/partial/);
  });
});
