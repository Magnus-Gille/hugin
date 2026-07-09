import { describe, it, expect } from "vitest";
import { buildPlannerPrompt, buildSynthesizerPrompt } from "../../src/orchestrator/prompts.js";
import { TASK_TYPES } from "../../src/orchestrator/plan.js";
import type { SubtaskOutcome } from "../../src/orchestrator/engine.js";
import type { WorkerResult } from "../../src/orchestrator/worker-executor.js";

function outcome(id: string, overrides: Partial<WorkerResult> = {}): SubtaskOutcome {
  return {
    subtask: { id, prompt: `Prompt for ${id}`, taskType: "other" },
    result: {
      ok: true,
      output: `Output of ${id}`,
      provider: "openrouter",
      model: "m",
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.001,
      latencyMs: 5,
      ...overrides,
    },
  };
}

describe("buildPlannerPrompt — taskType taxonomy (V2)", () => {
  it("asks the planner to emit a taskType per subtask", () => {
    const prompt = buildPlannerPrompt("Do a complex task");
    expect(prompt).toContain("taskType");
  });

  it("lists every taxonomy value verbatim in the prompt", () => {
    const prompt = buildPlannerPrompt("Do a complex task");
    for (const t of TASK_TYPES) {
      expect(prompt).toContain(t);
    }
  });

  it("still contains the original task prompt", () => {
    const prompt = buildPlannerPrompt("UNIQUE_MARKER_TASK");
    expect(prompt).toContain("UNIQUE_MARKER_TASK");
  });
});

describe("buildSynthesizerPrompt — degraded coverage (issue #157)", () => {
  it("without failed outcomes the prompt has no degraded-coverage section", () => {
    const prompt = buildSynthesizerPrompt("Overall task", [outcome("1"), outcome("2")]);
    expect(prompt.toLowerCase()).not.toContain("degraded");
    expect(prompt).toContain("Output of 1");
    expect(prompt).toContain("Output of 2");
  });

  it("names never-ran subtasks and instructs the model to state partial coverage", () => {
    const failed = outcome("2", {
      ok: false,
      output: "",
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      error: "HTTP 503 server_busy retryAfterS=5",
    });
    const prompt = buildSynthesizerPrompt("Overall task", [outcome("1")], [failed]);
    expect(prompt.toLowerCase()).toContain("degraded");
    expect(prompt).toContain("Subtask 2");
    expect(prompt).toContain("HTTP 503 server_busy retryAfterS=5");
  });
});
