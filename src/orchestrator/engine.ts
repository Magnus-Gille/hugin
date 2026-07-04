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
  /**
   * Default completion-token cap sent to every model call (issue #112).
   * A per-role RoleBinding.maxTokens overrides this for that role.
   */
  maxTokens: number;
  /**
   * Adaptive quality gate (verdict layer V5, HUGIN_ORCH_ADAPTIVE_VERIFY).
   * When true (and `verifyWorkers` is false), the verifier is consulted
   * selectively per subtask based on the injected `confidence` lookup rather
   * than run on every successful worker. `verifyWorkers: true` always wins
   * (verify everything) regardless of this flag.
   */
  adaptiveVerify: boolean;
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
  maxTokens: 4096,
  adaptiveVerify: false,
};

/**
 * Confidence recommendation for a (model × task-type) pair, as derived by the
 * verdict store (cloud providers) or read verbatim from the M5 gateway ledger
 * (homeserver-bound workers). See docs/orchestrator-verdict-layer.md V4/V5/V7.
 */
export type ConfidenceRecommendation = "delegate-local" | "escalate-frontier" | "explore";

/**
 * Lookup injected into the engine for the adaptive verify gate (V5). Returns
 * `null` when no signal is available (fail-open — treated as "verify").
 * Synchronous by design: the executor pre-fetches store/ledger data once per
 * task and wraps it in a plain closure, keeping the engine itself pure (no
 * I/O of its own).
 */
export type ConfidenceFn = (
  model: string,
  taskType: string,
) => ConfidenceRecommendation | null;

export interface SubtaskOutcome {
  subtask: SubTask;
  result: WorkerResult;
  verdict?: { ok: boolean; notes?: string };
}

/**
 * A per-call ledger entry (savings tracker S1, docs/orchestrator-savings-tracker.md)
 * recorded for EVERY model invocation the engine makes — planner, each
 * worker, each verifier, and the synthesizer — regardless of success. This is
 * pure bookkeeping of data the engine already holds (WorkerResult), pushed at
 * every existing `allCosts.push(...)` site. Savings are computed downstream
 * PER CALL from this ledger, never from `totalCostUsd` (which is
 * all-or-nothing-null — see sumCosts below).
 */
export interface ModelCallRecord {
  role: OrchestratorRole;
  provider: string;
  model: string;
  ok: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  /**
   * Subtask this call was spent ON (issue #144) — set for worker and verifier
   * calls (and any future escalation/retry call, which MUST carry the id of
   * the local attempt that caused it); absent for planner/synthesizer calls,
   * which belong to the run as a whole. This is what lets the savings tracker
   * attribute verification/escalation cost BACK to the local attempt instead
   * of booking it as independent frontier spend.
   */
  subtaskId?: string;
}

export interface OrchestrationResult {
  ok: boolean;
  finalOutput: string;
  plan: OrchestrationPlan;
  outcomes: SubtaskOutcome[];
  /**
   * Sum across ALL invocations; null when there are no calls or ANY
   * invocation has unknown cost (all-or-nothing — see sumCosts). Savings are
   * therefore computed per call from `modelCalls`, never from this total.
   */
  totalCostUsd: number | null;
  totalLatencyMs: number;
  /**
   * Per-call ledger (savings tracker S1) — one entry per model invocation
   * (planner/worker/verifier/synthesizer), in the order calls were made.
   * Populated even on the early "all workers failed" return (whatever calls
   * were made up to that point are still recorded).
   */
  modelCalls: ModelCallRecord[];
  /**
   * Non-fatal warnings surfaced to the caller (issue #112) — e.g. a planner,
   * worker, or synthesizer response that hit the completion-token cap
   * (finish_reason=length) and is therefore incomplete. Empty when clean.
   */
  warnings: string[];
  error?: string;
}

/** Build a ModelCallRecord from a role and the WorkerResult it produced. */
function toModelCallRecord(
  role: OrchestratorRole,
  result: WorkerResult,
  subtaskId?: string,
): ModelCallRecord {
  return {
    role,
    provider: result.provider,
    model: result.model,
    ok: result.ok,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    ...(subtaskId !== undefined ? { subtaskId } : {}),
  };
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

/**
 * Parse a verifier response into a verdict, or `undefined` when the output
 * can't be reliably read as PASS/FAIL (Fix #4).
 *
 * Priority order:
 *   1. JSON `{ "ok": true/false, "notes"?: string }` anywhere in the output.
 *   2. A PASS/FAIL token at the START of the first non-empty line (the shape
 *      buildVerifierPrompt asks for) — this is checked BEFORE any substring
 *      search so a note like "PASS — would otherwise FAIL on X" is read as
 *      PASS, not misclassified as FAIL by a naive "contains FAIL" check.
 *   3. Fallback: an UNAMBIGUOUS single occurrence of PASS or FAIL anywhere
 *      (word-boundary) — only when exactly one of the two appears.
 *   4. Otherwise (empty, gibberish, or both/neither present) → `undefined`.
 *      Never defaults to `{ ok: true }` — an unparseable verdict must never
 *      masquerade as a verified pass.
 */
function parseVerdict(output: string): { ok: boolean; notes?: string } | undefined {
  // 1. Try JSON first: { "ok": true/false, "notes"?: string }
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

  // 2. Leading token on the first non-empty line.
  const firstLine = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const leadingMatch = firstLine?.match(/^(PASS|FAIL)\b/i);
  if (leadingMatch) {
    return { ok: leadingMatch[1].toUpperCase() === "PASS", notes: output.trim() || undefined };
  }

  // 3. Fallback: trust an unambiguous lone occurrence anywhere in the text.
  const hasPass = /\bPASS\b/i.test(output);
  const hasFail = /\bFAIL\b/i.test(output);
  if (hasPass && !hasFail) return { ok: true, notes: output.trim() || undefined };
  if (hasFail && !hasPass) return { ok: false, notes: output.trim() || undefined };

  // 4. Unparseable / ambiguous (both or neither) — never assume ok.
  return undefined;
}

// ---------------------------------------------------------------------------
// Cost aggregation
// ---------------------------------------------------------------------------

/**
 * Sum costs across all invocations.
 *
 * Returns null if:
 * - No costs were recorded (costs is empty).
 * - ANY recorded cost is null (cost unknown for that invocation — reporting a
 *   partial sum would under-report and mislead; null is the honest answer).
 *
 * Returns a numeric sum only when ALL costs are known.
 */
function sumCosts(costs: (number | null)[]): number | null {
  if (costs.length === 0) return null;
  if (costs.some((c) => c === null)) return null;
  return (costs as number[]).reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// runOrchestration
// ---------------------------------------------------------------------------

export interface RunOrchestrationOpts {
  signal?: AbortSignal;
  /** Adaptive verify gate lookup (V5) — see ConfidenceFn. */
  confidence?: ConfidenceFn;
}

/**
 * Decide whether a given subtask's worker output should be sent through the
 * verifier.
 *
 *   - `verifyWorkers: true` always wins — verify everything (unchanged).
 *   - Else, if adaptive verify is on AND a confidence fn was supplied, verify
 *     unless the derived recommendation is exactly "delegate-local" (trust).
 *     A `null` (unknown/no-signal) recommendation still verifies — fail-open
 *     toward caution.
 *   - Else, no verification (unchanged default behavior).
 */
function shouldVerifySubtask(
  cfg: OrchestratorConfig,
  confidence: ConfidenceFn | undefined,
  model: string,
  taskType: string,
): boolean {
  if (cfg.verifyWorkers) return true;
  if (cfg.adaptiveVerify && confidence) {
    return confidence(model, taskType) !== "delegate-local";
  }
  return false;
}

export async function runOrchestration(
  taskPrompt: string,
  invoker: ModelInvoker,
  config?: Partial<OrchestratorConfig>,
  opts?: RunOrchestrationOpts,
): Promise<OrchestrationResult> {
  const cfg: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
  const signal = opts?.signal;
  const allCosts: (number | null)[] = [];
  const modelCalls: ModelCallRecord[] = [];
  const warnings: string[] = [];
  let totalLatencyMs = 0;

  // -------------------------------------------------------------------------
  // 1. Plan
  // -------------------------------------------------------------------------
  const planResp = await invoker.invoke("planner", buildPlannerPrompt(taskPrompt), { signal });
  allCosts.push(planResp.costUsd ?? null);
  modelCalls.push(toModelCallRecord("planner", planResp));
  totalLatencyMs += planResp.latencyMs;
  if (planResp.ok && planResp.truncated) {
    warnings.push(
      "planner output was truncated (finish_reason=length); the plan may be incomplete",
    );
  }

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
      const result = await invoker.invoke("worker", buildWorkerPrompt(taskPrompt, subtask), {
        signal,
      });
      allCosts.push(result.costUsd ?? null);
      modelCalls.push(toModelCallRecord("worker", result, subtask.id));
      totalLatencyMs += result.latencyMs;
      if (result.ok && result.truncated) {
        warnings.push(
          `worker output for subtask ${subtask.id} was truncated (finish_reason=length); output may be incomplete`,
        );
      }
      return { subtask, result };
    },
  );

  // -------------------------------------------------------------------------
  // 3. Verify (optional / adaptive — verdict layer V3 + V5)
  // -------------------------------------------------------------------------
  for (const outcome of outcomes) {
    if (!outcome.result.ok) continue; // skip failed workers
    const verify = shouldVerifySubtask(
      cfg,
      opts?.confidence,
      outcome.result.model,
      outcome.subtask.taskType,
    );
    if (!verify) continue;

    const verifyResp = await invoker.invoke(
      "verifier",
      buildVerifierPrompt(outcome.subtask, outcome.result.output),
      { signal },
    );
    allCosts.push(verifyResp.costUsd ?? null);
    modelCalls.push(toModelCallRecord("verifier", verifyResp, outcome.subtask.id));
    totalLatencyMs += verifyResp.latencyMs;
    if (verifyResp.ok && verifyResp.truncated) {
      warnings.push(
        `verifier output for subtask ${outcome.subtask.id} was truncated (finish_reason=length); the verdict may be unreliable`,
      );
    }

    if (!verifyResp.ok) {
      // V3 bug fix: a failed verifier CALL (infra outage) must not read as a
      // silent PASS via parseVerdict(""). Leave the verdict undefined — the
      // outcome still counts as a plain worker pass, never a verified pass.
      warnings.push(
        `verifier call failed for subtask ${outcome.subtask.id}: ${verifyResp.error ?? "unknown error"}; verdict left unknown`,
      );
      continue;
    }

    const verdict = parseVerdict(verifyResp.output);
    if (verdict === undefined) {
      // Fix #4: the verifier responded, but its output couldn't be reliably
      // read as PASS/FAIL (empty, gibberish, or ambiguous). Leave the verdict
      // unknown rather than defaulting to a fake PASS — this outcome counts
      // as "unverified" (Fix #1), never as verified quality signal.
      warnings.push(
        `verifier output for subtask ${outcome.subtask.id} could not be parsed as PASS/FAIL; verdict left unknown`,
      );
      continue;
    }
    outcome.verdict = verdict;
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
      modelCalls,
      warnings,
      error: `All workers failed: ${errors}`,
    };
  }

  // V6: exclude outcomes with an EXPLICIT failed verdict from synthesis. An
  // absent verdict (never verified, or verifier call failed → V3) still
  // counts as a plain pass and stays in.
  const verifiedOutcomes = successfulOutcomes.filter((o) => o.verdict?.ok !== false);
  let synthInputOutcomes = verifiedOutcomes;
  if (verifiedOutcomes.length === 0) {
    // All successful outputs failed verification — degraded output beats
    // none: fall back to including them rather than synthesizing from
    // nothing.
    synthInputOutcomes = successfulOutcomes;
    warnings.push(
      "all successful worker outputs failed verification; including them anyway to avoid empty synthesis",
    );
  } else if (verifiedOutcomes.length < successfulOutcomes.length) {
    const excludedIds = successfulOutcomes
      .filter((o) => o.verdict?.ok === false)
      .map((o) => o.subtask.id);
    warnings.push(
      `excluded ${excludedIds.length} worker output(s) that failed verification from synthesis: ${excludedIds.join(", ")}`,
    );
  }

  let finalOutput: string;

  if (plan.strategy === "single" || synthInputOutcomes.length === 1) {
    // Skip synth call to save cost
    finalOutput = synthInputOutcomes[0].result.output;
  } else {
    const synthResp = await invoker.invoke(
      "synthesizer",
      buildSynthesizerPrompt(taskPrompt, synthInputOutcomes),
      { signal },
    );
    allCosts.push(synthResp.costUsd ?? null);
    modelCalls.push(toModelCallRecord("synthesizer", synthResp));
    totalLatencyMs += synthResp.latencyMs;
    if (synthResp.ok && synthResp.truncated) {
      warnings.push(
        "synthesizer output was truncated (finish_reason=length); the final answer may be incomplete",
      );
    }

    // Robustness: if the synthesizer fails or returns empty/whitespace output,
    // fall back to a concatenation of the successful worker outputs rather than
    // returning an empty result. The workers succeeded — only the synth pass
    // failed — so we preserve ok:true and the caller still gets usable content.
    if (!synthResp.ok || !synthResp.output.trim()) {
      finalOutput = synthInputOutcomes
        .map((o) => `## ${o.subtask.id}\n${o.result.output}`)
        .join("\n\n");
    } else {
      finalOutput = synthResp.output;
    }
  }

  return {
    ok: true,
    finalOutput,
    plan,
    outcomes,
    totalCostUsd: sumCosts(allCosts),
    totalLatencyMs,
    modelCalls,
    warnings,
  };
}
