import * as fs from "node:fs";
import * as path from "node:path";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";

// --- Types ---

export interface SdkTaskConfig {
  prompt: string;
  workingDir: string;
  timeoutMs: number;
  muninUrl: string;
  muninApiKey: string;
  maxOutputChars: number;
  model?: string;
}

export interface SdkExecutorResult {
  exitCode: number | "TIMEOUT";
  output: string;
  logFile: string;
  resultText: string | null;
  costUsd: number | null;
  numTurns: number | null;
  durationApiMs: number | null;
}

// --- SDK Executor ---

export interface SdkExecutorOptions {
  onTimeout?: (partialOutput: string) => Promise<void>;
  /** External abort controller for graceful shutdown. If provided, aborting it will cancel the SDK query. */
  abortController?: AbortController;
}

export async function executeSdkTask(
  task: SdkTaskConfig,
  taskId: string,
  logDir: string,
  options?: SdkExecutorOptions,
): Promise<SdkExecutorResult> {
  const logFile = path.join(logDir, `${taskId}.log`);
  const startedAt = new Date().toISOString();

  // Ensure working directory exists
  fs.mkdirSync(task.workingDir, { recursive: true });

  // Open log file stream
  const logStream = fs.createWriteStream(logFile, { encoding: "utf-8" });
  logStream.write(
    [
      "=== Hugin Task Log (SDK) ===",
      `Task: ${taskId}`,
      `Runtime: claude (agent-sdk)`,
      `Working dir: ${task.workingDir}`,
      `Timeout: ${task.timeoutMs}`,
      `Started: ${startedAt}`,
      "===\n",
    ].join("\n"),
  );

  const { onTimeout, abortController: externalAbort } = options ?? {};
  const abortController = new AbortController();
  let timedOut = false;
  let output = "";

  // If an external abort controller is provided (e.g., for graceful shutdown),
  // forward its abort signal to our internal controller
  if (externalAbort) {
    if (externalAbort.signal.aborted) {
      abortController.abort();
    } else {
      externalAbort.signal.addEventListener("abort", () => {
        abortController.abort();
      });
    }
  }

  const appendOutput = (text: string) => {
    output += text;
    if (output.length > task.maxOutputChars * 2) {
      output = output.slice(-task.maxOutputChars);
    }
    logStream.write(text);
  };

  // Two-stage timeout: abort first, then force-close after grace period
  const CLOSE_GRACE_MS = 10_000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const timer = setTimeout(() => {
    timedOut = true;
    const elapsedS = Math.round((Date.now() - startMs) / 1000);
    appendOutput(
      `\n===\nTIMEOUT after ${elapsedS}s — aborting SDK query\n===\n`,
    );

    // Stage 1: signal abort IMMEDIATELY (non-blocking)
    abortController.abort();

    // Fire onTimeout in parallel — must not delay abort or close
    if (onTimeout) {
      onTimeout(output.slice(-task.maxOutputChars)).catch((err) => {
        console.error("onTimeout callback error:", err);
      });
    }

    // Stage 2: force close after grace period if generator hasn't terminated
    closeTimer = setTimeout(() => {
      if (queryInstance) {
        appendOutput(`\n[Force closing SDK query after ${CLOSE_GRACE_MS}ms grace period]\n`);
        try {
          queryInstance.close();
        } catch {
          // Already closed
        }
      }
    }, CLOSE_GRACE_MS);
  }, task.timeoutMs);

  const startMs = Date.now();
  let resultText: string | null = null;
  let costUsd: number | null = null;
  let numTurns: number | null = null;
  let durationApiMs: number | null = null;
  let exitCode: number | "TIMEOUT" = 1;
  let queryInstance: Query | null = null;

  try {
    // Build MCP servers config so task-spawned agents get Munin access
    const mcpServers: Record<string, { type: "http"; url: string; headers?: Record<string, string> }> = {};
    if (task.muninUrl && task.muninApiKey) {
      const muninMcpUrl = task.muninUrl.replace(/\/$/, "") + "/mcp";
      mcpServers["munin-memory"] = {
        type: "http",
        url: muninMcpUrl,
        headers: { Authorization: `Bearer ${task.muninApiKey}` },
      };
    }

    queryInstance = query({
      prompt: task.prompt,
      options: {
        cwd: task.workingDir,
        abortController,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        ...(task.model ? { model: task.model } : {}),
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        env: {
          ...process.env,
          HOME: "/home/magnus",
          HUGIN_TASK_ID: taskId,
        },
      },
    });

    for await (const message of queryInstance) {
      switch (message.type) {
        case "assistant": {
          // Extract text content from the assistant message
          for (const block of message.message.content) {
            if (
              typeof block === "object" &&
              block !== null &&
              "type" in block &&
              block.type === "text" &&
              "text" in block
            ) {
              appendOutput((block as { text: string }).text + "\n");
            }
          }
          break;
        }

        case "result": {
          if (message.subtype === "success") {
            resultText = message.result;
            exitCode = 0;
          } else {
            // Error result
            const errors =
              "errors" in message ? (message.errors as string[]) : [];
            appendOutput(
              `\n[SDK Error: ${message.subtype}] ${errors.join(", ")}\n`,
            );
            exitCode = 1;
          }
          costUsd = message.total_cost_usd;
          numTurns = message.num_turns;
          durationApiMs = message.duration_api_ms;
          break;
        }

        case "system": {
          if ("subtype" in message && message.subtype !== "compact_boundary") {
            appendOutput(`[system] ${JSON.stringify(message)}\n`);
          }
          break;
        }

        default:
          // Log other message types at debug level
          if ("type" in message) {
            appendOutput(`[${message.type}] ${JSON.stringify(message).slice(0, 500)}\n`);
          }
          break;
      }
    }
  } catch (err) {
    if (timedOut) {
      exitCode = "TIMEOUT";
      appendOutput(`\n[SDK aborted due to timeout]\n`);
    } else if (err instanceof Error && err.name === "AbortError") {
      exitCode = "TIMEOUT";
      appendOutput(`\n[SDK AbortError: ${err.message}]\n`);
    } else {
      exitCode = 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      appendOutput(`\n[SDK Error: ${errMsg}]\n`);
    }
  } finally {
    clearTimeout(timer);
    if (closeTimer) clearTimeout(closeTimer);

    // Ensure query is cleaned up on timeout
    if (queryInstance && timedOut) {
      try {
        queryInstance.close();
      } catch {
        // Already closed
      }
    }

    const durationS = Math.round((Date.now() - startMs) / 1000);
    const footer = [
      "\n===",
      `Exit code: ${exitCode}`,
      `Duration: ${durationS}s`,
      `Cost: ${costUsd !== null ? `$${costUsd.toFixed(4)}` : "unknown"}`,
      `Turns: ${numTurns ?? "unknown"}`,
      `API time: ${durationApiMs !== null ? `${Math.round(durationApiMs / 1000)}s` : "unknown"}`,
      `Completed: ${new Date().toISOString()}`,
      "===\n",
    ].join("\n");

    logStream.write(footer);
    await new Promise<void>((resolve) => logStream.end(resolve));
  }

  return {
    exitCode: timedOut ? "TIMEOUT" : exitCode,
    output: output.slice(-task.maxOutputChars),
    logFile,
    resultText,
    costUsd,
    numTurns,
    durationApiMs,
  };
}
