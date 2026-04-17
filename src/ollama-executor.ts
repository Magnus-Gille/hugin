/**
 * Ollama executor for Hugin tasks.
 *
 * Calls ollama's OpenAI-compatible API with streaming, matching Hugin's
 * existing operational contract (incremental logs, partial capture on timeout).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// --- Types ---

export interface OllamaTaskConfig {
  prompt: string;
  model: string;
  ollamaBaseUrl: string;
  timeoutMs: number;
  maxOutputChars: number;
  injectedContext?: string;
  /**
   * Control hybrid-reasoning behaviour for models that generate internal
   * "thinking" tokens (qwen3, deepseek-r1, gpt-oss, …).
   * - `false`: force think:false via native /api/chat (fast path, skips reasoning).
   * - `true`: force think:true via native /api/chat (explicit opt-in to reasoning).
   * - `undefined`: auto — default to think:false for known reasoning families
   *   (otherwise use the OpenAI-compat endpoint unchanged).
   */
  reasoning?: boolean;
}

/**
 * Model-family patterns that emit internal thinking tokens by default AND
 * accept a boolean `think` parameter to disable it. GPT-OSS is intentionally
 * omitted: it uses level-based reasoning (`"low"`/`"medium"`/`"high"`) and
 * ignores boolean values — auto-routing it here would silently do nothing.
 * If/when Hugin adds level-based reasoning support, extend the task schema
 * first rather than this list.
 */
const REASONING_MODEL_PATTERNS: RegExp[] = [
  /^qwen3(?:[.:]|$)/i,
  /^deepseek-r1/i,
  /^magistral/i,
];

/**
 * Returns true when the model family is known to generate internal reasoning
 * tokens and therefore benefits from explicit `think:false` by default.
 */
export function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_PATTERNS.some((re) => re.test(model));
}

export interface OllamaExecutorResult {
  exitCode: number | "TIMEOUT";
  output: string;
  logFile: string;
  resultText: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  inferenceMs: number | null;
  loadMs: number | null;
  promptChars: number;
  outputChars: number;
  freeMemBeforeMb: number;
  freeMemAfterMb: number;
}

export interface OllamaExecutorOptions {
  abortController?: AbortController;
}

// --- Constants ---

/** Minimum streaming timeout floor to prevent near-zero or negative timeouts after a slow initial fetch. */
const MIN_STREAM_TIMEOUT_MS = 5_000;

// --- System prompt ---

const SYSTEM_PROMPT =
  "You are a task worker in the Grimnir system. Complete the task below using only the provided context. Be concise and direct.";

// --- Executor ---

export async function executeOllamaTask(
  task: OllamaTaskConfig,
  taskId: string,
  logDir: string,
  options?: OllamaExecutorOptions,
): Promise<OllamaExecutorResult> {
  const logFile = path.join(logDir, `${taskId}.log`);
  const startedAt = new Date().toISOString();
  const freeMemBeforeMb = Math.round(os.freemem() / 1024 / 1024);

  // Open log file stream
  const logStream = fs.createWriteStream(logFile, { encoding: "utf-8" });
  logStream.write(
    [
      "=== Hugin Task Log (ollama) ===",
      `Task: ${taskId}`,
      `Runtime: ollama`,
      `Model: ${task.model}`,
      `Host: ${task.ollamaBaseUrl}`,
      `Timeout: ${task.timeoutMs}ms`,
      `Context injected: ${task.injectedContext ? `${task.injectedContext.length} chars` : "none"}`,
      `Free memory: ${freeMemBeforeMb} MB`,
      `Started: ${startedAt}`,
      "===\n",
    ].join("\n"),
  );

  // Build user message with optional context
  const userParts: string[] = [];
  if (task.injectedContext) {
    userParts.push("## Context\n" + task.injectedContext);
  }
  userParts.push("## Task\n" + task.prompt);
  const userMessage = userParts.join("\n\n---\n\n");
  const promptChars = SYSTEM_PROMPT.length + userMessage.length;

  // Ring buffer for output capture
  let output = "";
  const appendOutput = (text: string) => {
    output += text;
    if (output.length > task.maxOutputChars * 2) {
      output = output.slice(-task.maxOutputChars);
    }
    logStream.write(text);
  };

  const startMs = Date.now();
  let exitCode: number | "TIMEOUT" = 1;
  let resultText: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let totalTokens: number | null = null;
  let inferenceMs: number | null = null;
  let loadMs: number | null = null;

  try {
    const abortController = new AbortController();
    if (options?.abortController) {
      if (options.abortController.signal.aborted) {
        abortController.abort();
      } else {
        options.abortController.signal.addEventListener("abort", () => {
          abortController.abort();
        });
      }
    }
    const timer = setTimeout(() => {
      abortController.abort();
    }, task.timeoutMs);

    // Decide whether we need the native /api/chat endpoint (it's the only one
    // that honours the `think` parameter). Explicit reasoning setting always
    // wins; otherwise auto-default to think:false for reasoning model families.
    const needsNativeChat =
      task.reasoning !== undefined || isReasoningModel(task.model);
    const thinkValue = task.reasoning ?? false;

    const endpoint = needsNativeChat ? "/api/chat" : "/v1/chat/completions";
    const body: Record<string, unknown> = {
      model: task.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      stream: true,
    };
    if (needsNativeChat) {
      body.think = thinkValue;
      // Log-only metadata — must not go through appendOutput(), which would
      // pollute output/resultText and corrupt tasks that expect clean JSON.
      logStream.write(`[Ollama native /api/chat, think:${thinkValue}]\n`);
    }

    const res = await fetch(`${task.ollamaBaseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      appendOutput(`[Ollama HTTP ${res.status}] ${errText}\n`);
      exitCode = 1;
    } else if (!res.body) {
      appendOutput("[Ollama error: no response body]\n");
      exitCode = 1;
    } else {
      // Stream SSE response
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let timedOut = false;

      // Set up streaming timeout (the initial fetch may succeed but streaming can hang).
      // Apply a minimum floor so a slow initial connect can't leave near-zero or negative
      // remaining time, which would fire the timer on the next tick and immediately cancel.
      const rawRemainingMs = task.timeoutMs - (Date.now() - startMs);
      const remainingMs = Math.max(MIN_STREAM_TIMEOUT_MS, rawRemainingMs);
      if (rawRemainingMs < MIN_STREAM_TIMEOUT_MS) {
        appendOutput(
          `[Ollama stream timeout floored to ${MIN_STREAM_TIMEOUT_MS}ms (raw remaining: ${rawRemainingMs}ms)]\n`,
        );
      }
      const streamTimer = setTimeout(() => {
        timedOut = true;
        reader.cancel().catch(() => {});
      }, remainingMs);

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let data: string;
        if (needsNativeChat) {
          // Native /api/chat streams NDJSON — each non-empty line is JSON.
          data = trimmed;
        } else {
          // OpenAI-compat streams SSE: `data: {json}` or `data: [DONE]`.
          if (!trimmed.startsWith("data: ")) return;
          data = trimmed.slice(6).trim();
          if (data === "[DONE]") return;
        }

        try {
          const chunk = JSON.parse(data);

          if (needsNativeChat) {
            const delta = chunk.message?.content;
            if (delta) appendOutput(delta);

            // Capture thinking trace to the log file only (never into
            // resultText) so opt-in Reasoning: true stays debuggable without
            // corrupting machine-readable output.
            const thinking = chunk.message?.thinking;
            if (thinking) logStream.write(`[thinking] ${thinking}`);

            // Native endpoint embeds usage + timing in the final (done:true)
            // chunk instead of a separate usage object.
            if (chunk.done) {
              if (typeof chunk.prompt_eval_count === "number") {
                promptTokens = chunk.prompt_eval_count;
              }
              if (typeof chunk.eval_count === "number") {
                completionTokens = chunk.eval_count;
              }
              if (promptTokens !== null || completionTokens !== null) {
                totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
              }
              if (typeof chunk.total_duration === "number") {
                inferenceMs = Math.round(chunk.total_duration / 1_000_000);
              }
              if (typeof chunk.load_duration === "number") {
                loadMs = Math.round(chunk.load_duration / 1_000_000);
              }
            }
          } else {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) appendOutput(delta);

            // OpenAI-compat usage arrives on the final chunk.
            if (chunk.usage) {
              promptTokens = chunk.usage.prompt_tokens ?? null;
              completionTokens = chunk.usage.completion_tokens ?? null;
              totalTokens = chunk.usage.total_tokens ?? null;
            }
          }
        } catch {
          // Skip malformed chunks
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

        // Flush: the final record may arrive without a trailing newline, so
        // anything left in the buffer (plus any bytes pending in the decoder)
        // must still be parsed. On /api/chat this chunk carries the done:true
        // payload with usage + timing metadata.
        buffer += decoder.decode();
        if (buffer) processLine(buffer);
      } finally {
        clearTimeout(streamTimer);
      }

      if (timedOut) {
        exitCode = "TIMEOUT";
        appendOutput("\n[Ollama streaming timed out]\n");
      } else {
        exitCode = 0;
        resultText = output.trim();
      }
    }

    // Record wall-clock inference time only when the native endpoint didn't
    // provide timing (OpenAI-compat path has no duration fields).
    if (inferenceMs === null) {
      inferenceMs = Date.now() - startMs;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      exitCode = "TIMEOUT";
      const elapsedS = Math.round((Date.now() - startMs) / 1000);
      appendOutput(`\n[Ollama request aborted after ${elapsedS}s]\n`);
    } else {
      exitCode = 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      appendOutput(`\n[Ollama error: ${errMsg}]\n`);
    }
  } finally {
    const freeMemAfterMb = Math.round(os.freemem() / 1024 / 1024);
    const durationS = Math.round((Date.now() - startMs) / 1000);
    const footer = [
      "\n===",
      `Exit code: ${exitCode}`,
      `Duration: ${durationS}s`,
      `Model: ${task.model}`,
      `Prompt tokens: ${promptTokens ?? "unknown"}`,
      `Completion tokens: ${completionTokens ?? "unknown"}`,
      `Prompt chars: ${promptChars}`,
      `Output chars: ${output.length}`,
      `Free memory after: ${freeMemAfterMb} MB`,
      `Completed: ${new Date().toISOString()}`,
      "===\n",
    ].join("\n");

    logStream.write(footer);
    await new Promise<void>((resolve) => logStream.end(resolve));

    return {
      exitCode,
      output: output.slice(-task.maxOutputChars),
      logFile,
      resultText,
      promptTokens,
      completionTokens,
      totalTokens,
      inferenceMs,
      loadMs,
      promptChars,
      outputChars: output.length,
      freeMemBeforeMb,
      freeMemAfterMb,
    };
  }
}
