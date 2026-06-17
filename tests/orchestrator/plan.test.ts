import { describe, it, expect } from "vitest";
import { parsePlan } from "../../src/orchestrator/plan.js";

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
});
