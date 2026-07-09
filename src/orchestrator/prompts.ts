import type { SubTask, SubtaskOutcome } from "./engine.js";
import { TASK_TYPES } from "./plan.js";

/**
 * Build the prompt for the planner role.
 *
 * The planner must return ONLY valid JSON matching:
 *   { "subtasks": [{ "id": string, "prompt": string, "rationale"?: string, "taskType"?: string }] }
 *
 * No prose before or after the JSON object. `taskType` (V2, verdict layer) is
 * requested per subtask from the taxonomy in TASK_TYPES; an unrecognized or
 * missing value normalizes to "other" downstream in parsePlan.
 */
export function buildPlannerPrompt(taskPrompt: string): string {
  return `You are an expert task planner. Decompose the following task into parallel subtasks.

Return ONLY a JSON object — no prose, no markdown fences — in this exact shape:
{"subtasks":[{"id":"1","prompt":"...","rationale":"...","taskType":"..."},...]}

Each subtask must be independently executable. Keep subtasks focused and distinct.

For each subtask, set "taskType" to exactly one of these values (use "other" if none fit):
${TASK_TYPES.join(", ")}

Task:
${taskPrompt}`;
}

/**
 * Build the prompt for a worker role executing one subtask.
 */
export function buildWorkerPrompt(taskPrompt: string, subtask: SubTask): string {
  return `You are executing subtask ${subtask.id} of a larger task.

Overall task context:
${taskPrompt}

Your specific subtask:
${subtask.prompt}

Complete this subtask thoroughly. Your output will be collected and merged with other subtasks.`;
}

/**
 * Build the prompt for the verifier role checking a worker's output.
 */
export function buildVerifierPrompt(subtask: SubTask, workerOutput: string): string {
  return `You are a quality verifier. Review the following subtask and its output.

Subtask:
${subtask.prompt}

Output to verify:
${workerOutput}

Respond with either PASS or FAIL followed by brief notes. Example:
PASS - output is complete and accurate.
FAIL - output is missing key details about X.`;
}

/**
 * Build the prompt for the synthesizer role merging worker outputs.
 *
 * `failedOutcomes` (issue #157): planned subtasks whose worker never produced
 * output (e.g. rejected by a busy gateway until the retry budget ran out).
 * When present, the synthesizer is explicitly told coverage is degraded and
 * instructed to say so — the final answer must never imply full fanout
 * coverage when workers never ran.
 */
export function buildSynthesizerPrompt(
  taskPrompt: string,
  successfulOutcomes: SubtaskOutcome[],
  failedOutcomes: SubtaskOutcome[] = [],
): string {
  const parts = successfulOutcomes.map(
    (o) => `### Subtask ${o.subtask.id}\n${o.result.output}`,
  );

  const degradedSection =
    failedOutcomes.length > 0
      ? `\n\nIMPORTANT — degraded coverage: the following planned subtasks never produced output and are NOT included above:
${failedOutcomes
  .map(
    (o) =>
      `- Subtask ${o.subtask.id}: ${o.subtask.prompt}${o.result.error ? ` (failed: ${o.result.error})` : ""}`,
  )
  .join("\n")}
Your answer MUST explicitly state that these parts of the task were not completed. Do not present the result as complete coverage of the overall task.`
      : "";

  return `You are synthesizing the results of parallel subtasks into one coherent final answer.

Overall task:
${taskPrompt}

Subtask results:
${parts.join("\n\n")}${degradedSection}

Merge these into a single, coherent, well-structured response that fully answers the overall task. Do not merely concatenate — synthesize.`;
}
