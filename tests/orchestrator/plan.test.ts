import { describe, it, expect } from "vitest";
import { parsePlan, TASK_TYPES } from "../../src/orchestrator/plan.js";

const FALLBACK_PROMPT = "Do the whole task yourself.";

describe("parsePlan", () => {
  it("parses valid JSON with subtasks", () => {
    const raw = JSON.stringify({
      subtasks: [
        { id: "1", prompt: "First step", rationale: "reason" },
        { id: "2", prompt: "Second step" },
      ],
    });
    const plan = parsePlan(raw, { maxSubtasks: 10, fallbackPrompt: FALLBACK_PROMPT });
    expect(plan.strategy).toBe("fanout");
    expect(plan.subtasks).toHaveLength(2);
    expect(plan.subtasks[0].id).toBe("1");
    expect(plan.subtasks[1].rationale).toBeUndefined();
  });

  it("parses JSON wrapped in ```json fences", () => {
    const raw = `\`\`\`json\n${JSON.stringify({ subtasks: [{ id: "1", prompt: "step" }] })}\n\`\`\``;
    const plan = parsePlan(raw, { maxSubtasks: 10, fallbackPrompt: FALLBACK_PROMPT });
    expect(plan.strategy).toBe("fanout");
    expect(plan.subtasks).toHaveLength(1);
  });

  it("parses JSON with leading prose", () => {
    const raw = `Here is your plan:\n${JSON.stringify({ subtasks: [{ id: "a", prompt: "Do it" }] })}\nDone.`;
    const plan = parsePlan(raw, { maxSubtasks: 10, fallbackPrompt: FALLBACK_PROMPT });
    expect(plan.strategy).toBe("fanout");
    expect(plan.subtasks[0].prompt).toBe("Do it");
  });

  it("returns single fallback on garbage input", () => {
    const plan = parsePlan("this is not json at all!!!", { maxSubtasks: 10, fallbackPrompt: FALLBACK_PROMPT });
    expect(plan.strategy).toBe("single");
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0].id).toBe("1");
    expect(plan.subtasks[0].prompt).toBe(FALLBACK_PROMPT);
  });

  it("returns single fallback when subtasks is empty array", () => {
    const raw = JSON.stringify({ subtasks: [] });
    const plan = parsePlan(raw, { maxSubtasks: 10, fallbackPrompt: FALLBACK_PROMPT });
    expect(plan.strategy).toBe("single");
    expect(plan.subtasks[0].prompt).toBe(FALLBACK_PROMPT);
  });

  it("caps subtasks to maxSubtasks (keeps first N)", () => {
    const subtasks = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), prompt: `Step ${i + 1}` }));
    const raw = JSON.stringify({ subtasks });
    const plan = parsePlan(raw, { maxSubtasks: 3, fallbackPrompt: FALLBACK_PROMPT });
    expect(plan.strategy).toBe("fanout");
    expect(plan.subtasks).toHaveLength(3);
    expect(plan.subtasks[2].id).toBe("3");
  });

  it("returns single fallback for empty string input", () => {
    const plan = parsePlan("", { maxSubtasks: 10, fallbackPrompt: FALLBACK_PROMPT });
    expect(plan.strategy).toBe("single");
    expect(plan.subtasks[0].prompt).toBe(FALLBACK_PROMPT);
  });

  it("falls back to single when maxSubtasks:0 empties the subtask list (Fix #5)", () => {
    const raw = JSON.stringify({
      subtasks: [
        { id: "1", prompt: "Step 1" },
        { id: "2", prompt: "Step 2" },
      ],
    });
    const plan = parsePlan(raw, { maxSubtasks: 0, fallbackPrompt: FALLBACK_PROMPT });
    expect(plan.strategy).toBe("single");
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0].prompt).toBe(FALLBACK_PROMPT);
  });
});

describe("parsePlan — taskType taxonomy (V2)", () => {
  it("TASK_TYPES is the 21-value taxonomy including 'other'", () => {
    expect(TASK_TYPES).toContain("other");
    expect(TASK_TYPES).toHaveLength(21);
    expect([...TASK_TYPES].sort()).toEqual([...TASK_TYPES].slice().sort());
  });

  it("carries a valid planner-emitted taskType through per subtask", () => {
    const raw = JSON.stringify({
      subtasks: [
        { id: "1", prompt: "Step 1", taskType: "summarize" },
        { id: "2", prompt: "Step 2", taskType: "code-review" },
      ],
    });
    const plan = parsePlan(raw, { maxSubtasks: 10, fallbackPrompt: FALLBACK_PROMPT });
    expect(plan.subtasks[0].taskType).toBe("summarize");
    expect(plan.subtasks[1].taskType).toBe("code-review");
  });

  it("normalizes an unknown taskType value to 'other'", () => {
    const raw = JSON.stringify({
      subtasks: [{ id: "1", prompt: "Step 1", taskType: "not-a-real-type" }],
    });
    const plan = parsePlan(raw, { maxSubtasks: 10, fallbackPrompt: FALLBACK_PROMPT });
    expect(plan.subtasks[0].taskType).toBe("other");
  });

  it("defaults taskType to 'other' when the planner omits the field", () => {
    const raw = JSON.stringify({ subtasks: [{ id: "1", prompt: "Step 1" }] });
    const plan = parsePlan(raw, { maxSubtasks: 10, fallbackPrompt: FALLBACK_PROMPT });
    expect(plan.subtasks[0].taskType).toBe("other");
  });

  it("defaults taskType to 'other' on the single-worker fallback plan", () => {
    const plan = parsePlan("garbage, not json", { maxSubtasks: 10, fallbackPrompt: FALLBACK_PROMPT });
    expect(plan.strategy).toBe("single");
    expect(plan.subtasks[0].taskType).toBe("other");
  });
});
