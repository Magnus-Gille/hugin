import { describe, expect, it, vi } from "vitest";
import { BrokerNetworkError } from "../src/mcp/broker-client.js";
import { observeDurably } from "../src/learning/durable-observation.js";
import type { RecordedLearningObservation } from "../src/learning/experiment-schema.js";
import { makeExperimentInput, makeObservation } from "./fixtures/learning.js";

function stateWith(observations: RecordedLearningObservation[]) {
  const experiment = makeExperimentInput();
  return {
    state: {
      schemaVersion: 1,
      experimentId: experiment.experiment_id,
      scope: experiment.scope,
      taskType: experiment.task_type,
      ownerPrincipal: "codex",
      hypothesis: experiment.hypothesis,
      changeAxis: experiment.change_axis,
      champion: experiment.champion,
      challenger: experiment.challenger,
      gates: experiment.gates,
      status: "running",
      revision: 1,
      createdAt: "2026-07-13T12:00:00.000Z",
      updatedAt: "2026-07-13T12:00:00.000Z",
      observations,
      evaluation: {
        decision: "gathering",
        reason: "waiting",
        evaluatedAt: "2026-07-13T12:00:00.000Z",
        matchedPairs: 0,
        holdoutPairs: 0,
        unmatchedObservations: observations.length,
        champion: {
          samples: 0, verifiedSamples: 0, verifiedCoverage: 0,
          qualityRate: null, ratedSamples: 0, ratedCoverage: 0,
          usefulRate: null, rescueRate: null, infraRate: 0,
          latencyMeanMs: null, costMeanUsd: null,
          humanReviewMeanSeconds: null, editStartMeanMs: null,
          observabilityCoverageMean: null, verifierScoreMean: null,
        },
        challenger: {
          samples: 0, verifiedSamples: 0, verifiedCoverage: 0,
          qualityRate: null, ratedSamples: 0, ratedCoverage: 0,
          usefulRate: null, rescueRate: null, infraRate: 0,
          latencyMeanMs: null, costMeanUsd: null,
          humanReviewMeanSeconds: null, editStartMeanMs: null,
          observabilityCoverageMean: null, verifierScoreMean: null,
        },
        primaryMetric: experiment.gates.primaryMetric,
        primaryChampion: null,
        primaryChallenger: null,
        primaryImprovement: null,
        guardFailures: [],
        missingRequirements: ["waiting"],
        failureSignals: [],
        nextAction: "wait",
      },
    },
  };
}

function recordedObservation() {
  return {
    ...makeObservation("case-1", "champion"),
    recorded_at: "2026-07-13T12:00:00.000Z",
    recorded_by: "codex",
  };
}

describe("observeDurably", () => {
  it("returns after the first acknowledged write", async () => {
    const broker = {
      experimentObserve: vi.fn(async () => ({})),
      experimentStatus: vi.fn(async () => stateWith([])),
    };
    await expect(observeDurably(broker, makeObservation("case-1", "champion")))
      .resolves.toEqual({ attempts: 1, reconciled: false });
    expect(broker.experimentStatus).not.toHaveBeenCalled();
  });

  it("reconciles a write whose response was lost", async () => {
    const observation = {
      ...makeObservation("case-1", "champion"),
      task_id: undefined,
    };
    const broker = {
      experimentObserve: vi.fn(async () => {
        throw new BrokerNetworkError("response timed out");
      }),
      experimentStatus: vi.fn(async () => stateWith([recordedObservation()])),
    };
    await expect(observeDurably(broker, observation))
      .resolves.toEqual({ attempts: 1, reconciled: true });
    expect(broker.experimentObserve).toHaveBeenCalledTimes(1);
  });

  it("retries the identical evidence when reconciliation proves it absent", async () => {
    const broker = {
      experimentObserve: vi.fn()
        .mockRejectedValueOnce(new BrokerNetworkError("request failed"))
        .mockResolvedValueOnce({}),
      experimentStatus: vi.fn(async () => stateWith([])),
    };
    await expect(observeDurably(
      broker,
      makeObservation("case-1", "champion"),
      { retryDelayMs: 0, sleep: async () => undefined },
    )).resolves.toEqual({ attempts: 2, reconciled: false });
    expect(broker.experimentObserve).toHaveBeenCalledTimes(2);
  });

  it("never hides a conflicting durable observation", async () => {
    const expected = makeObservation("case-1", "champion");
    const conflicting = { ...recordedObservation(), latency_ms: 999 };
    const broker = {
      experimentObserve: vi.fn(async () => {
        throw new BrokerNetworkError("response timed out");
      }),
      experimentStatus: vi.fn(async () => stateWith([conflicting])),
    };
    await expect(observeDurably(broker, expected)).rejects.toThrow(/different evidence/);
  });
});
