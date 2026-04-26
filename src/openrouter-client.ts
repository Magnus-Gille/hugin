/**
 * Minimal OpenRouter HTTP client for orchestrator v1.
 *
 * Scope:
 *   - Single chat-completions request (non-streaming) with optional
 *     reasoning level. The orchestrator v1 executor is one-shot, so
 *     streaming is intentionally omitted.
 *   - Hard ZDR allowlist enforcement before the request hits the wire.
 *   - Structured error mapping (`zdr_blocked` / `network` / `provider`
 *     / `parse`) so the executor can translate to DelegationErrorKind
 *     without re-parsing strings.
 *
 * The client does NOT handle retries, scanner policy, or finalization —
 * those are the executor's job. This module is intentionally thin: a
 * fetch wrapper plus the ZDR gate.
 *
 * Auth: the API key is passed in via the constructor / options rather
 * than read from process.env directly, so the executor controls
 * lifetime and so tests can supply a dummy key without touching env.
 */

import { assertZdrAllowed } from "./openrouter-zdr.js";

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_USER_AGENT = "hugin-orch-v1";

export type OpenRouterErrorCode =
  | "zdr_blocked"
  | "network"
  | "provider"
  | "parse"
  | "timeout";

export class OpenRouterError extends Error {
  readonly code: OpenRouterErrorCode;
  readonly httpStatus?: number;
  readonly providerMessage?: string;
  constructor(
    code: OpenRouterErrorCode,
    message: string,
    options: { httpStatus?: number; providerMessage?: string } = {},
  ) {
    super(message);
    this.name = "OpenRouterError";
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.providerMessage = options.providerMessage;
  }
}

export interface OpenRouterClientConfig {
  apiKey: string;
  baseUrl?: string;
  /**
   * Optional fetch implementation override (used by tests). Defaults to
   * the global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /** HTTP-Referer header — OpenRouter uses it for ranking/attribution. */
  referer?: string;
  /** X-Title header — OpenRouter uses it for ranking/attribution. */
  appTitle?: string;
}

export interface OpenRouterChatRequest {
  model: string;
  prompt: string;
  /**
   * Optional system prompt prepended as a separate message. Kept
   * explicit (vs. concatenating into prompt) so OpenRouter's role
   * parsing stays correct.
   */
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Pinned per-row reasoning level (low / medium / high). For models
   * that don't accept the field (most non-gpt-oss families) the API
   * silently ignores it.
   */
  reasoningLevel?: "low" | "medium" | "high";
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface OpenRouterChatResponse {
  output: string;
  finishReason: string | null;
  modelEffective: string;
  usage: OpenRouterUsage;
  /** Raw response JSON, for diagnostic surfaces. */
  raw: unknown;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly referer?: string;
  private readonly appTitle?: string;

  constructor(config: OpenRouterClientConfig) {
    if (!config.apiKey) {
      throw new Error("OpenRouterClient requires an apiKey");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.referer = config.referer;
    this.appTitle = config.appTitle;
  }

  async chat(request: OpenRouterChatRequest): Promise<OpenRouterChatResponse> {
    assertZdrAllowed(request.model);

    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    messages.push({ role: "user", content: request.prompt });

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: false,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) {
      body.max_tokens = request.maxOutputTokens;
    }
    if (request.reasoningLevel) {
      body.reasoning = { effort: request.reasoningLevel };
    }

    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (request.abortSignal) {
      if (request.abortSignal.aborted) controller.abort();
      else request.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error & { name?: string }).name === "AbortError") {
        throw new OpenRouterError("timeout", `OpenRouter request timed out after ${timeoutMs}ms`);
      }
      throw new OpenRouterError(
        "network",
        `OpenRouter network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    clearTimeout(timer);

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new OpenRouterError(
        "provider",
        `OpenRouter returned HTTP ${response.status}`,
        { httpStatus: response.status, providerMessage: text },
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new OpenRouterError(
        "parse",
        `OpenRouter response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return mapChatResponse(parsed);
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      "user-agent": OPENROUTER_USER_AGENT,
    };
    if (this.referer) h["http-referer"] = this.referer;
    if (this.appTitle) h["x-title"] = this.appTitle;
    return h;
  }
}

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

interface OpenRouterChoice {
  message?: { content?: unknown };
  finish_reason?: string | null;
}

interface OpenRouterRawResponse {
  model?: string;
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage;
}

export function mapChatResponse(raw: unknown): OpenRouterChatResponse {
  if (!raw || typeof raw !== "object") {
    throw new OpenRouterError("parse", "OpenRouter response was not an object");
  }
  const r = raw as OpenRouterRawResponse;
  const choice = r.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string") {
    throw new OpenRouterError(
      "parse",
      "OpenRouter response missing choices[0].message.content (string)",
    );
  }
  return {
    output: content,
    finishReason: choice?.finish_reason ?? null,
    modelEffective: r.model ?? "",
    usage: r.usage ?? {},
    raw,
  };
}
