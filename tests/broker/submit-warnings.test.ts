import { describe, expect, it } from "vitest";
import {
  JUDGMENT_TASK_TYPES,
  NO_RUBRIC_WARNING,
  computeSubmitWarnings,
  promptHasRubric,
} from "../../src/broker/submit-warnings.js";

function req(overrides: {
  task_type?: string;
  acceptance?: { mode: "l1_review" } | { mode: "verifier"; verifier: unknown };
  prompt?: string;
} = {}) {
  return {
    task_type: overrides.task_type ?? "classify",
    acceptance: overrides.acceptance ?? { mode: "l1_review" as const },
    prompt: overrides.prompt ?? "Classify this ticket as bug or feature.",
  } as Parameters<typeof computeSubmitWarnings>[0];
}

describe("computeSubmitWarnings (#184)", () => {
  it("warns for a judgment-flavored task_type with default l1_review acceptance and no rubric", () => {
    expect(computeSubmitWarnings(req())).toEqual([NO_RUBRIC_WARNING]);
  });

  it.each(JUDGMENT_TASK_TYPES)("warns for every judgment task_type: %s", (taskType) => {
    expect(computeSubmitWarnings(req({ task_type: taskType }))).toEqual([NO_RUBRIC_WARNING]);
  });

  it("does not warn when acceptance is an explicit verifier", () => {
    const warnings = computeSubmitWarnings(
      req({ acceptance: { mode: "verifier", verifier: { type: "nonEmpty" } } }),
    );
    expect(warnings).toEqual([]);
  });

  it("does not warn when the prompt has a Rubric heading (case-insensitive)", () => {
    const warnings = computeSubmitWarnings(
      req({ prompt: "Classify this.\n\n## RUBRIC\n- bug: mentions a defect\n- feature: mentions new capability" }),
    );
    expect(warnings).toEqual([]);
  });

  it("does not warn when the prompt mentions grading criteria", () => {
    const warnings = computeSubmitWarnings(
      req({ prompt: "Triage this issue.\nGrading criteria: correct severity + correct owner." }),
    );
    expect(warnings).toEqual([]);
  });

  it("does not warn for a non-judgment task_type even without a rubric", () => {
    const warnings = computeSubmitWarnings(req({ task_type: "summarize", prompt: "Summarize the README." }));
    expect(warnings).toEqual([]);
  });

  describe("promptHasRubric", () => {
    it("is case-insensitive and dumb (no NLP) — substring match only", () => {
      expect(promptHasRubric("See the RuBrIc below.")).toBe(true);
      expect(promptHasRubric("Grading Criteria: must be exact.")).toBe(true);
      expect(promptHasRubric("No structured criteria here.")).toBe(false);
    });
  });
});
