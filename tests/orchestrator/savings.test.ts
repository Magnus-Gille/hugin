import { describe, it, expect } from "vitest";
import { computeSavings } from "../../src/orchestrator/savings.js";
import type { ModelCallRecord } from "../../src/orchestrator/engine.js";
import { CLAUDE_BASELINE_MODEL_ID } from "../../src/model-pricing.js";

function call(overrides: Partial<ModelCallRecord> = {}): ModelCallRecord {
  return {
    role: "worker",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    ok: true,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    costUsd: 0.27, // 0.09 + 0.18 per M at 1M tokens each
    latencyMs: 10,
    ...overrides,
  };
}

describe("computeSavings — S2 semantics", () => {
  it("returns null (disabled) when the baseline model is not in MODEL_PRICING", () => {
    const result = computeSavings([call()], "not-a-real-model");
    expect(result).toBeNull();
  });

  it("computes covered savings for a single fully-known call", () => {
    const result = computeSavings([call()], CLAUDE_BASELINE_MODEL_ID);
    expect(result).not.toBeNull();
    // Baseline: claude-sonnet-4-6 @ 1M in + 1M out = 3.00 + 15.00 = 18.00
    expect(result!.baselineCostUsd).toBeCloseTo(18.0, 6);
    expect(result!.actualCostUsd).toBeCloseTo(0.27, 6);
    expect(result!.savedUsd).toBeCloseTo(18.0 - 0.27, 6);
    expect(result!.coveredCalls).toBe(1);
    expect(result!.uncoveredCalls).toBe(0);
    expect(result!.inputTokens).toBe(1_000_000);
    expect(result!.outputTokens).toBe(1_000_000);
    expect(result!.baselineModelId).toBe(CLAUDE_BASELINE_MODEL_ID);
  });

  it("mixed known/unknown tokens: a call missing token counts is uncovered, never guessed", () => {
    const calls = [
      call(), // covered
      call({ inputTokens: null, outputTokens: null, costUsd: null }), // uncovered — no tokens
    ];
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID);
    expect(result!.coveredCalls).toBe(1);
    expect(result!.uncoveredCalls).toBe(1);
    // Totals only reflect the covered call.
    expect(result!.inputTokens).toBe(1_000_000);
    expect(result!.outputTokens).toBe(1_000_000);
  });

  it("a failed worker call (ok:false, cost null, tokens null) is uncovered", () => {
    const calls = [call({ ok: false, inputTokens: null, outputTokens: null, costUsd: null })];
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID);
    expect(result!.coveredCalls).toBe(0);
    expect(result!.uncoveredCalls).toBe(1);
    expect(result!.actualCostUsd).toBe(0);
    expect(result!.baselineCostUsd).toBe(0);
    expect(result!.savedUsd).toBe(0);
  });

  it("homeserver $0 models: savedUsd equals the full baseline cost", () => {
    const calls = [
      call({
        provider: "homeserver",
        model: "mellum",
        inputTokens: 500_000,
        outputTokens: 500_000,
        costUsd: 0,
      }),
    ];
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID);
    // Baseline: 0.5M in @ 3.00/M + 0.5M out @ 15.00/M = 1.5 + 7.5 = 9.0
    expect(result!.baselineCostUsd).toBeCloseTo(9.0, 6);
    expect(result!.actualCostUsd).toBe(0);
    expect(result!.savedUsd).toBeCloseTo(9.0, 6);
  });

  it("falls back to estimateCostUsd(call.model, ...) when costUsd is null but tokens are known", () => {
    const calls = [call({ costUsd: null })]; // deepseek-v4-flash, tokens known
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID);
    expect(result!.coveredCalls).toBe(1);
    // deepseek-v4-flash: 1M*0.09 + 1M*0.18 = 0.27
    expect(result!.actualCostUsd).toBeCloseTo(0.27, 6);
  });

  it("a call priced for an unpriced model AND missing costUsd is uncovered (never guessed)", () => {
    const calls = [call({ model: "totally-unknown-model", costUsd: null })];
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID);
    expect(result!.coveredCalls).toBe(0);
    expect(result!.uncoveredCalls).toBe(1);
  });

  it("aggregates byModel keyed 'provider|model'", () => {
    const calls = [
      call({ provider: "openrouter", model: "deepseek/deepseek-v4-flash" }),
      call({ provider: "openrouter", model: "deepseek/deepseek-v4-flash" }),
      call({
        provider: "homeserver",
        model: "mellum",
        inputTokens: 100_000,
        outputTokens: 100_000,
        costUsd: 0,
      }),
    ];
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID);
    expect(Object.keys(result!.byModel).sort()).toEqual([
      "homeserver|mellum",
      "openrouter|deepseek/deepseek-v4-flash",
    ]);
    expect(result!.byModel["openrouter|deepseek/deepseek-v4-flash"].calls).toBe(2);
    expect(result!.byModel["homeserver|mellum"].calls).toBe(1);
  });

  it("never computes savings from a run total — each call is judged independently", () => {
    // One covered, one uncovered — the presence of an uncovered call must not
    // null out the covered call's contribution (unlike totalCostUsd).
    const calls = [call(), call({ inputTokens: null, outputTokens: null, costUsd: null })];
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID);
    expect(result!.savedUsd).toBeGreaterThan(0);
  });
});
