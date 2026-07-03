import { describe, it, expect } from "vitest";
import { buildPlannerPrompt } from "../../src/orchestrator/prompts.js";
import { TASK_TYPES } from "../../src/orchestrator/plan.js";

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
