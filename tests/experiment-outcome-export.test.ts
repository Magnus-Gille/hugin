import { describe, expect, it, vi } from "vitest";
import {
  buildOutcomeExportBundle,
  createGilleOutcomeExportClient,
  experimentOutcomeBundleWireSchema,
  GilleOutcomeExportError,
  resolveExperimentOutcomeExportEndpoint,
  type GilleOutcomeArmEvidence,
  type GilleOutcomeEvidenceResolver,
} from "../src/learning/experiment-outcome-export.js";
import { makeLearningConfig } from "./fixtures/learning.js";
import type { LearningExperimentState, RecordedLearningObservation } from "../src/learning/experiment-schema.js";

function observation(
  arm: "champion" | "challenger",
  sampleId: string,
  overrides: Partial<RecordedLearningObservation> = {},
): RecordedLearningObservation {
  return {
    experiment_id: "pkg-test",
    run_id: `${sampleId}-${arm}`,
    sample_id: sampleId,
    arm,
    holdout: false,
    configuration_fingerprint: makeLearningConfig(arm).fingerprint,
    quality_outcome: arm === "champion" ? "fail" : "pass",
    product_outcome: arm === "champion" ? "discarded" : "accepted-unchanged",
    verifier: { kind: "mechanical", independent: true, id: "protected-check", version: "1" },
    latency_ms: 1000,
    cost_usd: 0,
    recorded_at: "2026-07-10T00:00:00.000Z",
    recorded_by: "service:test",
    ...overrides,
  };
}

function experimentState(observations: RecordedLearningObservation[]): LearningExperimentState {
  const champion = makeLearningConfig("champion");
  const challenger = makeLearningConfig("challenger");
  return {
    schemaVersion: 1,
    experimentId: "pkg-test",
    scope: "proposed-code-edit-agent-prompt",
    taskType: "code-edit",
    ownerPrincipal: "service:test",
    hypothesis: "test hypothesis",
    changeAxis: "agent-prompt",
    champion,
    challenger,
    gates: {
      minMatchedPairs: 2, minHoldoutPairs: 1, minVerifiedCoverage: 0.8, minRatedCoverage: 0.5,
      minChallengerAgentCheckCoverage: 0, maxQualityRegression: 0, maxUsefulRegression: 0,
      maxRescueRateIncrease: 0, maxInfraRateIncrease: 0.05, maxLatencyRatio: 1.25, maxCostRatio: 1.25,
      primaryMetric: "quality-rate", minPrimaryImprovement: 0.05,
    },
    status: "promotion-ready",
    revision: 3,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    observations,
    evaluation: {
      decision: "promotion-ready", reason: "cleared every gate", evaluatedAt: "2026-07-10T00:00:00.000Z",
      matchedPairs: observations.length / 2, holdoutPairs: 0, unmatchedObservations: 0,
      champion: {
        samples: 0, verifiedSamples: 0, verifiedCoverage: 0, qualityRate: 0, ratedSamples: 0, ratedCoverage: 0,
        usefulRate: null, rescueRate: null, infraRate: 0, latencyMeanMs: null, costMeanUsd: null,
        humanReviewMeanSeconds: null, editStartMeanMs: null, observabilityCoverageMean: null,
        verifierScoreMean: null, agentCheckSamples: 0, agentCheckCoverage: 0,
      },
      challenger: {
        samples: 0, verifiedSamples: 0, verifiedCoverage: 0, qualityRate: 1, ratedSamples: 0, ratedCoverage: 0,
        usefulRate: null, rescueRate: null, infraRate: 0, latencyMeanMs: null, costMeanUsd: null,
        humanReviewMeanSeconds: null, editStartMeanMs: null, observabilityCoverageMean: null,
        verifierScoreMean: null, agentCheckSamples: 0, agentCheckCoverage: 0,
      },
      primaryMetric: "quality-rate", primaryChampion: 0, primaryChallenger: 1, primaryImprovement: 1,
      guardFailures: [], missingRequirements: [], failureSignals: [], nextAction: "review and promote",
    },
  };
}

const FULL_EVIDENCE: GilleOutcomeArmEvidence = {
  prompt: "resolved-prompt-text",
  evidenceIdentity: {
    modelArtifact: { kind: "digest", id: "m", version: "1", digest: "a".repeat(64), origin: "server-observed" },
    configEpoch: { kind: "digest", id: "c", version: "1", digest: "b".repeat(64), origin: "server-observed" },
    logicalTask: { kind: "digest", id: "t", version: "1", digest: "c".repeat(64), origin: "learning-task-stamp" },
    renderedPrompt: { kind: "digest", id: "p", version: "1", digest: "d".repeat(64), origin: "learning-task-stamp" },
    harness: { kind: "digest", id: "h", version: "1", digest: "e".repeat(64), origin: "server-observed" },
    taxonomyVersion: { kind: "label", label: "v1", origin: "server-observed" },
    verifierRubric: { kind: "label", label: "protected-check-v1", origin: "server-observed" },
    sampling: { kind: "label", label: "default", origin: "server-observed" },
    toolPolicy: { kind: "label", label: "default", origin: "server-observed" },
    lane: "code-loop",
  },
  verifier: { name: "protected-check", independent: true, mode: "deterministic" },
  exposure: { contaminationStatus: "clean" },
  policyEpoch: "epoch-1",
};

describe("buildOutcomeExportBundle", () => {
  it("builds a bundle mapping quality_outcome and pairing arm/sample correctly", async () => {
    const observations = [observation("champion", "case-1"), observation("challenger", "case-1")];
    const state = experimentState(observations);
    const resolver: GilleOutcomeEvidenceResolver = { resolveArmEvidence: async () => FULL_EVIDENCE };

    const { bundle, unresolvedSamples } = await buildOutcomeExportBundle(state, "run-1", resolver);

    expect(unresolvedSamples).toEqual([]);
    expect(bundle).not.toBeNull();
    expect(bundle!.experimentId).toBe("pkg-test");
    expect(bundle!.runId).toBe("run-1");
    expect(bundle!.status).toBe("completed");
    expect(bundle!.arms).toHaveLength(2);
    const champArm = bundle!.arms.find((a) => a.armId === "champion")!;
    expect(champArm.outcome).toBe("fail");
    expect(champArm.modelId).toBe(makeLearningConfig("champion").model.id);
    const challArm = bundle!.arms.find((a) => a.armId === "challenger")!;
    expect(challArm.outcome).toBe("pass");
    expect(experimentOutcomeBundleWireSchema.parse(bundle)).toEqual(bundle);
  });

  it("maps an infra-error quality outcome onto the wire 'error' outcome", async () => {
    const observations = [
      observation("champion", "case-1", { quality_outcome: "infra-error" }),
      observation("challenger", "case-1"),
    ];
    const state = experimentState(observations);
    const resolver: GilleOutcomeEvidenceResolver = { resolveArmEvidence: async () => FULL_EVIDENCE };
    const { bundle } = await buildOutcomeExportBundle(state, "run-1", resolver);
    expect(bundle!.arms.find((a) => a.armId === "champion")!.outcome).toBe("error");
  });

  it("drops samples the resolver cannot honestly resolve rather than fabricating evidence", async () => {
    const observations = [observation("champion", "case-1"), observation("challenger", "case-1")];
    const state = experimentState(observations);
    const resolver: GilleOutcomeEvidenceResolver = { resolveArmEvidence: async () => null };

    const { bundle, unresolvedSamples } = await buildOutcomeExportBundle(state, "run-1", resolver);

    expect(bundle).toBeNull();
    expect(unresolvedSamples).toEqual(["champion:case-1", "challenger:case-1"]);
  });

  it("marks a rejected (non-promotion-ready) experiment as inconclusive on the wire", async () => {
    const observations = [observation("champion", "case-1"), observation("challenger", "case-1")];
    const state = { ...experimentState(observations), status: "rejected" as const };
    const resolver: GilleOutcomeEvidenceResolver = { resolveArmEvidence: async () => FULL_EVIDENCE };
    const { bundle } = await buildOutcomeExportBundle(state, "run-1", resolver);
    expect(bundle!.status).toBe("inconclusive");
  });
});

describe("resolveExperimentOutcomeExportEndpoint", () => {
  it("resolves the admin import path under a sovereign gateway root", () => {
    expect(resolveExperimentOutcomeExportEndpoint("http://localhost:8080")).toBe(
      "http://localhost:8080/admin/experiments/import",
    );
  });

  it("rejects a non-root path", () => {
    expect(() => resolveExperimentOutcomeExportEndpoint("http://localhost:8080/v2")).toThrow(GilleOutcomeExportError);
  });

  it("rejects an unparseable URL", () => {
    expect(() => resolveExperimentOutcomeExportEndpoint("not a url")).toThrow(GilleOutcomeExportError);
  });
});

describe("createGilleOutcomeExportClient", () => {
  const bundle = experimentOutcomeBundleWireSchema.parse({
    experimentId: "pkg-test",
    runId: "run-1",
    status: "completed",
    arms: [{
      armId: "champion",
      sampleId: "case-1",
      taskType: "code-edit",
      modelId: makeLearningConfig("champion").model.id,
      outcome: "fail",
      prompt: "resolved-prompt-text",
      evidenceIdentity: FULL_EVIDENCE.evidenceIdentity,
      verifier: FULL_EVIDENCE.verifier,
      exposure: FULL_EVIDENCE.exposure,
      policyEpoch: "epoch-1",
      recordedAt: "2026-07-10T00:00:00.000Z",
    }],
  });

  it("POSTs the bundle with bearer auth and returns the parsed per-arm result", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://localhost:8080/admin/experiments/import");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret-admin-key");
      expect(JSON.parse(init!.body as string)).toEqual(bundle);
      return new Response(JSON.stringify({
        experimentId: "pkg-test",
        runId: "run-1",
        arms: [{ armId: "champion", sampleId: "case-1", status: "imported", delegationId: "d1", shadow: false }],
      }), { status: 200 });
    });

    const client = createGilleOutcomeExportClient({
      gatewayBaseUrl: "http://localhost:8080",
      apiKey: "secret-admin-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.exportOutcome(bundle);
    expect(result.arms).toEqual([
      { armId: "champion", sampleId: "case-1", status: "imported", delegationId: "d1", shadow: false },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const client = createGilleOutcomeExportClient({
      gatewayBaseUrl: "http://localhost:8080", apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.exportOutcome(bundle)).rejects.toThrow(GilleOutcomeExportError);
  });

  it("throws a distinct error for a 400 malformed-bundle response", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 }));
    const client = createGilleOutcomeExportClient({
      gatewayBaseUrl: "http://localhost:8080", apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.exportOutcome(bundle)).rejects.toThrow("malformed-bundle");
  });

  it("rejects a missing api key", () => {
    expect(() => createGilleOutcomeExportClient({ gatewayBaseUrl: "http://localhost:8080", apiKey: "  " }))
      .toThrow(GilleOutcomeExportError);
  });
});
