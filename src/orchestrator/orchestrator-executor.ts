import * as fs from "node:fs";
import * as path from "node:path";
import {
  runOrchestration,
  type OrchestratorConfig,
  type OrchestrationResult,
  type ConfidenceFn,
  type SubtaskOutcome,
} from "./engine.js";
import type { ModelInvoker } from "./model-invoker.js";
import { assertProvidersAllowSensitivity } from "./sensitivity-guard.js";
import type { Sensitivity } from "../sensitivity.js";
import type { VerdictStoreLike, VerdictEvent } from "./verdict-store.js";
import type { LedgerClientLike } from "./ledger-client.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface OrchestratorTaskInput {
  prompt: string;
  sensitivity: Sensitivity;
  timeoutMs: number;
  maxOutputChars: number;
  /**
   * Resolved `Context-refs` content to inject into the engine prompt, mirroring
   * the Ollama path (Codex review of #127). Combined into the prompt only AFTER
   * the sensitivity guard passes, so it never materializes for a rejected task.
   */
  injectedContext?: string;
}

export interface OrchestratorExecResult {
  exitCode: number | "TIMEOUT";
  output: string;
  resultText: string | null;
  costUsd: number | null;
  /**
   * Per-worker outcomes from the engine (verdict layer V8) — empty when the
   * run never reached a completed OrchestrationResult (sensitivity guard
   * rejection, pre-execution abort, timeout, or post-completion abort).
   * Consumed by src/index.ts to populate the structured result's
   * `orchestratorOutcomes` field.
   */
  outcomes: SubtaskOutcome[];
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

  if (result.warnings.length > 0) {
    lines.push(`### Warnings`);
    for (const w of result.warnings) {
      lines.push(`- ⚠️ ${w}`);
    }
    lines.push(``);
  }

  if (result.outcomes.length > 0) {
    lines.push(`### Subtask Outcomes`);
    for (const [i, outcome] of result.outcomes.entries()) {
      const costStr =
        outcome.result.costUsd !== null && outcome.result.costUsd !== undefined
          ? ` ($${outcome.result.costUsd.toFixed(6)})`
          : "";
      const status = outcome.result.ok ? "ok" : `failed${outcome.result.error ? `: ${outcome.result.error}` : ""}`;
      // Verdict layer (V8): surface the worker model and, when a subtask was
      // explicitly failed by the verifier, a ✗ marker — never shown for an
      // unverified outcome (verdict undefined) or a passed verdict.
      const verdictMarker = outcome.verdict?.ok === false ? " ✗ verdict" : "";
      lines.push(
        `- ${i + 1}. [${outcome.subtask.id}] (${outcome.result.model}): ${status}${costStr}${verdictMarker}`,
      );
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
 * Cancellation (issue #110): an internal AbortController is threaded into the
 * engine and every model call. It fires when EITHER the task-level timeout wins
 * the race OR the operator/shutdown `deps.signal` aborts — so a timeout/cancel
 * aborts in-flight fetch/child work instead of letting it spend until the
 * per-call timeout. Per-call timeouts remain the backstop.
 */
export async function runOrchestratorTask(
  input: OrchestratorTaskInput,
  config: OrchestratorConfig,
  deps: {
    invoker: ModelInvoker;
    onLog?: (line: string) => void;
    signal?: AbortSignal;
    /**
     * Verdict layer (V4): when present, every worker outcome is recorded as
     * a pass/fail/error event after the run, AND (when config.adaptiveVerify
     * is on and the worker role is NOT bound to "homeserver") consulted for
     * the adaptive verify gate's confidence lookup (V5).
     */
    verdictStore?: VerdictStoreLike;
    /**
     * Verdict layer (V7): confidence source for the adaptive verify gate
     * when the worker role IS bound to "homeserver" — reads the M5 gateway's
     * own `/ledger` recommendation rather than Hugin's own store (D5).
     */
    ledgerClient?: LedgerClientLike;
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
      outcomes: [],
    };
  }

  // --- 2. Check for abort before spending ---
  if (deps.signal?.aborted) {
    const reason = "aborted before execution started";
    onLog?.(`[orchestrator] ${reason}`);
    return { exitCode: 1, output: reason, resultText: null, costUsd: null, outcomes: [] };
  }

  onLog?.(`[orchestrator] starting (strategy will be determined by planner)`);

  // --- 2.5. Adaptive verify gate confidence source (V5) ---
  // Built ONCE per task (one store read / one ledger fetch, per the ADR's
  // "hydrates nothing at boot" wiring note) and wrapped in a plain sync
  // closure so the pure engine never does I/O of its own.
  const confidenceFn = await buildConfidenceFn(config, deps, onLog);

  // Build the engine prompt only after the guard has passed: prepend any
  // resolved Context-refs as a `## Context` section (Codex review of #127).
  const enginePrompt = input.injectedContext
    ? `## Context\n${input.injectedContext}\n\n${input.prompt}`
    : input.prompt;
  if (input.injectedContext) {
    onLog?.(`[orchestrator] injected context: ${input.injectedContext.length} chars`);
  }

  // --- 3. Task-level timeout race ---
  // Internal controller threaded into the engine (issue #110). It aborts when
  // the timeout wins OR the caller's signal fires, cancelling in-flight calls.
  const engineAbort = new AbortController();
  const forwardCallerAbort = () => engineAbort.abort();
  deps.signal?.addEventListener("abort", forwardCallerAbort, { once: true });

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<"TIMEOUT">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("TIMEOUT"), input.timeoutMs);
  });

  const enginePromise = runOrchestration(enginePrompt, deps.invoker, config, {
    signal: engineAbort.signal,
    confidence: confidenceFn,
  }).then((result): OrchestrationResult | "TIMEOUT" => result);

  // Race the engine against the timeout.
  let raceResult: OrchestrationResult | "TIMEOUT";
  try {
    raceResult = await Promise.race([enginePromise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    // If the timeout won, abort the still-running engine so its in-flight model
    // calls are cancelled rather than left spending until their per-call timeout.
    if (!engineAbort.signal.aborted) engineAbort.abort();
    deps.signal?.removeEventListener("abort", forwardCallerAbort);
  }

  // --- 4. Handle abort signal after run (if race completed first) ---
  if (deps.signal?.aborted) {
    const reason = "aborted after execution completed";
    onLog?.(`[orchestrator] ${reason}`);
    return { exitCode: 1, output: reason, resultText: null, costUsd: null, outcomes: [] };
  }

  // --- 5. Timeout path ---
  if (raceResult === "TIMEOUT") {
    onLog?.(`[orchestrator] task timed out after ${input.timeoutMs}ms`);
    return {
      exitCode: "TIMEOUT",
      output: `Orchestration timed out after ${input.timeoutMs}ms`,
      resultText: null,
      costUsd: null,
      outcomes: [],
    };
  }

  // --- 6. Map OrchestrationResult → OrchestratorExecResult ---
  const result = raceResult;

  // --- 6a. Verdict recording (V3/V4) — fire-and-forget per outcome, never
  // throws (VerdictStore.record self-catches; recordVerdictEvents guards too).
  await recordVerdictEvents(deps.verdictStore, result.outcomes, onLog);

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

  for (const w of result.warnings) {
    onLog?.(`[orchestrator] warning: ${w}`);
  }

  onLog?.(`[orchestrator] ${result.ok ? "done" : "failed"} — total_cost=${result.totalCostUsd !== null ? `$${result.totalCostUsd.toFixed(6)}` : "unknown"} latency=${result.totalLatencyMs}ms`);

  const exitCode = result.ok ? 0 : 1;
  const output = buildSummary(input.prompt, result, input.maxOutputChars);
  const resultText = result.finalOutput || null;
  const costUsd = result.totalCostUsd;

  return { exitCode, output, resultText, costUsd, outcomes: result.outcomes };
}

// ---------------------------------------------------------------------------
// Verdict layer helpers (V3/V4/V5/V7)
// ---------------------------------------------------------------------------

/**
 * Build the engine's synchronous confidence lookup (V5) from whichever
 * source applies to the CURRENT worker role binding:
 *   - `homeserver` worker provider → the M5 gateway ledger (V7, D5's local
 *     lane), read verbatim (the gateway already computes `recommendation`).
 *   - any other provider → Hugin's own verdict store (V4), pre-loaded once
 *     into a plain Map and looked up synchronously.
 *
 * Returns `undefined` when adaptive verify is off, or when the applicable
 * dependency wasn't supplied — the engine then falls back to its unchanged
 * default (no adaptive gating).
 */
async function buildConfidenceFn(
  config: OrchestratorConfig,
  deps: { verdictStore?: VerdictStoreLike; ledgerClient?: LedgerClientLike },
  onLog?: (line: string) => void,
): Promise<ConfidenceFn | undefined> {
  if (!config.adaptiveVerify) return undefined;

  const workerProvider = config.roles.worker.provider;

  if (workerProvider === "homeserver") {
    if (!deps.ledgerClient) return undefined;
    const ledger = await deps.ledgerClient.getLedger();
    if (!ledger) {
      onLog?.(
        "[orchestrator] ledger unavailable for adaptive verify — degrading to always-verify",
      );
      return () => null;
    }
    return (model, taskType) => {
      const row = ledger.report.find((r) => r.modelId === model && r.taskType === taskType);
      return row ? row.recommendation : null;
    };
  }

  if (!deps.verdictStore) return undefined;
  const recommendations = await deps.verdictStore.loadRecommendations();
  return (model, taskType) => recommendations.get(`${model}|${taskType}`) ?? "explore";
}

/**
 * Record exactly one verdict event per outcome (V3): "error" for an infra
 * worker failure, "fail" for an explicit failed verifier verdict, "pass"
 * otherwise (including a never-verified or verifier-outage-unknown outcome).
 * No-op when no verdictStore was supplied. Never throws — VerdictStore.record
 * already self-catches; the try/catch here is defense in depth so a rogue
 * VerdictStoreLike implementation (e.g. in tests) can't break the task.
 */
async function recordVerdictEvents(
  verdictStore: VerdictStoreLike | undefined,
  outcomes: SubtaskOutcome[],
  onLog?: (line: string) => void,
): Promise<void> {
  if (!verdictStore) return;
  for (const outcome of outcomes) {
    const event: VerdictEvent = !outcome.result.ok
      ? "error"
      : outcome.verdict?.ok === false
        ? "fail"
        : "pass";
    try {
      await verdictStore.record(
        outcome.result.model,
        outcome.subtask.taskType,
        event,
        outcome.result.latencyMs,
      );
    } catch (err) {
      onLog?.(
        `[orchestrator] verdict recording failed unexpectedly: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
