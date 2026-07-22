/**
 * Worker-executor interface and factory for the orchestration engine.
 *
 * Workers run a single bounded sub-task on a chosen model/harness and return
 * a structured result with token usage and cost. The orchestration engine
 * (built later) fans out to workers and decides what to do with failures.
 *
 * Two concrete implementations are provided:
 *   - DirectModelExecutor: POSTs to any OpenAI-compatible /chat/completions
 *     endpoint (openrouter, berget). Reuses no existing client because the
 *     existing OpenRouterClient is ZDR-gated and openrouter-specific; a minimal
 *     fetch-based implementation here avoids leaking broker concerns into
 *     the orchestrator layer.
 *   - PiHarnessExecutor: Spawns the `pi` CLI and parses its JSON-Lines output.
 */

import { spawn } from "node:child_process";
import type {
  HomeserverResponseFormat,
  HomeserverVerifierSpec,
} from "../homeserver-executor.js";
import { extractM5Provenance, sanitizeProviderTokenCount } from "../m5-provenance.js";
import type { M5DelegationProvenance } from "../m5-provenance.js";
import { estimateCostUsd } from "../model-pricing.js";
import { getRegistryEntryById } from "../runtime-registry.js";
import { buildTaskSubprocessEnv } from "../task-subprocess-env.js";
import {
  getProviderConfig,
  resolveGatewayRootUrl,
  resolveProviderBaseUrl,
} from "./provider-config.js";
import type { OrchestratorRole } from "./plan.js";

/** Default maximum output characters when not specified in the request. */
export const DEFAULT_MAX_OUTPUT_CHARS = 50_000;

/**
 * Default completion-token cap when the request does not specify one.
 *
 * A conservative 4096 avoids provider defaults that can exceed small models'
 * context windows (e.g. Berget auto-sets max_tokens=32768). Callers that need
 * longer output (typically the synthesizer role) override via WorkerRequest.
 */
export const DEFAULT_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Homeserver busy-backpressure retry policy (issue #157)
// ---------------------------------------------------------------------------
//
// The M5 gateway has ONE serial GPU: owner-preempts-guest admission answers a
// concurrent /delegate with `503 server_busy` + `Retry-After`, and quota
// pressure answers with `429`. Those are queue signals, not task failures —
// the 2026-07-08 cassette-ai fanout lost 3 of 5 workers by treating them as
// terminal. The delegate executor now waits in line: it retries 503/429 with
// bounded attempts, honoring Retry-After (exponential backoff when absent),
// under a total wall-clock budget. The caller's AbortSignal (the task-level
// timeout) still cancels the wait at any moment.

/** Default number of busy RETRIES after the first attempt (0 disables retrying). */
export const DEFAULT_BUSY_MAX_RETRIES = 6;
/** Default total wall-clock budget for busy waiting + retrying, per worker call. */
export const DEFAULT_BUSY_RETRY_BUDGET_MS = 240_000;
/** Default base delay for exponential backoff when the gateway sends no Retry-After. */
export const DEFAULT_BUSY_RETRY_BASE_DELAY_MS = 1_000;
/** Cap any single busy wait (Retry-After or backoff step) to this. */
const MAX_BUSY_WAIT_MS = 30_000;

interface BusyRetryPolicy {
  maxRetries: number;
  budgetMs: number;
  baseDelayMs: number;
}

/**
 * Parse a nonnegative integer env var; anything else (absent, empty, junk,
 * negative, fractional) returns the fallback. Unlike orchestrator config's
 * parseIntEnv, zero IS valid here — `HOMESERVER_BUSY_MAX_RETRIES=0` is the
 * documented way to disable busy retrying entirely.
 */
function parseNonNegativeIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : fallback;
}

function loadBusyRetryPolicy(env: NodeJS.ProcessEnv = process.env): BusyRetryPolicy {
  return {
    maxRetries: parseNonNegativeIntEnv(env.HOMESERVER_BUSY_MAX_RETRIES, DEFAULT_BUSY_MAX_RETRIES),
    budgetMs: parseNonNegativeIntEnv(
      env.HOMESERVER_BUSY_RETRY_BUDGET_MS,
      DEFAULT_BUSY_RETRY_BUDGET_MS,
    ),
    baseDelayMs: parseNonNegativeIntEnv(
      env.HOMESERVER_BUSY_RETRY_BASE_DELAY_MS,
      DEFAULT_BUSY_RETRY_BASE_DELAY_MS,
    ),
  };
}

/** Retry-After is either delta-seconds or an HTTP-date (RFC 9110). */
function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(headerValue);
  if (!Number.isNaN(timestamp)) return Math.max(0, timestamp - Date.now());
  return null;
}

/**
 * Extract the gateway's error code from an OpenAI-shaped error body
 * (`{"error":{"code":"server_busy",...}}`), falling back to the canonical
 * code for the status when the body is absent or unparseable.
 */
function busyErrorCode(status: number, bodyText: string | undefined): string {
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText) as { error?: { code?: unknown } };
      const code = parsed?.error?.code;
      if (typeof code === "string" && code.length > 0) return code;
    } catch {
      // fall through to the status-derived label
    }
  }
  return status === 429 ? "rate_limit_exceeded" : "server_busy";
}

/**
 * Cap on the busy-response diagnostic body read (Codex review of #157). The
 * body only refines the error code — a gateway/proxy that flushes 503/429
 * headers but stalls the body must NOT hold the retry loop until the
 * per-attempt timeout aborts the read; the Retry-After wait has to start
 * promptly. On timeout the stalled stream is cancelled and the status-derived
 * code is used instead.
 */
const BUSY_BODY_READ_TIMEOUT_MS = 2_000;

/** Bounded, best-effort read of a busy response's diagnostic body. */
async function readBusyBodyBounded(
  response: Response,
  timeoutMs = BUSY_BODY_READ_TIMEOUT_MS,
): Promise<string | undefined> {
  const textPromise = response.text();
  // The race below may abandon textPromise (timeout path); a late rejection
  // from the cancelled stream must not surface as an unhandled rejection.
  textPromise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      textPromise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    if (result === undefined) {
      // Timed out — cancel the stalled stream so it doesn't hold the socket.
      response.body?.cancel().catch(() => {});
    }
    return result;
  } catch {
    return undefined; // failed/aborted body read — the status code suffices
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Abortable sleep: resolves "slept" after `ms`, or "aborted" as soon as the
 * signal fires (a queued worker must not hold its slot once cancelled).
 */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<"slept" | "aborted"> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve("aborted");
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("slept");
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface WorkerRequest {
  /** Provider id: "openrouter" | "berget" | "pi-harness" | "homeserver" */
  provider: string;
  /** Resolved model id. */
  model: string;
  prompt: string;
  systemPrompt?: string;
  timeoutMs: number;
  /** Truncate output to this many characters. Defaults to DEFAULT_MAX_OUTPUT_CHARS. */
  maxOutputChars?: number;
  /** Completion-token cap sent to the model. Defaults to DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
  /**
   * External cancellation signal (issue #110). When it fires, the in-flight
   * fetch / child process is aborted; when already aborted at entry, run()
   * short-circuits without spending. Combined with the per-call timeout.
   */
  signal?: AbortSignal;
  /** M5 /delegate ledger bucket. Passed only by orchestrator worker leaves. */
  taskType?: string;
  /** Deterministic verifier spec for M5 /delegate when the caller has one. */
  verifier?: HomeserverVerifierSpec;
  /** Grammar/format contract for M5 /delegate when the caller has one. */
  responseFormat?: HomeserverResponseFormat;
  /** Cloud/conductor model responsible for the leaf, for M5 savings attribution. */
  delegatorModelId?: string;
  /** Optional counterfactual savings baseline forwarded to M5 /delegate. */
  premiumBaselineModelId?: string;
  /** Explicit homeserver gateway node pin (issue #160). */
  nodeId?: string;
  /** Model to use for the one bounded M5 fallback after an Orin failure. */
  fallbackModel?: string;
}

export interface WorkerResult {
  ok: boolean;
  output: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Cost in USD computed from model-pricing when both token counts are known. */
  costUsd: number | null;
  latencyMs: number;
  /**
   * True when the model stopped because it hit the completion-token cap
   * (finish_reason === "length"), meaning `output` is incomplete. Callers
   * should surface this rather than treat the result as fully successful.
   */
  truncated?: boolean;
  /** Set when ok=false. Never throws out of run(). */
  error?: string;
  /** Hugin's initial node decision, when this was an explicitly routed call. */
  selectedNode?: string;
  /** Node that actually produced the result ("m5" denotes the default gateway model). */
  effectiveNode?: string;
  /** True when one Orin failure was deliberately re-routed. */
  fallbackTriggered?: boolean;
  /** Status-derived Orin fallback signal, never request content. */
  fallbackReason?: string;
  /**
   * M5 execution provenance for this leaf (issue #163). Set only on the
   * `/delegate` path; `ledgerId` is the join key back to M5's authoritative
   * evidence row. Sanitized from the untrusted gateway response by
   * src/m5-provenance.ts — never trusted verbatim.
   */
  delegation?: M5DelegationProvenance;
}

export interface WorkerExecutor {
  run(req: WorkerRequest): Promise<WorkerResult>;
}

/**
 * Factory: returns the appropriate executor for the given provider id.
 *   - "pi-harness" → PiHarnessExecutor
 *   - "homeserver" worker role → HomeserverDelegateWorkerExecutor
 *   - everything else → DirectModelExecutor
 */
export function createWorkerExecutor(
  provider: string,
  opts?: { role?: OrchestratorRole },
): WorkerExecutor {
  if (provider === "pi-harness") {
    return new PiHarnessExecutor();
  }
  if (provider === "homeserver" && opts?.role === "worker") {
    return new HomeserverDelegateWorkerExecutor();
  }
  return new DirectModelExecutor();
}

// ---------------------------------------------------------------------------
// DirectModelExecutor — OpenAI-compatible /chat/completions
// ---------------------------------------------------------------------------

/**
 * Executes a single chat completion against any OpenAI-compatible provider.
 *
 * Why not reuse OpenRouterClient from src/openrouter-client.ts?
 * The existing client is gated by the ZDR allowlist (assertZdrAllowed) which is
 * a broker-level policy concern. The worker-executor layer is provider-agnostic
 * and must not inherit broker policy; a minimal fetch-based implementation here
 * is deliberate.
 */
export class DirectModelExecutor implements WorkerExecutor {
  async run(req: WorkerRequest): Promise<WorkerResult> {
    const start = Date.now();
    const maxOutput = req.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

    // Short-circuit an already-cancelled call before spending anything (issue #110).
    if (req.signal?.aborted) {
      return {
        ok: false,
        output: "",
        provider: req.provider,
        model: req.model,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        latencyMs: Date.now() - start,
        error: "Request aborted before it started",
      };
    }

    const providerCfg = getProviderConfig(req.provider);
    if (!providerCfg) {
      return {
        ok: false,
        output: "",
        provider: req.provider,
        model: req.model,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        latencyMs: Date.now() - start,
        error: `Unknown provider: ${req.provider}`,
      };
    }

    // Env-resolved providers (homeserver) validate their gateway URL at
    // request time; fail before touching credentials or the network.
    const resolved = resolveProviderBaseUrl(providerCfg);
    if (!resolved.ok) {
      return {
        ok: false,
        output: "",
        provider: req.provider,
        model: req.model,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        latencyMs: Date.now() - start,
        error: resolved.reason,
      };
    }
    const baseUrl = resolved.baseUrl;

    const apiKey = process.env[providerCfg.apiKeyEnvVar];
    if (!apiKey) {
      return {
        ok: false,
        output: "",
        provider: req.provider,
        model: req.model,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        latencyMs: Date.now() - start,
        error: `Missing API key: environment variable ${providerCfg.apiKeyEnvVar} is not set`,
      };
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (req.systemPrompt) {
      messages.push({ role: "system", content: req.systemPrompt });
    }
    messages.push({ role: "user", content: req.prompt });

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: false,
      // Explicitly cap completion tokens to avoid provider defaults (e.g. Berget
      // auto-sets max_tokens=32768 which exceeds many small models' context windows).
      // Configurable per role/task (issue #112); DEFAULT_MAX_TOKENS is a safe floor.
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(req.nodeId !== undefined ? { node: req.nodeId } : {}),
    };

    // Combine the per-call timeout with the caller's cancellation signal
    // (issue #110): whichever fires first aborts the fetch. `abortReason` is
    // first-writer-wins so the reported reason (timeout vs external cancel) is
    // attributed to whichever actually fired first, even if the other follows
    // before the fetch/body rejection settles.
    const controller = new AbortController();
    let abortReason: "timeout" | "external" | null = null;
    const abortWith = (reason: "timeout" | "external") => {
      if (abortReason === null) abortReason = reason;
      controller.abort();
    };
    const timer = setTimeout(() => abortWith("timeout"), req.timeoutMs);
    const onExternalAbort = () => abortWith("external");
    req.signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: buildHeaders(req.provider, apiKey),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (fetchErr) {
        const errMsg = !isAbortError(fetchErr)
          ? `Network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`
          : abortReason === "timeout"
            ? `Request timed out after ${req.timeoutMs}ms`
            : "Request aborted";
        return {
          ok: false,
          output: "",
          provider: req.provider,
          model: req.model,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          latencyMs: Date.now() - start,
          error: errMsg,
        };
      }

      if (!response.ok) {
        let body: string | undefined;
        try {
          body = await response.text();
        } catch {
          // ignore
        }
        return {
          ok: false,
          output: "",
          provider: req.provider,
          model: req.model,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          latencyMs: Date.now() - start,
          error: `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        };
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (parseErr) {
        if (isAbortError(parseErr)) {
          return {
            ok: false,
            output: "",
            provider: req.provider,
            model: req.model,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            latencyMs: Date.now() - start,
            error: abortReason === "timeout"
              ? `Response body stalled and timed out after ${req.timeoutMs}ms`
              : "Request aborted while reading the response body",
          };
        }
        return {
          ok: false,
          output: "",
          provider: req.provider,
          model: req.model,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          latencyMs: Date.now() - start,
          error: `Response was not valid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        };
      }

      const extracted = extractChatCompletion(parsed);
      if (!extracted.ok) {
        return {
          ok: false,
          output: "",
          provider: req.provider,
          model: req.model,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          latencyMs: Date.now() - start,
          error: extracted.error,
        };
      }

      const { content, inputTokens, outputTokens, finishReason } = extracted;
      const costUsd =
        inputTokens !== null && outputTokens !== null
          ? estimateCostUsd(req.model, inputTokens, outputTokens)
          : null;

      return {
        ok: true,
        output: content.slice(0, maxOutput),
        provider: req.provider,
        model: req.model,
        inputTokens,
        outputTokens,
        costUsd,
        latencyMs: Date.now() - start,
        truncated: finishReason === "length",
        ...(req.nodeId
          ? {
              selectedNode: req.nodeId,
              effectiveNode: req.nodeId,
              fallbackTriggered: false,
            }
          : {}),
      };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// HomeserverDelegateWorkerExecutor — M5 gateway /delegate
// ---------------------------------------------------------------------------

/**
 * Executes an orchestrator worker leaf through the M5 `/delegate` endpoint.
 *
 * Raw homeserver chat remains available through DirectModelExecutor: the
 * factory only selects this adapter for provider="homeserver" and role="worker".
 * This path is what lets M5's ledger see taskType/delegatorModelId and attribute
 * local-offload savings.
 */
export class HomeserverDelegateWorkerExecutor implements WorkerExecutor {
  async run(req: WorkerRequest): Promise<WorkerResult> {
    const start = Date.now();
    const maxOutput = req.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

    if (req.signal?.aborted) {
      return {
        ok: false,
        output: "",
        provider: req.provider,
        model: req.model,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        latencyMs: Date.now() - start,
        error: "Request aborted before it started",
      };
    }

    const resolved = resolveGatewayRootUrl(process.env, "HOMESERVER_GATEWAY_URL");
    if (!resolved.ok) {
      return {
        ok: false,
        output: "",
        provider: req.provider,
        model: req.model,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        latencyMs: Date.now() - start,
        error: resolved.reason,
      };
    }

    const apiKey = process.env.HOMESERVER_GATEWAY_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        output: "",
        provider: req.provider,
        model: req.model,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        latencyMs: Date.now() - start,
        error: "Missing API key: environment variable HOMESERVER_GATEWAY_API_KEY is not set",
      };
    }

    const delegateBody = (model: string, nodeId?: string): Record<string, unknown> => ({
      prompt: req.prompt,
      modelId: model,
      maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(nodeId !== undefined ? { nodeId } : {}),
      ...(req.taskType !== undefined ? { taskType: req.taskType } : {}),
      ...(req.systemPrompt !== undefined ? { systemPrompt: req.systemPrompt } : {}),
      ...(req.verifier !== undefined ? { verifier: req.verifier } : {}),
      ...(req.responseFormat !== undefined ? { responseFormat: req.responseFormat } : {}),
      ...(req.delegatorModelId !== undefined ? { delegatorModelId: req.delegatorModelId } : {}),
      ...(req.premiumBaselineModelId !== undefined
        ? { premiumBaselineModelId: req.premiumBaselineModelId }
        : {}),
    });

    const failResult = (error: string, model = req.model): WorkerResult => ({
      ok: false,
      output: "",
      provider: req.provider,
      model,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      latencyMs: Date.now() - start,
      error,
    });

    /**
     * One HTTP attempt against /delegate. Normal 503/429 answers bubble to
     * the busy retry loop. An explicitly pinned Orin response of 502/503/504
     * instead bubbles to the one-shot macro fallback below (issue #160).
     */
    type AttemptOutcome =
      | { kind: "done"; result: WorkerResult }
      | {
          kind: "busy";
          status: number;
          code: string;
          retryAfterMs: number | null;
          retryAfterS: number | null;
        }
      | {
          kind: "orin-unavailable";
          status: 502 | 503 | 504;
          retryAfterMs: number | null;
          retryAfterS: number | null;
        };

    const attemptOnce = async (model: string, nodeId?: string): Promise<AttemptOutcome> => {
      const controller = new AbortController();
      let abortReason: "timeout" | "external" | null = null;
      const abortWith = (reason: "timeout" | "external") => {
        if (abortReason === null) abortReason = reason;
        controller.abort();
      };
      // The per-attempt timeout is per HTTP attempt — time spent waiting in
      // the busy queue between attempts is bounded separately by the busy
      // retry budget and the caller's task-level AbortSignal.
      const timer = setTimeout(() => abortWith("timeout"), req.timeoutMs);
      const onExternalAbort = () => abortWith("external");
      req.signal?.addEventListener("abort", onExternalAbort, { once: true });

      try {
        let response: Response;
        try {
          response = await fetch(`${resolved.baseUrl}/delegate`, {
            method: "POST",
            headers: buildHeaders(req.provider, apiKey),
            body: JSON.stringify(delegateBody(model, nodeId)),
            signal: controller.signal,
          });
        } catch (fetchErr) {
          const errMsg = !isAbortError(fetchErr)
            ? `Network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`
            : abortReason === "timeout"
              ? `Request timed out after ${req.timeoutMs}ms`
              : "Request aborted";
          return { kind: "done", result: failResult(errMsg, model) };
        }

        if (
          nodeId === "orin" &&
          (response.status === 502 || response.status === 503 || response.status === 504)
        ) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          // The response body contains no trusted routing signal and may
          // stall, so cancel it rather than delaying the bounded fallback.
          response.body?.cancel().catch(() => {});
          return {
            kind: "orin-unavailable",
            status: response.status,
            retryAfterMs,
            retryAfterS: retryAfterMs !== null ? Math.round(retryAfterMs / 1000) : null,
          };
        }

        // Busy backpressure (issue #157): 503 = admission (owner preempted the
        // serial GPU), 429 = quota. Queue signals, not task failures.
        if (response.status === 503 || response.status === 429) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          // Bounded diagnostic read (Codex review): a stalled busy body must
          // not delay the retry wait until the per-attempt timeout.
          const bodyText = await readBusyBodyBounded(response);
          return {
            kind: "busy",
            status: response.status,
            code: busyErrorCode(response.status, bodyText),
            retryAfterMs,
            retryAfterS: retryAfterMs !== null ? Math.round(retryAfterMs / 1000) : null,
          };
        }

        if (!response.ok) {
          let responseBody: string | undefined;
          try {
            responseBody = await response.text();
          } catch {
            // ignore
          }
          return {
            kind: "done",
            result: failResult(
              `HTTP ${response.status}${responseBody ? `: ${responseBody.slice(0, 200)}` : ""}`,
              model,
            ),
          };
        }

        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch (parseErr) {
          if (isAbortError(parseErr)) {
            return {
              kind: "done",
              result: failResult(
                abortReason === "timeout"
                  ? `Response body stalled and timed out after ${req.timeoutMs}ms`
                  : "Request aborted while reading the response body",
                model,
              ),
            };
          }
          return {
            kind: "done",
            result: failResult(
              `Response was not valid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
              model,
            ),
          };
        }

        // Issue #163: preserve the M5 execution trace. Sanitized from the raw
        // (untrusted) gateway body and extracted BEFORE operational validation,
        // so a response carrying a usable trace (real ledgerId/node/model) but
        // one malformed operational field still surfaces the ledger key — that
        // is precisely the response an operator needs to diagnose, and the call
        // was paid for either way.
        const delegation = extractM5Provenance(parsed);
        const withDelegation = (result: WorkerResult): WorkerResult =>
          Object.keys(delegation).length > 0 ? { ...result, delegation } : result;

        const outcome = extractDelegationOutcome(parsed);
        if (!outcome.ok) {
          return { kind: "done", result: withDelegation(failResult(outcome.error, model)) };
        }

        const inputTokens = sanitizeTokenCount(outcome.metrics?.promptTokens);
        const outputTokens = sanitizeTokenCount(outcome.metrics?.completionTokens);
        const costUsd =
          inputTokens !== null && outputTokens !== null
            ? estimateCostUsd(model, inputTokens, outputTokens)
            : null;
        const output = (outcome.output ?? outcome.frontierOutput ?? "").slice(0, maxOutput);
        const outcomeStatus = typeof outcome.outcome === "string" ? outcome.outcome : null;
        const failed = outcomeStatus === "fail" || outcomeStatus === "error";

        return {
          kind: "done",
          result: withDelegation({
            ok: !failed,
            output,
            provider: req.provider,
            model,
            inputTokens,
            outputTokens,
            costUsd,
            latencyMs: Date.now() - start,
            ...(failed ? { error: `Delegation outcome: ${outcomeStatus}` } : {}),
          }),
        };
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onExternalAbort);
      }
    };

    // --- Busy retry loop (issue #157): wait in line instead of failing ---
    const runWithBusyRetry = async (
      model: string,
      nodeId: string | undefined,
      firstOutcome?: AttemptOutcome,
    ): Promise<WorkerResult> => {
      const policy = loadBusyRetryPolicy();
      const queueStart = Date.now();
      let attempt = 0;
      let nextOutcome = firstOutcome;

      while (true) {
        const outcome = nextOutcome ?? (await attemptOnce(model, nodeId));
        nextOutcome = undefined;
        // An Orin-unavailable signal is handled by the outer route path and
        // never joins this loop (which is intentionally for generic M5 busy).
        if (outcome.kind === "orin-unavailable") {
          return failResult(`HTTP ${outcome.status}`, model);
        }
        if (outcome.kind === "done") return outcome.result;

        // Exact gateway reason, preserved verbatim into any terminal error so a
        // failed fanout leaf names WHY it never ran (acceptance criterion).
        const busyLabel = `HTTP ${outcome.status} ${outcome.code}${
          outcome.retryAfterS !== null ? ` retryAfterS=${outcome.retryAfterS}` : ""
        }`;
        const attemptsMade = attempt + 1;
        const plural = attemptsMade === 1 ? "" : "s";

        if (attempt >= policy.maxRetries) {
          return failResult(
            `${busyLabel} — gave up after ${attemptsMade} attempt${plural} over ${Math.round(
              (Date.now() - queueStart) / 1000,
            )}s waiting for the gateway`,
            model,
          );
        }

        const waitMs = Math.min(
          outcome.retryAfterMs ?? policy.baseDelayMs * 2 ** attempt,
          MAX_BUSY_WAIT_MS,
        );
        if (Date.now() + waitMs - queueStart > policy.budgetMs) {
          return failResult(
            `${busyLabel} — busy-retry budget of ${policy.budgetMs}ms exhausted after ${attemptsMade} attempt${plural}`,
            model,
          );
        }

        const slept = await sleepWithAbort(waitMs, req.signal);
        if (slept === "aborted") {
          return failResult(`${busyLabel} — request aborted while waiting for a free gateway slot`, model);
        }
        attempt++;
      }
    };

    const withRouteMetadata = (
      result: WorkerResult,
      effectiveNode: string,
      fallbackTriggered: boolean,
      fallbackReason?: string,
    ): WorkerResult =>
      req.nodeId
        ? {
            ...result,
            selectedNode: req.nodeId,
            effectiveNode,
            fallbackTriggered,
            ...(fallbackReason ? { fallbackReason } : {}),
          }
        : result;

    if (req.nodeId === "orin") {
      const firstOutcome = await attemptOnce(req.model, req.nodeId);
      if (firstOutcome.kind !== "orin-unavailable") {
        return withRouteMetadata(
          await runWithBusyRetry(req.model, req.nodeId, firstOutcome),
          "orin",
          false,
        );
      }

      const fallbackReason = `HTTP ${firstOutcome.status}`;
      // Retry-After applies to a retry of the congested Orin node, not the
      // M5 re-route. Still respect it when there is enough call budget left;
      // otherwise re-route immediately rather than turning a bounded fallback
      // into a timeout.
      const waitMs = Math.min(firstOutcome.retryAfterMs ?? 0, MAX_BUSY_WAIT_MS);
      const elapsedMs = Date.now() - start;
      if (waitMs > 0 && elapsedMs + waitMs < req.timeoutMs) {
        const slept = await sleepWithAbort(waitMs, req.signal);
        if (slept === "aborted") {
          return withRouteMetadata(
            failResult(`${fallbackReason} — request aborted before M5 fallback`, req.fallbackModel ?? req.model),
            "m5",
            true,
            fallbackReason,
          );
        }
      }
      return withRouteMetadata(
        await runWithBusyRetry(req.fallbackModel ?? req.model, undefined),
        "m5",
        true,
        fallbackReason,
      );
    }

    return runWithBusyRetry(req.model, req.nodeId);
  }
}

// ---------------------------------------------------------------------------
// PiHarnessExecutor — spawn the `pi` CLI
// ---------------------------------------------------------------------------

/**
 * Executes a task via the `pi` CLI harness.
 *
 * NOTE: All pi argument construction is in one place (buildPiArgs) so it is
 * trivial to adjust flags once the exact interface is verified against the
 * real binary at integration time.
 */
export class PiHarnessExecutor implements WorkerExecutor {
  async run(req: WorkerRequest): Promise<WorkerResult> {
    const start = Date.now();
    const maxOutput = req.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

    const entry = getRegistryEntryById("pi-harness");
    if (!entry) {
      return {
        ok: false,
        output: "",
        provider: req.provider,
        model: req.model,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        latencyMs: Date.now() - start,
        error: "pi-harness entry not found in runtime registry",
      };
    }

    // Short-circuit an already-cancelled call before spawning (issue #110).
    if (req.signal?.aborted) {
      return {
        ok: false,
        output: "",
        provider: req.provider,
        model: req.model,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        latencyMs: Date.now() - start,
        error: "Process aborted before it started",
      };
    }

    const args = buildPiArgs(req, entry);

    return new Promise<WorkerResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      // First-writer-wins kill reason (issue #110): whichever of the per-call
      // timeout or the external abort fires first owns the reported reason, so a
      // later kill of the other kind can't mislabel it before `close` arrives.
      let killReason: "timeout" | "external" | null = null;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(entry.harnessCmd ?? "pi", args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: buildTaskSubprocessEnv(),
        });
      } catch (spawnErr) {
        resolve({
          ok: false,
          output: "",
          provider: req.provider,
          model: req.model,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          latencyMs: Date.now() - start,
          error: `Spawn error: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`,
        });
        return;
      }

      const killWith = (reason: "timeout" | "external") => {
        if (killReason === null) killReason = reason;
        child.kill("SIGTERM");
      };
      const killTimer = setTimeout(() => killWith("timeout"), req.timeoutMs);

      // External cancellation (issue #110): kill the child when the caller's
      // signal fires. The reason is recorded first-writer-wins.
      const onExternalAbort = () => killWith("external");
      req.signal?.addEventListener("abort", onExternalAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        clearTimeout(killTimer);
        req.signal?.removeEventListener("abort", onExternalAbort);
        resolve({
          ok: false,
          output: "",
          provider: req.provider,
          model: req.model,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          latencyMs: Date.now() - start,
          error: `Child process error: ${err.message}`,
        });
      });

      child.on("close", (code) => {
        clearTimeout(killTimer);
        req.signal?.removeEventListener("abort", onExternalAbort);

        if (killReason !== null) {
          resolve({
            ok: false,
            output: "",
            provider: req.provider,
            model: req.model,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            latencyMs: Date.now() - start,
            error: killReason === "external"
              ? "Process aborted"
              : `Process timed out after ${req.timeoutMs}ms`,
          });
          return;
        }

        if (code !== 0) {
          resolve({
            ok: false,
            output: "",
            provider: req.provider,
            model: req.model,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            latencyMs: Date.now() - start,
            error: `Process exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
          });
          return;
        }

        const parsed = parsePiJsonLines(stdout);

        const costUsd =
          parsed.inputTokens !== null && parsed.outputTokens !== null
            ? estimateCostUsd(req.model, parsed.inputTokens, parsed.outputTokens)
            : null;

        resolve({
          ok: true,
          output: parsed.output.slice(0, maxOutput),
          provider: req.provider,
          model: req.model,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          costUsd,
          latencyMs: Date.now() - start,
        });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Build the argument list for the `pi` CLI harness.
 *
 * NOTE: exact pi flags will be verified against the real binary at integration
 * time — keep ALL pi argument construction in this one function so it is
 * trivial to adjust later.
 */
function buildPiArgs(
  req: WorkerRequest,
  registryEntry: ReturnType<typeof getRegistryEntryById> & {},
): string[] {
  const flags: string[] = [...(registryEntry.harnessFlags ?? [])];
  flags.push("--mode", "json");
  flags.push("--model", req.model);
  flags.push("-p", req.prompt);
  return flags;
}

/**
 * Provider-reported token counts are only trusted as nonnegative integers;
 * anything else (fractional estimates, negatives, NaN, non-numbers) → null.
 *
 * Re-exported from src/m5-provenance.ts (issue #163) so the direct homeserver
 * executor applies the identical contract — a fractional count from either M5
 * path would otherwise fail the structured result's `.int()` constraint and
 * poison the savings store.
 */
function sanitizeTokenCount(value: unknown): number | null {
  return sanitizeProviderTokenCount(value);
}

function buildHeaders(provider: string, apiKey: string): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  if (provider === "openrouter") {
    h["http-referer"] = process.env.OPENROUTER_REFERER ?? "https://hugin.local";
    h["x-title"] = process.env.OPENROUTER_APP_TITLE ?? "hugin-orch";
  }
  return h;
}

interface ExtractedCompletion {
  ok: true;
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** OpenAI-style stop reason for choices[0]; null when absent. "length" ⇒ truncated. */
  finishReason: string | null;
}
interface ExtractedError {
  ok: false;
  error: string;
}

interface DelegationOutcome {
  delegated?: boolean;
  escalate?: boolean;
  outcome?: string;
  score?: number | null;
  output?: string;
  decisionReason?: string;
  ledgerId?: string;
  metrics?: { promptTokens?: unknown; completionTokens?: unknown; latencyMs?: unknown };
  frontierOutput?: string;
}

function extractChatCompletion(raw: unknown): ExtractedCompletion | ExtractedError {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Response was not an object" };
  }
  const r = raw as Record<string, unknown>;
  const choices = r["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    return { ok: false, error: "Response missing choices array" };
  }
  const choice = choices[0];
  if (choice === null || typeof choice !== "object") {
    return { ok: false, error: "Response choices[0] is not an object" };
  }
  const choiceObj = choice as Record<string, unknown>;
  const message = choiceObj["message"];
  if (message !== null && message !== undefined && typeof message !== "object") {
    return { ok: false, error: "Response choices[0].message is not an object" };
  }
  const messageObj = message as Record<string, unknown> | undefined;
  const content = messageObj?.["content"];
  if (typeof content !== "string") {
    return { ok: false, error: "Response missing choices[0].message.content (string)" };
  }

  const usage = r["usage"] as Record<string, unknown> | undefined;
  // Provider JSON is untrusted: token counts must be nonnegative integers or
  // they are dropped (a fractional count from a proxy that estimates usage
  // would otherwise poison the savings store and fail the structured-result
  // schema's .int() constraint downstream).
  const inputTokens = sanitizeTokenCount(usage?.["prompt_tokens"]);
  const outputTokens = sanitizeTokenCount(usage?.["completion_tokens"]);

  const finishReason =
    typeof choiceObj["finish_reason"] === "string"
      ? (choiceObj["finish_reason"] as string)
      : null;

  return { ok: true, content, inputTokens, outputTokens, finishReason };
}

function extractDelegationOutcome(raw: unknown): ({ ok: true } & DelegationOutcome) | ExtractedError {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Response was not an object" };
  }
  const r = raw as DelegationOutcome;
  if (r.output !== undefined && typeof r.output !== "string") {
    return { ok: false, error: "Response output was not a string" };
  }
  if (r.frontierOutput !== undefined && typeof r.frontierOutput !== "string") {
    return { ok: false, error: "Response frontierOutput was not a string" };
  }
  if (r.outcome !== undefined && typeof r.outcome !== "string") {
    return { ok: false, error: "Response outcome was not a string" };
  }
  if (r.metrics !== undefined && (!r.metrics || typeof r.metrics !== "object")) {
    return { ok: false, error: "Response metrics was not an object" };
  }
  return { ok: true, ...r };
}

interface PiParsedOutput {
  output: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Parse JSON Lines output from `pi --mode json`.
 *
 * The pi CLI (version 3 schema) emits events of the form:
 *   { "type": "message_start"|"message_end"|"turn_end", "message": { "role": "assistant", "content": [...], "usage": { "input": N, "output": N } } }
 *
 * Content is an array of content blocks; we concatenate all text blocks from
 * the final assistant message. Usage is at message.usage.input / message.usage.output.
 *
 * Legacy / hypothetical shapes (type "assistant"/"result", flat content/text,
 * flat usage with input_tokens/prompt_tokens) are also handled for forward
 * compatibility with harness variants.
 */
function parsePiJsonLines(raw: string): PiParsedOutput {
  let output = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const o = obj as Record<string, unknown>;

    // --- Pi v3 event schema: message_start / message_end / turn_end ---
    const msgTypes = ["message_start", "message_end", "turn_end"];
    if (msgTypes.includes(o["type"] as string)) {
      const msg = o["message"] as Record<string, unknown> | undefined;
      if (msg && msg["role"] === "assistant") {
        // Extract text from content array: [{ type: "text", text: "..." }, ...]
        const contentArr = msg["content"];
        if (Array.isArray(contentArr) && contentArr.length > 0) {
          const texts = contentArr
            .filter(
              (b): b is Record<string, unknown> =>
                b !== null && typeof b === "object" && (b as Record<string, unknown>)["type"] === "text",
            )
            .map((b) => (typeof b["text"] === "string" ? b["text"] : ""));
          const joined = texts.join("");
          if (joined.length > 0) {
            output = joined;
          }
        }

        // Usage: message.usage.input / message.usage.output
        const msgUsage = msg["usage"] as Record<string, unknown> | undefined;
        if (msgUsage) {
          if (typeof msgUsage["input"] === "number") inputTokens = msgUsage["input"];
          if (typeof msgUsage["output"] === "number") outputTokens = msgUsage["output"];
          // Also check OpenAI-style field names used by some pi backends
          if (typeof msgUsage["input_tokens"] === "number") inputTokens = msgUsage["input_tokens"];
          if (typeof msgUsage["output_tokens"] === "number") outputTokens = msgUsage["output_tokens"];
          if (typeof msgUsage["prompt_tokens"] === "number") inputTokens = msgUsage["prompt_tokens"];
          if (typeof msgUsage["completion_tokens"] === "number") outputTokens = msgUsage["completion_tokens"];
        }
      }
    }

    // --- Legacy / flat event schema: type "assistant" or "result" ---
    if (o["type"] === "assistant" || o["type"] === "result") {
      if (typeof o["content"] === "string") {
        output = o["content"];
      } else if (typeof o["text"] === "string") {
        output = o["text"];
      }
    }

    // --- Top-level usage (legacy, separate "usage" event) ---
    const usage = o["usage"] as Record<string, unknown> | undefined;
    if (usage) {
      inputTokens = sanitizeTokenCount(usage["input_tokens"]) ?? inputTokens;
      outputTokens = sanitizeTokenCount(usage["output_tokens"]) ?? outputTokens;
      inputTokens = sanitizeTokenCount(usage["prompt_tokens"]) ?? inputTokens;
      outputTokens = sanitizeTokenCount(usage["completion_tokens"]) ?? outputTokens;
    }
  }

  return { output, inputTokens, outputTokens };
}

function isAbortError(err: unknown): boolean {
  return (err as Error & { name?: string })?.name === "AbortError";
}
