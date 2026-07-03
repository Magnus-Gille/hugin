import { describe, it, expect } from "vitest";
import { assertProvidersAllowSensitivity } from "../../src/orchestrator/sensitivity-guard.js";
import { effectiveOrchestratorConfig } from "../../src/orchestrator/config.js";
import { DEFAULT_ORCHESTRATOR_CONFIG } from "../../src/orchestrator/engine.js";
import type { OrchestratorConfig } from "../../src/orchestrator/engine.js";

// Default config uses openrouter for all roles
const defaultConfig = DEFAULT_ORCHESTRATOR_CONFIG;

// All-berget config
const bergetConfig: OrchestratorConfig = {
  ...defaultConfig,
  roles: {
    planner: { provider: "berget", model: "llama-3.1-70b" },
    worker: { provider: "berget", model: "llama-3.1-8b" },
    verifier: { provider: "berget", model: "llama-3.1-70b" },
    synthesizer: { provider: "berget", model: "llama-3.1-70b" },
  },
};

// All-homeserver config (M5 local-inference gateway — sovereign/local)
const homeserverConfig: OrchestratorConfig = {
  ...defaultConfig,
  roles: {
    planner: { provider: "homeserver", model: "qwen3-30b-instruct" },
    worker: { provider: "homeserver", model: "qwen3-30b-instruct" },
    verifier: { provider: "homeserver", model: "qwen3-30b-instruct" },
    synthesizer: { provider: "homeserver", model: "qwen3-30b-instruct" },
  },
};

describe("assertProvidersAllowSensitivity", () => {
  it("private + default openrouter config → not ok", () => {
    const result = assertProvidersAllowSensitivity(defaultConfig, "private");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("private");
      expect(result.reason).toContain("openrouter");
    }
  });

  it("private + all-berget config → ok", () => {
    const result = assertProvidersAllowSensitivity(bergetConfig, "private");
    expect(result.ok).toBe(true);
  });

  it("internal + openrouter → ok", () => {
    const result = assertProvidersAllowSensitivity(defaultConfig, "internal");
    expect(result.ok).toBe(true);
  });

  it("public + openrouter → ok", () => {
    const result = assertProvidersAllowSensitivity(defaultConfig, "public");
    expect(result.ok).toBe(true);
  });

  it("private + mixed providers → not ok, lists non-sovereign providers", () => {
    const mixedConfig: OrchestratorConfig = {
      ...defaultConfig,
      roles: {
        planner: { provider: "berget", model: "llama" },
        worker: { provider: "openrouter", model: "gpt-4o" },
        verifier: { provider: "berget", model: "llama" },
        synthesizer: { provider: "openrouter", model: "claude" },
      },
    };
    const result = assertProvidersAllowSensitivity(mixedConfig, "private");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("openrouter");
    }
  });

  it("internal + all-berget config → ok", () => {
    const result = assertProvidersAllowSensitivity(bergetConfig, "internal");
    expect(result.ok).toBe(true);
  });

  it("private + all-homeserver config → ok (local hardware is sovereign)", () => {
    const result = assertProvidersAllowSensitivity(homeserverConfig, "private");
    expect(result.ok).toBe(true);
  });

  it("private + homeserver/openrouter mix → not ok, lists only openrouter", () => {
    const mixedConfig: OrchestratorConfig = {
      ...defaultConfig,
      roles: {
        planner: { provider: "homeserver", model: "qwen3-30b-instruct" },
        worker: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
        verifier: { provider: "homeserver", model: "qwen3-30b-instruct" },
        synthesizer: { provider: "homeserver", model: "qwen3-30b-instruct" },
      },
    };
    const result = assertProvidersAllowSensitivity(mixedConfig, "private");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("openrouter");
      expect(result.reason).not.toContain("homeserver");
    }
  });
});

// The task-level Model: field can switch the worker PROVIDER (provider|model
// syntax), so the guard must always judge the post-override config. These
// tests pin that composition via effectiveOrchestratorConfig — the exact
// helper the dispatcher uses — so a refactor that reorders guard vs override
// fails here instead of silently opening a private→cloud leak.
describe("sensitivity guard × task-model composition (ordering pin)", () => {
  const allHomeserverEnv = {
    HUGIN_ORCH_PLANNER_MODEL: "homeserver|qwen3-30b-instruct",
    HUGIN_ORCH_WORKER_MODEL: "homeserver|qwen3-30b-instruct",
    HUGIN_ORCH_VERIFIER_MODEL: "homeserver|qwen3-30b-instruct",
    HUGIN_ORCH_SYNTH_MODEL: "homeserver|qwen3-30b-instruct",
  };

  it("private task steering the worker to a cloud provider via Model: is rejected", () => {
    const cfg = effectiveOrchestratorConfig(
      allHomeserverEnv,
      "openrouter|deepseek/deepseek-v4-flash",
    );
    const result = assertProvidersAllowSensitivity(cfg, "private");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("openrouter");
  });

  it("private task on a default cloud env stays rejected even with Model: homeserver|…", () => {
    // Worker flips to homeserver, but planner/verifier/synth remain openrouter.
    const cfg = effectiveOrchestratorConfig({}, "homeserver|qwen3-30b-instruct");
    expect(assertProvidersAllowSensitivity(cfg, "private").ok).toBe(false);
  });

  it("private + all-homeserver env + homeserver task model → admitted", () => {
    const cfg = effectiveOrchestratorConfig(allHomeserverEnv, "homeserver|mellum");
    expect(assertProvidersAllowSensitivity(cfg, "private").ok).toBe(true);
  });
});
