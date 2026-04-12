import { spawn } from "node:child_process";
import type { MuninEntry, MuninQueryResult, MuninReadResult } from "./munin-client.js";

export function getFoundBatchEntry(
  entry: MuninReadResult | undefined
): (MuninEntry & { found: true }) | null {
  return entry && entry.found ? entry : null;
}

export function extractTaskId(namespace: string): string {
  return namespace.replace(/^tasks\//, "");
}

/**
 * Select the oldest pending task from a batch of query results (FIFO ordering).
 * Filters to key === "status" entries and sorts by created_at ascending.
 */
export function pickEarliestTask(
  results: MuninQueryResult[],
): MuninQueryResult | undefined {
  const statusEntries = results.filter((r) => r.key === "status");
  if (statusEntries.length === 0) return undefined;
  return statusEntries.reduce((earliest, r) =>
    r.created_at < earliest.created_at ? r : earliest,
  );
}

/**
 * Parse the **Group:** field from task content (or content_preview).
 * Returns the group name string, or undefined if not present.
 */
export function parseGroupField(content: string): string | undefined {
  return content.match(/\*\*Group:\*\*\s*(.+)/i)?.[1]?.trim() || undefined;
}

/**
 * Parse the **Sequence:** field from task content (or content_preview).
 * Returns the sequence number, or undefined if not present.
 */
export function parseSequenceField(content: string): number | undefined {
  const raw = content.match(/\*\*Sequence:\*\*\s*(\d+)/i)?.[1];
  return raw !== undefined ? parseInt(raw, 10) : undefined;
}

/**
 * Select the next eligible task to dispatch, respecting Group/Sequence ordering.
 *
 * For each candidate task (in FIFO order by created_at):
 * - If no Group field → eligible immediately
 * - If has Group field → check if any lower-sequence task in the same group
 *   is still pending (in pendingTasks) or running (in runningTasks).
 *   If a lower-sequence sibling exists → skip this candidate.
 *
 * Both pendingTasks and runningTasks are arrays of MuninQueryResult; Group and
 * Sequence are parsed from content_preview which contains the task metadata.
 */
export function selectNextTask(
  pendingTasks: MuninQueryResult[],
  runningTasks: MuninQueryResult[],
): MuninQueryResult | undefined {
  // Work in FIFO order (earliest first)
  const statusEntries = pendingTasks.filter((r) => r.key === "status");
  if (statusEntries.length === 0) return undefined;

  const sorted = [...statusEntries].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  );

  for (const candidate of sorted) {
    const group = parseGroupField(candidate.content_preview);
    if (!group) {
      // No group field — always eligible
      return candidate;
    }

    const sequence = parseSequenceField(candidate.content_preview);
    if (sequence === undefined) {
      // Has group but no sequence — treat as eligible (no ordering constraint)
      return candidate;
    }

    // Check if any lower-sequence sibling exists in pending tasks
    const blockedByPending = statusEntries.some((other) => {
      if (other === candidate) return false;
      const otherGroup = parseGroupField(other.content_preview);
      if (otherGroup !== group) return false;
      const otherSeq = parseSequenceField(other.content_preview);
      return otherSeq !== undefined && otherSeq < sequence;
    });

    if (blockedByPending) continue;

    // Check if any lower-sequence sibling is currently running
    const blockedByRunning = runningTasks.some((r) => {
      const otherGroup = parseGroupField(r.content_preview);
      if (otherGroup !== group) return false;
      const otherSeq = parseSequenceField(r.content_preview);
      return otherSeq !== undefined && otherSeq < sequence;
    });

    if (blockedByRunning) continue;

    return candidate;
  }

  return undefined;
}

// --- Pre-task repo sync (#21) ---

export interface RepoSyncResult {
  action: "skipped" | "up-to-date" | "synced" | "fetch-failed" | "failed";
  commitsBehind?: number;
  error?: string;
  /** Set when dirty worktree state was auto-stashed to unblock the pull (#45). */
  autoStashed?: boolean;
  /** Label of the auto-stash entry, when one was created. Surfaced so operators can recover. */
  stashLabel?: string;
}

export interface SyncRepoOptions {
  /** Backoff in ms before each retry attempt after the first. Defaults to [500, 2000]. */
  fetchRetryDelaysMs?: number[];
  /** Task ID included in the auto-stash label for forensics. */
  taskId?: string;
  /** Clock override for deterministic stash labels in tests. */
  now?: () => Date;
}

const DEFAULT_FETCH_RETRY_DELAYS_MS = [500, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runGitFetch(
  workingDir: string,
  bypassSystemSshConfig: boolean,
): Promise<{ ok: boolean; exitCode: number | null; output: string }> {
  const home = "/home/magnus";
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: home };
  if (bypassSystemSshConfig) {
    env.GIT_SSH_COMMAND = `ssh -F ${home}/.ssh/config`;
  }
  return new Promise((resolve) => {
    const child = spawn("git", ["fetch", "origin"], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => resolve({ ok: code === 0, exitCode: code, output }));
    child.on("error", () => resolve({ ok: false, exitCode: null, output }));
  });
}

export async function syncRepoBeforeTask(
  workingDir: string,
  options: SyncRepoOptions = {},
): Promise<RepoSyncResult> {
  // Only sync repos under /home/magnus/repos/
  if (!workingDir.startsWith("/home/magnus/repos/")) {
    return { action: "skipped" };
  }

  // Check if the directory is a git repo
  const isGit = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["rev-parse", "--git-dir"], {
      cwd: workingDir,
      stdio: "ignore",
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });

  if (!isGit) {
    return { action: "skipped" };
  }

  // Check if remote exists
  const hasRemote = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["remote", "get-url", "origin"], {
      cwd: workingDir,
      stdio: "ignore",
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });

  if (!hasRemote) {
    return { action: "skipped" };
  }

  // Fetch from origin, with retries.
  // Attempt 1 uses normal environment; retries bypass the system SSH config
  // (`ssh -F ~/.ssh/config`) to sidestep strict-modes errors on
  // /etc/ssh/ssh_config.d/* in the systemd-user service context (see issue #42).
  const retryDelaysMs = options.fetchRetryDelaysMs ?? DEFAULT_FETCH_RETRY_DELAYS_MS;
  const totalAttempts = 1 + retryDelaysMs.length;
  let fetchOk = false;
  let lastOutput = "";
  let lastExit: number | null = null;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(retryDelaysMs[attempt - 1]);
    }
    const bypass = attempt > 0;
    const result = await runGitFetch(workingDir, bypass);
    if (result.ok) {
      fetchOk = true;
      if (attempt > 0) {
        console.log(`Pre-task git fetch succeeded on attempt ${attempt + 1} (bypass=${bypass}) in ${workingDir}`);
      }
      break;
    }
    lastOutput = result.output;
    lastExit = result.exitCode;
    console.warn(
      `Pre-task git fetch failed (attempt ${attempt + 1}/${totalAttempts}, exit ${lastExit}, bypass=${bypass}) in ${workingDir}: ${lastOutput.trim()}`,
    );
  }

  if (!fetchOk) {
    return {
      action: "fetch-failed",
      error: `git fetch origin failed in ${workingDir} after ${totalAttempts} attempts — proceeding with local state`,
    };
  }

  // Check how many commits behind
  const commitsBehind = await new Promise<number>((resolve) => {
    const child = spawn("git", ["rev-list", "--count", "HEAD..origin/main"], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => resolve(code === 0 ? parseInt(out.trim(), 10) || 0 : 0));
    child.on("error", () => resolve(0));
  });

  if (commitsBehind === 0) {
    console.log(`Pre-task repo sync: ${workingDir} is already up to date`);
    return { action: "up-to-date", commitsBehind: 0 };
  }

  // Attempt fast-forward against the already-fetched ref. We use `git merge
  // --ff-only origin/main` rather than `git pull` so we don't accidentally
  // trigger another network fetch — that would make the failure signal
  // ambiguous (network/SSH blip vs. real ff conflict) and could route a
  // perfectly-clean repo through the auto-stash path unnecessarily.
  const firstMerge = await runGitMergeFfOnly(workingDir);
  if (firstMerge.ok) {
    console.log(`Pre-task repo sync: ${workingDir} synced ${commitsBehind} commits from origin`);
    return { action: "synced", commitsBehind };
  }

  // Merge failed. Most common cause on the task dispatcher is a dirty worktree
  // left by a prior task (crash, timeout, un-committed tool edits, tool
  // artifacts like .claude/ or .playwright-mcp/). Auto-stash and retry (#45).
  // Actual divergence — local commits on main not in origin — still falls
  // through to manual intervention.
  const dirty = await isWorktreeDirty(workingDir);
  if (!dirty) {
    return {
      action: "failed",
      commitsBehind,
      error: `Working directory ${workingDir} is ${commitsBehind} commits behind origin/main and cannot fast-forward (worktree clean — likely local commits on main). Manual intervention required.`,
    };
  }

  const now = options.now ?? (() => new Date());
  const label = buildAutoStashLabel(now(), options.taskId);
  const stashOk = await runGitStashPush(workingDir, label);
  if (!stashOk) {
    return {
      action: "failed",
      commitsBehind,
      error: `Working directory ${workingDir} is ${commitsBehind} commits behind origin/main; dirty worktree detected but auto-stash failed. Manual intervention required.`,
    };
  }
  console.warn(
    `Pre-task repo sync: auto-stashed dirty state in ${workingDir} (${label}) to unblock fast-forward`,
  );

  const secondMerge = await runGitMergeFfOnly(workingDir);
  if (!secondMerge.ok) {
    return {
      action: "failed",
      commitsBehind,
      autoStashed: true,
      stashLabel: label,
      error: `Working directory ${workingDir} is ${commitsBehind} commits behind origin/main and cannot fast-forward even after auto-stashing dirty state (stash: ${label}). Manual intervention required.`,
    };
  }

  console.log(
    `Pre-task repo sync: ${workingDir} synced ${commitsBehind} commits from origin (auto-stashed prior dirty state as ${label})`,
  );
  return { action: "synced", commitsBehind, autoStashed: true, stashLabel: label };
}

function runGitMergeFfOnly(workingDir: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["merge", "--ff-only", "origin/main"], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(`Pre-task git merge --ff-only failed (exit ${code}) in ${workingDir}: ${output.trim()}`);
      }
      resolve({ ok: code === 0, output });
    });
    child.on("error", () => resolve({ ok: false, output }));
  });
}

function isWorktreeDirty(workingDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("git", ["status", "--porcelain"], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => resolve(code === 0 && out.trim().length > 0));
    child.on("error", () => resolve(false));
  });
}

function runGitStashPush(workingDir: string, label: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("git", ["stash", "push", "-u", "-m", label], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(`Auto-stash failed (exit ${code}) in ${workingDir}: ${output.trim()}`);
      }
      resolve(code === 0);
    });
    child.on("error", () => resolve(false));
  });
}

function buildAutoStashLabel(now: Date, taskId: string | undefined): string {
  const ts = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const taskPart = taskId ? ` task=${taskId}` : "";
  return `hugin-autosave ${ts}${taskPart}`;
}
