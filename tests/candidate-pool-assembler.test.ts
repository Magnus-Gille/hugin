import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MuninWriteRejectedError, type MuninClient } from "../src/munin-client.js";
import { LearningRegistryStore } from "../src/learning-registry-store.js";
import { buildQualityBinding, buildQualityReceipt } from "../src/quality-receipt.js";
import {
  assembleCandidatePool,
  createCandidatePoolAssembler,
} from "../src/learning/candidate-pool-assembler.js";
import {
  buildFixtureAdmittedAttempt,
  buildFixtureResultStructuredDocument,
  buildFixtureStatusDocument,
} from "./helpers/candidate-evidence-fixtures.js";

// ---------------------------------------------------------------------------
// In-memory Munin double -- same contract copied across this codebase's own
// learning-* test files (see tests/experiment-cadence.test.ts's own copy).
// ---------------------------------------------------------------------------

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
    return { ...entry, found: true } as unknown as { content: string; updated_at: string; found: true };
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
    if (createIfAbsent === true && existing) {
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
    if (existing) Object.assign(existing, next); else this.entries.push(next);
    return { ok: true, status: existing ? "updated" : "created", updated_at };
  }

  async query(opts: { namespace?: string; tags?: string[]; limit?: number; entry_type?: string }) {
    let rows = this.entries.filter((e) =>
      (!opts.namespace || e.namespace.startsWith(opts.namespace))
      && (opts.tags ?? []).every((tag) => e.tags.includes(tag)));
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

  async log() {
    // unused by this module
  }
}

function munin(): InMemoryMunin & MuninClient {
  return new InMemoryMunin() as unknown as InMemoryMunin & MuninClient;
}

const ref = (namespace: string, key: string) => ({ namespace, key });
const hash = (seed: string) => createHash("sha256").update(seed).digest("hex");
const PERIOD = "2026-07";

/**
 * Seed one fully resolvable production candidate: registry submission +
 * attempt-reference + terminal-outcome (completed, carrying `delegation`
 * with a real modelId+taskType and a real `attemptOutcomeRef`), the admitted
 * evidence row at that ref, and a bound, effective quality receipt.
 */
async function seedResolvableCandidate(
  m: InMemoryMunin & MuninClient,
  store: LearningRegistryStore,
  input: {
    taskId: string;
    taskType: string;
    modelId: string;
    rating: "pass" | "partial" | "redo" | "wrong";
    occurredAt: string;
    reviewerIndependence?: "independent" | "self" | "unknown";
  },
): Promise<{ attemptId: string }> {
  const { attemptId, attemptOutcomeRef, evidence } = buildFixtureAdmittedAttempt({
    taskId: input.taskId,
    taskType: input.taskType,
  });
  await m.write(attemptOutcomeRef.namespace, attemptOutcomeRef.key, JSON.stringify(evidence), ["learning-task-attempt"]);

  const taskOutcomeRef = ref(`tasks/${input.taskId}`, "result-structured");
  await store.recordSubmission({ taskId: input.taskId, taskOutcomeRef, occurredAt: input.occurredAt });
  await store.recordAttemptReference({
    taskId: input.taskId,
    attemptId,
    attemptStartRef: ref(`tasks/${input.taskId}`, `learning-attempt-${attemptId}`),
    taskOutcomeRef,
    occurredAt: input.occurredAt,
  });
  await store.recordTerminalOutcome({
    taskId: input.taskId,
    attemptId,
    outcome: "completed",
    taskOutcomeRef,
    attemptOutcomeRef,
    delegation: {
      modelId: input.modelId,
      taskType: input.taskType,
      lane: "harness",
      evidenceIdentityHash: hash(`evidence:${input.taskId}`),
    },
    occurredAt: input.occurredAt,
  });

  const statusContent = buildFixtureStatusDocument(input.taskId, `prompt for ${input.taskId}`);
  const resultContent = buildFixtureResultStructuredDocument(input.taskId);
  await m.write(`tasks/${input.taskId}`, "status", statusContent, ["status"]);
  await m.write(`tasks/${input.taskId}`, "result-structured", resultContent, ["result"]);

  const binding = buildQualityBinding({ statusContent, structuredResultContent: resultContent });
  const receipt = buildQualityReceipt({
    taskId: input.taskId,
    reviewerPrincipal: "codex",
    reviewerIndependence: input.reviewerIndependence ?? "independent",
    rating: input.rating,
    ratingReason: `SECRET-RAW-EVIDENCE-TEXT-${input.taskId}`,
    verificationOutcome: input.rating === "pass" ? "accepted_unchanged" : "major_rewrite",
    ratedAt: input.occurredAt,
    bindingAttestation: "server-bound",
    binding,
  });
  await m.write(`tasks/${input.taskId}`, "feedback", JSON.stringify({ schemaVersion: 1, taskId: input.taskId, receipts: [receipt] }), ["feedback"]);

  return { attemptId };
}

describe("assembleCandidatePool", () => {
  it("resolves a candidate per (taskId, attemptId), regardless of quality rating -- no floor applied here", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    await seedResolvableCandidate(m, store, {
      taskId: "task-pass", taskType: "code-edit", modelId: "model-a", rating: "pass", occurredAt: "2026-07-05T00:00:00.000Z",
    });
    await seedResolvableCandidate(m, store, {
      taskId: "task-wrong", taskType: "code-edit", modelId: "model-b", rating: "wrong", occurredAt: "2026-07-06T00:00:00.000Z",
    });

    const result = await assembleCandidatePool({ registry: store, munin: m }, { periods: [PERIOD] });
    expect(result.skipped).toEqual([]);
    expect(result.candidates).toHaveLength(2);
    const byTask = new Map(result.candidates.map((c) => [c.taskId, c]));
    expect(byTask.get("task-pass")?.qualityReceipt.rating).toBe("pass");
    expect(byTask.get("task-wrong")?.qualityReceipt.rating).toBe("wrong");
    expect(byTask.get("task-pass")?.configuration.model.id).toBe("model-a");
    expect(byTask.get("task-wrong")?.configuration.model.id).toBe("model-b");
  });

  it("is content-blind: no raw prompt/task bytes ever appear in the assembled pool", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    await seedResolvableCandidate(m, store, {
      taskId: "task-content-blind", taskType: "code-edit", modelId: "model-a", rating: "pass", occurredAt: "2026-07-05T00:00:00.000Z",
    });
    const result = await assembleCandidatePool({ registry: store, munin: m }, { periods: [PERIOD] });
    const serialized = JSON.stringify(result.candidates);
    expect(serialized).not.toContain("fixture rendered prompt");
    expect(serialized).not.toContain("fixture raw task text");
    expect(serialized).not.toContain("prompt for task-content-blind");
  });

  it("dedupes by natural key across overlapping scanned periods", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    await seedResolvableCandidate(m, store, {
      taskId: "task-dedup", taskType: "code-edit", modelId: "model-a", rating: "pass", occurredAt: "2026-07-05T00:00:00.000Z",
    });
    const result = await assembleCandidatePool({ registry: store, munin: m }, { periods: [PERIOD, PERIOD] });
    expect(result.candidates).toHaveLength(1);
  });

  it("is deterministic and idempotent across repeated runs against unchanged state", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    await seedResolvableCandidate(m, store, {
      taskId: "task-b", taskType: "code-edit", modelId: "model-b", rating: "pass", occurredAt: "2026-07-05T00:00:00.000Z",
    });
    await seedResolvableCandidate(m, store, {
      taskId: "task-a", taskType: "code-edit", modelId: "model-a", rating: "pass", occurredAt: "2026-07-06T00:00:00.000Z",
    });
    const run1 = await assembleCandidatePool({ registry: store, munin: m }, { periods: [PERIOD] });
    const run2 = await assembleCandidatePool({ registry: store, munin: m }, { periods: [PERIOD] });
    expect(run1.candidates.map((c) => c.taskId)).toEqual(["task-a", "task-b"]); // sorted
    expect(run2.candidates).toEqual(run1.candidates);
  });

  it("skips a non-completed terminal outcome", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    const taskId = "task-failed";
    const { attemptId, attemptOutcomeRef } = buildFixtureAdmittedAttempt({ taskId, taskType: "code-edit" });
    const taskOutcomeRef = ref(`tasks/${taskId}`, "result-structured");
    await store.recordSubmission({ taskId, taskOutcomeRef, occurredAt: "2026-07-05T00:00:00.000Z" });
    await store.recordAttemptReference({
      taskId, attemptId, attemptStartRef: ref(`tasks/${taskId}`, `learning-attempt-${attemptId}`), taskOutcomeRef,
      occurredAt: "2026-07-05T00:00:00.000Z",
    });
    await store.recordTerminalOutcome({
      taskId, attemptId, outcome: "failed", taskOutcomeRef, attemptOutcomeRef,
      delegation: { modelId: "model-a", taskType: "code-edit", evidenceIdentityHash: hash("failed") },
      occurredAt: "2026-07-05T00:00:00.000Z",
    });

    const result = await assembleCandidatePool({ registry: store, munin: m }, { periods: [PERIOD] });
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual([{ taskId, attemptId, reason: "outcome-not-completed" }]);
  });

  it("skips a completed outcome with no delegation-carried model identity", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    const taskId = "task-no-model";
    const attemptId = "some-attempt-id";
    const taskOutcomeRef = ref(`tasks/${taskId}`, "result-structured");
    await store.recordSubmission({ taskId, taskOutcomeRef, occurredAt: "2026-07-05T00:00:00.000Z" });
    await store.recordAttemptReference({
      taskId, attemptId, attemptStartRef: ref(`tasks/${taskId}`, `learning-attempt-${attemptId}`), taskOutcomeRef,
      occurredAt: "2026-07-05T00:00:00.000Z",
    });
    await store.recordTerminalOutcome({
      taskId, attemptId, outcome: "completed", taskOutcomeRef,
      occurredAt: "2026-07-05T00:00:00.000Z",
    });

    const result = await assembleCandidatePool({ registry: store, munin: m }, { periods: [PERIOD] });
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual([{ taskId, attemptId, reason: "missing-model-identity" }]);
  });

  it("skips a completed outcome whose model lacks an authoritative evidence identity", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    const taskId = "task-no-evidence-identity";
    const attemptId = "some-attempt-id";
    const taskOutcomeRef = ref(`tasks/${taskId}`, "result-structured");
    await store.recordSubmission({ taskId, taskOutcomeRef, occurredAt: "2026-07-05T00:00:00.000Z" });
    await store.recordAttemptReference({
      taskId, attemptId, attemptStartRef: ref(`tasks/${taskId}`, `learning-attempt-${attemptId}`), taskOutcomeRef,
      occurredAt: "2026-07-05T00:00:00.000Z",
    });
    await store.recordTerminalOutcome({
      taskId, attemptId, outcome: "completed", taskOutcomeRef,
      delegation: { modelId: "model-a", taskType: "code-edit" },
      occurredAt: "2026-07-05T00:00:00.000Z",
    });

    const result = await assembleCandidatePool({ registry: store, munin: m }, { periods: [PERIOD] });
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual([{ taskId, attemptId, reason: "missing-evidence-identity" }]);
  });

  it("skips a completed outcome missing an attempt-outcome ref", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    const taskId = "task-no-ref";
    const attemptId = "some-attempt-id";
    const taskOutcomeRef = ref(`tasks/${taskId}`, "result-structured");
    await store.recordSubmission({ taskId, taskOutcomeRef, occurredAt: "2026-07-05T00:00:00.000Z" });
    await store.recordAttemptReference({
      taskId, attemptId, attemptStartRef: ref(`tasks/${taskId}`, `learning-attempt-${attemptId}`), taskOutcomeRef,
      occurredAt: "2026-07-05T00:00:00.000Z",
    });
    await store.recordTerminalOutcome({
      taskId, attemptId, outcome: "completed", taskOutcomeRef,
      delegation: { modelId: "model-a", taskType: "code-edit", evidenceIdentityHash: hash("no-ref") },
      occurredAt: "2026-07-05T00:00:00.000Z",
    });

    const result = await assembleCandidatePool({ registry: store, munin: m }, { periods: [PERIOD] });
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual([{ taskId, attemptId, reason: "missing-attempt-outcome-ref" }]);
  });

  it("skips when the attempt-outcome ref resolves to a non-admitted (e.g. join-failed) row", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    const taskId = "task-not-admitted";
    const attemptId = "some-attempt-id";
    const attemptOutcomeRef = ref(`tasks/${taskId}`, "learning-attempt-x-outcome");
    await m.write(attemptOutcomeRef.namespace, attemptOutcomeRef.key, JSON.stringify({
      schemaVersion: 1,
      contractVersion: "grimnir.learning-task/v1",
      state: "join-failed",
      evidenceAccepted: false,
      taskId,
      attemptId,
      attemptStartedAt: "2026-07-05T00:00:00.000Z",
      taskOutcomeRef: { namespace: `tasks/${taskId}`, key: "result-structured" },
      rawFingerprint: { algorithm: "sha256", version: "trim-utf8-sha256-v1", digest: hash("x") },
    }), []);

    const taskOutcomeRef = ref(`tasks/${taskId}`, "result-structured");
    await store.recordSubmission({ taskId, taskOutcomeRef, occurredAt: "2026-07-05T00:00:00.000Z" });
    await store.recordAttemptReference({
      taskId, attemptId, attemptStartRef: ref(`tasks/${taskId}`, `learning-attempt-${attemptId}`), taskOutcomeRef,
      occurredAt: "2026-07-05T00:00:00.000Z",
    });
    await store.recordTerminalOutcome({
      taskId, attemptId, outcome: "completed", taskOutcomeRef, attemptOutcomeRef,
      delegation: { modelId: "model-a", taskType: "code-edit", evidenceIdentityHash: hash("not-admitted") },
      occurredAt: "2026-07-05T00:00:00.000Z",
    });

    const result = await assembleCandidatePool({ registry: store, munin: m }, { periods: [PERIOD] });
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual([{ taskId, attemptId, reason: "attempt-outcome-not-admitted" }]);
  });

  it("skips a fully-admitted attempt with no resolvable quality receipt", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    const taskId = "task-no-receipt";
    const { attemptId, attemptOutcomeRef, evidence } = buildFixtureAdmittedAttempt({ taskId, taskType: "code-edit" });
    await m.write(attemptOutcomeRef.namespace, attemptOutcomeRef.key, JSON.stringify(evidence), []);
    const taskOutcomeRef = ref(`tasks/${taskId}`, "result-structured");
    await store.recordSubmission({ taskId, taskOutcomeRef, occurredAt: "2026-07-05T00:00:00.000Z" });
    await store.recordAttemptReference({
      taskId, attemptId, attemptStartRef: ref(`tasks/${taskId}`, `learning-attempt-${attemptId}`), taskOutcomeRef,
      occurredAt: "2026-07-05T00:00:00.000Z",
    });
    await store.recordTerminalOutcome({
      taskId, attemptId, outcome: "completed", taskOutcomeRef, attemptOutcomeRef,
      delegation: { modelId: "model-a", taskType: "code-edit", evidenceIdentityHash: hash("no-receipt") },
      occurredAt: "2026-07-05T00:00:00.000Z",
    });
    // No status/result-structured/feedback docs written -- nothing to bind a receipt against.

    const result = await assembleCandidatePool({ registry: store, munin: m }, { periods: [PERIOD] });
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual([{ taskId, attemptId, reason: "missing-quality-receipt" }]);
  });

  it("skips an exact-bound receipt when the reviewer is not independent", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    const taskId = "task-self-reviewed";
    const { attemptId } = await seedResolvableCandidate(m, store, {
      taskId,
      taskType: "code-edit",
      modelId: "model-a",
      rating: "pass",
      occurredAt: "2026-07-05T00:00:00.000Z",
      reviewerIndependence: "self",
    });

    const result = await assembleCandidatePool({ registry: store, munin: m }, { periods: [PERIOD] });
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual([{ taskId, attemptId, reason: "missing-quality-receipt" }]);
  });

  it("throws on a truncated period scan rather than returning a partial pool", async () => {
    const truncatedRegistry: Pick<LearningRegistryStore, "listTerminalOutcomesForPeriod"> = {
      listTerminalOutcomesForPeriod: async () => ({ events: [], truncated: true }),
    };
    await expect(
      assembleCandidatePool({ registry: truncatedRegistry as LearningRegistryStore, munin: munin() }, { periods: [PERIOD] }),
    ).rejects.toThrow(/truncated/);
  });

  it("createCandidatePoolAssembler returns a bare loadCandidates()-shaped function", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    await seedResolvableCandidate(m, store, {
      taskId: "task-loader", taskType: "code-edit", modelId: "model-a", rating: "pass", occurredAt: "2026-07-05T00:00:00.000Z",
    });
    const loadCandidates = createCandidatePoolAssembler({ registry: store, munin: m }, { periods: [PERIOD] });
    const candidates = await loadCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.taskId).toBe("task-loader");
  });

  it("defaults to scanning the current and previous UTC month when no periods are given", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    await seedResolvableCandidate(m, store, {
      taskId: "task-default-window", taskType: "code-edit", modelId: "model-a", rating: "pass", occurredAt: "2026-06-15T00:00:00.000Z",
    });
    const result = await assembleCandidatePool(
      { registry: store, munin: m, now: () => "2026-07-20T00:00:00.000Z" },
      {},
    );
    expect(result.scannedPeriods).toEqual(["2026-07", "2026-06"]);
    expect(result.candidates.map((c) => c.taskId)).toEqual(["task-default-window"]);
  });
});
