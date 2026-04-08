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
  action: "skipped" | "up-to-date" | "synced" | "failed";
  commitsBehind?: number;
  error?: string;
}

export async function syncRepoBeforeTask(workingDir: string): Promise<RepoSyncResult> {
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

  // Fetch from origin
  const fetchOk = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["fetch", "origin"], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(`Pre-task git fetch failed (exit ${code}) in ${workingDir}: ${output.trim()}`);
      }
      resolve(code === 0);
    });
    child.on("error", () => resolve(false));
  });

  if (!fetchOk) {
    return { action: "failed", error: `git fetch origin failed in ${workingDir}` };
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

  // Attempt fast-forward pull
  const pullOk = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["pull", "--ff-only"], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(`Pre-task git pull --ff-only failed (exit ${code}) in ${workingDir}: ${output.trim()}`);
      }
      resolve(code === 0);
    });
    child.on("error", () => resolve(false));
  });

  if (!pullOk) {
    return {
      action: "failed",
      commitsBehind,
      error: `Working directory ${workingDir} is ${commitsBehind} commits behind origin/main and cannot fast-forward. Manual intervention required.`,
    };
  }

  console.log(`Pre-task repo sync: ${workingDir} synced ${commitsBehind} commits from origin`);
  return { action: "synced", commitsBehind };
}
