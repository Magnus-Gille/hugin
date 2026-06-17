import { describe, it, expect } from "vitest";
import { loadOrchestratorConfig } from "../../src/orchestrator/config.js";
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

  it("ignores bad int for maxSubtasks (falls back to default)", () => {
    const cfg = loadOrchestratorConfig({ HUGIN_ORCH_MAX_SUBTASKS: "abc" });
    expect(cfg.maxSubtasks).toBe(DEFAULT_ORCHESTRATOR_CONFIG.maxSubtasks);
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
