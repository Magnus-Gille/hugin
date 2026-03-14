import { spawn, type ChildProcess } from "node:child_process";
import express from "express";
import { MuninClient } from "./munin-client.js";

// --- Configuration ---

const config = {
  port: parseInt(process.env.HUGIN_PORT || "3032"),
  host: process.env.HUGIN_HOST || "127.0.0.1",
  muninUrl: process.env.MUNIN_URL || "http://localhost:3030",
  muninApiKey: process.env.MUNIN_API_KEY || "",
  pollIntervalMs: parseInt(process.env.HUGIN_POLL_INTERVAL_MS || "30000"),
  defaultTimeoutMs: parseInt(process.env.HUGIN_DEFAULT_TIMEOUT_MS || "300000"),
  workspace: process.env.HUGIN_WORKSPACE || "/home/magnus/workspace",
  maxOutputChars: parseInt(process.env.HUGIN_MAX_OUTPUT_CHARS || "4000"),
};

if (!config.muninApiKey) {
  console.error("MUNIN_API_KEY is required");
  process.exit(1);
}

// --- State ---

let shuttingDown = false;
let currentTask: string | null = null;
let currentChild: ChildProcess | null = null;

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

// --- Task execution ---

function spawnRuntime(
  task: TaskConfig
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
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

    // Ring buffer for output capture
    let output = "";
    const appendOutput = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > config.maxOutputChars * 2) {
        output = output.slice(-config.maxOutputChars);
      }
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    const timer = setTimeout(() => {
      console.log(
        `Task timeout (${task.timeoutMs}ms), sending SIGTERM to child`
      );
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 10000);
    }, task.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      currentChild = null;
      resolve({
        exitCode: code ?? 1,
        output: output.slice(-config.maxOutputChars),
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      currentChild = null;
      resolve({
        exitCode: 1,
        output: `Spawn error: ${err.message}\n${output.slice(-config.maxOutputChars)}`,
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

      const submittedAt = entry.content.match(
        /\*\*Submitted at:\*\*\s*(.+)/i
      )?.[1]?.trim();
      if (!submittedAt) continue;

      const timeoutStr = entry.content.match(
        /\*\*Timeout:\*\*\s*(\d+)/i
      )?.[1];
      const timeoutMs = timeoutStr
        ? parseInt(timeoutStr)
        : config.defaultTimeoutMs;
      const elapsed = Date.now() - new Date(submittedAt).getTime();

      if (elapsed > timeoutMs * 2) {
        console.log(
          `Recovering stale task ${result.namespace} (elapsed: ${Math.round(elapsed / 1000)}s)`
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

// --- Poll loop ---

async function pollOnce(): Promise<boolean> {
  const { results } = await munin.query({
    query: "task",
    tags: ["pending"],
    namespace: "tasks/",
    entry_type: "state",
    limit: 1,
  });

  // Find the first result that has key "status"
  const taskResult = results.find((r) => r.key === "status");
  if (!taskResult) return false;

  const taskNs = taskResult.namespace;
  const entry = await munin.read(taskNs, "status");
  if (!entry) return false;

  // Verify it's still pending (another dispatcher might have claimed it)
  if (!entry.tags.includes("pending")) {
    console.log(`Task ${taskNs} no longer pending, skipping`);
    return false;
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
    return true;
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
    return false;
  }

  currentTask = taskNs;
  const startedAt = new Date().toISOString();
  console.log(`Executing task ${taskNs}...`);

  await munin.log(
    taskNs,
    `Task started by Hugin (runtime: ${task.runtime}, timeout: ${task.timeoutMs}ms)`
  );

  const startMs = Date.now();
  const result = await spawnRuntime(task);
  const durationMs = Date.now() - startMs;
  const completedAt = new Date().toISOString();
  const ok = result.exitCode === 0;

  console.log(
    `Task ${taskNs} ${ok ? "completed" : "failed"} (exit: ${result.exitCode}, duration: ${Math.round(durationMs / 1000)}s)`
  );

  // Write result
  await munin.write(
    taskNs,
    "result",
    [
      "## Result\n",
      `- **Exit code:** ${result.exitCode}`,
      `- **Started at:** ${startedAt}`,
      `- **Completed at:** ${completedAt}`,
      `- **Duration:** ${Math.round(durationMs / 1000)}s`,
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
    `Task ${ok ? "completed" : "failed"} in ${Math.round(durationMs / 1000)}s (exit ${result.exitCode})`
  );

  currentTask = null;
  return true;
}

async function pollLoop(): Promise<void> {
  console.log(
    `Hugin dispatcher started (poll interval: ${config.pollIntervalMs}ms)`
  );

  // Recover any tasks left running from a previous crash
  await recoverStaleTasks();

  while (!shuttingDown) {
    try {
      const hadTask = await pollOnce();
      if (hadTask && !shuttingDown) continue; // Check for more immediately
    } catch (err) {
      console.error("Poll error:", err);
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
