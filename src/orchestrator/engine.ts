import type { ModelInvoker, RoleBinding } from "./model-invoker.js";
import {
  parsePlan,
  type OrchestratorRole,
  type OrchestrationPlan,
  type SubTask,
} from "./plan.js";
import type { WorkerResult } from "./worker-executor.js";
import {
  buildPlannerPrompt,
  buildWorkerPrompt,
  buildVerifierPrompt,
  buildSynthesizerPrompt,
} from "./prompts.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { SubTask };

export interface OrchestratorConfig {
  roles: Record<OrchestratorRole, RoleBinding>;
  /** Max concurrent worker invocations. */
  maxConcurrency: number;
  /** Run a verifier on each successful worker result. */
  verifyWorkers: boolean;
  /** Timeout per model call in ms. */
  perCallTimeoutMs: number;
  /** Cap the planner's subtask list to this many entries. */
  maxSubtasks: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  roles: {
    planner: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
    worker: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
    verifier: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
    synthesizer: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
  },
  maxConcurrency: 4,
  verifyWorkers: false,
  perCallTimeoutMs: 120_000,
  maxSubtasks: 12,
};

export interface SubtaskOutcome {
  subtask: SubTask;
  result: WorkerResult;
  verdict?: { ok: boolean; notes?: string };
}

export interface OrchestrationResult {
  ok: boolean;
  finalOutput: string;
  plan: OrchestrationPlan;
  outcomes: SubtaskOutcome[];
  /** Sum of known costUsd across ALL invocations; null only if NO call had a known cost. */
  totalCostUsd: number | null;
  totalLatencyMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// mapWithConcurrency — run async tasks with a concurrency cap
// ---------------------------------------------------------------------------

/**
 * Map `items` through `fn` with at most `limit` concurrent executions.
 *
 * This is the standard sliding-window approach: we maintain a pool of
 * in-flight promises and always start the next item when any slot frees up.
 * Uses no external dependencies.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Verdict parser
// ---------------------------------------------------------------------------

function parseVerdict(output: string): { ok: boolean; notes?: string } {
  // Try JSON first: { "ok": true/false, "notes"?: string }
  const braceStart = output.indexOf("{");
  if (braceStart !== -1) {
    try {
      const obj = JSON.parse(output.slice(braceStart));
      if (typeof obj === "object" && obj !== null && "ok" in obj) {
        return {
          ok: Boolean(obj.ok),
          notes: typeof obj.notes === "string" ? obj.notes : undefined,
        };
      }
    } catch {
      // fall through to text parsing
    }
  }

  // Text parsing: look for PASS/FAIL (case-insensitive)
  const upper = output.toUpperCase();
  if (upper.includes("FAIL")) return { ok: false, notes: output.trim() };
  if (upper.includes("PASS")) return { ok: true, notes: output.trim() };

  // Default: assume ok if unparseable
  return { ok: true, notes: output.trim() || undefined };
}

// ---------------------------------------------------------------------------
// Cost aggregation
// ---------------------------------------------------------------------------

function sumCosts(costs: (number | null)[]): number | null {
  const known = costs.filter((c): c is number => c !== null);
  if (known.length === 0) return null;
  return known.reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// runOrchestration
// ---------------------------------------------------------------------------

export async function runOrchestration(
  taskPrompt: string,
  invoker: ModelInvoker,
  config?: Partial<OrchestratorConfig>,
): Promise<OrchestrationResult> {
  const cfg: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
  const allCosts: (number | null)[] = [];
  let totalLatencyMs = 0;

  // -------------------------------------------------------------------------
  // 1. Plan
  // -------------------------------------------------------------------------
  const planResp = await invoker.invoke("planner", buildPlannerPrompt(taskPrompt));
  allCosts.push(planResp.costUsd ?? null);
  totalLatencyMs += planResp.latencyMs;

  const plan = parsePlan(planResp.ok ? planResp.output : "", {
    maxSubtasks: cfg.maxSubtasks,
    fallbackPrompt: taskPrompt,
  });

  // -------------------------------------------------------------------------
  // 2. Fan-out workers
  // -------------------------------------------------------------------------
  const outcomes: SubtaskOutcome[] = await mapWithConcurrency(
    plan.subtasks,
    cfg.maxConcurrency,
    async (subtask): Promise<SubtaskOutcome> => {
      const result = await invoker.invoke("worker", buildWorkerPrompt(taskPrompt, subtask));
      allCosts.push(result.costUsd ?? null);
      totalLatencyMs += result.latencyMs;
      return { subtask, result };
    },
  );

  // -------------------------------------------------------------------------
  // 3. Verify (optional)
  // -------------------------------------------------------------------------
  if (cfg.verifyWorkers) {
    for (const outcome of outcomes) {
      if (!outcome.result.ok) continue; // skip failed workers
      const verifyResp = await invoker.invoke(
        "verifier",
        buildVerifierPrompt(outcome.subtask, outcome.result.output),
      );
      allCosts.push(verifyResp.costUsd ?? null);
      totalLatencyMs += verifyResp.latencyMs;
      outcome.verdict = parseVerdict(verifyResp.output);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Synthesize
  // -------------------------------------------------------------------------
  const successfulOutcomes = outcomes.filter((o) => o.result.ok);

  if (successfulOutcomes.length === 0) {
    // All workers failed
    const errors = outcomes.map((o) => o.result.error ?? "unknown error").join("; ");
    return {
      ok: false,
      finalOutput: "",
      plan,
      outcomes,
      totalCostUsd: sumCosts(allCosts),
      totalLatencyMs,
      error: `All workers failed: ${errors}`,
    };
  }

  let finalOutput: string;

  if (plan.strategy === "single" || successfulOutcomes.length === 1) {
    // Skip synth call to save cost
    finalOutput = successfulOutcomes[0].result.output;
  } else {
    const synthResp = await invoker.invoke(
      "synthesizer",
      buildSynthesizerPrompt(taskPrompt, successfulOutcomes),
    );
    allCosts.push(synthResp.costUsd ?? null);
    totalLatencyMs += synthResp.latencyMs;
    finalOutput = synthResp.output;
  }

  const ok = finalOutput.length > 0;

  return {
    ok,
    finalOutput,
    plan,
    outcomes,
    totalCostUsd: sumCosts(allCosts),
    totalLatencyMs,
    error: ok ? undefined : "Synthesizer returned empty output",
  };
}
