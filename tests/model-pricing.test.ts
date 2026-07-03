import { describe, it, expect } from "vitest";
import {
  MODEL_PRICING,
  CLAUDE_BASELINE_MODEL_ID,
  getModelPrice,
  estimateCostUsd,
} from "../src/model-pricing.js";

describe("getModelPrice", () => {
  it("returns entry for a known model", () => {
    const price = getModelPrice("deepseek/deepseek-v4-flash");
    expect(price).toBeDefined();
    expect(price!.provider).toBe("openrouter");
    expect(price!.inputUsdPerM).toBe(0.09);
    expect(price!.outputUsdPerM).toBe(0.18);
  });

  it("returns undefined for an unknown model", () => {
    expect(getModelPrice("nonexistent/model-xyz")).toBeUndefined();
  });

  it("returns the berget mistral-small entry", () => {
    // Real slug from Berget /v1/models (case-sensitive); price is EUR 0.30/M → USD ~0.34/M.
    const price = getModelPrice("mistralai/Mistral-Small-3.2-24B-Instruct-2506");
    expect(price).toBeDefined();
    expect(price!.provider).toBe("berget");
    expect(price!.inputUsdPerM).toBe(0.34);
    expect(price!.outputUsdPerM).toBe(0.34);
  });

  it("returns explicit $0 entries for homeserver (M5 gateway) models", () => {
    // Slugs from the gateway's /v1/models (verified 2026-07-03).
    for (const modelId of [
      "mellum",
      "qwen3-30b-instruct",
      "qwen3-coder-next-80b",
      "gpt-oss-120b",
      "gemma4",
      "qwen36-a3b",
      "tongyi-dr",
    ]) {
      const price = getModelPrice(modelId);
      expect(price, modelId).toBeDefined();
      expect(price!.provider, modelId).toBe("homeserver");
      expect(price!.inputUsdPerM, modelId).toBe(0);
      expect(price!.outputUsdPerM, modelId).toBe(0);
    }
  });
});

describe("estimateCostUsd", () => {
  it("computes cost correctly for a known model", () => {
    // deepseek-v4-flash: 0.09/0.18 per 1M tokens
    // input: 1_000_000 tokens → $0.09; output: 500_000 tokens → $0.09
    // total = 0.18
    const cost = estimateCostUsd("deepseek/deepseek-v4-flash", 1_000_000, 500_000);
    expect(cost).not.toBeNull();
    expect(cost!).toBeCloseTo(0.18, 10);
  });

  it("returns null for an unknown model", () => {
    expect(estimateCostUsd("unknown/model", 100, 100)).toBeNull();
  });

  it("returns an explicit 0 (not null) for homeserver models", () => {
    // Known-free local inference must be distinguishable from unknown cost.
    expect(estimateCostUsd("qwen3-30b-instruct", 1_000_000, 1_000_000)).toBe(0);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCostUsd("deepseek/deepseek-v4-flash", 0, 0)).toBe(0);
  });
});

describe("CLAUDE_BASELINE_MODEL_ID and pricing sanity", () => {
  it("baseline model exists in MODEL_PRICING", () => {
    expect(MODEL_PRICING[CLAUDE_BASELINE_MODEL_ID]).toBeDefined();
  });

  it("Claude sonnet is much pricier than deepseek-v4-flash (input)", () => {
    const claude = getModelPrice(CLAUDE_BASELINE_MODEL_ID)!;
    const deepseek = getModelPrice("deepseek/deepseek-v4-flash")!;
    expect(claude.inputUsdPerM).toBeGreaterThan(deepseek.inputUsdPerM * 10);
  });

  it("CLAUDE_BASELINE_MODEL_ID is claude-sonnet-4-6", () => {
    expect(CLAUDE_BASELINE_MODEL_ID).toBe("claude-sonnet-4-6");
  });
});
