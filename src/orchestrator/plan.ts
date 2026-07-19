import { z } from "zod";
import {
  taskTypeSchema,
  type TaskType as BrokerTaskType,
} from "../broker/types.js";

export type OrchestratorRole = "planner" | "worker" | "verifier" | "synthesizer";

/**
 * Task-type taxonomy (verdict layer, V1 — docs/orchestrator-verdict-layer.md).
 *
 * Hugin has one local mirror of the M5 taxonomy: broker/types.ts. Reusing its
 * schema here prevents planner/verdict labels from drifting from Broker submit
 * and persisted harvest metadata. Additive values owned by Hugin #191 will
 * flow through this alias when they land in the shared schema.
 */
export const TASK_TYPES: readonly BrokerTaskType[] = Object.freeze([
  ...taskTypeSchema.options,
]);

export type TaskType = BrokerTaskType;

const TASK_TYPE_SET: ReadonlySet<string> = new Set(TASK_TYPES);

/** Fallback task type for a missing/unrecognized planner-emitted value. */
const DEFAULT_TASK_TYPE: TaskType = "other";

function normalizeTaskType(raw: string | undefined): TaskType {
  if (raw && TASK_TYPE_SET.has(raw)) return raw as TaskType;
  return DEFAULT_TASK_TYPE;
}

export interface SubTask {
  id: string;
  prompt: string;
  rationale?: string;
  /**
   * Planner-emitted task-type label (V2), always normalized to a member of
   * TASK_TYPES by parsePlan — never left undefined, never an unrecognized
   * string. Defaults to "other" when the planner omits it or emits an
   * unknown value.
   */
  taskType: TaskType;
}

export interface OrchestrationPlan {
  strategy: "fanout" | "single";
  subtasks: SubTask[];
}

// ---------------------------------------------------------------------------
// Zod schema for the planner's JSON output
// ---------------------------------------------------------------------------

const SubTaskSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  rationale: z.string().optional(),
  // Intentionally z.string() (not z.enum(TASK_TYPES)): an unrecognized value
  // must normalize to "other" for THAT subtask, not fail validation for the
  // whole plan.
  taskType: z.string().optional(),
});

const PlanSchema = z.object({
  subtasks: z.array(SubTaskSchema).min(1),
});

// ---------------------------------------------------------------------------
// parsePlan
// ---------------------------------------------------------------------------

/**
 * Extract a JSON object from `raw` — even if wrapped in ```json fences or
 * surrounded by prose — validate against the plan schema, and return an
 * OrchestrationPlan.
 *
 * On ANY failure (no JSON / invalid schema / empty subtasks): returns a
 * single-strategy fallback plan. Never throws.
 */
export function parsePlan(
  raw: string,
  opts: { maxSubtasks: number; fallbackPrompt: string },
): OrchestrationPlan {
  const fallback: OrchestrationPlan = {
    strategy: "single",
    subtasks: [{ id: "1", prompt: opts.fallbackPrompt, taskType: DEFAULT_TASK_TYPE }],
  };

  if (!raw || !raw.trim()) return fallback;

  // Step 1: strip ```json ... ``` fences if present
  let candidate = raw;
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  // Step 2: extract the first {...} block (handles leading prose)
  const braceStart = candidate.indexOf("{");
  if (braceStart === -1) return fallback;

  // Find the matching closing brace
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < candidate.length; i++) {
    if (candidate[i] === "{") depth++;
    else if (candidate[i] === "}") {
      depth--;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  if (braceEnd === -1) return fallback;

  const jsonStr = candidate.slice(braceStart, braceEnd + 1);

  // Step 3: parse and validate
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return fallback;
  }

  const validated = PlanSchema.safeParse(parsed);
  if (!validated.success) return fallback;

  // Cap to maxSubtasks (keep first N). If the cap reduces the list to empty
  // (e.g. maxSubtasks < 1), fall back to the single-worker plan.
  const capped = validated.data.subtasks.slice(0, opts.maxSubtasks);
  if (capped.length === 0) return fallback;

  const seenIds = new Set<string>();
  const subtasks: SubTask[] = capped.map((s, index) => {
    // Fix #7: a planner-emitted empty/whitespace id would otherwise pass
    // SubTaskSchema (z.string(), no minLength) but violate
    // orchestratorOutcomeSchema's subtaskId.min(1) at structured-result write
    // time — AFTER a successful (and possibly expensive) run. Normalize here,
    // at plan-parse time, using the subtask's position in the CAPPED list.
    let id = s.id.trim() ? s.id : `subtask-${index + 1}`;
    // Issue #144 (Codex review): ids must also be UNIQUE — the savings
    // tracker joins worker/verifier costs to verdict outcomes keyed by
    // subtask id, so a planner-emitted duplicate would collapse two
    // subtasks' verdicts into whichever was recorded last. Keep the first
    // occurrence's id; suffix later duplicates deterministically (the loop
    // grows the id each round, so it always terminates and cannot collide
    // with an already-assigned id).
    while (seenIds.has(id)) id = `${id}-${index + 1}`;
    seenIds.add(id);
    return {
      id,
      prompt: s.prompt,
      rationale: s.rationale,
      taskType: normalizeTaskType(s.taskType),
    };
  });

  return { strategy: "fanout", subtasks };
}
