import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MuninWriteRejectedError, type MuninClient } from "../src/munin-client.js";
import { LearningRegistryStore } from "../src/learning-registry-store.js";
import { computeConfigurationFingerprint } from "../src/learning/experiment-schema.js";
import { buildQualityReceipt, type QualityReceipt } from "../src/quality-receipt.js";
import { LearningExperimentStore } from "../src/learning/experiment-store.js";
import type { PackagerCandidateInput } from "../src/learning/candidate-packager-schema.js";
import {
  runExperimentCadenceTick,
  type ExperimentCadenceDeps,
} from "../src/learning/experiment-cadence.js";
import { makeLearningConfig } from "./fixtures/learning.js";

// ---------------------------------------------------------------------------
// In-memory Munin double -- same create-if-absent / CAS contract as the real
// service, copied from tests/experiment-proposer.test.ts's own copy (itself
// copied from tests/learning-registry-store.test.ts), extended with `log()`
// so this file can assert the durable tick log actually gets written.
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
  readonly logs: Array<{ namespace: string; content: string; tags?: string[] }> = [];

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

  async log(namespace: string, content: string, tags?: string[]) {
    this.logs.push({ namespace, content, tags });
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

function receiptFor(
  taskId: string,
  rating: "pass" | "partial" | "redo" | "wrong",
  ratedAt: string,
  overrides: Partial<Parameters<typeof buildQualityReceipt>[0]> = {},
): QualityReceipt {
  return buildQualityReceipt({
    taskId,
    reviewerPrincipal: "codex",
    reviewerIndependence: "independent",
    rating,
    ratingReason: `SECRET-RAW-EVIDENCE-TEXT-${taskId}-${rating}`,
    verificationOutcome: rating === "pass" ? "accepted_unchanged" : "major_rewrite",
    ratedAt,
    bindingAttestation: "server-bound",
    binding: {
      taskDocumentSha256: hash(`${taskId}-doc`),
      structuredResultSha256: hash(`${taskId}-result`),
      repository: { state: "no-changes", baseBranch: "main", baseCommit: hash(`${taskId}-base`).slice(0, 40) },
    },
    ...overrides,
  });
}

/** Register `count` qualified attempts of `taskType` for one config arm. See
 * tests/experiment-proposer.test.ts's own copy of this helper -- this cadence
 * suite only ever drives the registry-backed orchestration functions, so it
 * does not also need to return a timelines map the way that file's does. */
async function seedArm(
  store: LearningRegistryStore,
  input: {
    taskType: string;
    arm: "champion" | "challenger";
    axis: Parameters<typeof makeLearningConfig>[1];
    idPrefix: string;
    count: number;
    ratings: Array<"pass" | "partial" | "redo" | "wrong">;
    startIso: string;
  },
): Promise<PackagerCandidateInput[]> {
  const candidates: PackagerCandidateInput[] = [];
  const configuration = makeLearningConfig(input.arm, input.axis);
  for (let i = 0; i < input.count; i += 1) {
    const taskId = `${input.idPrefix}-${i}`;
    const attemptId = `${input.idPrefix}-attempt-${i}`;
    const occurredAt = new Date(Date.parse(input.startIso) + i * 86_400_000).toISOString();
    await registerQualifiedAttempt(store, { taskId, attemptId, occurredAt });
    const rating = input.ratings[i % input.ratings.length]!;
    candidates.push({
      taskId,
      attemptId,
      taskType: input.taskType as PackagerCandidateInput["taskType"],
      configuration,
      qualityReceipt: receiptFor(taskId, rating, occurredAt),
    });
  }
  return candidates;
}

const MECHANICAL_VERIFIER = { kind: "mechanical" as const, independent: true, id: "protected-check", version: "1" };
const HOLDOUT_SAMPLES = new Set(["case-1", "case-2"]);

/** Push `count` matched champion/challenger observation pairs (idempotent per
 * run_id) engineered to clear every default gate once `count` reaches 6:
 * verified+rated coverage 1.0, 2 holdout pairs, challenger quality-rate 1.0
 * vs champion 0.0 (>= the 0.05 minPrimaryImprovement default), matched
 * latency/cost so no ratio guard fires. */
async function observePairs(
  store: LearningExperimentStore,
  principal: string,
  experimentId: string,
  count: number,
): Promise<void> {
  for (let i = 1; i <= count; i += 1) {
    const sample = `case-${i}`;
    const holdout = HOLDOUT_SAMPLES.has(sample);
    await store.observe(principal, {
      experiment_id: experimentId,
      run_id: `${sample}-champion`,
      sample_id: sample,
      arm: "champion",
      holdout,
      configuration_fingerprint: makeLearningConfig("champion", "agent-prompt").fingerprint,
      quality_outcome: "fail",
      product_outcome: "discarded",
      verifier: MECHANICAL_VERIFIER,
      latency_ms: 1000,
      cost_usd: 0,
    });
    await store.observe(principal, {
      experiment_id: experimentId,
      run_id: `${sample}-challenger`,
      sample_id: sample,
      arm: "challenger",
      holdout,
      configuration_fingerprint: makeLearningConfig("challenger", "agent-prompt").fingerprint,
      quality_outcome: "pass",
      product_outcome: "accepted-unchanged",
      verifier: MECHANICAL_VERIFIER,
      latency_ms: 1000,
      cost_usd: 0,
    });
  }
}

function baseDeps(
  m: InMemoryMunin & MuninClient,
  registry: LearningRegistryStore,
  experimentStore: LearningExperimentStore,
  principal: string,
  candidates: PackagerCandidateInput[],
): ExperimentCadenceDeps {
  return {
    registry,
    experimentStore,
    munin: m,
    principal,
    loadCandidates: async () => candidates,
    now: () => "2026-07-10T00:00:00.000Z",
  };
}

/**
 * The #234 proposer floors at "wrong" (the whole outcome spectrum) so it can
 * detect a quality delta at all, but the #233 packager only ever freezes
 * "pass"-rated candidates (candidate-packager.ts's `DEFAULT_MIN_QUALITY_RATING`).
 * A realistic proposal-that-packages therefore needs each arm to carry at
 * least `minCandidatesPerArm` (2) pass-rated candidates while still showing a
 * proposer-visible delta across the WHOLE arm -- champion here is 2 pass + 2
 * wrong (proposer-visible rate 0.5), challenger is 4 pass (rate 1.0), a 0.5
 * delta comfortably above the 0.1 default threshold. The packager will
 * legitimately reject the 2 non-pass champion candidates and still freeze
 * the surviving 2 -- exactly the "some matched candidates rejected, enough
 * survive" behavior `packageExperimentCandidates` is designed for.
 */
async function seedOneAxisPopulation(registry: LearningRegistryStore): Promise<PackagerCandidateInput[]> {
  const champion = await seedArm(registry, {
    taskType: "code-edit", arm: "champion", axis: "agent-prompt", idPrefix: "champ",
    count: 4, ratings: ["pass", "pass", "wrong", "wrong"], startIso: "2026-07-01T00:00:00.000Z",
  });
  const challenger = await seedArm(registry, {
    taskType: "code-edit", arm: "challenger", axis: "agent-prompt", idPrefix: "chall",
    count: 4, ratings: ["pass"], startIso: "2026-07-05T00:00:00.000Z",
  });
  return [...champion, ...challenger];
}

describe("runExperimentCadenceTick", () => {
  it("packages exactly one experiment from a qualified proposal; a re-tick with unchanged state duplicates nothing", async () => {
    const m = munin();
    const registry = new LearningRegistryStore(m);
    const experimentStore = new LearningExperimentStore(m);
    const candidates = await seedOneAxisPopulation(registry);
    const principal = "service:test-cadence-happy-path";
    const deps = baseDeps(m, registry, experimentStore, principal, candidates);

    const tick1 = await runExperimentCadenceTick(deps);
    expect(tick1.errors).toEqual([]);
    expect(tick1.refusals).toEqual([]);
    expect(tick1.proposalDeclines).toEqual([]);
    expect(tick1.proposalsConsidered).toBe(1);
    expect(tick1.skippedInFlight).toEqual([]);
    expect(tick1.packaged).not.toBeNull();
    expect(tick1.packaged!.reused).toBe(false);
    expect(m.logs).toHaveLength(1);

    const experimentId = tick1.packaged!.experimentId;
    const created = await experimentStore.read(principal, experimentId);
    expect(created.status).toBe("running");
    expect(created.changeAxis).toBe("agent-prompt");

    // Re-run against the exact same evidence: the same proposal is produced
    // again, but it is already in flight -- nothing new is packaged.
    const tick2 = await runExperimentCadenceTick(deps);
    expect(tick2.errors).toEqual([]);
    expect(tick2.refusals).toEqual([]);
    expect(tick2.proposalsConsidered).toBe(1);
    expect(tick2.skippedInFlight).toHaveLength(1);
    expect(tick2.packaged).toBeNull();
    expect(m.logs).toHaveLength(2);

    const stillOne = await experimentStore.read(principal, experimentId);
    expect(stillOne.revision).toBe(1);
  });

  it("dry-run reports the would-be package and mutates nothing", async () => {
    const m = munin();
    const registry = new LearningRegistryStore(m);
    const experimentStore = new LearningExperimentStore(m);
    const candidates = await seedOneAxisPopulation(registry);
    const principal = "service:test-cadence-dry-run";
    const deps = baseDeps(m, registry, experimentStore, principal, candidates);

    const dryTick = await runExperimentCadenceTick(deps, { dryRun: true });
    expect(dryTick.dryRun).toBe(true);
    expect(dryTick.packaged).not.toBeNull();
    expect(dryTick.packaged!.wouldPackage).toBe(true);
    expect(dryTick.errors).toEqual([]);
    expect(m.logs).toEqual([]);

    // Nothing was actually created under the previewed id.
    await expect(experimentStore.read(principal, dryTick.packaged!.experimentId)).rejects.toThrow();

    // A real tick afterwards behaves as if the dry run never happened.
    const realTick = await runExperimentCadenceTick(deps);
    expect(realTick.packaged).not.toBeNull();
    expect(realTick.packaged!.reused).toBe(false);
    expect(realTick.packaged!.experimentId).toBe(dryTick.packaged!.experimentId);
  });

  it("surfaces a multi-axis population decline from the #234 proposer and packages nothing", async () => {
    const m = munin();
    const registry = new LearningRegistryStore(m);
    const experimentStore = new LearningExperimentStore(m);
    const champion = await seedArm(registry, {
      taskType: "code-edit", arm: "champion", axis: "agent-prompt", idPrefix: "champ",
      count: 3, ratings: ["partial"], startIso: "2026-07-01T00:00:00.000Z",
    });
    const challengerBase = await seedArm(registry, {
      taskType: "code-edit", arm: "challenger", axis: "agent-prompt", idPrefix: "chall",
      count: 3, ratings: ["pass"], startIso: "2026-07-05T00:00:00.000Z",
    });
    // Contaminate the challenger arm so its harness ALSO differs, not just
    // the prompt -- this is the same technique
    // tests/experiment-proposer.test.ts uses to prove one-axis discipline.
    const contaminatedHarnessDigest = hash("contaminated-harness");
    const challenger = challengerBase.map((c) => {
      const configuration = {
        ...c.configuration,
        harness: { ...c.configuration.harness, version: "9", configSha256: contaminatedHarnessDigest },
      };
      configuration.fingerprint = computeConfigurationFingerprint(configuration);
      return { ...c, configuration };
    });
    const candidates = [...champion, ...challenger];
    const principal = "service:test-cadence-multiaxis";
    const deps = baseDeps(m, registry, experimentStore, principal, candidates);

    const tick = await runExperimentCadenceTick(deps);
    expect(tick.errors).toEqual([]);
    expect(tick.refusals).toEqual([]);
    expect(tick.proposalsConsidered).toBe(0);
    expect(tick.packaged).toBeNull();
    expect(tick.proposalDeclines).toContainEqual(
      expect.objectContaining({ code: "multi-axis-delta", taskType: "code-edit" }),
    );
  });

  it("a running experiment below target is observed, not concluded; a proposer failure does not abort the tick", async () => {
    const m = munin();
    const registry = new LearningRegistryStore(m);
    const experimentStore = new LearningExperimentStore(m);
    const candidates = await seedOneAxisPopulation(registry);
    const principal = "service:test-cadence-observe";
    const deps = baseDeps(m, registry, experimentStore, principal, candidates);

    const tick1 = await runExperimentCadenceTick(deps);
    const experimentId = tick1.packaged!.experimentId;
    await observePairs(experimentStore, principal, experimentId, 2);

    const brokenRegistry: Pick<LearningRegistryStore, "listEventsForTask"> = {
      listEventsForTask: async () => {
        throw new Error("registry unavailable (simulated)");
      },
    };
    const brokenDeps: ExperimentCadenceDeps = { ...deps, registry: brokenRegistry as LearningRegistryStore };

    const tick2 = await runExperimentCadenceTick(brokenDeps);
    expect(tick2.errors).toContainEqual(expect.objectContaining({ stage: "propose" }));
    expect(tick2.packaged).toBeNull();
    // The propose-stage failure does not stop the tick from observing the
    // already-tracked experiment.
    expect(tick2.observed).toContainEqual(
      expect.objectContaining({ experimentId, status: "running", matchedPairs: 2 }),
    );
    expect(tick2.concluded).toEqual([]);
  });

  it("reaching the frozen sample target concludes exactly once: one summary, idempotent on re-tick", async () => {
    const m = munin();
    const registry = new LearningRegistryStore(m);
    const experimentStore = new LearningExperimentStore(m);
    const candidates = await seedOneAxisPopulation(registry);
    const principal = "service:test-cadence-conclude";
    const deps = baseDeps(m, registry, experimentStore, principal, candidates);

    const tick1 = await runExperimentCadenceTick(deps);
    const experimentId = tick1.packaged!.experimentId;
    await observePairs(experimentStore, principal, experimentId, 6);

    const concludedState = await experimentStore.read(principal, experimentId);
    expect(concludedState.status).toBe("promotion-ready");
    expect(concludedState.evaluation.matchedPairs).toBe(6);
    expect(concludedState.evaluation.holdoutPairs).toBe(2);

    const tick2 = await runExperimentCadenceTick(deps);
    expect(tick2.errors).toEqual([]);
    expect(tick2.observed).toContainEqual(
      expect.objectContaining({ experimentId, status: "promotion-ready", matchedPairs: 6 }),
    );
    expect(tick2.concluded).toEqual([
      expect.objectContaining({
        experimentId,
        alreadyConcluded: false,
        summaryWritten: true,
        exportStatus: "skipped",
      }),
    ]);

    // Re-run: the reviewable summary already exists -- concluding is a no-op.
    const tick3 = await runExperimentCadenceTick(deps);
    expect(tick3.concluded).toEqual([
      expect.objectContaining({ experimentId, alreadyConcluded: true, summaryWritten: false }),
    ]);
  });

  it("always names the gille-side quarantine visibility limitation rather than inventing a channel", async () => {
    const m = munin();
    const registry = new LearningRegistryStore(m);
    const experimentStore = new LearningExperimentStore(m);
    const principal = "service:test-cadence-limitations";
    const deps = baseDeps(m, registry, experimentStore, principal, []);

    const tick = await runExperimentCadenceTick(deps);
    expect(tick.limitations).toContainEqual(expect.stringContaining("quarantine"));
    expect(tick.candidatesLoaded).toBe(0);
    expect(tick.packaged).toBeNull();
  });
});
