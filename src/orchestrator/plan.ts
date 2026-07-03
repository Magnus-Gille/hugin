import { z } from "zod";

export type OrchestratorRole = "planner" | "worker" | "verifier" | "synthesizer";

/**
 * Task-type taxonomy (verdict layer, V1 — docs/orchestrator-verdict-layer.md).
 *
 * Adopted VERBATIM from the M5 gateway's `/ledger` taxonomy so Hugin's own
 * cloud-worker verdict store shares the same `(taskType × modelId)` row shape
 * from day one — a merge, not a migration, when the two stores converge later
 * (D5's "converge to a single KB later").
 */
export const TASK_TYPES = [
  "claim-verify",
  "classify",
  "code-edit",
  "code-implement",
  "code-review",
  "data-transform",
  "extract",
  "gap-check",
  "other",
  "plan-decompose",
  "qa-factual",
  "reason-hard",
  "reason-math",
  "regex",
  "research-plan",
  "rewrite",
  "source-distill",
  "sql",
  "summarize",
  "synthesis",
  "translate",
  "unit-test-gen",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

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

  const subtasks: SubTask[] = capped.map((s, index) => ({
    // Fix #7: a planner-emitted empty/whitespace id would otherwise pass
    // SubTaskSchema (z.string(), no minLength) but violate
    // orchestratorOutcomeSchema's subtaskId.min(1) at structured-result write
    // time — AFTER a successful (and possibly expensive) run. Normalize here,
    // at plan-parse time, using the subtask's position in the CAPPED list.
    id: s.id.trim() ? s.id : `subtask-${index + 1}`,
    prompt: s.prompt,
    rationale: s.rationale,
    taskType: normalizeTaskType(s.taskType),
  }));

  return { strategy: "fanout", subtasks };
}
