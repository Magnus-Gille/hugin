import type { SubTask, SubtaskOutcome } from "./engine.js";

/**
 * Build the prompt for the planner role.
 *
 * The planner must return ONLY valid JSON matching:
 *   { "subtasks": [{ "id": string, "prompt": string, "rationale"?: string }] }
 *
 * No prose before or after the JSON object.
 */
export function buildPlannerPrompt(taskPrompt: string): string {
  return `You are an expert task planner. Decompose the following task into parallel subtasks.

Return ONLY a JSON object — no prose, no markdown fences — in this exact shape:
{"subtasks":[{"id":"1","prompt":"...","rationale":"..."},...]}

Each subtask must be independently executable. Keep subtasks focused and distinct.

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
 */
export function buildSynthesizerPrompt(
  taskPrompt: string,
  successfulOutcomes: SubtaskOutcome[],
): string {
  const parts = successfulOutcomes.map(
    (o) => `### Subtask ${o.subtask.id}\n${o.result.output}`,
  );
  return `You are synthesizing the results of parallel subtasks into one coherent final answer.

Overall task:
${taskPrompt}

Subtask results:
${parts.join("\n\n")}

Merge these into a single, coherent, well-structured response that fully answers the overall task. Do not merely concatenate — synthesize.`;
}
