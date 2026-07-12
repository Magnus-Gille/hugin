/**
 * Non-blocking submit-time warnings (issue #184).
 *
 * Judgment-flavored task types (classify, qa-factual, triage,
 * memory-decision, claim-verify) have no mechanical acceptance check to
 * fall back on — with the default `l1_review` acceptance and no rubric in
 * the prompt, the resulting pass/fail grade is pure L1 subjectivity, and
 * the m5h harvest evidence it produces is weak. This never rejects a task;
 * it only surfaces advice in the submit response.
 */

import type { DelegationRequest, TaskType } from "./types.js";

export const JUDGMENT_TASK_TYPES: readonly TaskType[] = [
  "classify",
  "qa-factual",
  "triage",
  "memory-decision",
  "claim-verify",
];

export const NO_RUBRIC_WARNING =
  "judgment-type task submitted without verifier or rubric — capability evidence will be weak";

/**
 * Deliberately dumb, no NLP: a case-insensitive substring match for
 * "rubric" or "grading criteria" anywhere in the prompt. False negatives
 * (a rubric phrased some other way) are expected and fine — this only
 * gates an advisory warning, never the task itself.
 */
const RUBRIC_PATTERN = /rubric|grading criteria/i;

export function promptHasRubric(prompt: string): boolean {
  return RUBRIC_PATTERN.test(prompt);
}

export function computeSubmitWarnings(
  request: Pick<DelegationRequest, "task_type" | "acceptance" | "prompt">,
): string[] {
  const isJudgmentType = (JUDGMENT_TASK_TYPES as readonly string[]).includes(request.task_type);
  const isDefaultAcceptance = request.acceptance.mode === "l1_review";
  if (isJudgmentType && isDefaultAcceptance && !promptHasRubric(request.prompt)) {
    return [NO_RUBRIC_WARNING];
  }
  return [];
}
