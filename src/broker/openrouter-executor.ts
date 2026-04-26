/**
 * OpenRouter executor for orchestrator-v1 one-shot delegations.
 *
 * Pipeline:
 *   1. Pull the resolved alias / model / reasoning level out of the
 *      delegation envelope.
 *   2. Hand the prompt to `OpenRouterClient.chat` (which itself
 *      enforces the pinned ZDR allowlist before any HTTP call).
 *   3. Translate the raw provider output through
 *      `finalizeDelegatedOutput` so every byte that crosses the
 *      broker → MCP boundary is scanner-checked and provenance-tagged.
 *
 * Errors are returned as `DelegationError` rather than thrown, so the
 * worker that drives this executor can route success and failure
 * through the same two-phase commit machinery (see §12.3).
 *
 * The harness path (`pi-harness`) lives in a separate executor (Step 5b)
 * because its I/O surface is fundamentally different (spawn + worktree
 * + diff capture vs. pure HTTP).
 */

import {
  finalizeDelegatedOutput,
  type DelegationError,
  type DelegationResult,
  type ScannerPolicy,
} from "../finalize-delegated-output.js";
import {
  OpenRouterError,
  type OpenRouterChatResponse,
  type OpenRouterClient,
} from "../openrouter-client.js";
import type { DelegationEnvelope } from "./types.js";

export interface OpenRouterExecutorDeps {
  client: OpenRouterClient;
  scannerPolicy?: ScannerPolicy;
  now?: () => number;
}

export type OpenRouterExecutorOutcome =
  | { ok: true; result: DelegationResult }
  | { ok: false; error: DelegationError };

/**
 * Run a one-shot delegation against OpenRouter. Returns a
 * discriminated outcome — never throws for expected failure modes
 * (timeout, provider 5xx, ZDR rejection, scanner blocked). Truly
 * unexpected exceptions still propagate so the caller can mark the
 * task `failed` with `kind: "internal"`.
 */
export async function executeOpenRouterDelegation(
  envelope: DelegationEnvelope,
  deps: OpenRouterExecutorDeps,
): Promise<OpenRouterExecutorOutcome> {
  if (envelope.alias_resolved.runtime !== "openrouter") {
    return {
      ok: false,
      error: {
        task_id: envelope.task_id,
        kind: "internal",
        message: `executor expected runtime 'openrouter', got '${envelope.alias_resolved.runtime}'`,
        retryable: false,
      },
    };
  }
  if (envelope.alias_resolved.family !== "one-shot") {
    return {
      ok: false,
      error: {
        task_id: envelope.task_id,
        kind: "internal",
        message: `OpenRouter executor only handles one-shot family; got '${envelope.alias_resolved.family}'`,
        retryable: false,
      },
    };
  }

  const start = (deps.now ?? Date.now)();

  let chatResponse: OpenRouterChatResponse;
  try {
    chatResponse = await deps.client.chat({
      model: envelope.alias_resolved.model_requested,
      prompt: envelope.prompt,
      reasoningLevel: envelope.alias_resolved.reasoning_level,
      maxOutputTokens: envelope.max_output_tokens,
      timeoutMs: envelope.timeout_ms,
    });
  } catch (err) {
    return { ok: false, error: mapClientError(envelope, err) };
  }

  const durationS = ((deps.now ?? Date.now)() - start) / 1000;

  return finalizeDelegatedOutput({
    result_kind: "text",
    raw_output: chatResponse.output,
    task_id: envelope.task_id,
    alias_requested: envelope.alias_resolved.alias,
    model_effective: chatResponse.modelEffective || envelope.alias_resolved.model_requested,
    runtime_effective: "openrouter",
    runtime_row_id_effective: envelope.alias_resolved.runtime_row_id,
    host_effective: "openrouter",
    policy_version: envelope.policy_version,
    scanner_policy: deps.scannerPolicy,
    prompt_tokens: chatResponse.usage.prompt_tokens,
    completion_tokens: chatResponse.usage.completion_tokens,
    total_tokens: chatResponse.usage.total_tokens,
    duration_s: durationS,
    cost_usd: 0,
  });
}

function mapClientError(
  envelope: DelegationEnvelope,
  err: unknown,
): DelegationError {
  if (err instanceof OpenRouterError) {
    if (err.code === "zdr_blocked") {
      return {
        task_id: envelope.task_id,
        kind: "policy_rejected",
        message: err.message,
        retryable: false,
      };
    }
    if (err.code === "timeout") {
      return {
        task_id: envelope.task_id,
        kind: "timeout",
        message: err.message,
        retryable: true,
      };
    }
    if (err.code === "network") {
      return {
        task_id: envelope.task_id,
        kind: "executor_failed",
        message: err.message,
        retryable: true,
      };
    }
    if (err.code === "provider") {
      return {
        task_id: envelope.task_id,
        kind: "executor_failed",
        message: `${err.message}${err.providerMessage ? `: ${err.providerMessage}` : ""}`,
        retryable: isRetryableHttpStatus(err.httpStatus),
      };
    }
    if (err.code === "parse") {
      return {
        task_id: envelope.task_id,
        kind: "executor_failed",
        message: err.message,
        retryable: false,
      };
    }
  }
  // Catch-all: the ZDR gate raises a plain Error with `code: "zdr_blocked"`.
  if ((err as Error & { code?: string }).code === "zdr_blocked") {
    return {
      task_id: envelope.task_id,
      kind: "policy_rejected",
      message: (err as Error).message,
      retryable: false,
    };
  }
  return {
    task_id: envelope.task_id,
    kind: "internal",
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}

function isRetryableHttpStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}
