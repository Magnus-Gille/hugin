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
import { estimateCostUsd } from "../model-pricing.js";
import { getRegistryEntryById } from "../runtime-registry.js";
import { getProviderConfig } from "./provider-config.js";

/** Default maximum output characters when not specified in the request. */
export const DEFAULT_MAX_OUTPUT_CHARS = 50_000;

export interface WorkerRequest {
  /** Provider id: "openrouter" | "berget" | "pi-harness" */
  provider: string;
  /** Resolved model id. */
  model: string;
  prompt: string;
  systemPrompt?: string;
  timeoutMs: number;
  /** Truncate output to this many characters. Defaults to DEFAULT_MAX_OUTPUT_CHARS. */
  maxOutputChars?: number;
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
  /** Set when ok=false. Never throws out of run(). */
  error?: string;
}

export interface WorkerExecutor {
  run(req: WorkerRequest): Promise<WorkerResult>;
}

/**
 * Factory: returns the appropriate executor for the given provider id.
 *   - "pi-harness" → PiHarnessExecutor
 *   - everything else → DirectModelExecutor
 */
export function createWorkerExecutor(provider: string): WorkerExecutor {
  if (provider === "pi-harness") {
    return new PiHarnessExecutor();
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
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(`${providerCfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: buildHeaders(req.provider, apiKey),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (fetchErr) {
        const errMsg = isAbortError(fetchErr)
          ? `Request timed out after ${req.timeoutMs}ms`
          : `Network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`;
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
            error: `Response body stalled and timed out after ${req.timeoutMs}ms`,
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

      const { content, inputTokens, outputTokens } = extracted;
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
      };
    } finally {
      clearTimeout(timer);
    }
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

    const args = buildPiArgs(req, entry);

    return new Promise<WorkerResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(entry.harnessCmd ?? "pi", args, {
          stdio: ["ignore", "pipe", "pipe"],
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

      const killTimer = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
      }, req.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        clearTimeout(killTimer);
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

        if (killed) {
          resolve({
            ok: false,
            output: "",
            provider: req.provider,
            model: req.model,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            latencyMs: Date.now() - start,
            error: `Process timed out after ${req.timeoutMs}ms`,
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
}
interface ExtractedError {
  ok: false;
  error: string;
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
  const choice = choices[0] as Record<string, unknown>;
  const message = choice["message"] as Record<string, unknown> | undefined;
  const content = message?.["content"];
  if (typeof content !== "string") {
    return { ok: false, error: "Response missing choices[0].message.content (string)" };
  }

  const usage = r["usage"] as Record<string, unknown> | undefined;
  const inputTokens =
    typeof usage?.["prompt_tokens"] === "number" ? usage["prompt_tokens"] : null;
  const outputTokens =
    typeof usage?.["completion_tokens"] === "number" ? usage["completion_tokens"] : null;

  return { ok: true, content, inputTokens, outputTokens };
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
      if (typeof usage["input_tokens"] === "number") inputTokens = usage["input_tokens"];
      if (typeof usage["output_tokens"] === "number") outputTokens = usage["output_tokens"];
      if (typeof usage["prompt_tokens"] === "number") inputTokens = usage["prompt_tokens"];
      if (typeof usage["completion_tokens"] === "number")
        outputTokens = usage["completion_tokens"];
    }
  }

  return { output, inputTokens, outputTokens };
}

function isAbortError(err: unknown): boolean {
  return (err as Error & { name?: string })?.name === "AbortError";
}
