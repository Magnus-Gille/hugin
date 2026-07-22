import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MuninWriteRejectedError, type MuninClient, type MuninQueryResult } from "../src/munin-client.js";
import { LearningRegistryStore } from "../src/learning-registry-store.js";
import { buildTaskLifecycleTimeline, type TaskLifecycleTimeline } from "../src/learning-registry-view.js";
import { LearningExperimentStore } from "../src/learning/experiment-store.js";
import { computeConfigurationFingerprint, learningExperimentGatesSchema } from "../src/learning/experiment-schema.js";
import { buildQualityReceipt, type QualityReceipt } from "../src/quality-receipt.js";
import {
  packageAndHandOff,
  packageExperimentCandidates,
  qualifyCandidate,
  toExperimentCreateInput,
  type PackageRequest,
  type PackagerCandidateInput,
} from "../src/learning/candidate-packager.js";
import { makeLearningConfig } from "./fixtures/learning.js";

// ---------------------------------------------------------------------------
// In-memory Munin double -- same create-if-absent / CAS contract as the real
// service, copied from tests/learning-registry-store.test.ts's fixture so
// this file can drive a real LearningRegistryStore and LearningExperimentStore.
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

const ref = (namespace: string, key: string) => ({ namespace, key });
const hash = (seed: string) => createHash("sha256").update(seed).digest("hex");

async function registerQualifiedAttempt(
  store: LearningRegistryStore,
  input: { taskId: string; attemptId: string; occurredAt: string; outcome?: "completed" | "failed" },
) {
  const taskOutcomeRef = ref(`tasks/${input.taskId}`, "result-structured");
  await store.recordSubmission({ taskId: input.taskId, taskOutcomeRef, occurredAt: input.occurredAt });
  await store.recordAttemptReference({
    taskId: input.taskId,
    attemptId: input.attemptId,
    attemptStartRef: ref(`tasks/${input.taskId}`, `learning-attempt-${input.attemptId}`),
    taskOutcomeRef,
    occurredAt: input.occurredAt,
  });
  await store.recordTerminalOutcome({
    taskId: input.taskId,
    attemptId: input.attemptId,
    outcome: input.outcome ?? "completed",
    taskOutcomeRef,
    occurredAt: input.occurredAt,
  });
}

function passingReceipt(taskId: string, overrides: Partial<Parameters<typeof buildQualityReceipt>[0]> = {}): QualityReceipt {
  return buildQualityReceipt({
    taskId,
    reviewerPrincipal: "codex",
    reviewerIndependence: "independent",
    rating: "pass",
    ratingReason: "Matches the ticket's acceptance criteria; no further changes needed.",
    verificationOutcome: "accepted_unchanged",
    ratedAt: "2026-07-20T00:00:00.000Z",
    bindingAttestation: "server-bound",
    binding: {
      taskDocumentSha256: hash(`${taskId}-doc`),
      structuredResultSha256: hash(`${taskId}-result`),
      repository: { state: "no-changes", baseBranch: "main", baseCommit: hash(`${taskId}-base`).slice(0, 40) },
    },
    ...overrides,
  });
}

function candidateFor(
  taskId: string,
  attemptId: string,
  arm: "champion" | "challenger",
  axis: PackageRequest["changeAxis"] = "agent-prompt",
  receiptOverrides: Partial<Parameters<typeof buildQualityReceipt>[0]> = {},
): PackagerCandidateInput {
  return {
    taskId,
    attemptId,
    taskType: "code-edit",
    configuration: makeLearningConfig(arm, axis),
    qualityReceipt: passingReceipt(taskId, receiptOverrides),
  };
}

function defaultGates() {
  return learningExperimentGatesSchema.parse({ primaryMetric: "quality-rate" });
}

function defaultRequest(overrides: Partial<PackageRequest> = {}): PackageRequest {
  return {
    scope: "code-edit-pilot",
    hypothesis: "A revised prompt improves acceptance without regressing quality.",
    changeAxis: "agent-prompt",
    championFingerprint: makeLearningConfig("champion", "agent-prompt").fingerprint,
    gates: defaultGates(),
    now: () => "2026-07-20T12:00:00.000Z",
    ...overrides,
  };
}

/** Two champion + two challenger candidates, all wired into a fresh registry with completed, unexcluded evidence. */
async function qualifiedPool(store: LearningRegistryStore, axis: PackageRequest["changeAxis"] = "agent-prompt") {
  const specs: Array<{ taskId: string; attemptId: string; arm: "champion" | "challenger" }> = [
    { taskId: "task-champ-1", attemptId: "attempt-champ-1", arm: "champion" },
    { taskId: "task-champ-2", attemptId: "attempt-champ-2", arm: "champion" },
    { taskId: "task-chall-1", attemptId: "attempt-chall-1", arm: "challenger" },
    { taskId: "task-chall-2", attemptId: "attempt-chall-2", arm: "challenger" },
  ];
  const candidates: PackagerCandidateInput[] = [];
  const timelines = new Map<string, TaskLifecycleTimeline>();
  for (const spec of specs) {
    await registerQualifiedAttempt(store, { taskId: spec.taskId, attemptId: spec.attemptId, occurredAt: "2026-07-19T00:00:00.000Z" });
    candidates.push(candidateFor(spec.taskId, spec.attemptId, spec.arm, axis));
    timelines.set(spec.taskId, await buildTaskLifecycleTimeline(store, spec.taskId));
  }
  return { candidates, timelines };
}

describe("qualifyCandidate", () => {
  it("accepts a candidate with completed, unexcluded evidence and a matching passing receipt", async () => {
    const store = new LearningRegistryStore(munin());
    await registerQualifiedAttempt(store, { taskId: "t1", attemptId: "a1", occurredAt: "2026-07-19T00:00:00.000Z" });
    const timeline = await buildTaskLifecycleTimeline(store, "t1");
    const candidate = candidateFor("t1", "a1", "champion");
    expect(qualifyCandidate(candidate, timeline)).toEqual({ ok: true });
  });

  it("fails closed on a truncated timeline rather than reasoning over incomplete evidence", async () => {
    const store = new LearningRegistryStore(munin());
    await registerQualifiedAttempt(store, { taskId: "t1", attemptId: "a1", occurredAt: "2026-07-19T00:00:00.000Z" });
    const timeline = await buildTaskLifecycleTimeline(store, "t1");
    const candidate = candidateFor("t1", "a1", "champion");
    const result = qualifyCandidate(candidate, { ...timeline, truncated: true });
    expect(result).toEqual({ ok: false, reasons: [{ code: "timeline-truncated" }] });
  });

  it("rejects a candidate whose attempt was never referenced in the registry", async () => {
    const store = new LearningRegistryStore(munin());
    await store.recordSubmission({
      taskId: "t1", taskOutcomeRef: ref("tasks/t1", "result-structured"), occurredAt: "2026-07-19T00:00:00.000Z",
    });
    const timeline = await buildTaskLifecycleTimeline(store, "t1");
    const candidate = candidateFor("t1", "a-missing", "champion");
    const result = qualifyCandidate(candidate, timeline);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContainEqual({ code: "missing-attempt-reference" });
      expect(result.reasons).toContainEqual({ code: "missing-terminal-outcome" });
    }
  });

  it("rejects an attempt whose registry evidence was excluded (erasure/exclusion)", async () => {
    const store = new LearningRegistryStore(munin());
    await registerQualifiedAttempt(store, { taskId: "t1", attemptId: "a1", occurredAt: "2026-07-19T00:00:00.000Z" });
    const beforeExclusion = await buildTaskLifecycleTimeline(store, "t1");
    const attemptEvent = beforeExclusion.entries.find((e) => e.event.recordKind === "attempt-reference")!.event;
    await store.writeExclusionAdjustment({
      taskId: "t1", targetEventId: attemptEvent.eventId, adjustmentReason: "erasure", occurredAt: "2026-07-19T01:00:00.000Z",
    });
    const timeline = await buildTaskLifecycleTimeline(store, "t1");
    const result = qualifyCandidate(candidateFor("t1", "a1", "champion"), timeline);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContainEqual({ code: "attempt-reference-excluded", reasons: ["erasure"] });
    }
  });

  it("rejects a candidate whose attempt did not complete", async () => {
    const store = new LearningRegistryStore(munin());
    await registerQualifiedAttempt(store, { taskId: "t1", attemptId: "a1", occurredAt: "2026-07-19T00:00:00.000Z", outcome: "failed" });
    const timeline = await buildTaskLifecycleTimeline(store, "t1");
    const result = qualifyCandidate(candidateFor("t1", "a1", "champion"), timeline);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContainEqual({ code: "outcome-not-completed", outcome: "failed" });
  });

  it("rejects a receipt bound to a different task (contaminated evidence)", async () => {
    const store = new LearningRegistryStore(munin());
    await registerQualifiedAttempt(store, { taskId: "t1", attemptId: "a1", occurredAt: "2026-07-19T00:00:00.000Z" });
    const timeline = await buildTaskLifecycleTimeline(store, "t1");
    const candidate: PackagerCandidateInput = {
      ...candidateFor("t1", "a1", "champion"),
      qualityReceipt: passingReceipt("some-other-task"),
    };
    const result = qualifyCandidate(candidate, timeline);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContainEqual({ code: "quality-receipt-task-mismatch" });
  });

  it("rejects a candidate whose quality receipt is not independently reviewed", async () => {
    const store = new LearningRegistryStore(munin());
    await registerQualifiedAttempt(store, { taskId: "t1", attemptId: "a1", occurredAt: "2026-07-19T00:00:00.000Z" });
    const timeline = await buildTaskLifecycleTimeline(store, "t1");
    const candidate = candidateFor("t1", "a1", "champion", "agent-prompt", {
      reviewerIndependence: "self",
    });
    const result = qualifyCandidate(candidate, timeline);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContainEqual({ code: "quality-receipt-not-independent", independence: "self" });
    }
  });

  it("rejects a candidate whose receipt rating is below the required threshold", async () => {
    const store = new LearningRegistryStore(munin());
    await registerQualifiedAttempt(store, { taskId: "t1", attemptId: "a1", occurredAt: "2026-07-19T00:00:00.000Z" });
    const timeline = await buildTaskLifecycleTimeline(store, "t1");
    const candidate = candidateFor("t1", "a1", "champion", "agent-prompt", {
      rating: "redo",
      verificationOutcome: "major_rewrite",
    });
    const result = qualifyCandidate(candidate, timeline);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContainEqual({ code: "quality-rating-insufficient", rating: "redo" });
  });
});

describe("packageExperimentCandidates", () => {
  it("packages a qualified, coherent one-axis candidate set", async () => {
    const store = new LearningRegistryStore(munin());
    const { candidates, timelines } = await qualifiedPool(store, "agent-prompt");
    const outcome = packageExperimentCandidates(candidates, timelines, defaultRequest());
    expect(outcome.status).toBe("packaged");
    expect(outcome.rejected).toEqual([]);
    const pkg = outcome.package!;
    expect(pkg.changeAxis).toBe("agent-prompt");
    expect(pkg.matchedTasks).toHaveLength(4);
    expect(pkg.matchedTasks.filter((t) => t.arm === "champion")).toHaveLength(2);
    expect(pkg.matchedTasks.filter((t) => t.arm === "challenger")).toHaveLength(2);
    expect(pkg.idempotencyKey).toBe(pkg.packageId);
    expect(pkg.packageId).toMatch(/^pkg-[a-f0-9]{64}$/);
  });

  it("re-packaging the identical qualified set is a no-op returning the same package id", async () => {
    const store = new LearningRegistryStore(munin());
    const { candidates, timelines } = await qualifiedPool(store, "agent-harness");
    const request = defaultRequest({
      changeAxis: "agent-harness",
      championFingerprint: makeLearningConfig("champion", "agent-harness").fingerprint,
      now: () => "2026-07-20T12:00:00.000Z",
    });
    const first = packageExperimentCandidates(candidates, timelines, request);
    const second = packageExperimentCandidates(
      candidates,
      timelines,
      { ...request, now: () => "2026-07-21T09:00:00.000Z" }, // different wall clock, same content
    );
    expect(first.status).toBe("packaged");
    expect(second.status).toBe("packaged");
    expect(second.package!.packageId).toBe(first.package!.packageId);
    // qualifiedAt legitimately differs -- it is intentionally excluded from the identity digest.
    expect(second.package!.qualifiedAt).not.toBe(first.package!.qualifiedAt);
  });

  it("refuses a candidate set that changes more than the declared axis (multi-axis delta)", async () => {
    const store = new LearningRegistryStore(munin());
    const { candidates, timelines } = await qualifiedPool(store, "agent-prompt");
    // Mutate the challenger candidates so their harness ALSO differs, not just the prompt.
    const contaminatedHarnessDigest = hash("contaminated-harness");
    const contaminated = candidates.map((c) => {
      if (c.taskId.startsWith("task-chall")) {
        const configuration = {
          ...c.configuration,
          harness: { ...c.configuration.harness, version: "9", configSha256: contaminatedHarnessDigest },
        };
        configuration.fingerprint = computeConfigurationFingerprint(configuration);
        return { ...c, configuration };
      }
      return c;
    });
    const outcome = packageExperimentCandidates(contaminated, timelines, defaultRequest());
    expect(outcome.status).toBe("refused");
    expect(outcome.refusalReasons).toContainEqual(
      expect.objectContaining({ code: "multi-axis-delta", changedAxes: expect.arrayContaining(["agent-prompt", "agent-harness"]) }),
    );
  });

  it("refuses when the observed single-axis delta does not match the declared axis", async () => {
    const store = new LearningRegistryStore(munin());
    // Candidates actually vary by harness, but the request declares agent-prompt.
    const { candidates, timelines } = await qualifiedPool(store, "agent-harness");
    const outcome = packageExperimentCandidates(candidates, timelines, defaultRequest({ changeAxis: "agent-prompt" }));
    expect(outcome.status).toBe("refused");
    expect(outcome.refusalReasons).toContainEqual({
      code: "declared-axis-mismatch", declared: "agent-prompt", detected: ["agent-harness"],
    });
  });

  it("refuses a pool with more than two distinct configurations", async () => {
    const store = new LearningRegistryStore(munin());
    const { candidates, timelines } = await qualifiedPool(store, "agent-prompt");
    await registerQualifiedAttempt(store, { taskId: "task-chall-3", attemptId: "attempt-chall-3", occurredAt: "2026-07-19T00:00:00.000Z" });
    timelines.set("task-chall-3", await buildTaskLifecycleTimeline(store, "task-chall-3"));
    // A third, distinct configuration on the challenger side (a second challenger axis value).
    const thirdConfig = makeLearningConfig("challenger", "agent-harness");
    const withThird = [
      ...candidates,
      { ...candidateFor("task-chall-3", "attempt-chall-3", "challenger", "agent-prompt"), configuration: thirdConfig },
    ];
    const outcome = packageExperimentCandidates(withThird, timelines, defaultRequest());
    expect(outcome.status).toBe("refused");
    expect(outcome.refusalReasons.some((r) => r.code === "more-than-two-distinct-configurations")).toBe(true);
  });

  it("refuses an arm with fewer than the required number of qualified candidates", async () => {
    const store = new LearningRegistryStore(munin());
    const { candidates, timelines } = await qualifiedPool(store, "agent-prompt");
    const onlyOneChallenger = candidates.filter((c) => c.taskId !== "task-chall-2");
    const outcome = packageExperimentCandidates(onlyOneChallenger, timelines, defaultRequest());
    expect(outcome.status).toBe("refused");
    expect(outcome.refusalReasons).toContainEqual({ code: "insufficient-candidates", arm: "challenger", count: 1, required: 2 });
  });

  it("rejects a candidate whose task has no supplied timeline at all, distinct from a truncated one", async () => {
    const store = new LearningRegistryStore(munin());
    const { candidates, timelines } = await qualifiedPool(store, "agent-prompt");
    timelines.delete("task-chall-2"); // simulate a candidate the caller forgot to fetch a timeline for
    const outcome = packageExperimentCandidates(candidates, timelines, defaultRequest());
    expect(outcome.rejected).toContainEqual({
      taskId: "task-chall-2", attemptId: "attempt-chall-2", reasons: [{ code: "missing-timeline" }],
    });
  });

  it("refuses when every candidate fails qualification", async () => {
    const store = new LearningRegistryStore(munin());
    await registerQualifiedAttempt(store, { taskId: "t1", attemptId: "a1", occurredAt: "2026-07-19T00:00:00.000Z", outcome: "failed" });
    const timelines = new Map([["t1", await buildTaskLifecycleTimeline(store, "t1")]]);
    const outcome = packageExperimentCandidates([candidateFor("t1", "a1", "champion")], timelines, defaultRequest());
    expect(outcome.status).toBe("refused");
    expect(outcome.refusalReasons).toEqual([{ code: "no-qualified-candidates" }]);
    expect(outcome.rejected).toHaveLength(1);
  });

  it("never carries the raw free-text rating reason or other task content into the frozen package (content-blindness)", async () => {
    const store = new LearningRegistryStore(munin());
    const secretTaskContent = "SECRET-RAW-TASK-CONTENT-do-not-leak-6f19c2";
    const { candidates: base, timelines } = await qualifiedPool(store, "agent-prompt");
    const candidates = base.map((c) =>
      c.taskId === "task-champ-1"
        ? { ...c, qualityReceipt: passingReceipt(c.taskId, { ratingReason: secretTaskContent }) }
        : c);
    const outcome = packageExperimentCandidates(candidates, timelines, defaultRequest());
    expect(outcome.status).toBe("packaged");
    const serialized = JSON.stringify(outcome.package);
    expect(serialized).not.toContain(secretTaskContent);
    expect(serialized).not.toContain("ratingReason");
  });
});

describe("toExperimentCreateInput", () => {
  it("maps a frozen package onto the existing champion/challenger create contract", async () => {
    const store = new LearningRegistryStore(munin());
    const { candidates, timelines } = await qualifiedPool(store, "agent-prompt");
    const outcome = packageExperimentCandidates(candidates, timelines, defaultRequest());
    const input = toExperimentCreateInput(outcome.package!);
    expect(input.change_axis).toBe("agent-prompt");
    expect(input.scope).toBe("code-edit-pilot");
    expect(input.champion.fingerprint).toBe(outcome.package!.champion.fingerprint);
    expect(input.challenger.fingerprint).toBe(outcome.package!.challenger.fingerprint);
  });
});

describe("packageAndHandOff (handoff to the existing experiment surface)", () => {
  it("packages, freezes, and hands off to LearningExperimentStore.create; a repeat run is idempotent", async () => {
    const registryMunin = munin();
    const experimentMunin = munin();
    const registry = new LearningRegistryStore(registryMunin);
    const experimentStore = new LearningExperimentStore(experimentMunin);

    const specs: Array<{ taskId: string; attemptId: string; arm: "champion" | "challenger" }> = [
      { taskId: "task-champ-1", attemptId: "attempt-champ-1", arm: "champion" },
      { taskId: "task-champ-2", attemptId: "attempt-champ-2", arm: "champion" },
      { taskId: "task-chall-1", attemptId: "attempt-chall-1", arm: "challenger" },
      { taskId: "task-chall-2", attemptId: "attempt-chall-2", arm: "challenger" },
    ];
    const candidates: PackagerCandidateInput[] = [];
    for (const spec of specs) {
      await registerQualifiedAttempt(registry, { taskId: spec.taskId, attemptId: spec.attemptId, occurredAt: "2026-07-19T00:00:00.000Z" });
      candidates.push(candidateFor(spec.taskId, spec.attemptId, spec.arm, "agent-prompt"));
    }

    const request = defaultRequest();
    const first = await packageAndHandOff(registry, experimentStore, "codex", candidates, request);
    expect(first.status).toBe("packaged");
    expect(first.experiment?.reused).toBe(false);
    expect(first.experiment?.state.status).toBe("running");

    const second = await packageAndHandOff(registry, experimentStore, "codex", candidates, {
      ...request, now: () => "2026-07-22T00:00:00.000Z",
    });
    expect(second.status).toBe("packaged");
    expect(second.package!.packageId).toBe(first.package!.packageId);
    expect(second.experiment?.reused).toBe(true);
    expect(second.experiment?.state.experimentId).toBe(first.experiment?.state.experimentId);
  });

  it("refuses the handoff (never calls create) when the candidate set is not qualifiable", async () => {
    const registry = new LearningRegistryStore(munin());
    const experimentStore = new LearningExperimentStore(munin());
    await registerQualifiedAttempt(registry, { taskId: "t1", attemptId: "a1", occurredAt: "2026-07-19T00:00:00.000Z", outcome: "failed" });
    const result = await packageAndHandOff(
      registry, experimentStore, "codex", [candidateFor("t1", "a1", "champion")], defaultRequest(),
    );
    expect(result.status).toBe("refused");
    expect(result.experiment).toBeUndefined();
  });
});
