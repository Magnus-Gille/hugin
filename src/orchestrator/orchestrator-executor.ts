import * as fs from "node:fs";
import * as path from "node:path";
import {
  runOrchestration,
  type OrchestratorConfig,
  type OrchestrationResult,
} from "./engine.js";
import type { ModelInvoker } from "./model-invoker.js";
import { assertProvidersAllowSensitivity } from "./sensitivity-guard.js";
import type { Sensitivity } from "../sensitivity.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface OrchestratorTaskInput {
  prompt: string;
  sensitivity: Sensitivity;
  timeoutMs: number;
  maxOutputChars: number;
}

export interface OrchestratorExecResult {
  exitCode: number | "TIMEOUT";
  output: string;
  resultText: string | null;
  costUsd: number | null;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(
  prompt: string,
  result: OrchestrationResult,
  maxOutputChars: number,
): string {
  const lines: string[] = [];

  lines.push(`## Orchestration Result`);
  lines.push(``);
  lines.push(`- **Strategy:** ${result.plan.strategy}`);
  lines.push(`- **Subtasks:** ${result.outcomes.length}`);
  lines.push(`- **Total cost:** ${result.totalCostUsd !== null ? `$${result.totalCostUsd.toFixed(6)}` : "unknown"}`);
  lines.push(`- **Total latency:** ${result.totalLatencyMs}ms`);
  lines.push(`- **Outcome:** ${result.ok ? "ok" : `failed${result.error ? ` — ${result.error}` : ""}`}`);
  lines.push(``);

  if (result.outcomes.length > 0) {
    lines.push(`### Subtask Outcomes`);
    for (const [i, outcome] of result.outcomes.entries()) {
      const costStr =
        outcome.result.costUsd !== null && outcome.result.costUsd !== undefined
          ? ` ($${outcome.result.costUsd.toFixed(6)})`
          : "";
      const status = outcome.result.ok ? "ok" : `failed${outcome.result.error ? `: ${outcome.result.error}` : ""}`;
      lines.push(`- ${i + 1}. [${outcome.subtask.id}]: ${status}${costStr}`);
    }
    lines.push(``);
  }

  if (result.finalOutput) {
    lines.push(`### Final Output`);
    lines.push(``);
    lines.push(result.finalOutput);
  }

  const full = lines.join("\n");
  if (full.length <= maxOutputChars) return full;
  return full.slice(0, maxOutputChars);
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

/**
 * Run a task through the orchestration engine, enforcing sensitivity guards
 * and a task-level timeout.
 *
 * The `deps.signal` abort is checked before and after the engine run but does
 * NOT cancel in-flight model calls mid-engine (per-call timeouts via
 * `config.perCallTimeoutMs` bound spend). TODO: wire AbortSignal into
 * ModelInvoker.invoke() for mid-engine cancellation.
 */
export async function runOrchestratorTask(
  input: OrchestratorTaskInput,
  config: OrchestratorConfig,
  deps: {
    invoker: ModelInvoker;
    onLog?: (line: string) => void;
    signal?: AbortSignal;
  },
): Promise<OrchestratorExecResult> {
  const { onLog } = deps;

  // --- 1. Sensitivity guard — fail closed BEFORE any model calls ---
  const guardResult = assertProvidersAllowSensitivity(config, input.sensitivity);
  if (!guardResult.ok) {
    onLog?.(`[orchestrator] sensitivity guard rejected: ${guardResult.reason}`);
    return {
      exitCode: 1,
      output: guardResult.reason,
      resultText: null,
      costUsd: null,
    };
  }

  // --- 2. Check for abort before spending ---
  if (deps.signal?.aborted) {
    const reason = "aborted before execution started";
    onLog?.(`[orchestrator] ${reason}`);
    return { exitCode: 1, output: reason, resultText: null, costUsd: null };
  }

  onLog?.(`[orchestrator] starting (strategy will be determined by planner)`);

  // --- 3. Task-level timeout race ---
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<"TIMEOUT">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("TIMEOUT"), input.timeoutMs);
  });

  const enginePromise = runOrchestration(input.prompt, deps.invoker, config).then(
    (result): OrchestrationResult | "TIMEOUT" => result,
  );

  // Race the engine against the timeout.
  let raceResult: OrchestrationResult | "TIMEOUT";
  try {
    raceResult = await Promise.race([enginePromise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }

  // --- 4. Handle abort signal after run (if race completed first) ---
  if (deps.signal?.aborted) {
    const reason = "aborted after execution completed";
    onLog?.(`[orchestrator] ${reason}`);
    return { exitCode: 1, output: reason, resultText: null, costUsd: null };
  }

  // --- 5. Timeout path ---
  if (raceResult === "TIMEOUT") {
    onLog?.(`[orchestrator] task timed out after ${input.timeoutMs}ms`);
    return {
      exitCode: "TIMEOUT",
      output: `Orchestration timed out after ${input.timeoutMs}ms`,
      resultText: null,
      costUsd: null,
    };
  }

  // --- 6. Map OrchestrationResult → OrchestratorExecResult ---
  const result = raceResult;

  onLog?.(`[orchestrator] planner ok — strategy=${result.plan.strategy} subtasks=${result.outcomes.length}`);

  for (const [i, outcome] of result.outcomes.entries()) {
    const costStr =
      outcome.result.costUsd !== null && outcome.result.costUsd !== undefined
        ? ` ($${outcome.result.costUsd.toFixed(6)})`
        : "";
    const status = outcome.result.ok ? "ok" : "failed";
    onLog?.(
      `[orchestrator] worker ${i + 1}/${result.outcomes.length} ${status}${costStr} — [${outcome.subtask.id}]`,
    );
  }

  onLog?.(`[orchestrator] ${result.ok ? "done" : "failed"} — total_cost=${result.totalCostUsd !== null ? `$${result.totalCostUsd.toFixed(6)}` : "unknown"} latency=${result.totalLatencyMs}ms`);

  const exitCode = result.ok ? 0 : 1;
  const output = buildSummary(input.prompt, result, input.maxOutputChars);
  const resultText = result.finalOutput || null;
  const costUsd = result.totalCostUsd;

  return { exitCode, output, resultText, costUsd };
}
