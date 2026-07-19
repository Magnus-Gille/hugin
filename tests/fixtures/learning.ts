import {
  learningExperimentCreateSchema,
  learningObservationSchema,
  computeConfigurationFingerprint,
  type LearningConfiguration,
  type LearningExperimentCreate,
  type LearningObservationInput,
} from "../../src/learning/experiment-schema.js";

const hash = (char: string) => char.repeat(64);

export function makeLearningConfig(
  arm: "champion" | "challenger",
  axis: LearningExperimentCreate["change_axis"] = "agent-harness",
): LearningConfiguration {
  const changed = arm === "challenger";
  const base: LearningConfiguration = {
    fingerprint: changed ? hash("b") : hash("a"),
    prompt: { id: "code-worker", version: "1", sha256: hash("c") },
    harness: {
      id: "pi-code-loop",
      version: "1",
      configSha256: hash("d"),
      maxTurns: 13,
      timeoutMs: 600_000,
    },
    model: {
      id: "qwen3-coder-next-80b",
      provider: "m5",
      runtime: "llama-swap",
      config: {
        quantization: "q4-k-m",
        contextWindow: 131_072,
        maxOutputTokens: 16_384,
        temperature: 0.2,
      },
    },
    logging: { schemaVersion: "1", requiredFieldsSha256: hash("e") },
    testHarness: {
      id: "wave-five",
      version: "1",
      corpusSha256: hash("f"),
      oracleVersion: "protected-check-v1",
      holdoutRevision: "holdout-1",
    },
    routing: { policyId: "m5-shadow", version: "1", configSha256: hash("1") },
  };
  if (!changed) {
    base.fingerprint = computeConfigurationFingerprint(base);
    return base;
  }

  switch (axis) {
    case "logging":
      base.logging = { schemaVersion: "2", requiredFieldsSha256: hash("2") };
      break;
    case "test-harness":
      base.testHarness = { ...base.testHarness, version: "2", corpusSha256: hash("2") };
      break;
    case "agent-prompt":
      base.prompt = { ...base.prompt, version: "2", sha256: hash("2") };
      break;
    case "agent-harness":
      base.harness = {
        ...base.harness,
        version: "2",
        configSha256: hash("2"),
        editDeadlineTurn: 6,
      };
      break;
    case "model":
      base.model = { ...base.model, id: "candidate-coder-80b" };
      break;
    case "model-config":
      base.model = { ...base.model, config: { ...base.model.config, temperature: 0.1 } };
      break;
    case "routing":
      base.routing = { policyId: "m5-canary", version: "2", configSha256: hash("2") };
      break;
  }
  base.fingerprint = computeConfigurationFingerprint(base);
  return base;
}

export function makeExperimentInput(
  overrides: Partial<LearningExperimentCreate> = {},
): LearningExperimentCreate {
  const axis = overrides.change_axis ?? "agent-harness";
  return learningExperimentCreateSchema.parse({
    experiment_id: "wave-six-edit-deadline",
    scope: "m5-code-edit",
    task_type: "code-edit",
    hypothesis: "An edit deadline makes the harness edit before exhausting its turn budget.",
    change_axis: axis,
    champion: makeLearningConfig("champion", axis),
    challenger: makeLearningConfig("challenger", axis),
    gates: {
      minMatchedPairs: 2,
      minHoldoutPairs: 1,
      minVerifiedCoverage: 1,
      minRatedCoverage: 1,
      maxQualityRegression: 0,
      maxUsefulRegression: 0,
      maxRescueRateIncrease: 0,
      maxInfraRateIncrease: 0,
      maxLatencyRatio: 1.25,
      maxCostRatio: 1.25,
      primaryMetric: "edit-start-ms",
      minPrimaryImprovement: 0.1,
    },
    ...overrides,
  });
}

export function makeObservation(
  sample: string,
  arm: "champion" | "challenger",
  overrides: Partial<LearningObservationInput> = {},
): LearningObservationInput {
  return learningObservationSchema.parse({
    experiment_id: "wave-six-edit-deadline",
    run_id: `${sample}-${arm}`,
    sample_id: sample,
    arm,
    holdout: sample === "case-2",
    configuration_fingerprint: makeLearningConfig(arm).fingerprint,
    quality_outcome: "pass",
    product_outcome: "accepted-unchanged",
    verifier: { kind: "mechanical", independent: true, id: "protected-check", version: "1" },
    latency_ms: arm === "champion" ? 100_000 : 90_000,
    cost_usd: 0,
    human_review_seconds: arm === "champion" ? 60 : 50,
    edit_start_ms: arm === "champion" ? 60_000 : 40_000,
    observability_coverage: 1,
    verifier_score: 1,
    edited: true,
    tests_run: true,
    tests_passed: true,
    ...overrides,
  });
}
