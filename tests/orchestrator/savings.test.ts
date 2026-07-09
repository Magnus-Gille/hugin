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

describe("computeSavings — quality-adjusted savings (issue #144)", () => {
  it("acceptance (issue #157): a busy-rejected worker (503 server_busy) earns no savings credit", () => {
    // A worker the M5 gateway rejected with 503 server_busy never ran: the
    // call failed (ok:false), reported no tokens, and produced no output. It
    // must be uncovered — and must NOT book any verified savings.
    const calls = [
      call({
        subtaskId: "s1",
        ok: false,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      }),
    ];
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID, { s1: "error" });
    expect(result!.coveredCalls).toBe(0);
    expect(result!.uncoveredCalls).toBe(1);
    expect(result!.savedUsd).toBe(0);
    expect(result!.qualityAdjustedSavedUsd).toBe(0);
    expect(result!.qaBaselineCreditUsd).toBe(0);
  });

  it("acceptance: local is cheaper but FAILS verification → quality-adjusted savings is ~zero or negative", () => {
    // Raw savings would book this as a big win: deepseek did 1M+1M tokens for
    // $0.27 vs $18.00 on the Claude baseline. But the verifier failed the
    // output — the work still has to be done at the frontier, so no baseline
    // cost was actually avoided. Quality-adjusted, the run LOST $0.27.
    const calls = [call({ subtaskId: "s1" })];
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID, { s1: "fail" });
    expect(result).not.toBeNull();
    // Raw series is unchanged (still reported for comparability)…
    expect(result!.savedUsd).toBeCloseTo(18.0 - 0.27, 6);
    // …but the headline quality-adjusted number must not reward cheap-but-wrong.
    expect(result!.qualityAdjustedSavedUsd).toBeLessThanOrEqual(0);
    expect(result!.qualityAdjustedSavedUsd).toBeCloseTo(-0.27, 6);
  });

  it("failed verification: the verifier's cost is ALSO attributed to the local attempt", () => {
    // Worker s1 fails verification. The verifier call (frontier-priced) that
    // caught it was spend caused by the local attempt — it must book as part
    // of the loss, not as neutral independent frontier spend.
    const calls = [
      call({ subtaskId: "s1" }), // $0.27 actual
      call({
        role: "verifier",
        model: "claude-sonnet-4-6",
        subtaskId: "s1",
        inputTokens: 100_000,
        outputTokens: 10_000,
        costUsd: null, // estimated: 0.1*3.00 + 0.01*15.00 = 0.45
      }),
    ];
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID, { s1: "fail" });
    expect(result!.qualityAdjustedSavedUsd).toBeCloseTo(-(0.27 + 0.45), 6);
    expect(result!.byOutcome.fail!.calls).toBe(2);
    expect(result!.byOutcome.fail!.qaBaselineCreditUsd).toBe(0);
  });

  it("verified pass: worker earns full baseline credit, verifier cost still counts as overhead", () => {
    const calls = [
      call({ subtaskId: "s1" }), // worker: baseline 18.00, actual 0.27
      call({
        role: "verifier",
        model: "claude-sonnet-4-6",
        subtaskId: "s1",
        inputTokens: 100_000,
        outputTokens: 10_000,
        costUsd: null, // 0.45 actual — zero credit (counterfactual doesn't verify)
      }),
    ];
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID, { s1: "pass" });
    // QA = (18.00 credit − 0.27) + (0 credit − 0.45)
    expect(result!.qualityAdjustedSavedUsd).toBeCloseTo(18.0 - 0.27 - 0.45, 6);
    // Raw counts the verifier at baseline == actual, so raw > QA by baseline_v (0.45).
    expect(result!.savedUsd).toBeCloseTo(18.0 - 0.27, 6);
    expect(result!.byOutcome.pass!.calls).toBe(2);
    expect(result!.byOutcome.pass!.qaBaselineCreditUsd).toBeCloseTo(18.0, 6);
  });

  it("unverified (unknown) subtask keeps baseline credit but is surfaced in byOutcome", () => {
    const calls = [call({ subtaskId: "s1" })];
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID, { s1: "unknown" });
    expect(result!.qualityAdjustedSavedUsd).toBeCloseTo(18.0 - 0.27, 6);
    expect(result!.byOutcome.unknown!.calls).toBe(1);
    expect(result!.byOutcome.unknown!.qaBaselineCreditUsd).toBeCloseTo(18.0, 6);
  });

  it("a subtask missing from the verdict map — or no map at all — counts as unknown", () => {
    const withEmptyMap = computeSavings([call({ subtaskId: "s1" })], CLAUDE_BASELINE_MODEL_ID, {});
    const withNoMap = computeSavings([call({ subtaskId: "s1" })], CLAUDE_BASELINE_MODEL_ID);
    for (const result of [withEmptyMap, withNoMap]) {
      expect(result!.byOutcome.unknown!.calls).toBe(1);
      expect(result!.qualityAdjustedSavedUsd).toBeCloseTo(18.0 - 0.27, 6);
    }
  });

  it("escalated subtask earns zero credit — its local spend books as a loss", () => {
    const calls = [call({ subtaskId: "s1" })];
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID, { s1: "escalated" });
    expect(result!.qualityAdjustedSavedUsd).toBeCloseTo(-0.27, 6);
    expect(result!.byOutcome.escalated!.qaBaselineCreditUsd).toBe(0);
  });

  it("a covered call that itself failed (ok:false) earns zero credit even without a verdict", () => {
    const calls = [call({ subtaskId: "s1", ok: false })]; // tokens+cost known, call failed
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID, { s1: "error" });
    expect(result!.qualityAdjustedSavedUsd).toBeCloseTo(-0.27, 6);
    expect(result!.byOutcome.error!.calls).toBe(1);
  });

  it("run-level calls (planner/synthesizer, no subtaskId) keep raw treatment and stay out of byOutcome", () => {
    const calls = [
      call({ role: "planner", model: "claude-sonnet-4-6", costUsd: null }), // baseline == actual
      call({ subtaskId: "s1" }),
    ];
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID, { s1: "pass" });
    // Planner contributes 0 net to both series (sonnet vs sonnet baseline).
    expect(result!.qualityAdjustedSavedUsd).toBeCloseTo(18.0 - 0.27, 6);
    expect(result!.byOutcome.pass!.calls).toBe(1); // planner not bucketed
    expect(Object.keys(result!.byOutcome)).toEqual(["pass"]);
  });

  it("all-pass unverified run: quality-adjusted equals raw (no verifier calls, no failures)", () => {
    const calls = [call({ subtaskId: "s1" }), call({ subtaskId: "s2" })];
    const result = computeSavings(calls, CLAUDE_BASELINE_MODEL_ID, { s1: "pass", s2: "pass" });
    expect(result!.qualityAdjustedSavedUsd).toBeCloseTo(result!.savedUsd, 9);
    expect(result!.qaBaselineCreditUsd).toBeCloseTo(result!.baselineCostUsd, 9);
  });
});

describe("computeSavings — token integrity (review fix)", () => {
  it("classifies calls with fractional token counts as uncovered", () => {
    const result = computeSavings(
      [
        { role: "worker", provider: "homeserver", model: "qwen3-30b-instruct",
          ok: true, inputTokens: 100.5, outputTokens: 50, costUsd: 0, latencyMs: 10 },
      ],
      "claude-sonnet-4-6",
    );
    expect(result).not.toBeNull();
    expect(result!.coveredCalls).toBe(0);
    expect(result!.uncoveredCalls).toBe(1);
  });
});
