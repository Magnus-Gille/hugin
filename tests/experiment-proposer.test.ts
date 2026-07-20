import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MuninWriteRejectedError, type MuninClient, type MuninQueryResult } from "../src/munin-client.js";
import { LearningRegistryStore } from "../src/learning-registry-store.js";
import { buildTaskLifecycleTimeline, type TaskLifecycleTimeline } from "../src/learning-registry-view.js";
import { computeConfigurationFingerprint } from "../src/learning/experiment-schema.js";
import { packageExperimentCandidates } from "../src/learning/candidate-packager.js";
import { buildQualityReceipt, type QualityReceipt } from "../src/quality-receipt.js";
import {
  proposeExperiments,
  proposeExperimentsFromRegistry,
  proposalToPackageRequest,
  type ProposeRequest,
} from "../src/learning/experiment-proposer.js";
import type { PackagerCandidateInput } from "../src/learning/candidate-packager-schema.js";
import { makeLearningConfig } from "./fixtures/learning.js";

// ---------------------------------------------------------------------------
// In-memory Munin double -- same create-if-absent / CAS contract as the real
// service, copied from tests/candidate-packager.test.ts's own copy of the
// tests/learning-registry-store.test.ts fixture.
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

/**
 * Register `count` qualified attempts of `taskType` for one config arm and
 * return their proposer candidate inputs. `ratings` (cycled if shorter than
 * `count`) drives the population's quality signal; `ratedAt` timestamps step
 * forward one day apart starting at `startIso` so recency ordering is
 * deterministic and distinct from the other arm's timestamps.
 */
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
): Promise<{ candidates: PackagerCandidateInput[]; timelines: Map<string, TaskLifecycleTimeline> }> {
  const candidates: PackagerCandidateInput[] = [];
  const timelines = new Map<string, TaskLifecycleTimeline>();
  const configuration = makeLearningConfig(input.arm, input.axis);
  for (let i = 0; i < input.count; i += 1) {
    const taskId = `${input.idPrefix}-${i}`;
    const attemptId = `${input.idPrefix}-attempt-${i}`;
    const occurredAt = new Date(Date.parse(input.startIso) + i * 86_400_000).toISOString();
    await registerQualifiedAttempt(store, { taskId, attemptId, occurredAt });
    timelines.set(taskId, await buildTaskLifecycleTimeline(store, taskId));
    const rating = input.ratings[i % input.ratings.length]!;
    candidates.push({
      taskId,
      attemptId,
      taskType: input.taskType as PackagerCandidateInput["taskType"],
      configuration,
      qualityReceipt: receiptFor(taskId, rating, occurredAt),
    });
  }
  return { candidates, timelines };
}

function mergeSeeds(...seeds: Array<{ candidates: PackagerCandidateInput[]; timelines: Map<string, TaskLifecycleTimeline> }>) {
  const candidates = seeds.flatMap((seed) => seed.candidates);
  const timelines = new Map<string, TaskLifecycleTimeline>();
  for (const seed of seeds) {
    for (const [taskId, timeline] of seed.timelines) timelines.set(taskId, timeline);
  }
  return { candidates, timelines };
}

describe("proposeExperiments", () => {
  it("proposes a valid one-axis experiment from a seeded two-config population", async () => {
    const store = new LearningRegistryStore(munin());
    const champion = await seedArm(store, {
      taskType: "code-edit", arm: "champion", axis: "agent-prompt", idPrefix: "champ",
      count: 4, ratings: ["partial", "redo", "partial", "wrong"], startIso: "2026-07-01T00:00:00.000Z",
    });
    const challenger = await seedArm(store, {
      taskType: "code-edit", arm: "challenger", axis: "agent-prompt", idPrefix: "chall",
      count: 4, ratings: ["pass", "pass", "pass", "partial"], startIso: "2026-07-05T00:00:00.000Z",
    });
    const { candidates, timelines } = mergeSeeds(champion, challenger);

    const outcome = proposeExperiments(candidates, timelines, {
      now: () => "2026-07-10T00:00:00.000Z",
    });

    expect(outcome.status).toBe("proposed");
    expect(outcome.rejectedCandidates).toEqual([]);
    expect(outcome.proposals).toHaveLength(1);
    const proposal = outcome.proposals[0]!;
    expect(proposal.taskType).toBe("code-edit");
    expect(proposal.changeAxis).toBe("agent-prompt");
    // Champion evidence started earlier (2026-07-01) than challenger (2026-07-05).
    expect(proposal.championFingerprint).toBe(makeLearningConfig("champion", "agent-prompt").fingerprint);
    expect(proposal.challengerFingerprint).toBe(makeLearningConfig("challenger", "agent-prompt").fingerprint);
    expect(proposal.evidence.championQualityRate).toBe(0);
    expect(proposal.evidence.challengerQualityRate).toBeCloseTo(0.75, 5);
    expect(proposal.evidence.qualityRateDelta).toBeCloseTo(0.75, 5);
    expect(proposal.rank.effectSize).toBeCloseTo(0.75, 5);
    expect(proposal.rank.sampleSize).toBe(4);
    expect(proposal.matchedTasks).toHaveLength(8);
    expect(proposal.matchedTasks.filter((t) => t.arm === "champion")).toHaveLength(4);
    expect(proposal.matchedTasks.filter((t) => t.arm === "challenger")).toHaveLength(4);
    expect(proposal.proposalId).toMatch(/^prop-[a-f0-9]{64}$/);
    expect(proposal.suggestedScope).toBe("proposed-code-edit-agent-prompt");
  });

  it("refuses (declines) a population whose two configurations differ on more than one axis", async () => {
    const store = new LearningRegistryStore(munin());
    const champion = await seedArm(store, {
      taskType: "code-edit", arm: "champion", axis: "agent-prompt", idPrefix: "champ",
      count: 3, ratings: ["partial"], startIso: "2026-07-01T00:00:00.000Z",
    });
    const challengerBase = await seedArm(store, {
      taskType: "code-edit", arm: "challenger", axis: "agent-prompt", idPrefix: "chall",
      count: 3, ratings: ["pass"], startIso: "2026-07-05T00:00:00.000Z",
    });
    // Contaminate the challenger arm so its harness ALSO differs, not just the prompt.
    const contaminatedHarnessDigest = hash("contaminated-harness");
    const challenger = {
      ...challengerBase,
      candidates: challengerBase.candidates.map((c) => {
        const configuration = {
          ...c.configuration,
          harness: { ...c.configuration.harness, version: "9", configSha256: contaminatedHarnessDigest },
        };
        configuration.fingerprint = computeConfigurationFingerprint(configuration);
        return { ...c, configuration };
      }),
    };
    const { candidates, timelines } = mergeSeeds(champion, challenger);

    const outcome = proposeExperiments(candidates, timelines, { now: () => "2026-07-10T00:00:00.000Z" });

    expect(outcome.status).toBe("no-proposals");
    expect(outcome.proposals).toEqual([]);
    expect(outcome.declinedPopulations).toContainEqual(
      expect.objectContaining({
        code: "multi-axis-delta",
        taskType: "code-edit",
        changedAxes: expect.arrayContaining(["agent-prompt", "agent-harness"]),
      }),
    );
  });

  it("refuses (declines) a population with fewer than the required samples in one arm", async () => {
    const store = new LearningRegistryStore(munin());
    const champion = await seedArm(store, {
      taskType: "code-edit", arm: "champion", axis: "agent-prompt", idPrefix: "champ",
      count: 3, ratings: ["partial"], startIso: "2026-07-01T00:00:00.000Z",
    });
    const challenger = await seedArm(store, {
      taskType: "code-edit", arm: "challenger", axis: "agent-prompt", idPrefix: "chall",
      count: 2, ratings: ["pass"], startIso: "2026-07-05T00:00:00.000Z",
    });
    const { candidates, timelines } = mergeSeeds(champion, challenger);

    const outcome = proposeExperiments(candidates, timelines, {
      now: () => "2026-07-10T00:00:00.000Z", minSamplesPerArm: 3,
    });

    expect(outcome.status).toBe("no-proposals");
    expect(outcome.declinedPopulations).toContainEqual({
      code: "insufficient-samples",
      taskType: "code-edit",
      axis: "agent-prompt",
      arm: "challenger",
      count: 2,
      required: 3,
      championFingerprint: makeLearningConfig("champion", "agent-prompt").fingerprint,
      challengerFingerprint: makeLearningConfig("challenger", "agent-prompt").fingerprint,
    });
  });

  it("refuses (declines) a task type with only a single observed configuration", async () => {
    const store = new LearningRegistryStore(munin());
    const champion = await seedArm(store, {
      taskType: "code-edit", arm: "champion", axis: "agent-prompt", idPrefix: "champ",
      count: 5, ratings: ["pass", "partial"], startIso: "2026-07-01T00:00:00.000Z",
    });

    const outcome = proposeExperiments(champion.candidates, champion.timelines, {
      now: () => "2026-07-10T00:00:00.000Z",
    });

    expect(outcome.status).toBe("no-proposals");
    expect(outcome.declinedPopulations).toContainEqual({
      code: "single-configuration",
      taskType: "code-edit",
      distinctConfigurations: 1,
    });
  });

  it("declines a population whose quality-rate delta does not clear the configured threshold", async () => {
    const store = new LearningRegistryStore(munin());
    const champion = await seedArm(store, {
      taskType: "code-edit", arm: "champion", axis: "agent-prompt", idPrefix: "champ",
      count: 4, ratings: ["pass", "pass", "pass", "partial"], startIso: "2026-07-01T00:00:00.000Z",
    });
    const challenger = await seedArm(store, {
      taskType: "code-edit", arm: "challenger", axis: "agent-prompt", idPrefix: "chall",
      count: 4, ratings: ["pass", "pass", "pass", "wrong"], startIso: "2026-07-05T00:00:00.000Z",
    });
    const { candidates, timelines } = mergeSeeds(champion, challenger);

    const outcome = proposeExperiments(candidates, timelines, {
      now: () => "2026-07-10T00:00:00.000Z", minQualityRateDelta: 0.5,
    });

    expect(outcome.status).toBe("no-proposals");
    expect(outcome.declinedPopulations).toContainEqual(
      expect.objectContaining({ code: "no-quality-signal-delta", taskType: "code-edit", axis: "agent-prompt" }),
    );
  });

  it("fails closed on contaminated evidence exactly like the packager's qualifyCandidate", async () => {
    const store = new LearningRegistryStore(munin());
    const champion = await seedArm(store, {
      taskType: "code-edit", arm: "champion", axis: "agent-prompt", idPrefix: "champ",
      count: 3, ratings: ["partial"], startIso: "2026-07-01T00:00:00.000Z",
    });
    // A failed (never-completed) attempt on the challenger side.
    await registerQualifiedAttempt(store, {
      taskId: "chall-broken", attemptId: "chall-broken-attempt", occurredAt: "2026-07-05T00:00:00.000Z", outcome: "failed",
    });
    const brokenTimeline = await buildTaskLifecycleTimeline(store, "chall-broken");
    const brokenCandidate: PackagerCandidateInput = {
      taskId: "chall-broken",
      attemptId: "chall-broken-attempt",
      taskType: "code-edit",
      configuration: makeLearningConfig("challenger", "agent-prompt"),
      qualityReceipt: receiptFor("chall-broken", "pass", "2026-07-05T00:00:00.000Z"),
    };

    const outcome = proposeExperiments(
      [...champion.candidates, brokenCandidate],
      new Map([...champion.timelines, ["chall-broken", brokenTimeline]]),
      { now: () => "2026-07-10T00:00:00.000Z" },
    );

    expect(outcome.rejectedCandidates).toContainEqual({
      taskId: "chall-broken",
      attemptId: "chall-broken-attempt",
      reasons: [{ code: "outcome-not-completed", outcome: "failed" }],
    });
    // Only one configuration (champion's) survived qualification -- nothing to compare.
    expect(outcome.status).toBe("no-proposals");
    expect(outcome.declinedPopulations).toContainEqual({
      code: "single-configuration", taskType: "code-edit", distinctConfigurations: 1,
    });
  });

  it("refuses entirely when no candidate survives qualification", async () => {
    const store = new LearningRegistryStore(munin());
    await registerQualifiedAttempt(store, {
      taskId: "t1", attemptId: "a1", occurredAt: "2026-07-01T00:00:00.000Z", outcome: "failed",
    });
    const timeline = await buildTaskLifecycleTimeline(store, "t1");
    const candidate: PackagerCandidateInput = {
      taskId: "t1", attemptId: "a1", taskType: "code-edit",
      configuration: makeLearningConfig("champion", "agent-prompt"),
      qualityReceipt: receiptFor("t1", "pass", "2026-07-01T00:00:00.000Z"),
    };
    const outcome = proposeExperiments([candidate], new Map([["t1", timeline]]), {
      now: () => "2026-07-10T00:00:00.000Z",
    });
    expect(outcome.status).toBe("no-proposals");
    expect(outcome.declinedPopulations).toEqual([{ code: "no-qualified-evidence" }]);
  });

  it("ranks multiple proposal-worthy populations by effect size x sample size x recency, descending", async () => {
    const store = new LearningRegistryStore(munin());
    // code-edit / agent-prompt: large effect (1.0), small samples (3 each), stale (30 days old at "now").
    const editChamp = await seedArm(store, {
      taskType: "code-edit", arm: "champion", axis: "agent-prompt", idPrefix: "edit-champ",
      count: 3, ratings: ["wrong"], startIso: "2026-06-01T00:00:00.000Z",
    });
    const editChall = await seedArm(store, {
      taskType: "code-edit", arm: "challenger", axis: "agent-prompt", idPrefix: "edit-chall",
      count: 3, ratings: ["pass"], startIso: "2026-06-02T00:00:00.000Z",
    });
    // code-review / model: moderate effect (~0.6), large samples (8 each), fresh (recent).
    const reviewChamp = await seedArm(store, {
      taskType: "code-review", arm: "champion", axis: "model", idPrefix: "review-champ",
      count: 8, ratings: ["partial", "partial", "wrong"], startIso: "2026-07-08T00:00:00.000Z",
    });
    const reviewChall = await seedArm(store, {
      taskType: "code-review", arm: "challenger", axis: "model", idPrefix: "review-chall",
      count: 8, ratings: ["pass", "pass", "partial"], startIso: "2026-07-08T00:00:00.000Z",
    });
    const { candidates, timelines } = mergeSeeds(editChamp, editChall, reviewChamp, reviewChall);

    const outcome = proposeExperiments(candidates, timelines, { now: () => "2026-07-10T00:00:00.000Z" });

    expect(outcome.status).toBe("proposed");
    expect(outcome.proposals).toHaveLength(2);
    // Fresh, larger, moderate-effect code-review/model population should outrank
    // the stale, small, large-effect code-edit/agent-prompt population.
    expect(outcome.proposals[0]!.taskType).toBe("code-review");
    expect(outcome.proposals[1]!.taskType).toBe("code-edit");
    expect(outcome.proposals[0]!.rank.score).toBeGreaterThan(outcome.proposals[1]!.rank.score);
    // The list itself is sorted descending by score.
    const scores = outcome.proposals.map((p) => p.rank.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("never leaks raw rating-reason text or other task content into a proposal (content-blindness)", async () => {
    const store = new LearningRegistryStore(munin());
    const champion = await seedArm(store, {
      taskType: "code-edit", arm: "champion", axis: "agent-prompt", idPrefix: "champ",
      count: 3, ratings: ["partial"], startIso: "2026-07-01T00:00:00.000Z",
    });
    const challenger = await seedArm(store, {
      taskType: "code-edit", arm: "challenger", axis: "agent-prompt", idPrefix: "chall",
      count: 3, ratings: ["pass"], startIso: "2026-07-05T00:00:00.000Z",
    });
    const { candidates, timelines } = mergeSeeds(champion, challenger);

    const outcome = proposeExperiments(candidates, timelines, { now: () => "2026-07-10T00:00:00.000Z" });
    expect(outcome.status).toBe("proposed");
    const serialized = JSON.stringify(outcome.proposals);
    expect(serialized).not.toContain("SECRET-RAW-EVIDENCE-TEXT");
    expect(serialized).not.toContain("ratingReason");
  });

  it("is a pure function of its inputs -- proposalId is stable across reruns at a different wall clock", async () => {
    const store = new LearningRegistryStore(munin());
    const champion = await seedArm(store, {
      taskType: "code-edit", arm: "champion", axis: "agent-prompt", idPrefix: "champ",
      count: 3, ratings: ["partial"], startIso: "2026-07-01T00:00:00.000Z",
    });
    const challenger = await seedArm(store, {
      taskType: "code-edit", arm: "challenger", axis: "agent-prompt", idPrefix: "chall",
      count: 3, ratings: ["pass"], startIso: "2026-07-05T00:00:00.000Z",
    });
    const { candidates, timelines } = mergeSeeds(champion, challenger);

    const first = proposeExperiments(candidates, timelines, { now: () => "2026-07-10T00:00:00.000Z" });
    const second = proposeExperiments(candidates, timelines, { now: () => "2026-07-20T00:00:00.000Z" });

    expect(first.proposals[0]!.proposalId).toBe(second.proposals[0]!.proposalId);
    // Recency weight legitimately differs (evaluated 10 days later) even though identity does not.
    expect(first.proposals[0]!.evidence.recencyWeight).not.toBe(second.proposals[0]!.evidence.recencyWeight);
  });
});

describe("proposeExperimentsFromRegistry", () => {
  it("is read-only: fetches timelines from the registry and never mutates it", async () => {
    const store = new LearningRegistryStore(munin());
    const champion = await seedArm(store, {
      taskType: "code-edit", arm: "champion", axis: "agent-prompt", idPrefix: "champ",
      count: 3, ratings: ["partial"], startIso: "2026-07-01T00:00:00.000Z",
    });
    const challenger = await seedArm(store, {
      taskType: "code-edit", arm: "challenger", axis: "agent-prompt", idPrefix: "chall",
      count: 3, ratings: ["pass"], startIso: "2026-07-05T00:00:00.000Z",
    });
    const { candidates } = mergeSeeds(champion, challenger);

    const outcome = await proposeExperimentsFromRegistry(store, candidates, { now: () => "2026-07-10T00:00:00.000Z" });

    expect(outcome.status).toBe("proposed");
    expect(outcome.proposals).toHaveLength(1);
    // A second call against the same, unmodified registry is deterministic.
    const again = await proposeExperimentsFromRegistry(store, candidates, { now: () => "2026-07-10T00:00:00.000Z" });
    expect(again.proposals[0]!.proposalId).toBe(outcome.proposals[0]!.proposalId);
  });
});

describe("proposalToPackageRequest (shape alignment with the #233 packager)", () => {
  it("maps a proposal onto a PackageRequest the packager accepts, and the resolved candidates package successfully", async () => {
    const store = new LearningRegistryStore(munin());
    const champion = await seedArm(store, {
      taskType: "code-edit", arm: "champion", axis: "agent-prompt", idPrefix: "champ",
      count: 3, ratings: ["partial"], startIso: "2026-07-01T00:00:00.000Z",
    });
    const challenger = await seedArm(store, {
      taskType: "code-edit", arm: "challenger", axis: "agent-prompt", idPrefix: "chall",
      count: 3, ratings: ["pass"], startIso: "2026-07-05T00:00:00.000Z",
    });
    const { candidates, timelines } = mergeSeeds(champion, challenger);

    const proposeOutcome = proposeExperiments(candidates, timelines, { now: () => "2026-07-10T00:00:00.000Z" });
    expect(proposeOutcome.status).toBe("proposed");
    const proposal = proposeOutcome.proposals[0]!;

    // The proposer's own default rating floor ("wrong") is deliberately looser than
    // the packager's ("pass"), so a proposal built from partial/wrong-rated evidence
    // must explicitly relax the packager's floor to actually freeze -- exercise that
    // override here rather than papering over it.
    const packageRequest = proposalToPackageRequest(proposal, {
      now: () => "2026-07-11T00:00:00.000Z",
      minCandidatesPerArm: 3,
      minQualityRating: "partial",
    });
    expect(packageRequest.scope).toBe(proposal.suggestedScope);
    expect(packageRequest.changeAxis).toBe(proposal.changeAxis);
    expect(packageRequest.championFingerprint).toBe(proposal.championFingerprint);
    expect(packageRequest.gates.primaryMetric).toBe("quality-rate");
    expect(packageRequest.minCandidatesPerArm).toBe(3);
    expect(packageRequest.minQualityRating).toBe("partial");

    // The proposal's matchedTasks are content-blind references; a caller resolves
    // each one back into a full PackagerCandidateInput from its own durable stores
    // (here, simply looking the original seeded candidate back up by taskId) --
    // exactly the re-fetch-by-id discipline documented on proposalToPackageRequest.
    const byTaskId = new Map(candidates.map((c) => [c.taskId, c]));
    const resolvedCandidates: PackagerCandidateInput[] = proposal.matchedTasks.map((matched) => {
      const resolved = byTaskId.get(matched.taskId);
      if (!resolved) throw new Error(`test setup error: no candidate for ${matched.taskId}`);
      return resolved;
    });

    const packageOutcome = packageExperimentCandidates(resolvedCandidates, timelines, packageRequest);
    expect(packageOutcome.status).toBe("packaged");
    expect(packageOutcome.package!.changeAxis).toBe(proposal.changeAxis);
    expect(packageOutcome.package!.champion.fingerprint).toBe(proposal.championFingerprint);
    expect(packageOutcome.package!.challenger.fingerprint).toBe(proposal.challengerFingerprint);
  });
});
