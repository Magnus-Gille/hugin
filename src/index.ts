import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import express from "express";
import { MuninClient } from "./munin-client.js";
import { executeSdkTask } from "./sdk-executor.js";

const HUGIN_HOME = path.join(process.env.HOME || "/home/magnus", ".hugin");
const LOG_DIR = path.join(HUGIN_HOME, "logs");
const HOOK_RESULT_DIR = path.join(HUGIN_HOME, "hook-results");

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
  claudeExecutor: (process.env.HUGIN_CLAUDE_EXECUTOR || "sdk") as "sdk" | "spawn",
};

if (!config.muninApiKey) {
  console.error("MUNIN_API_KEY is required");
  process.exit(1);
}

// --- State ---

let shuttingDown = false;
let currentTask: string | null = null;
let currentTaskConfig: TaskConfig | null = null;
let currentChild: ChildProcess | null = null;
let currentSdkAbort: AbortController | null = null;
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
  context?: string;
  timeoutMs: number;
  submittedBy: string;
  submittedAt: string;
  replyTo?: string;
  replyFormat?: string;
  group?: string;
  sequence?: number;
  model?: string;
}

function resolveContext(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("repo:")) {
    const name = trimmed.slice(5);
    const resolved = path.resolve(`/home/magnus/repos/${name}`);
    // Guard against traversal (e.g. repo:../../tmp)
    if (!resolved.startsWith("/home/magnus/repos/")) {
      return "/home/magnus/workspace";
    }
    return resolved;
  }
  switch (trimmed) {
    case "scratch": return "/home/magnus/scratch";
    case "files": return "/home/magnus/mimir";
    default: {
      // Only allow absolute paths; reject relative paths
      if (trimmed.startsWith("/")) return trimmed;
      return "/home/magnus/workspace";
    }
  }
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
  const contextRaw = content.match(
    /\*\*Context:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const timeoutStr = content.match(/\*\*Timeout:\*\*\s*(\d+)/i)?.[1];
  const submittedBy = content.match(
    /\*\*Submitted by:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const submittedAt = content.match(
    /\*\*Submitted at:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const replyTo = content.match(
    /\*\*Reply-to:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const replyFormat = content.match(
    /\*\*Reply-format:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const group = content.match(
    /\*\*Group:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const sequenceStr = content.match(
    /\*\*Sequence:\*\*\s*(\d+)/i
  )?.[1];
  const modelRaw = content.match(
    /\*\*Model:\*\*\s*(.+)/i
  )?.[1]?.trim();

  // Extract prompt from ### Prompt section
  const promptMatch = content.match(/###\s*Prompt\s*\n([\s\S]+)$/i);
  const prompt = promptMatch?.[1]?.trim();

  if (!prompt || !runtime) return null;

  // Resolution priority: Context > Working dir > config.workspace
  const resolvedDir = contextRaw
    ? resolveContext(contextRaw)
    : workingDir || config.workspace;

  return {
    prompt,
    runtime: runtime || "claude",
    workingDir: resolvedDir,
    context: contextRaw || undefined,
    timeoutMs: timeoutStr ? parseInt(timeoutStr) : config.defaultTimeoutMs,
    submittedBy: submittedBy || "unknown",
    submittedAt: submittedAt || new Date().toISOString(),
    replyTo: replyTo || undefined,
    replyFormat: replyFormat || undefined,
    group: group || undefined,
    sequence: sequenceStr ? parseInt(sequenceStr) : undefined,
    model: modelRaw || undefined,
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

// --- Quota snapshot ---

interface QuotaSnapshot {
  q5: number | null;
  q7: number | null;
}

async function fetchQuota(): Promise<QuotaSnapshot> {
  try {
    const credPath = path.join(process.env.HOME || "/home/magnus", ".claude", ".credentials.json");
    const creds = JSON.parse(fs.readFileSync(credPath, "utf-8"));
    const token = creds?.claudeAiOauth?.accessToken;
    if (!token) return { q5: null, q7: null };

    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        "anthropic-beta": "oauth-2025-04-20",
        "Authorization": `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { q5: null, q7: null };
    const data = await res.json() as Record<string, Record<string, number>>;
    return {
      q5: data?.five_hour?.utilization ?? null,
      q7: data?.seven_day?.utilization ?? null,
    };
  } catch {
    return { q5: null, q7: null };
  }
}

// --- Invocation journal ---

const JOURNAL_FILE = path.join(HUGIN_HOME, "invocation-journal.jsonl");

function appendJournal(entry: Record<string, unknown>): void {
  try {
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(JOURNAL_FILE, line, { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    console.error("Journal write failed:", err);
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

// --- Hook result reader ---

interface HookResult {
  task_id: string;
  task_namespace: string;
  session_id: string | null;
  last_assistant_message: string;
  completed_at: string;
}

function readHookResult(taskId: string): HookResult | null {
  const filePath = path.join(HOOK_RESULT_DIR, `${taskId}.json`);
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    fs.unlinkSync(filePath); // Clean up after reading
    return JSON.parse(data) as HookResult;
  } catch {
    return null;
  }
}

// --- Post-task git push ---

async function postTaskGitPush(workingDir: string): Promise<void> {
  // Check if the working directory is a git repo
  const isGit = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["rev-parse", "--git-dir"], {
      cwd: workingDir,
      stdio: "ignore",
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });

  if (!isGit) return;

  // Check if there are commits ahead of remote
  const isAhead = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["status", "--porcelain=v2", "--branch"], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", () => resolve(out.includes("branch.ab +") && !out.includes("branch.ab +0")));
    child.on("error", () => resolve(false));
  });

  if (!isAhead) return;

  console.log(`Post-task: unpushed commits detected in ${workingDir}, running git push`);
  await new Promise<void>((resolve) => {
    const child = spawn("git", ["push"], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => {
      if (code === 0) {
        console.log(`Post-task git push: ok (${workingDir})`);
      } else {
        console.warn(`Post-task git push failed (exit ${code}) in ${workingDir}: ${output.trim()}`);
      }
      resolve();
    });
    child.on("error", (err) => {
      console.warn(`Post-task git push error in ${workingDir}: ${(err as Error).message}`);
      resolve();
    });
  });
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
      env: {
        ...process.env,
        HOME: "/home/magnus",
        HUGIN_TASK_ID: taskId,
        HUGIN_TASK_NAMESPACE: ctx.taskNs,
      },
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
        const recoverTypeTags = entry.tags.filter((t) => t.startsWith("type:"));
        await munin.write(
          result.namespace,
          "status",
          entry.content,
          ["failed", ...(runtimeTag ? [runtimeTag] : []), ...recoverTypeTags],
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
    const heartbeat: Record<string, unknown> = {
      polled_at: new Date().toISOString(),
      queue_depth: queueDepth,
      current_task: currentTask,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
    };
    if (currentTaskConfig?.group) heartbeat.group = currentTaskConfig.group;
    if (currentTaskConfig?.sequence !== undefined) heartbeat.sequence = currentTaskConfig.sequence;
    await munin.write("tasks/_heartbeat", "status", JSON.stringify(heartbeat), ["heartbeat"]);
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
    const parseTypeTags = entry.tags.filter((t) => t.startsWith("type:"));
    await munin.write(
      taskNs,
      "status",
      entry.content,
      ["failed", ...(runtimeTag ? [runtimeTag] : []), ...parseTypeTags],
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
  const typeTags = entry.tags.filter((t) => t.startsWith("type:"));
  try {
    await munin.write(
      taskNs,
      "status",
      entry.content,
      ["running", runtimeTag, ...typeTags],
      entry.updated_at
    );
  } catch (err) {
    console.log(`Failed to claim ${taskNs} (concurrent claim?):`, err);
    return { hadTask: false, queueDepth };
  }

  currentTask = taskNs;
  currentTaskConfig = task;
  const startedAt = new Date().toISOString();
  const taskId = extractTaskId(taskNs);
  console.log(`Executing task ${taskNs}...`);

  const useSdk = task.runtime === "claude" && config.claudeExecutor === "sdk";
  const executorLabel = useSdk ? "agent-sdk" : "spawn";

  // Capture quota before task execution (for pilot experiment)
  const quotaBefore = await fetchQuota();

  await munin.log(
    taskNs,
    `Task started by Hugin (runtime: ${task.runtime}, executor: ${executorLabel}, model: ${task.model || "default"}, timeout: ${task.timeoutMs}ms)`
  );

  const startMs = Date.now();

  // --- Execute via SDK or spawn ---
  let exitCode: number | "TIMEOUT";
  let output: string;
  let logFile: string;
  let resultText: string | null = null;
  let costUsd: number | null = null;

  if (useSdk) {
    console.log(`Using Agent SDK executor for task ${taskNs}`);
    const sdkAbort = new AbortController();
    currentSdkAbort = sdkAbort;
    const sdkResult = await executeSdkTask(
      {
        prompt: task.prompt,
        workingDir: task.workingDir,
        timeoutMs: task.timeoutMs,
        muninUrl: config.muninUrl,
        muninApiKey: config.muninApiKey,
        maxOutputChars: config.maxOutputChars,
        model: task.model,
      },
      taskId,
      LOG_DIR,
      {
        abortController: sdkAbort,
        onTimeout: async (partialOutput) => {
          // Write partial result on timeout
          try {
            await munin.write(taskNs, "result", [
              "## Result (PARTIAL — task timed out)\n",
              `- **Exit code:** TIMEOUT`,
              `- **Started at:** ${startedAt}`,
              `- **Timed out at:** ${new Date().toISOString()}`,
              `- **Duration:** ${Math.round((Date.now() - startMs) / 1000)}s`,
              `- **Executor:** agent-sdk`,
              `- **Log file:** ~/.hugin/logs/${taskId}.log`,
              "",
              "### Last Output",
              "```",
              partialOutput || "(no output captured)",
              "```",
            ].join("\n"));
          } catch (err) {
            console.error("Failed to write partial result on timeout:", err);
          }
        },
      },
    );
    currentSdkAbort = null;
    exitCode = sdkResult.exitCode;
    output = sdkResult.output;
    logFile = sdkResult.logFile;
    resultText = sdkResult.resultText;
    costUsd = sdkResult.costUsd;
  } else {
    const spawnResult = await spawnRuntime(task, { taskNs, muninClient: munin });
    exitCode = spawnResult.exitCode;
    output = spawnResult.output;
    logFile = spawnResult.logFile;
  }

  const durationMs = Date.now() - startMs;
  const completedAt = new Date().toISOString();
  const isTimeout = exitCode === "TIMEOUT";
  const ok = exitCode === 0;

  // Safety net: push any commits the task left unpushed
  if (ok) {
    await postTaskGitPush(task.workingDir);
  }

  console.log(
    `Task ${taskNs} ${ok ? "completed" : isTimeout ? "timed out" : "failed"} (exit: ${exitCode}, executor: ${executorLabel}, duration: ${Math.round(durationMs / 1000)}s)`
  );

  // For SDK executor, use resultText directly (structured result from query)
  // For spawn executor, check for hook result, then fall back to stdout
  let resultBody: string;
  let resultSource: string;

  if (useSdk && resultText) {
    resultSource = "agent-sdk";
    resultBody = `### Response\n\n${resultText}`;
  } else if (!useSdk) {
    const hookResult = readHookResult(taskId);
    if (hookResult) {
      resultSource = "hook";
      resultBody = `### Response\n\n${hookResult.last_assistant_message}`;
      console.log(`Using Stop hook result for task ${taskNs}`);
    } else {
      resultSource = "stdout";
      resultBody = `### Output\n\`\`\`\n${output || "(no output)"}\n\`\`\``;
    }
  } else {
    resultSource = useSdk ? "agent-sdk" : "stdout";
    resultBody = `### Output\n\`\`\`\n${output || "(no output)"}\n\`\`\``;
  }

  const costLine = costUsd !== null ? `\n- **Cost:** $${costUsd.toFixed(4)}` : "";
  const replyToLine = task.replyTo ? `\n- **Reply-to:** ${task.replyTo}` : "";
  const replyFormatLine = task.replyFormat ? `\n- **Reply-format:** ${task.replyFormat}` : "";
  const groupLine = task.group ? `\n- **Group:** ${task.group}` : "";
  const sequenceLine = task.sequence !== undefined ? `\n- **Sequence:** ${task.sequence}` : "";

  // Write result to Munin (skip if timeout already wrote partial result via SDK)
  if (!(isTimeout && useSdk)) {
    await munin.write(
      taskNs,
      "result",
      [
        isTimeout ? "## Result (task timed out)\n" : "## Result\n",
        `- **Exit code:** ${exitCode}`,
        `- **Started at:** ${startedAt}`,
        `- **Completed at:** ${completedAt}`,
        `- **Duration:** ${Math.round(durationMs / 1000)}s`,
        `- **Executor:** ${executorLabel}`,
        `- **Result source:** ${resultSource}`,
        `- **Log file:** ~/.hugin/logs/${taskId}.log`,
        costLine,
        replyToLine,
        replyFormatLine,
        groupLine,
        sequenceLine,
        "",
        resultBody,
      ].join("\n")
    );
  }

  // Update status tags
  await munin.write(taskNs, "status", entry.content, [
    ok ? "completed" : "failed",
    runtimeTag,
    ...typeTags,
  ]);

  await munin.log(
    taskNs,
    `Task ${ok ? "completed" : isTimeout ? "timed out" : "failed"} in ${Math.round(durationMs / 1000)}s (exit ${exitCode}, executor: ${executorLabel}${costUsd !== null ? `, cost: $${costUsd.toFixed(4)}` : ""})`
  );

  // Capture quota after task execution
  const quotaAfter = await fetchQuota();

  // Append to invocation journal for usage analysis
  appendJournal({
    ts: completedAt,
    task_id: taskId,
    repo: task.context || path.basename(task.workingDir),
    runtime: task.runtime,
    executor: executorLabel,
    model_requested: task.model || "default",
    exit_code: exitCode,
    duration_s: Math.round(durationMs / 1000),
    timeout_ms: task.timeoutMs,
    cost_usd: costUsd,
    group: task.group || null,
    quota_before: quotaBefore,
    quota_after: quotaAfter,
  });

  // Fire-and-forget email notification
  sendTaskNotification(
    taskId,
    ok ? "completed" : isTimeout ? "timed out" : "failed",
    Math.round(durationMs / 1000),
    resultText || output || "(no output)",
  ).catch(() => {}); // swallow — must never block task lifecycle

  currentTask = null;
  currentTaskConfig = null;
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

  if (currentSdkAbort) {
    console.log("Aborting running SDK task...");
    currentSdkAbort.abort();
  }

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
  console.log(`Claude executor: ${config.claudeExecutor} (set HUGIN_CLAUDE_EXECUTOR=spawn to use legacy)`);
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
