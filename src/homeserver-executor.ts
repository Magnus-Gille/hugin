/**
 * Home-server (BosGame M5) executor for Hugin tasks.
 *
 * Speaks the home-server gateway contract documented in
 * `docs/gateway-api-contract.md` of the home-server-inference-evaluation repo.
 * Dual-path:
 *   - "chat":     POST /v1/chat/completions  (OpenAI-compatible, streaming SSE) — raw inference
 *   - "delegate": POST /delegate             (ledger-gated one-shot; returns DelegationOutcome)
 *
 * Bearer auth via the gateway API key. Honors gateway backpressure so Hugin's
 * macro-router can route elsewhere instead of failing the task:
 *   - 429 → backpressure="quota"      (RPM/TPM/daily budget)
 *   - 503 → backpressure="admission"  (owner preempted the serial GPU) + Retry-After
 *
 * SCOPE: this module is intentionally standalone and is NOT yet spliced into the
 * dispatcher's runtime union / executor-selection switch. That live-wiring is the
 * M5 boot-day step — it needs the real box to validate end-to-end. Everything here
 * is unit-tested against a mocked gateway so the splice is a fill-in-the-blanks job.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// --- Types ---

export type HomeserverPath = "chat" | "delegate";

export interface HomeserverTaskConfig {
  prompt: string;
  gatewayBaseUrl: string; // e.g. http://127.0.0.1:8080
  apiKey: string; // Bearer token (may be "" on a keyless loopback gateway)
  path: HomeserverPath;
  /** Required for "chat" (the model to serve). Ignored on "delegate" (the gateway/ledger selects). */
  model?: string;
  /** Forwarded to /delegate as the ledger bucket. */
  taskType?: string;
  /** Reserved for forward-compat: the gateway /delegate HTTP endpoint does not yet accept a
   *  frontier model, so this is currently NOT sent. Re-wire once the gateway exposes escalation. */
  frontierModelId?: string;
  timeoutMs: number;
  maxOutputChars: number;
  injectedContext?: string;
}

export type Backpressure = "none" | "quota" | "admission";

export interface HomeserverExecutorResult {
  exitCode: number | "TIMEOUT";
  output: string;
  logFile: string;
  resultText: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  inferenceMs: number | null;
  promptChars: number;
  outputChars: number;
  /** Gateway asked us to back off; the macro-router should route elsewhere or retry later. */
  backpressure: Backpressure;
  retryAfterS: number | null;
  // --- /delegate-path metadata (null on the chat path) ---
  delegated: boolean | null;
  outcome: string | null; // pass | partial | fail | error | unverified
  score: number | null;
  decisionReason: string | null;
  ledgerId: string | null;
  escalated: boolean | null;
}

export interface HomeserverExecutorOptions {
  abortController?: AbortController;
}

export interface HomeserverGatewayConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Resolve the gateway endpoint from the environment. Returns null when
 * HOMESERVER_GATEWAY_URL is unset, so callers can cleanly fall back to other
 * runtimes when no M5 is configured.
 *   HOMESERVER_GATEWAY_URL      — e.g. http://127.0.0.1:8080 (required to enable)
 *   HOMESERVER_GATEWAY_API_KEY  — Bearer token (optional on a keyless loopback gateway)
 */
/** localhost / 127.0.0.1 / ::1 — the only hosts where a keyless gateway is safe. */
function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

export function loadHomeserverGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): HomeserverGatewayConfig | null {
  const raw = env.HOMESERVER_GATEWAY_URL?.trim();
  if (!raw) return null;
  // Strip ALL trailing slashes — same normalization as the orchestrator's
  // resolveProviderBaseUrl, which reads this env var too.
  const baseUrl = raw.replace(/\/+$/, "");
  const apiKey = env.HOMESERVER_GATEWAY_API_KEY?.trim() ?? "";
  // A keyless gateway is only safe on loopback. Refuse to send unauthenticated
  // requests to a remote/LAN/public gateway — treat it as not-configured.
  if (!apiKey && !isLoopbackUrl(baseUrl)) return null;
  return { baseUrl, apiKey };
}

// --- Constants ---

const MIN_STREAM_TIMEOUT_MS = 5_000;

const SYSTEM_PROMPT =
  "You are a task worker in the Grimnir system. Complete the task below using only the provided context. Be concise and direct.";

// --- Helpers ---

function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  // Retry-After is either delta-seconds or an HTTP-date (RFC 9110).
  const n = Number(raw);
  if (Number.isFinite(n)) return n >= 0 ? Math.round(n) : null;
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(0, Math.round((dateMs - Date.now()) / 1000));
  return null;
}

function buildUserMessage(task: HomeserverTaskConfig): string {
  const parts: string[] = [];
  if (task.injectedContext) parts.push("## Context\n" + task.injectedContext);
  parts.push("## Task\n" + task.prompt);
  return parts.join("\n\n---\n\n");
}

// --- Executor ---

export async function executeHomeserverTask(
  task: HomeserverTaskConfig,
  taskId: string,
  logDir: string,
  options?: HomeserverExecutorOptions,
): Promise<HomeserverExecutorResult> {
  const logFile = path.join(logDir, `${taskId}.log`);
  const startedAt = new Date().toISOString();
  const userMessage = buildUserMessage(task);
  const promptChars = SYSTEM_PROMPT.length + userMessage.length;

  fs.mkdirSync(logDir, { recursive: true });
  const logStream = fs.createWriteStream(logFile, { encoding: "utf-8" });
  // Best-effort log: never let a late stream error (ENOENT/EACCES after the dir is
  // removed, a full disk, etc.) surface as an unhandled exception that crashes the worker.
  logStream.on("error", () => {});
  logStream.write(
    [
      "=== Hugin Task Log (homeserver/M5) ===",
      `Task: ${taskId}`,
      `Runtime: homeserver`,
      `Path: ${task.path}`,
      `Model: ${task.model ?? "(gateway-selected)"}`,
      `Gateway: ${task.gatewayBaseUrl}`,
      `Timeout: ${task.timeoutMs}ms`,
      `Context injected: ${task.injectedContext ? `${task.injectedContext.length} chars` : "none"}`,
      `Started: ${startedAt}`,
      "===\n",
    ].join("\n"),
  );

  let output = "";
  const appendOutput = (text: string) => {
    output += text;
    if (output.length > task.maxOutputChars * 2) {
      output = output.slice(-task.maxOutputChars);
    }
    logStream.write(text);
  };

  const startMs = Date.now();
  const result: HomeserverExecutorResult = {
    exitCode: 1,
    output: "",
    logFile,
    resultText: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    inferenceMs: null,
    promptChars,
    outputChars: 0,
    backpressure: "none",
    retryAfterS: null,
    delegated: null,
    outcome: null,
    score: null,
    decisionReason: null,
    ledgerId: null,
    escalated: null,
  };

  const finish = async (): Promise<HomeserverExecutorResult> => {
    result.output = output.slice(-task.maxOutputChars);
    result.outputChars = output.length;
    if (result.inferenceMs === null) result.inferenceMs = Date.now() - startMs;
    const footer = [
      "\n===",
      `Exit code: ${result.exitCode}`,
      `Backpressure: ${result.backpressure}${result.retryAfterS !== null ? ` (retry ${result.retryAfterS}s)` : ""}`,
      `Duration: ${Math.round((Date.now() - startMs) / 1000)}s`,
      `Prompt tokens: ${result.promptTokens ?? "unknown"}`,
      `Completion tokens: ${result.completionTokens ?? "unknown"}`,
      `Output chars: ${output.length}`,
      `Completed: ${new Date().toISOString()}`,
      "===\n",
    ].join("\n");
    logStream.write(footer);
    await new Promise<void>((resolve) => logStream.end(() => resolve()));
    return result;
  };

  // Wire an abort controller + timeout, honoring an externally-supplied signal.
  const abortController = new AbortController();
  if (options?.abortController) {
    if (options.abortController.signal.aborted) abortController.abort();
    else options.abortController.signal.addEventListener("abort", () => abortController.abort());
  }
  const timer = setTimeout(() => abortController.abort(), task.timeoutMs);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (task.apiKey) headers.Authorization = `Bearer ${task.apiKey}`;

  try {
    const url =
      task.path === "delegate"
        ? `${task.gatewayBaseUrl}/delegate`
        : `${task.gatewayBaseUrl}/v1/chat/completions`;

    const body: Record<string, unknown> =
      task.path === "delegate"
        ? {
            // The gateway /delegate HTTP handler only accepts prompt + taskType
            // (+ systemPrompt/maxTokens). It does NOT accept modelId or frontierModelId
            // today, so we don't send them — see gateway-api-contract.md.
            prompt: userMessage,
            ...(task.taskType ? { taskType: task.taskType } : {}),
          }
        : {
            model: task.model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMessage },
            ],
            stream: true,
          };

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
    // NOTE: the abort timer stays armed until the body is fully consumed (see the
    // finally below) — a gateway that flushes headers then stalls the body must not
    // be able to wedge Hugin's single worker on res.json()/res.text().

    // Backpressure: the gateway is telling us to back off, not that the task failed.
    if (res.status === 429 || res.status === 503) {
      result.backpressure = res.status === 429 ? "quota" : "admission";
      result.retryAfterS = parseRetryAfter(res);
      result.exitCode = 1;
      const detail = await res.text().catch(() => "");
      appendOutput(
        `[Gateway ${res.status} ${result.backpressure}${result.retryAfterS !== null ? `, retry ${result.retryAfterS}s` : ""}] ${detail}\n`,
      );
      return finish();
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      appendOutput(`[Gateway HTTP ${res.status}] ${errText}\n`);
      result.exitCode = res.status; // surface 401/403/400 as the exit code
      return finish();
    }

    if (task.path === "delegate") {
      // Non-streaming JSON: DelegationOutcome.
      const outcome = (await res.json()) as {
        delegated?: boolean;
        escalate?: boolean;
        outcome?: string;
        score?: number | null;
        output?: string;
        decisionReason?: string;
        ledgerId?: string;
        metrics?: { promptTokens?: number; completionTokens?: number; latencyMs?: number };
        frontierOutput?: string;
      };
      const text = outcome.output ?? outcome.frontierOutput ?? "";
      appendOutput(text);
      result.resultText = text.trim() || null;
      result.delegated = outcome.delegated ?? null;
      result.escalated = outcome.escalate ?? null;
      result.outcome = outcome.outcome ?? null;
      result.score = outcome.score ?? null;
      result.decisionReason = outcome.decisionReason ?? null;
      result.ledgerId = outcome.ledgerId ?? null;
      result.promptTokens = outcome.metrics?.promptTokens ?? null;
      result.completionTokens = outcome.metrics?.completionTokens ?? null;
      if (result.promptTokens !== null || result.completionTokens !== null) {
        result.totalTokens = (result.promptTokens ?? 0) + (result.completionTokens ?? 0);
      }
      if (typeof outcome.metrics?.latencyMs === "number") result.inferenceMs = outcome.metrics.latencyMs;
      // A well-formed 200 DelegationOutcome can still report failure; don't mask fail/error
      // as a successful Hugin execution (that would suppress retry/escalation downstream).
      result.exitCode = outcome.outcome === "fail" || outcome.outcome === "error" ? 1 : 0;
      return finish();
    }

    // Chat path: stream the OpenAI-compatible SSE body.
    if (!res.body) {
      appendOutput("[Gateway error: no response body]\n");
      return finish();
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let timedOut = false;

    const rawRemainingMs = task.timeoutMs - (Date.now() - startMs);
    const remainingMs = Math.max(MIN_STREAM_TIMEOUT_MS, rawRemainingMs);
    const streamTimer = setTimeout(() => {
      timedOut = true;
      reader.cancel().catch(() => {});
    }, remainingMs);

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) return;
      const data = trimmed.slice(6).trim();
      if (data === "[DONE]") return;
      try {
        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) appendOutput(delta);
        if (chunk.usage) {
          result.promptTokens = chunk.usage.prompt_tokens ?? null;
          result.completionTokens = chunk.usage.completion_tokens ?? null;
          result.totalTokens = chunk.usage.total_tokens ?? null;
        }
      } catch {
        // skip malformed chunks
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      }
      buffer += decoder.decode();
      if (buffer) processLine(buffer);
    } finally {
      clearTimeout(streamTimer);
    }

    if (timedOut) {
      result.exitCode = "TIMEOUT";
      appendOutput("\n[Gateway streaming timed out]\n");
    } else {
      result.exitCode = 0;
      result.resultText = output.trim() || null;
    }
    return finish();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      result.exitCode = "TIMEOUT";
      appendOutput(`\n[Gateway request aborted after ${Math.round((Date.now() - startMs) / 1000)}s]\n`);
    } else {
      result.exitCode = 1;
      appendOutput(`\n[Gateway error: ${err instanceof Error ? err.message : String(err)}]\n`);
    }
    return finish();
  } finally {
    // Clear the task timeout only after the response body has been fully consumed.
    clearTimeout(timer);
  }
}
