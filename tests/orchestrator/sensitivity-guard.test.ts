import { describe, it, expect } from "vitest";
import { assertProvidersAllowSensitivity } from "../../src/orchestrator/sensitivity-guard.js";
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
});
