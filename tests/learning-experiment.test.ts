import { describe, expect, it } from "vitest";
import type { MuninClient, MuninEntry } from "../src/munin-client.js";
import { evaluateLearningExperiment } from "../src/learning/experiment-evaluator.js";
import {
  computeConfigurationFingerprint,
  learningExperimentCreateSchema,
  type RecordedLearningObservation,
} from "../src/learning/experiment-schema.js";
import {
  LearningExperimentStore,
  LearningStoreError,
} from "../src/learning/experiment-store.js";
import {
  makeExperimentInput,
  makeLearningConfig,
  makeObservation,
} from "./fixtures/learning.js";

function recorded(
  input: ReturnType<typeof makeObservation>,
): RecordedLearningObservation {
  return { ...input, recorded_at: "2026-07-13T12:00:00.000Z", recorded_by: "codex" };
}

describe("learning experiment schema", () => {
  it("accepts a single declared change axis", () => {
    expect(makeExperimentInput().change_axis).toBe("agent-harness");
  });

  it("rejects a challenger that changes more than the declared axis", () => {
    const challenger = makeLearningConfig("challenger", "agent-harness");
    challenger.model.config.temperature = 0.8;
    const parsed = learningExperimentCreateSchema.safeParse({
      ...makeExperimentInput(),
      challenger,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toMatch(/exactly one declared axis/);
  });

  it("rejects a stale top-level fingerprint after configuration changes", () => {
    const config = makeLearningConfig("challenger", "agent-harness");
    config.harness.maxTurns = 99;
    expect(learningExperimentCreateSchema.safeParse({
      ...makeExperimentInput(),
      challenger: config,
    }).success).toBe(false);
  });
});

describe("evaluateLearningExperiment", () => {
  it("stays in gathering until matched, independently verified holdout evidence exists", () => {
    const input = makeExperimentInput();
    const evaluation = evaluateLearningExperiment({
      observations: [recorded(makeObservation("case-1", "champion"))],
      gates: input.gates,
      now: () => new Date("2026-07-13T12:00:00.000Z"),
    });
    expect(evaluation.decision).toBe("gathering");
    expect(evaluation.matchedPairs).toBe(0);
    expect(evaluation.missingRequirements.join(" ")).toMatch(/matched pair/);
  });

  it("marks a faster non-regressing challenger promotion-ready", () => {
    const input = makeExperimentInput();
    const observations = ["case-1", "case-2"].flatMap((sample) => [
      recorded(makeObservation(sample, "champion")),
      recorded(makeObservation(sample, "challenger")),
    ]);
    const evaluation = evaluateLearningExperiment({ observations, gates: input.gates });
    expect(evaluation.decision).toBe("promotion-ready");
    expect(evaluation.primaryImprovement).toBeCloseTo(1 / 3);
    expect(evaluation.guardFailures).toEqual([]);
  });

  it("fails attribution closed when predeclared challenger agent-check coverage is missing", () => {
    const input = makeExperimentInput({
      gates: {
        ...makeExperimentInput().gates,
        minChallengerAgentCheckCoverage: 1,
      },
    });
    const observedCheck = (sample: string) => ({
      work_id: `work-${sample}`,
      agent_checks: {
        schema_version: 3 as const,
        source: "pi-bash-events" as const,
        state: "attempted" as const,
        unparseable_lines: 0,
        coverage_loss_events: 0,
        work_id: `work-${sample}`,
        attempts: [{
          order: 1,
          kind: "test" as const,
          command_fingerprint: `sha256:${"a".repeat(64)}`,
          started_ms: 10,
          ended_ms: 20,
          status: "passed" as const,
          exit_code: null,
        }],
      },
    });
    const observations = ["case-1", "case-2"].flatMap((sample) => [
      recorded(makeObservation(sample, "champion")),
      recorded(makeObservation(sample, "challenger", sample === "case-1"
        ? observedCheck(sample)
        : {
            work_id: `work-${sample}`,
            agent_checks: {
              schema_version: 3,
              source: "pi-bash-events",
              state: "attempted",
              unparseable_lines: 0,
              coverage_loss_events: 0,
              work_id: `work-${sample}`,
              attempts: [{
                order: 1,
                kind: "test",
                command_fingerprint: `sha256:${"b".repeat(64)}`,
                started_ms: 10,
                ended_ms: 20,
                status: "execution-error",
                exit_code: null,
              }],
            },
          })),
    ]);
    const gathering = evaluateLearningExperiment({ observations, gates: input.gates });
    expect(gathering.decision).toBe("gathering");
    expect(gathering.challenger.agentCheckCoverage).toBe(0.5);
    expect(gathering.missingRequirements.join(" ")).toMatch(/agent-check coverage/);
    expect(gathering.failureSignals).toContainEqual({ signal: "agent-check-execution-error", count: 1 });

    const complete = observations.map((observation) =>
      observation.arm === "challenger" && observation.sample_id === "case-2"
        ? recorded(makeObservation("case-2", "challenger", observedCheck("case-2")))
        : observation
    );
    expect(evaluateLearningExperiment({ observations: complete, gates: input.gates }).decision)
      .toBe("promotion-ready");
  });

  it("rejects a faster challenger when correctness regresses", () => {
    const input = makeExperimentInput();
    const observations = ["case-1", "case-2"].flatMap((sample) => [
      recorded(makeObservation(sample, "champion")),
      recorded(makeObservation(sample, "challenger", {
        quality_outcome: sample === "case-1" ? "fail" : "pass",
        product_outcome: sample === "case-1" ? "discarded" : "accepted-unchanged",
        failure_kind: sample === "case-1" ? "tests-failed" : undefined,
      })),
    ]);
    const evaluation = evaluateLearningExperiment({ observations, gates: input.gates });
    expect(evaluation.decision).toBe("reject");
    expect(evaluation.guardFailures.join(" ")).toMatch(/quality regression/);
    expect(evaluation.failureSignals[0]).toMatchObject({ signal: "tests-failed" });
  });

  it("accepts an exact decimal rate improvement at the configured threshold", () => {
    const input = makeExperimentInput({
      gates: {
        ...makeExperimentInput().gates,
        minMatchedPairs: 10,
        primaryMetric: "quality-rate",
        minPrimaryImprovement: 0.1,
      },
    });
    const observations = Array.from({ length: 10 }, (_, index) => {
      const sample = `case-${index + 1}`;
      return [
        recorded(makeObservation(sample, "champion", index === 0 ? {
          quality_outcome: "fail",
          product_outcome: "discarded",
          failure_kind: "protected-check-failed",
        } : {})),
        recorded(makeObservation(sample, "challenger")),
      ];
    }).flat();

    const evaluation = evaluateLearningExperiment({ observations, gates: input.gates });
    expect(evaluation.primaryImprovement).toBeCloseTo(0.1, 15);
    expect(evaluation.decision).toBe("promotion-ready");
  });

  it("still rejects a decimal rate improvement materially below the threshold", () => {
    const input = makeExperimentInput({
      gates: {
        ...makeExperimentInput().gates,
        minMatchedPairs: 10,
        primaryMetric: "quality-rate",
        minPrimaryImprovement: 0.100_001,
      },
    });
    const observations = Array.from({ length: 10 }, (_, index) => {
      const sample = `case-${index + 1}`;
      return [
        recorded(makeObservation(sample, "champion", index === 0 ? {
          quality_outcome: "fail",
          product_outcome: "discarded",
          failure_kind: "protected-check-failed",
        } : {})),
        recorded(makeObservation(sample, "challenger")),
      ];
    }).flat();

    const evaluation = evaluateLearningExperiment({ observations, gates: input.gates });
    expect(evaluation.decision).toBe("reject");
  });

  it("does not count a judge-only verdict as verified quality evidence", () => {
    const input = makeExperimentInput();
    const observations = ["case-1", "case-2"].flatMap((sample) => [
      recorded(makeObservation(sample, "champion", {
        verifier: { kind: "judge", independent: true },
      })),
      recorded(makeObservation(sample, "challenger", {
        verifier: { kind: "judge", independent: true },
      })),
    ]);
    const evaluation = evaluateLearningExperiment({ observations, gates: input.gates });
    expect(evaluation.decision).toBe("gathering");
    expect(evaluation.champion.verifiedSamples).toBe(0);
    expect(evaluation.missingRequirements.join(" ")).toMatch(/verified coverage/);
  });

  it("requires scalar primary measurements from the same matched samples", () => {
    const input = makeExperimentInput();
    const observations = [
      recorded(makeObservation("case-1", "champion", { edit_start_ms: 50_000 })),
      recorded(makeObservation("case-1", "challenger", { edit_start_ms: undefined })),
      recorded(makeObservation("case-2", "champion", { edit_start_ms: undefined })),
      recorded(makeObservation("case-2", "challenger", { edit_start_ms: 30_000 })),
    ];
    const evaluation = evaluateLearningExperiment({ observations, gates: input.gates });
    expect(evaluation.decision).toBe("gathering");
    expect(evaluation.primaryChampion).toBeNull();
    expect(evaluation.primaryChallenger).toBeNull();
    expect(evaluation.missingRequirements.join(" ")).toMatch(/paired measurement/);
  });
});

class FakeMunin {
  entries = new Map<string, MuninEntry & { found: true }>();
  revision = 0;

  async read(namespace: string, key: string) {
    return this.entries.get(`${namespace}/${key}`) ?? null;
  }

  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
  ): Promise<Record<string, unknown>> {
    const id = `${namespace}/${key}`;
    const existing = this.entries.get(id);
    if (expectedUpdatedAt && existing?.updated_at !== expectedUpdatedAt) {
      throw new Error("CAS conflict");
    }
    const now = `2026-07-13T12:00:${String(++this.revision).padStart(2, "0")}.000Z`;
    this.entries.set(id, {
      id,
      namespace,
      key,
      content,
      tags: tags ?? [],
      classification,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      found: true,
    });
    return { ok: true };
  }
}

describe("LearningExperimentStore", () => {
  it("persists observations idempotently and closes a winning experiment", async () => {
    const munin = new FakeMunin();
    let tick = 0;
    const store = new LearningExperimentStore(munin as unknown as MuninClient, {
      now: () => new Date(1_720_872_000_000 + tick++ * 1_000),
    });
    const created = await store.create("codex", makeExperimentInput());
    expect(created.reused).toBe(false);
    expect(created.state.status).toBe("running");

    for (const sample of ["case-1", "case-2"]) {
      await store.observe("codex", makeObservation(sample, "champion"));
      await store.observe("codex", makeObservation(sample, "challenger"));
    }
    const state = await store.read("codex", "wave-six-edit-deadline");
    expect(state.status).toBe("promotion-ready");
    expect(state.evaluation.decision).toBe("promotion-ready");
    expect(state.observations).toHaveLength(4);

    await expect(
      store.observe("codex", makeObservation("case-3", "challenger")),
    ).rejects.toMatchObject({ code: "invalid-state" });

    const promoted = await store.promote("codex", {
      experiment_id: "wave-six-edit-deadline",
      configuration_fingerprint: created.state.challenger.fingerprint,
      applied_ref: "gille-inference@abc123",
    });
    expect(promoted.state.status).toBe("promoted");
    expect(promoted.champion.configuration.fingerprint).toBe(
      created.state.challenger.fingerprint,
    );
    expect((await store.promote("codex", {
      experiment_id: "wave-six-edit-deadline",
      configuration_fingerprint: created.state.challenger.fingerprint,
      applied_ref: "gille-inference@abc123",
    })).reused).toBe(true);
  });

  it("refuses promotion-ready evidence with no explicit accepted product outcome", async () => {
    const munin = new FakeMunin();
    const store = new LearningExperimentStore(munin as unknown as MuninClient);
    const input = makeExperimentInput({
      experiment_id: "mechanical-only",
      gates: {
        ...makeExperimentInput().gates,
        minRatedCoverage: 0,
      },
    });
    const created = await store.create("codex", input);
    for (const sample of ["case-1", "case-2"]) {
      await store.observe("codex", makeObservation(sample, "champion", {
        experiment_id: "mechanical-only",
        product_outcome: "unrated",
      }));
      await store.observe("codex", makeObservation(sample, "challenger", {
        experiment_id: "mechanical-only",
        product_outcome: "unrated",
      }));
    }
    expect((await store.read("codex", "mechanical-only")).status).toBe("promotion-ready");

    await expect(store.promote("codex", {
      experiment_id: "mechanical-only",
      configuration_fingerprint: created.state.challenger.fingerprint,
      applied_ref: "gille-inference@abc123",
    })).rejects.toMatchObject({ code: "invalid-state" });
  });

  it("reuses an identical run_id but rejects conflicting evidence", async () => {
    const store = new LearningExperimentStore(new FakeMunin() as unknown as MuninClient);
    await store.create("codex", makeExperimentInput());
    const observation = makeObservation("case-1", "champion");
    expect((await store.observe("codex", observation)).reused).toBe(false);
    expect((await store.observe("codex", observation)).reused).toBe(true);
    await expect(
      store.observe("codex", { ...observation, latency_ms: 999 }),
    ).rejects.toBeInstanceOf(LearningStoreError);
  });

  it("enriches an unrated observation exactly once without weakening idempotency", async () => {
    const store = new LearningExperimentStore(new FakeMunin() as unknown as MuninClient, {
      now: () => new Date("2026-07-13T12:00:00.000Z"),
    });
    await store.create("codex", makeExperimentInput());
    const observation = makeObservation("case-1", "champion", {
      product_outcome: "unrated",
      human_review_seconds: undefined,
    });
    await store.observe("codex", observation);

    const rated = await store.rate("codex", {
      experiment_id: observation.experiment_id,
      run_id: observation.run_id,
      product_outcome: "minor-edit",
      human_review_seconds: 42,
    });
    expect(rated.reused).toBe(false);
    expect(rated.state.observations[0]).toMatchObject({
      product_outcome: "minor-edit",
      human_review_seconds: 42,
      product_rated_by: "codex",
    });

    expect((await store.rate("codex", {
      experiment_id: observation.experiment_id,
      run_id: observation.run_id,
      product_outcome: "minor-edit",
      human_review_seconds: 42,
    })).reused).toBe(true);
    await expect(store.rate("codex", {
      experiment_id: observation.experiment_id,
      run_id: observation.run_id,
      product_outcome: "discarded",
      human_review_seconds: 42,
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects rating an unknown run", async () => {
    const store = new LearningExperimentStore(new FakeMunin() as unknown as MuninClient);
    await store.create("codex", makeExperimentInput());
    await expect(store.rate("codex", {
      experiment_id: "wave-six-edit-deadline",
      run_id: "missing",
      product_outcome: "accepted-unchanged",
    })).rejects.toMatchObject({ code: "not-found" });
  });

  it("rejects evidence produced by a configuration outside the experiment contract", async () => {
    const store = new LearningExperimentStore(new FakeMunin() as unknown as MuninClient);
    await store.create("codex", makeExperimentInput());
    await expect(
      store.observe("codex", {
        ...makeObservation("case-1", "challenger"),
        configuration_fingerprint: "f".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("requires the next iteration to start from the promoted scope champion", async () => {
    const store = new LearningExperimentStore(new FakeMunin() as unknown as MuninClient);
    const first = makeExperimentInput();
    await store.create("codex", first);
    for (const sample of ["case-1", "case-2"]) {
      await store.observe("codex", makeObservation(sample, "champion"));
      await store.observe("codex", makeObservation(sample, "challenger"));
    }
    await store.promote("codex", {
      experiment_id: first.experiment_id,
      configuration_fingerprint: first.challenger.fingerprint,
      applied_ref: "gille-inference@abc123",
    });

    await expect(
      store.create("codex", makeExperimentInput({ experiment_id: "obsolete-baseline" })),
    ).rejects.toMatchObject({ code: "conflict" });

    const nextChallenger = structuredClone(first.challenger);
    nextChallenger.fingerprint = "3".repeat(64);
    nextChallenger.harness = {
      ...nextChallenger.harness,
      version: "3",
      configSha256: "3".repeat(64),
      editDeadlineTurn: 5,
    };
    nextChallenger.fingerprint = computeConfigurationFingerprint(nextChallenger);
    const next = makeExperimentInput({
      experiment_id: "wave-seven-earlier-edit",
      champion: first.challenger,
      challenger: nextChallenger,
    });
    expect((await store.create("codex", next)).state.status).toBe("running");
  });
});
