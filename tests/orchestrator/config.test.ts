import { describe, it, expect } from "vitest";
import {
  loadOrchestratorConfig,
  applyTaskModel,
  isVerdictStoreEnabled,
} from "../../src/orchestrator/config.js";
import { DEFAULT_ORCHESTRATOR_CONFIG } from "../../src/orchestrator/engine.js";

describe("loadOrchestratorConfig", () => {
  it("returns defaults when env is empty", () => {
    const cfg = loadOrchestratorConfig({});
    expect(cfg).toEqual(DEFAULT_ORCHESTRATOR_CONFIG);
  });

  it("overrides planner model with provider|model format", () => {
    const cfg = loadOrchestratorConfig({
      HUGIN_ORCH_PLANNER_MODEL: "berget|mistral/mistral-7b",
    });
    expect(cfg.roles.planner).toEqual({ provider: "berget", model: "mistral/mistral-7b" });
    // Other roles unchanged
    expect(cfg.roles.worker).toEqual(DEFAULT_ORCHESTRATOR_CONFIG.roles.worker);
  });

  it("overrides worker model without provider (keeps default provider)", () => {
    const cfg = loadOrchestratorConfig({
      HUGIN_ORCH_WORKER_MODEL: "google/gemma-3-27b-it",
    });
    expect(cfg.roles.worker.model).toBe("google/gemma-3-27b-it");
    expect(cfg.roles.worker.provider).toBe(DEFAULT_ORCHESTRATOR_CONFIG.roles.worker.provider);
  });

  it("overrides verifier model with provider|model", () => {
    const cfg = loadOrchestratorConfig({
      HUGIN_ORCH_VERIFIER_MODEL: "openrouter|anthropic/claude-opus-4",
    });
    expect(cfg.roles.verifier).toEqual({ provider: "openrouter", model: "anthropic/claude-opus-4" });
  });

  it("overrides synthesizer model with provider|model", () => {
    const cfg = loadOrchestratorConfig({
      HUGIN_ORCH_SYNTH_MODEL: "berget|meta/llama-3.1-70b",
    });
    expect(cfg.roles.synthesizer).toEqual({ provider: "berget", model: "meta/llama-3.1-70b" });
  });

  it("overrides maxConcurrency", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_MAX_CONCURRENCY: "8" });
    expect(cfg.maxConcurrency).toBe(8);
  });

  it("ignores bad int for maxConcurrency (falls back to default)", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_MAX_CONCURRENCY: "not-a-number" });
    expect(cfg.maxConcurrency).toBe(DEFAULT_ORCHESTRATOR_CONFIG.maxConcurrency);
  });

  it('enables verifyWorkers when HUGIN_ORCH_VERIFY=on', () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_VERIFY: "on" });
    expect(cfg.verifyWorkers).toBe(true);
  });

  it('enables verifyWorkers when HUGIN_ORCH_VERIFY=true', () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_VERIFY: "true" });
    expect(cfg.verifyWorkers).toBe(true);
  });

  it("overrides perCallTimeoutMs", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_PER_CALL_TIMEOUT_MS: "60000" });
    expect(cfg.perCallTimeoutMs).toBe(60000);
  });

  it("ignores bad int for perCallTimeoutMs (falls back to default)", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_PER_CALL_TIMEOUT_MS: "" });
    expect(cfg.perCallTimeoutMs).toBe(DEFAULT_ORCHESTRATOR_CONFIG.perCallTimeoutMs);
  });

  it("overrides maxSubtasks", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_MAX_SUBTASKS: "6" });
    expect(cfg.maxSubtasks).toBe(6);
  });

  it("defaults maxTokens to 4096 (issue #112)", () => {
    const cfg = loadOrchestratorConfig({});
    expect(cfg.maxTokens).toBe(4096);
  });

  it("overrides maxTokens via HUGIN_ORCH_MAX_TOKENS (issue #112)", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_MAX_TOKENS: "16384" });
    expect(cfg.maxTokens).toBe(16384);
  });

  it("ignores bad int for maxTokens (falls back to default)", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_MAX_TOKENS: "lots" });
    expect(cfg.maxTokens).toBe(DEFAULT_ORCHESTRATOR_CONFIG.maxTokens);
  });

  it("ignores bad int for maxSubtasks (falls back to default)", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_MAX_SUBTASKS: "abc" });
    expect(cfg.maxSubtasks).toBe(DEFAULT_ORCHESTRATOR_CONFIG.maxSubtasks);
  });

  it("rejects '0' for maxSubtasks (zero is not positive) → falls back to default", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_MAX_SUBTASKS: "0" });
    expect(cfg.maxSubtasks).toBe(DEFAULT_ORCHESTRATOR_CONFIG.maxSubtasks);
  });

  it("rejects '-1' for maxConcurrency (negative) → falls back to default", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_MAX_CONCURRENCY: "-1" });
    expect(cfg.maxConcurrency).toBe(DEFAULT_ORCHESTRATOR_CONFIG.maxConcurrency);
  });

  it("rejects '2abc' for perCallTimeoutMs (trailing junk) → falls back to default", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_PER_CALL_TIMEOUT_MS: "2abc" });
    expect(cfg.perCallTimeoutMs).toBe(DEFAULT_ORCHESTRATOR_CONFIG.perCallTimeoutMs);
  });

  it("rejects ' ' (whitespace) for maxSubtasks → falls back to default", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_MAX_SUBTASKS: " " });
    expect(cfg.maxSubtasks).toBe(DEFAULT_ORCHESTRATOR_CONFIG.maxSubtasks);
  });

  it("accepts '3' for maxSubtasks → 3", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_MAX_SUBTASKS: "3" });
    expect(cfg.maxSubtasks).toBe(3);
  });

  it("defaults adaptiveVerify to false (HUGIN_ORCH_ADAPTIVE_VERIFY unset)", () => {
    const cfg = loadOrchestratorConfig({});
    expect(cfg.adaptiveVerify).toBe(false);
  });

  it('enables adaptiveVerify when HUGIN_ORCH_ADAPTIVE_VERIFY=on', () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_ADAPTIVE_VERIFY: "on" });
    expect(cfg.adaptiveVerify).toBe(true);
  });

  it('enables adaptiveVerify when HUGIN_ORCH_ADAPTIVE_VERIFY=true', () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_ADAPTIVE_VERIFY: "true" });
    expect(cfg.adaptiveVerify).toBe(true);
  });

  it("ignores an unrecognized value for HUGIN_ORCH_ADAPTIVE_VERIFY", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_ADAPTIVE_VERIFY: "yes-please" });
    expect(cfg.adaptiveVerify).toBe(false);
  });

  it("applies multiple overrides simultaneously", () => {
    const cfg = loadOrchestratorConfig({
      HUGIN_ORCH_PLANNER_MODEL: "berget|llama-3.1-8b",
      HUGIN_ORCH_MAX_CONCURRENCY: "2",
      HUGIN_ORCH_VERIFY: "on",
      HUGIN_ORCH_MAX_SUBTASKS: "4",
    });
    expect(cfg.roles.planner).toEqual({ provider: "berget", model: "llama-3.1-8b" });
    expect(cfg.maxConcurrency).toBe(2);
    expect(cfg.verifyWorkers).toBe(true);
    expect(cfg.maxSubtasks).toBe(4);
  });
});

describe("loadOrchestratorConfig — malformed role overrides", () => {
  it("keeps the default binding when a role env override has an empty half", () => {
    const cfg = loadOrchestratorConfig({
      HUGIN_ORCH_WORKER_MODEL: "berget|",
      HUGIN_ORCH_PLANNER_MODEL: "|some-model",
    });
    expect(cfg.roles.worker).toEqual(DEFAULT_ORCHESTRATOR_CONFIG.roles.worker);
    expect(cfg.roles.planner).toEqual(DEFAULT_ORCHESTRATOR_CONFIG.roles.planner);
  });
});

describe("applyTaskModel (Fix #6)", () => {
  it("parses provider|model syntax, overriding the worker provider and model", () => {
    const cfg = applyTaskModel(DEFAULT_ORCHESTRATOR_CONFIG, "berget|some/model");
    expect(cfg.roles.worker.provider).toBe("berget");
    expect(cfg.roles.worker.model).toBe("some/model");
  });

  it("routes a task to the homeserver provider via provider|model syntax", () => {
    const cfg = applyTaskModel(DEFAULT_ORCHESTRATOR_CONFIG, "homeserver|qwen3-30b-instruct");
    expect(cfg.roles.worker.provider).toBe("homeserver");
    expect(cfg.roles.worker.model).toBe("qwen3-30b-instruct");
    // Only the worker role is task-overridable.
    expect(cfg.roles.planner).toEqual(DEFAULT_ORCHESTRATOR_CONFIG.roles.planner);
  });

  it("ignores malformed provider|model values (empty half) and keeps the defaults", () => {
    for (const malformed of ["|qwen3-30b-instruct", "openrouter|", "|", " | "]) {
      const result = applyTaskModel(DEFAULT_ORCHESTRATOR_CONFIG, malformed);
      expect(result, malformed).toBe(DEFAULT_ORCHESTRATOR_CONFIG);
    }
  });

  it("trims whitespace around the provider|model separator", () => {
    const cfg = applyTaskModel(DEFAULT_ORCHESTRATOR_CONFIG, " homeserver | qwen3-30b-instruct ");
    expect(cfg.roles.worker.provider).toBe("homeserver");
    expect(cfg.roles.worker.model).toBe("qwen3-30b-instruct");
  });

  it("overrides worker model, preserving the existing worker provider", () => {
    const base = { ...DEFAULT_ORCHESTRATOR_CONFIG, roles: { ...DEFAULT_ORCHESTRATOR_CONFIG.roles, worker: { provider: "berget", model: "old-model" } } };
    const cfg = applyTaskModel(base, "new-model");
    expect(cfg.roles.worker.model).toBe("new-model");
    expect(cfg.roles.worker.provider).toBe("berget");
  });

  it("leaves planner/verifier/synthesizer unchanged", () => {
    const cfg = applyTaskModel(DEFAULT_ORCHESTRATOR_CONFIG, "some/override");
    expect(cfg.roles.planner).toEqual(DEFAULT_ORCHESTRATOR_CONFIG.roles.planner);
    expect(cfg.roles.verifier).toEqual(DEFAULT_ORCHESTRATOR_CONFIG.roles.verifier);
    expect(cfg.roles.synthesizer).toEqual(DEFAULT_ORCHESTRATOR_CONFIG.roles.synthesizer);
  });

  it("returns the same config object when taskModel is undefined", () => {
    const result = applyTaskModel(DEFAULT_ORCHESTRATOR_CONFIG, undefined);
    expect(result).toBe(DEFAULT_ORCHESTRATOR_CONFIG);
  });

  it("returns the same config object when taskModel is empty string", () => {
    const result = applyTaskModel(DEFAULT_ORCHESTRATOR_CONFIG, "");
    expect(result).toBe(DEFAULT_ORCHESTRATOR_CONFIG);
  });

  it("returns the same config object when taskModel is whitespace-only", () => {
    const result = applyTaskModel(DEFAULT_ORCHESTRATOR_CONFIG, "   ");
    expect(result).toBe(DEFAULT_ORCHESTRATOR_CONFIG);
  });

  it("does not mutate the input config", () => {
    const original = { ...DEFAULT_ORCHESTRATOR_CONFIG, roles: { ...DEFAULT_ORCHESTRATOR_CONFIG.roles } };
    const originalWorkerModel = original.roles.worker.model;
    applyTaskModel(original, "new-model");
    expect(original.roles.worker.model).toBe(originalWorkerModel);
  });
});

describe("isVerdictStoreEnabled (V4)", () => {
  it("defaults to enabled (on) when HUGIN_ORCH_VERDICT_STORE is unset", () => {
    expect(isVerdictStoreEnabled({})).toBe(true);
  });

  it("disables when HUGIN_ORCH_VERDICT_STORE=off", () => {
    expect(isVerdictStoreEnabled({ HUGIN_ORCH_VERDICT_STORE: "off" })).toBe(false);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(isVerdictStoreEnabled({ HUGIN_ORCH_VERDICT_STORE: " OFF " })).toBe(false);
  });

  it("stays enabled for any other value", () => {
    expect(isVerdictStoreEnabled({ HUGIN_ORCH_VERDICT_STORE: "on" })).toBe(true);
    expect(isVerdictStoreEnabled({ HUGIN_ORCH_VERDICT_STORE: "banana" })).toBe(true);
  });
});
