import { z } from "zod";

export type OrchestratorRole = "planner" | "worker" | "verifier" | "synthesizer";

export interface SubTask {
  id: string;
  prompt: string;
  rationale?: string;
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
    subtasks: [{ id: "1", prompt: opts.fallbackPrompt }],
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

  // Cap to maxSubtasks (keep first N)
  const subtasks = validated.data.subtasks.slice(0, opts.maxSubtasks);

  return { strategy: "fanout", subtasks };
}
