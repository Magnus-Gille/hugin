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
import type { VerdictStoreLike, VerdictEvent, VerdictBatchEvent } from "./verdict-store.js";
import type { LedgerClientLike } from "./ledger-client.js";
import type { SavingsStoreLike } from "./savings-store.js";
import {
  computeSavings,
  type SavingsSummary,
  type SavingsVerdictOutcome,
} from "./savings.js";
import { parseIntEnv, isSavingsEnabled, resolveSavingsBaselineModel } from "./config.js";
import { selectOrinMacroRoute } from "./orin-macro-route.js";

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
  /**
   * Savings vs the configured baseline model (PR3, S4 —
   * docs/orchestrator-savings-tracker.md), computed from the engine's
   * modelCalls ledger. `null` when never computed: HUGIN_ORCH_SAVINGS=off,
   * the configured baseline model isn't in MODEL_PRICING, or the run never
   * reached a completed OrchestrationResult (sensitivity guard rejection,
   * pre-execution abort, or timeout). Consumed by src/index.ts to populate
   * the structured result's `savings` field.
   */
  savings: SavingsSummary | null;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(
  prompt: string,
  result: OrchestrationResult,
  maxOutputChars: number,
  savings: SavingsSummary | null,
): string {
  const lines: string[] = [];

  lines.push(`## Orchestration Result`);
  lines.push(``);
  lines.push(`- **Strategy:** ${result.plan.strategy}`);
  lines.push(`- **Subtasks:** ${result.outcomes.length}`);
  lines.push(`- **Total cost:** ${result.totalCostUsd !== null ? `$${result.totalCostUsd.toFixed(6)}` : "unknown"}`);
  if (savings) {
    // Savings tracker (PR3, S4) — one line, only when actually computed.
    lines.push(
      `- **Savings vs ${savings.baselineModelId}:** $${savings.savedUsd.toFixed(4)} (actual $${savings.actualCostUsd.toFixed(4)}, ${savings.coveredCalls} covered / ${savings.uncoveredCalls} uncovered calls)`,
    );
    // Quality-adjusted headline (issue #144): the verdict-joined series —
    // failed/escalated subtask spend books at full cost with no baseline
    // credit, and verification cost is attributed to the local attempt.
    const outcomeCounts = Object.entries(savings.byOutcome)
      .map(([outcome, bucket]) => `${outcome}: ${bucket.calls}`)
      .join(", ");
    lines.push(
      `- **Quality-adjusted savings:** $${savings.qualityAdjustedSavedUsd.toFixed(4)}${outcomeCounts ? ` (calls by verdict — ${outcomeCounts})` : ""}`,
    );
  }
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
    /**
     * Savings tracker (PR3, S3/S4 — docs/orchestrator-savings-tracker.md):
     * when present AND savings were computed for this run (HUGIN_ORCH_SAVINGS
     * is not "off" and the baseline model is priced), the run's SavingsSummary
     * is recorded here, detached (fire-and-forget), alongside verdict
     * recording.
     */
    savingsStore?: SavingsStoreLike;
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
      savings: null,
    };
  }

  // --- 2. Check for abort before spending ---
  if (deps.signal?.aborted) {
    const reason = "aborted before execution started";
    onLog?.(`[orchestrator] ${reason}`);
    return {
      exitCode: 1,
      output: reason,
      resultText: null,
      costUsd: null,
      outcomes: [],
      savings: null,
    };
  }

  onLog?.(`[orchestrator] starting (strategy will be determined by planner)`);

  // --- 2.5. Wire abort forwarding BEFORE the confidence-source load (Fix #3).
  // Internal controller threaded into the engine (issue #110). It aborts when
  // the timeout wins OR the caller's signal fires, cancelling in-flight calls.
  // This MUST be set up before buildConfidenceFn's internal await (a store
  // read / ledger fetch) — otherwise an abort that fires DURING that await is
  // lost: deps.signal already flips to aborted before the listener exists,
  // and addEventListener never retroactively fires for a past event.
  const engineAbort = new AbortController();
  const forwardCallerAbort = () => engineAbort.abort();
  deps.signal?.addEventListener("abort", forwardCallerAbort, { once: true });

  // --- 2.6. Adaptive verify gate confidence source (V5) ---
  // Built ONCE per task (one store read / one ledger fetch, per the ADR's
  // "hydrates nothing at boot" wiring note) and wrapped in a plain sync
  // closure so the pure engine never does I/O of its own. Time-bounded
  // (Fix #3) — a hanging store/ledger read must not stall the task.
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
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<"TIMEOUT">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("TIMEOUT"), input.timeoutMs);
  });

  const enginePromise = runOrchestration(enginePrompt, deps.invoker, config, {
    signal: engineAbort.signal,
    confidence: confidenceFn,
    // Route selection happens only after the task-level sensitivity guard
    // above. The pure engine merely forwards this bounded Hugin decision to
    // each worker leaf; it never delegates node selection to the gateway.
    workerRoute: (taskType) =>
      selectOrinMacroRoute({
        workerProvider: config.roles.worker.provider,
        taskType,
        sensitivity: input.sensitivity,
      }),
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
    return {
      exitCode: 1,
      output: reason,
      resultText: null,
      costUsd: null,
      outcomes: [],
      savings: null,
    };
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
      savings: null,
    };
  }

  // --- 6. Map OrchestrationResult → OrchestratorExecResult ---
  const result = raceResult;

  // --- 6a. Verdict recording (Fix #1/#2) — TRULY fire-and-forget: task
  // completion must NEVER wait on Munin traffic. Not awaited — deliberately.
  // recordVerdictEvents/VerdictStore.recordBatch already self-catch; the
  // trailing .catch() here is defense in depth against a rogue
  // VerdictStoreLike implementation (e.g. in tests) throwing synchronously.
  void recordVerdictEvents(deps.verdictStore, result.outcomes, onLog).catch(() => {});

  // --- 6b. Savings computation + recording (PR3, S2-S4) — computed from the
  // engine's per-call ledger, never from totalCostUsd (all-or-nothing-null).
  // Gated on HUGIN_ORCH_SAVINGS (default on); the configured baseline model
  // must be priced in MODEL_PRICING or savings are disabled for this run
  // (logged once via onLog, never per call). Recording is detached
  // fire-and-forget, same contract as verdict recording above.
  let savings: SavingsSummary | null = null;
  if (isSavingsEnabled(process.env)) {
    const baselineModelId = resolveSavingsBaselineModel(process.env, onLog);
    if (baselineModelId) {
      // Quality-adjusted join (issue #144): verification runs INSIDE
      // runOrchestration (before it returns), so every subtask's verdict is
      // already final here — a single write-time join, no two-phase write.
      // An adaptive-verify skip is semantically "unknown" (never verified
      // this run), not "pending".
      savings = computeSavings(
        result.modelCalls,
        baselineModelId,
        buildVerdictOutcomeMap(result.outcomes),
      );
    }
  }
  if (deps.savingsStore && savings) {
    void deps.savingsStore.record(savings).catch(() => {});
  }

  onLog?.(`[orchestrator] planner ok — strategy=${result.plan.strategy} subtasks=${result.outcomes.length}`);

  for (const [i, outcome] of result.outcomes.entries()) {
    const costStr =
      outcome.result.costUsd !== null && outcome.result.costUsd !== undefined
        ? ` ($${outcome.result.costUsd.toFixed(6)})`
        : "";
    // Surface the worker's exact failure reason in the task log (issue #157)
    // — a busy-gateway rejection must read as what it is, not agent flakiness.
    const status = outcome.result.ok
      ? "ok"
      : `failed${outcome.result.error ? `: ${outcome.result.error}` : ""}`;
    const route = outcome.result.selectedNode
      ? ` node=${outcome.result.selectedNode}->${outcome.result.effectiveNode ?? outcome.result.selectedNode}${
          outcome.result.fallbackTriggered
            ? ` fallback=${outcome.result.fallbackReason ?? "gateway unavailable"}`
            : ""
        }`
      : "";
    onLog?.(
      `[orchestrator] worker ${i + 1}/${result.outcomes.length} ${status}${costStr}${route} — [${outcome.subtask.id}]`,
    );
  }

  for (const w of result.warnings) {
    onLog?.(`[orchestrator] warning: ${w}`);
  }

  onLog?.(`[orchestrator] ${result.ok ? "done" : "failed"} — total_cost=${result.totalCostUsd !== null ? `$${result.totalCostUsd.toFixed(6)}` : "unknown"} latency=${result.totalLatencyMs}ms`);

  const exitCode = result.ok ? 0 : 1;
  const output = buildSummary(input.prompt, result, input.maxOutputChars, savings);
  const resultText = result.finalOutput || null;
  const costUsd = result.totalCostUsd;

  return { exitCode, output, resultText, costUsd, outcomes: result.outcomes, savings };
}

// ---------------------------------------------------------------------------
// Verdict layer helpers (V1/V3/V4/V5/V7 + Fix #1/#2/#3/#9)
// ---------------------------------------------------------------------------

/**
 * Deadline (Fix #3) for the confidence-source load inside buildConfidenceFn:
 * a hanging Munin read or gateway fetch must not stall the whole task. On
 * timeout the source degrades to "no signal", which every call site here
 * treats as `null` — the engine's adaptive gate reads `null` as "verify"
 * (fail toward caution, never toward silently skipping verification).
 */
export const CONFIDENCE_SOURCE_TIMEOUT_MS = 5_000;

/**
 * Default re-probe threshold (Fix #1, HUGIN_ORCH_REPROBE_UNVERIFIED). Once a
 * (model × taskType) row's unverified-pass streak reaches this many
 * consecutive unverified successes, the adaptive gate forces one more
 * verify even though the derived recommendation is "delegate-local" —
 * otherwise a row that only ever skips verification (because it's trusted)
 * can never generate the VERIFIED pass/fail that would refresh its
 * confidence, making "delegate-local" an absorbing state.
 */
const DEFAULT_REPROBE_UNVERIFIED = 10;

/** Race `promise` against a timeout; resolves to `onTimeout` if it fires first. Never rejects on timeout. */
async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build the engine's synchronous confidence lookup (V5) from whichever
 * source applies to the CURRENT worker role binding:
 *   - `homeserver` worker provider → the M5 gateway ledger (V7, D5's local
 *     lane), read verbatim (the gateway already computes `recommendation`).
 *   - any other provider → Hugin's own verdict store (V4), pre-loaded once
 *     into a plain Map and looked up synchronously. A row whose
 *     recommendation is "delegate-local" but whose unverified-pass streak
 *     has crossed HUGIN_ORCH_REPROBE_UNVERIFIED is downgraded to "explore"
 *     (Fix #1's re-probe — breaks the absorbing state).
 *
 * Returns `undefined` ONLY when adaptive verify itself is off (config flag),
 * in which case the engine never even consults `confidence`. When adaptive
 * verify IS on but the applicable dependency (verdictStore/ledgerClient) is
 * missing, or its load times out or fails, this ALWAYS returns a function
 * that resolves to `null` (Fix #9) — the engine reads `null` as "verify",
 * so a missing/broken confidence source fails TOWARD caution, never toward
 * silently skipping verification.
 */
async function buildConfidenceFn(
  config: OrchestratorConfig,
  deps: { verdictStore?: VerdictStoreLike; ledgerClient?: LedgerClientLike },
  onLog?: (line: string) => void,
): Promise<ConfidenceFn | undefined> {
  if (!config.adaptiveVerify) return undefined;

  const workerProvider = config.roles.worker.provider;

  if (workerProvider === "homeserver") {
    if (!deps.ledgerClient) return () => null;
    const ledger = await withDeadline(
      deps.ledgerClient.getLedger(),
      CONFIDENCE_SOURCE_TIMEOUT_MS,
      null,
    );
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

  if (!deps.verdictStore) return () => null;
  const reprobeThreshold = parseIntEnv(
    process.env.HUGIN_ORCH_REPROBE_UNVERIFIED,
    DEFAULT_REPROBE_UNVERIFIED,
  );
  const recommendations = await withDeadline(
    deps.verdictStore.loadRecommendations(),
    CONFIDENCE_SOURCE_TIMEOUT_MS,
    null,
  );
  if (!recommendations) {
    onLog?.(
      "[orchestrator] verdict store unavailable for adaptive verify — degrading to always-verify",
    );
    return () => null;
  }
  return (model, taskType) => {
    const row = recommendations.get(`${model}|${taskType}`);
    if (!row) return "explore";
    if (row.recommendation === "delegate-local" && row.unverifiedPasses >= reprobeThreshold) {
      // Fix #1 — re-probe: force one more verify so a permanently unverified
      // "trusted" row can generate the VERIFIED event that refreshes it.
      return "explore";
    }
    return row.recommendation;
  };
}

/**
 * Classify one outcome into exactly one verdict event (Fix #1 — the
 * verified/unverified separation that closes the confidence-poisoning gap):
 *   - "error"      — the worker call itself failed (infra).
 *   - "fail"        — the worker succeeded but the verifier gave an explicit
 *                     failed verdict.
 *   - "pass"        — the worker succeeded AND the verifier gave an explicit
 *                     PASSED verdict. The ONLY event that counts as verified
 *                     quality signal alongside "fail".
 *   - "unverified"  — the worker succeeded but was NEVER checked by a
 *                     verifier (verdict undefined — skipped by the adaptive
 *                     gate, or the verifier call/parse failed). This must
 *                     NEVER be recorded as "pass": that was the bug (every
 *                     unverified success poisoned the store with fake
 *                     confidence, making "delegate-local" — and therefore
 *                     skip-verification — an absorbing state).
 */
function classifyVerdictEvent(outcome: SubtaskOutcome): VerdictEvent {
  if (!outcome.result.ok) return "error";
  if (outcome.verdict?.ok === true) return "pass";
  if (outcome.verdict?.ok === false) return "fail";
  return "unverified";
}

/**
 * Map a run's subtask outcomes to the savings tracker's verdict-outcome join
 * key (issue #144), keyed by subtask id. Same classification as
 * classifyVerdictEvent, viewed from the savings side: the verdict layer's
 * "unverified" is savings' "unknown". "escalated" cannot be produced yet —
 * the engine has no escalation path; when it grows one, the escalating
 * outcome must map here so the escalation cost lands on the causing attempt.
 */
export function buildVerdictOutcomeMap(
  outcomes: SubtaskOutcome[],
): Record<string, SavingsVerdictOutcome> {
  const map: Record<string, SavingsVerdictOutcome> = {};
  for (const outcome of outcomes) {
    const event = classifyVerdictEvent(outcome);
    map[outcome.subtask.id] = event === "unverified" ? "unknown" : event;
  }
  return map;
}

/**
 * Record ALL of a run's outcomes in ONE batched call (Fix #2) — bounds
 * worst-case Munin traffic per task to a single read + single write
 * regardless of subtask count. No-op when no verdictStore was supplied.
 * Never throws — VerdictStore.recordBatch already self-catches; the
 * try/catch here is defense in depth so a rogue VerdictStoreLike
 * implementation (e.g. in tests) can't break the task.
 */
async function recordVerdictEvents(
  verdictStore: VerdictStoreLike | undefined,
  outcomes: SubtaskOutcome[],
  onLog?: (line: string) => void,
): Promise<void> {
  if (!verdictStore) return;
  const events: VerdictBatchEvent[] = outcomes.map((outcome) => ({
    modelId: outcome.result.model,
    taskType: outcome.subtask.taskType,
    event: classifyVerdictEvent(outcome),
    latencyMs: outcome.result.latencyMs,
  }));
  try {
    await verdictStore.recordBatch(events);
  } catch (err) {
    onLog?.(
      `[orchestrator] verdict recording failed unexpectedly: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
