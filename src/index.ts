import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import express from "express";
import { MuninClient } from "./munin-client.js";

const LOG_DIR = path.join(
  process.env.HOME || "/home/magnus",
  ".hugin",
  "logs"
);

// --- Configuration ---

const config = {
  port: parseInt(process.env.HUGIN_PORT || "3032"),
  host: process.env.HUGIN_HOST || "127.0.0.1",
  muninUrl: process.env.MUNIN_URL || "http://localhost:3030",
  muninApiKey: process.env.MUNIN_API_KEY || "",
  pollIntervalMs: parseInt(process.env.HUGIN_POLL_INTERVAL_MS || "30000"),
  defaultTimeoutMs: parseInt(process.env.HUGIN_DEFAULT_TIMEOUT_MS || "300000"),
  workspace: process.env.HUGIN_WORKSPACE || "/home/magnus/workspace",
  maxOutputChars: parseInt(process.env.HUGIN_MAX_OUTPUT_CHARS || "50000"),
  notifyEmail: process.env.NOTIFY_EMAIL || "",
  heimdallUrl: process.env.HEIMDALL_URL || "http://127.0.0.1:3033",
};

if (!config.muninApiKey) {
  console.error("MUNIN_API_KEY is required");
  process.exit(1);
}

// --- State ---

let shuttingDown = false;
let currentTask: string | null = null;
let currentChild: ChildProcess | null = null;
const startedAt = Date.now();

const munin = new MuninClient({
  baseUrl: config.muninUrl,
  apiKey: config.muninApiKey,
});

// --- Task parsing ---

interface TaskConfig {
  prompt: string;
  runtime: "claude" | "codex";
  workingDir: string;
  timeoutMs: number;
  submittedBy: string;
  submittedAt: string;
}

function parseTask(content: string): TaskConfig | null {
  const runtime =
    content.match(/\*\*Runtime:\*\*\s*(claude|codex)/i)?.[1]?.toLowerCase() as
      | "claude"
      | "codex"
      | undefined;
  const workingDir = content.match(
    /\*\*Working dir:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const timeoutStr = content.match(/\*\*Timeout:\*\*\s*(\d+)/i)?.[1];
  const submittedBy = content.match(
    /\*\*Submitted by:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const submittedAt = content.match(
    /\*\*Submitted at:\*\*\s*(.+)/i
  )?.[1]?.trim();

  // Extract prompt from ### Prompt section
  const promptMatch = content.match(/###\s*Prompt\s*\n([\s\S]+)$/i);
  const prompt = promptMatch?.[1]?.trim();

  if (!prompt || !runtime) return null;

  return {
    prompt,
    runtime: runtime || "claude",
    workingDir: workingDir || config.workspace,
    timeoutMs: timeoutStr ? parseInt(timeoutStr) : config.defaultTimeoutMs,
    submittedBy: submittedBy || "unknown",
    submittedAt: submittedAt || new Date().toISOString(),
  };
}

// --- Log directory ---

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function extractTaskId(namespace: string): string {
  return namespace.replace(/^tasks\//, "");
}

// --- Email notification via Heimdall ---

async function sendTaskNotification(
  taskId: string,
  status: "completed" | "failed" | "timed out",
  durationS: number,
  output: string,
): Promise<void> {
  if (!config.notifyEmail) return;

  const resultSnippet = output.slice(0, 500) + (output.length > 500 ? "\n…(truncated)" : "");
  const subject = `[Hugin] Task ${taskId}: ${status}`;
  const body = [
    `Task: ${taskId}`,
    `Status: ${status}`,
    `Duration: ${durationS}s`,
    "",
    "Result (first 500 chars):",
    resultSnippet,
    "",
    `Full result: memory_read("tasks/${taskId}", "result")`,
  ].join("\n");

  try {
    const res = await fetch(`${config.heimdallUrl}/api/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: config.notifyEmail, subject, body }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Email notification failed (${res.status}): ${text.slice(0, 200)}`);
    } else {
      console.log(`Email notification sent for task ${taskId}`);
    }
  } catch (err) {
    console.error("Email notification error:", err);
  }
}

// --- Log rotation ---

async function rotateOldLogs(): Promise<void> {
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - thirtyDaysMs;
  try {
    const files = fs.readdirSync(LOG_DIR);
    let cleaned = 0;
    for (const file of files) {
      if (!file.endsWith(".log")) continue;
      const filePath = path.join(LOG_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // Skip files we can't stat/delete
      }
    }
    if (cleaned > 0) {
      console.log(`Log rotation: cleaned ${cleaned} log file(s) older than 30 days`);
    }
  } catch {
    // LOG_DIR might not exist yet on first run
  }
}

// --- Task execution ---

interface SpawnContext {
  taskNs: string;
  muninClient: MuninClient;
}

function spawnRuntime(
  task: TaskConfig,
  ctx: SpawnContext
): Promise<{ exitCode: number | "TIMEOUT"; output: string; logFile: string }> {
  return new Promise((resolve) => {
    const taskId = extractTaskId(ctx.taskNs);
    const logFile = path.join(LOG_DIR, `${taskId}.log`);
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    // Ensure working directory exists
    fs.mkdirSync(task.workingDir, { recursive: true });

    // Open log file stream
    const logStream = fs.createWriteStream(logFile, { encoding: "utf-8" });
    logStream.write(
      [
        "=== Hugin Task Log ===",
        `Task: ${ctx.taskNs}`,
        `Runtime: ${task.runtime}`,
        `Working dir: ${task.workingDir}`,
        `Timeout: ${task.timeoutMs}`,
        `Started: ${startedAt}`,
        "===\n",
      ].join("\n")
    );

    const cmd =
      task.runtime === "codex"
        ? ["codex", ["exec", "--full-auto", task.prompt]]
        : ["claude", ["-p", "--dangerously-skip-permissions", "--verbose", task.prompt]];

    const child = spawn(cmd[0] as string, cmd[1] as string[], {
      cwd: task.workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });

    currentChild = child;
    let timedOut = false;

    // Ring buffer for output capture (kept for Munin result)
    let output = "";
    const appendOutput = (chunk: Buffer) => {
      // Replace non-UTF8 sequences for safety
      const text = chunk.toString("utf-8");
      output += text;
      if (output.length > config.maxOutputChars * 2) {
        output = output.slice(-config.maxOutputChars);
      }
      // Stream to log file
      logStream.write(text);
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    const timer = setTimeout(async () => {
      timedOut = true;
      const elapsedS = Math.round((Date.now() - startMs) / 1000);
      console.log(
        `Task timeout (${task.timeoutMs}ms / ${elapsedS}s), sending SIGTERM to child`
      );

      // Append timeout note to log file
      logStream.write(
        `\n===\nTIMEOUT after ${elapsedS}s — sending SIGTERM\n===\n`
      );

      // Write partial result to Munin before killing
      try {
        await ctx.muninClient.write(ctx.taskNs, "result", [
          "## Result (PARTIAL — task timed out)\n",
          `- **Exit code:** TIMEOUT`,
          `- **Started at:** ${startedAt}`,
          `- **Timed out at:** ${new Date().toISOString()}`,
          `- **Duration:** ${elapsedS}s`,
          `- **Log file:** ~/.hugin/logs/${taskId}.log`,
          "",
          "### Last Output",
          "```",
          output.slice(-config.maxOutputChars) || "(no output captured)",
          "```",
        ].join("\n"));
      } catch (err) {
        console.error("Failed to write partial result on timeout:", err);
      }

      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 10000);
    }, task.timeoutMs);

    let logEnded = false;
    function endLog(footer: string): void {
      if (logEnded) return;
      logEnded = true;
      logStream.write(footer);
      logStream.end();
    }

    child.on("close", (code) => {
      clearTimeout(timer);
      currentChild = null;

      const durationS = Math.round((Date.now() - startMs) / 1000);

      endLog(
        [
          "\n===",
          `Exit code: ${timedOut ? "TIMEOUT" : (code ?? 1)}`,
          `Duration: ${durationS}s`,
          `Completed: ${new Date().toISOString()}`,
          "===\n",
        ].join("\n")
      );

      resolve({
        exitCode: timedOut ? "TIMEOUT" : (code ?? 1),
        output: output.slice(-config.maxOutputChars),
        logFile,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      currentChild = null;

      endLog(`\n=== Spawn error: ${err.message} ===\n`);

      resolve({
        exitCode: 1,
        output: `Spawn error: ${err.message}\n${output.slice(-config.maxOutputChars)}`,
        logFile,
      });
    });
  });
}

// --- Stale task recovery ---

async function recoverStaleTasks(): Promise<void> {
  try {
    const { results } = await munin.query({
      query: "task",
      tags: ["running"],
      namespace: "tasks/",
      entry_type: "state",
      limit: 10,
    });

    for (const result of results) {
      if (!result.key || result.key !== "status") continue;

      const entry = await munin.read(result.namespace, "status");
      if (!entry) continue;

      // Use updated_at (when tags changed to "running") not submitted_at
      const claimedAt = new Date(entry.updated_at).getTime();
      const timeoutStr = entry.content.match(
        /\*\*Timeout:\*\*\s*(\d+)/i
      )?.[1];
      const timeoutMs = timeoutStr
        ? parseInt(timeoutStr)
        : config.defaultTimeoutMs;
      const elapsed = Date.now() - claimedAt;

      if (elapsed > timeoutMs * 2) {
        console.log(
          `Recovering stale task ${result.namespace} (running for ${Math.round(elapsed / 1000)}s, timeout: ${Math.round(timeoutMs / 1000)}s)`
        );
        const runtimeTag = entry.tags.find((t) => t.startsWith("runtime:"));
        await munin.write(
          result.namespace,
          "status",
          entry.content,
          ["failed", ...(runtimeTag ? [runtimeTag] : [])],
          entry.updated_at
        );
        await munin.write(
          result.namespace,
          "result",
          `## Result\n\n- **Exit code:** -1\n- **Error:** Recovered after dispatcher restart (task exceeded ${Math.round(timeoutMs / 1000)}s timeout)\n`
        );
        await munin.log(
          result.namespace,
          `Task recovered as failed after dispatcher restart (elapsed: ${Math.round(elapsed / 1000)}s)`
        );
      }
    }
  } catch (err) {
    console.error("Failed to recover stale tasks:", err);
  }
}

// --- Heartbeat ---

async function emitHeartbeat(queueDepth: number): Promise<void> {
  try {
    await munin.write("tasks/_heartbeat", "status", JSON.stringify({
      polled_at: new Date().toISOString(),
      queue_depth: queueDepth,
      current_task: currentTask,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
    }), ["heartbeat"]);
  } catch (err) {
    console.error("Heartbeat write failed:", err);
  }
}

// --- Poll loop ---

async function pollOnce(): Promise<{ hadTask: boolean; queueDepth: number }> {
  const { results, total } = await munin.query({
    query: "task",
    tags: ["pending"],
    namespace: "tasks/",
    entry_type: "state",
    limit: 1,
  });

  // Find the first result that has key "status"
  const taskResult = results.find((r) => r.key === "status");
  if (!taskResult) return { hadTask: false, queueDepth: 0 };

  const taskNs = taskResult.namespace;
  const queueDepth = total;
  const entry = await munin.read(taskNs, "status");
  if (!entry) return { hadTask: false, queueDepth };

  // Verify it's still pending (another dispatcher might have claimed it)
  if (!entry.tags.includes("pending")) {
    console.log(`Task ${taskNs} no longer pending, skipping`);
    return { hadTask: false, queueDepth };
  }

  const task = parseTask(entry.content);
  if (!task) {
    console.error(`Failed to parse task ${taskNs}, marking as failed`);
    const runtimeTag = entry.tags.find((t) => t.startsWith("runtime:"));
    await munin.write(
      taskNs,
      "status",
      entry.content,
      ["failed", ...(runtimeTag ? [runtimeTag] : [])],
      entry.updated_at
    );
    await munin.write(
      taskNs,
      "result",
      "## Result\n\n- **Exit code:** -1\n- **Error:** Failed to parse task (missing prompt or runtime)\n"
    );
    return { hadTask: true, queueDepth };
  }

  console.log(
    `Claiming task ${taskNs} (runtime: ${task.runtime}, timeout: ${task.timeoutMs}ms)`
  );

  // Claim the task with compare-and-swap
  const runtimeTag = `runtime:${task.runtime}`;
  try {
    await munin.write(
      taskNs,
      "status",
      entry.content,
      ["running", runtimeTag],
      entry.updated_at
    );
  } catch (err) {
    console.log(`Failed to claim ${taskNs} (concurrent claim?):`, err);
    return { hadTask: false, queueDepth };
  }

  currentTask = taskNs;
  const startedAt = new Date().toISOString();
  const taskId = extractTaskId(taskNs);
  console.log(`Executing task ${taskNs}...`);

  await munin.log(
    taskNs,
    `Task started by Hugin (runtime: ${task.runtime}, timeout: ${task.timeoutMs}ms)`
  );

  const startMs = Date.now();
  const result = await spawnRuntime(task, { taskNs, muninClient: munin });
  const durationMs = Date.now() - startMs;
  const completedAt = new Date().toISOString();
  const isTimeout = result.exitCode === "TIMEOUT";
  const ok = result.exitCode === 0;

  console.log(
    `Task ${taskNs} ${ok ? "completed" : isTimeout ? "timed out" : "failed"} (exit: ${result.exitCode}, duration: ${Math.round(durationMs / 1000)}s)`
  );

  // Write result (for timeout, partial result was already written — overwrite with final)
  await munin.write(
    taskNs,
    "result",
    [
      isTimeout ? "## Result (task timed out)\n" : "## Result\n",
      `- **Exit code:** ${result.exitCode}`,
      `- **Started at:** ${startedAt}`,
      `- **Completed at:** ${completedAt}`,
      `- **Duration:** ${Math.round(durationMs / 1000)}s`,
      `- **Log file:** ~/.hugin/logs/${taskId}.log`,
      "",
      "### Output",
      "```",
      result.output || "(no output)",
      "```",
    ].join("\n")
  );

  // Update status tags
  await munin.write(taskNs, "status", entry.content, [
    ok ? "completed" : "failed",
    runtimeTag,
  ]);

  await munin.log(
    taskNs,
    `Task ${ok ? "completed" : isTimeout ? "timed out" : "failed"} in ${Math.round(durationMs / 1000)}s (exit ${result.exitCode})`
  );

  // Fire-and-forget email notification
  sendTaskNotification(
    taskId,
    ok ? "completed" : isTimeout ? "timed out" : "failed",
    Math.round(durationMs / 1000),
    result.output || "(no output)",
  ).catch(() => {}); // swallow — must never block task lifecycle

  currentTask = null;
  return { hadTask: true, queueDepth };
}

async function pollLoop(): Promise<void> {
  console.log(
    `Hugin dispatcher started (poll interval: ${config.pollIntervalMs}ms)`
  );

  // Recover any tasks left running from a previous crash
  await recoverStaleTasks();

  // Clean up old log files
  await rotateOldLogs();

  while (!shuttingDown) {
    let queueDepth = 0;
    try {
      const poll = await pollOnce();
      queueDepth = poll.queueDepth;
      // Fire-and-forget heartbeat
      emitHeartbeat(queueDepth);
      if (poll.hadTask && !shuttingDown) continue; // Check for more immediately
    } catch (err) {
      console.error("Poll error:", err);
      // Still emit heartbeat on error
      emitHeartbeat(queueDepth);
    }

    // Wait for next poll
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.pollIntervalMs);
      // Allow early wakeup on shutdown
      if (shuttingDown) {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  console.log("Poll loop exited");
}

// --- Health endpoint ---

const app = express();

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "hugin",
    current_task: currentTask,
    polling: !shuttingDown,
  });
});

// --- Graceful shutdown ---

function shutdown(signal: string): void {
  if (shuttingDown) return;
  console.log(`Received ${signal}, shutting down...`);
  shuttingDown = true;

  if (currentChild) {
    console.log("Forwarding signal to running task...");
    currentChild.kill("SIGTERM");
    // Give the child 30s to finish
    setTimeout(() => {
      if (currentChild && !currentChild.killed) {
        console.log("Force killing child process");
        currentChild.kill("SIGKILL");
      }
    }, 30000);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// --- Start ---

// Ensure log directory exists
ensureLogDir();
console.log(`Log directory: ${LOG_DIR}`);

const server = app.listen(config.port, config.host, () => {
  console.log(`Hugin health endpoint: http://${config.host}:${config.port}/health`);
  console.log(`Munin: ${config.muninUrl}`);
  console.log(`Workspace: ${config.workspace}`);
});

// Check Munin is reachable before starting poll loop
munin.health().then((ok) => {
  if (!ok) {
    console.warn("WARNING: Munin health check failed — will retry on first poll");
  } else {
    console.log("Munin health check: ok");
  }
  pollLoop().then(() => {
    server.close();
    process.exit(0);
  });
});
