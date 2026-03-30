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

// --- System prompt ---

const SYSTEM_PROMPT =
  "You are a task worker in the Grimnir system. Complete the task below using only the provided context. Be concise and direct.";

// --- Executor ---

export async function executeOllamaTask(
  task: OllamaTaskConfig,
  taskId: string,
  logDir: string,
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
    const timer = setTimeout(() => {
      abortController.abort();
    }, task.timeoutMs);

    const res = await fetch(`${task.ollamaBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: task.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        stream: true,
      }),
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

      // Set up streaming timeout (the initial fetch may succeed but streaming can hang)
      const streamTimer = setTimeout(() => {
        timedOut = true;
        reader.cancel().catch(() => {});
      }, task.timeoutMs - (Date.now() - startMs));

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;

            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) {
                appendOutput(delta);
              }

              // Extract usage from final chunk (OpenAI-compatible format)
              if (chunk.usage) {
                promptTokens = chunk.usage.prompt_tokens ?? null;
                completionTokens = chunk.usage.completion_tokens ?? null;
                totalTokens = chunk.usage.total_tokens ?? null;
              }
            } catch {
              // Skip malformed chunks
            }
          }
        }
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

    // Try to get timing info from ollama's native API response headers or
    // use a separate call. The /v1/chat/completions endpoint doesn't reliably
    // include timing, so we estimate from wall clock if needed.
    // Ollama's native /api/generate returns total_duration and load_duration,
    // but we're using the OpenAI-compatible endpoint for simplicity.
    // Record wall-clock inference time as a fallback.
    inferenceMs = Date.now() - startMs;
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
