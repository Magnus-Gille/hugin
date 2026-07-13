import { spawn } from "node:child_process";
import * as path from "node:path";
import type { MuninEntry, MuninQueryResult, MuninReadResult } from "./munin-client.js";

/**
 * Task-workspace roots (issue #139).
 *
 * `reposRoot` is the directory under which `repo:<name>` aliases resolve and
 * which {@link checkoutTaskBranch} treats as "managed" (safe to branch). It is
 * configurable so a deployment can point task execution at an ISOLATED tree
 * (e.g. `/home/magnus/hugin-workspace`) that is disjoint from the production
 * deploy checkouts under `/home/magnus/repos` — a hugin task can then never
 * re-point a production checkout onto its task branch (grimnir#44 / grimnir#33).
 *
 * Defaults preserve the historical hardcoded behavior.
 */
export const DEFAULT_REPOS_ROOT = "/home/magnus/repos";
export const DEFAULT_WORKSPACE = "/home/magnus/workspace";

export interface WorkspaceRoots {
  /** Root for `repo:<name>` resolution. Defaults to {@link DEFAULT_REPOS_ROOT}. */
  reposRoot?: string;
  /** Fallback working dir for unresolvable contexts. Defaults to {@link DEFAULT_WORKSPACE}. */
  workspace?: string;
}

/** Hard dispatcher resource ceilings for ordinary (non-Broker) task fields. */
export const MAX_TASK_TIMEOUT_MS = 43_200_000; // 12h
export const MAX_TASK_OUTPUT_TOKENS = 32_768;

/** Strip any trailing slashes so `${root}/` composition is unambiguous. */
export function normalizeRoot(root: string): string {
  return root.replace(/\/+$/, "");
}

/**
 * Resolve a task `Context:` value to an absolute working directory.
 *
 * - `repo:<name>` → `<reposRoot>/<name>` (traversal outside `reposRoot` is
 *   rejected to the workspace fallback).
 * - `scratch` / `files` → fixed non-code locations.
 * - An absolute path under `/home/magnus/` passes through; anything else
 *   (relative paths, absolute paths elsewhere) falls back to `workspace`.
 *
 * `reposRoot`/`workspace` are configurable per #139; omitting them preserves
 * the original hardcoded `/home/magnus/repos` + `/home/magnus/workspace`.
 */
export function resolveContext(raw: string, roots: WorkspaceRoots = {}): string {
  const reposRoot = path.resolve(normalizeRoot(roots.reposRoot ?? DEFAULT_REPOS_ROOT));
  const workspace = path.resolve(roots.workspace ?? DEFAULT_WORKSPACE);
  const trimmed = raw.trim();
  if (trimmed.startsWith("repo:")) {
    const name = trimmed.slice(5);
    const resolved = path.resolve(reposRoot, name);
    // Guard against traversal (e.g. repo:../../tmp) escaping the repos root.
    if (!resolved.startsWith(`${reposRoot}${path.sep}`)) {
      return workspace;
    }
    return resolved;
  }
  switch (trimmed) {
    case "scratch": return "/home/magnus/scratch";
    case "files": return "/home/magnus/mimir";
    default: {
      // Normalize before checking the prefix. A lexical prefix check alone
      // accepts `/home/magnus/../../etc`, which later filesystem calls resolve
      // outside the intended workspace boundary.
      if (path.isAbsolute(trimmed)) {
        const resolved = path.resolve(trimmed);
        if (resolved.startsWith(`/home/magnus${path.sep}`)) return resolved;
        console.warn(`Context path outside /home/magnus/ rejected: ${trimmed}`);
        return workspace;
      }
      return workspace;
    }
  }
}

/** Apply the same path policy to both Context and the legacy Working dir field. */
export function resolveTaskWorkingDirectory(
  context: string | undefined,
  workingDir: string | undefined,
  roots: WorkspaceRoots = {},
): string {
  const fallback = path.resolve(roots.workspace ?? DEFAULT_WORKSPACE);
  if (context) return resolveContext(context, roots);
  if (workingDir) return resolveContext(workingDir, { ...roots, workspace: fallback });
  return fallback;
}

/** Parse a positive integer and clamp it to a caller-owned hard ceiling. */
export function parseBoundedPositiveInt(
  raw: string | number | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

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

// --- Lease reaping (#38) ---

export interface ReapDecisionInput {
  /** Tags on the running task entry. */
  tags: string[];
  /** Namespace of the task entry (e.g. "tasks/20260416-100000-a3f1"). */
  namespace: string;
  /** Namespace of the task this worker is currently executing, or null when idle. */
  currentTask: string | null;
  /** Epoch-millis "now" used to compare against the lease expiry. */
  now: number;
}

export interface ReapDecision {
  reap: boolean;
  /** Value of the `claimed_by:` tag, or null if absent. */
  claimedBy: string | null;
  /** Parsed `lease_expires:` timestamp, or null if the tag is missing/malformed. */
  leaseExpires: number | null;
  /** Milliseconds past expiry (0 when reap=false). */
  expiredByMs: number;
  /** Why we declined to reap; empty string when reap=true. */
  skipReason: "" | "currently-executing" | "lease-valid" | "no-lease-metadata";
}

function parseClaimedByTag(tags: string[]): string | null {
  const tag = tags.find((t) => t.startsWith("claimed_by:"));
  return tag ? tag.slice("claimed_by:".length) : null;
}

function parseLeaseExpiresTag(tags: string[]): number | null {
  const tag = tags.find((t) => t.startsWith("lease_expires:"));
  if (!tag) return null;
  const raw = tag.slice("lease_expires:".length);
  const ts = /^\d+$/.test(raw) ? Number(raw) : new Date(raw).getTime();
  return Number.isNaN(ts) ? null : ts;
}

/**
 * Decide whether a `running`-tagged task should be reaped because its lease
 * has actually expired. Conservative on purpose:
 *
 * - The currently-executing task on this worker is never reaped (its next
 *   lease renewal is about to land).
 * - Tasks missing lease metadata entirely are left alone; startup recovery
 *   (`recoverStaleTasks`) covers the legacy case, and the timer-driven reaper
 *   should only kill tasks we can prove are stuck.
 * - Tasks whose lease expiry is still in the future are left alone.
 */
export function shouldReapExpiredLease(input: ReapDecisionInput): ReapDecision {
  const claimedBy = parseClaimedByTag(input.tags);
  const leaseExpires = parseLeaseExpiresTag(input.tags);

  if (input.namespace === input.currentTask) {
    return {
      reap: false,
      claimedBy,
      leaseExpires,
      expiredByMs: 0,
      skipReason: "currently-executing",
    };
  }

  if (leaseExpires === null) {
    return {
      reap: false,
      claimedBy,
      leaseExpires,
      expiredByMs: 0,
      skipReason: "no-lease-metadata",
    };
  }

  if (input.now <= leaseExpires) {
    return {
      reap: false,
      claimedBy,
      leaseExpires,
      expiredByMs: 0,
      skipReason: "lease-valid",
    };
  }

  return {
    reap: true,
    claimedBy,
    leaseExpires,
    expiredByMs: input.now - leaseExpires,
    skipReason: "",
  };
}

export interface DeliveryRetryInput {
  /** How many delivery attempts have already completed (0 before the first). */
  attempts: number;
  /** Wall-clock ms of the FIRST delivery attempt (the deferral clock origin). */
  firstAttemptAtMs: number;
  /** Current wall-clock ms. */
  now: number;
  /** Max attempts before budget exhaustion (inclusive cap on attempts made). */
  maxAttempts: number;
  /** Max age in ms from the first attempt before budget exhaustion. */
  maxAgeMs: number;
}

export interface DeliveryRetryDecision {
  /** "retry" → attempt delivery again; "exhausted" → terminalize as failed. */
  action: "retry" | "exhausted";
  /** Human-readable reason (empty when action==="retry"). */
  reason: string;
}

/**
 * Decide whether a deferred (`HUGIN_DELIVERY_POLICY=defer`) delivery should be
 * retried again or has exhausted its retry budget (issue #72). Budget is the
 * conjunction of a max-attempts cap and a max-age cap — whichever trips first
 * terminalizes, so a permanently-unreachable NAS still reaches a terminal state.
 *
 * `attempts` is the number of attempts ALREADY made. The decision is whether to
 * make another one: exhausted once `attempts >= maxAttempts`, or once the elapsed
 * time since the first attempt exceeds `maxAgeMs`.
 */
export function decideDeliveryRetry(
  input: DeliveryRetryInput,
): DeliveryRetryDecision {
  // Fail SAFE (terminal), not unsafe (immortal): a non-finite / non-positive
  // budget — e.g. a malformed HUGIN_DELIVERY_RETRY_* env var that parsed to NaN
  // — must terminalize, never produce an endlessly-retried task (review MED).
  if (
    !Number.isFinite(input.maxAttempts) ||
    input.maxAttempts <= 0 ||
    !Number.isFinite(input.maxAgeMs) ||
    input.maxAgeMs < 0
  ) {
    return {
      action: "exhausted",
      reason: `delivery retry budget invalid (maxAttempts=${input.maxAttempts}, maxAgeMs=${input.maxAgeMs}) — terminalizing fail-safe`,
    };
  }
  if (input.attempts >= input.maxAttempts) {
    return {
      action: "exhausted",
      reason: `delivery retry budget exhausted after ${input.attempts} attempt(s) (max ${input.maxAttempts})`,
    };
  }
  const ageMs = input.now - input.firstAttemptAtMs;
  if (ageMs >= input.maxAgeMs) {
    return {
      action: "exhausted",
      reason: `delivery retry budget exhausted after ${Math.round(ageMs / 1000)}s (max age ${Math.round(input.maxAgeMs / 1000)}s)`,
    };
  }
  return { action: "retry", reason: "" };
}

export interface StartupRecoveryInput {
  /** Status-entry tags (carry `claimed_by:` / `lease_expires:` / `delivery:pending`). */
  tags: string[];
  /** This dispatcher's worker identity. HOST-stable since #77 (no PID). */
  workerId: string;
  /** Current wall-clock ms. */
  now: number;
}

export type StartupRecoveryAction =
  /** Owned by a still-live foreign worker — leave it alone. */
  | "skip"
  /** A `delivery:pending` checkpoint to re-deliver under CAS (#68). */
  | "reconcile-delivery"
  /** Generic stale/own task → terminalize as `failed`. */
  | "recover-failed";

export interface StartupRecoveryDecision {
  action: StartupRecoveryAction;
  isOurs: boolean;
  leaseExpired: boolean;
  claimedBy: string | null;
  leaseExpires: number | null;
}

/**
 * Decide what `recoverStaleTasks` should do with a `running` task seen at
 * startup. Pure mirror of the inline gate in `src/index.ts`.
 *
 * Issue #77: `workerId` is HOST-stable (not PID-derived). After a crash +
 * systemd restart, a `delivery:pending` checkpoint left by the dead incarnation
 * carries `claimed_by:hugin-<host>` — which now equals the restarted process's
 * `workerId` → `isOurs` is true → the gate falls through to "reconcile-delivery"
 * even though the dead worker's lease has not yet expired. With the old
 * PID-derived id `isOurs` was false and (lease still live) the task was
 * "skip"ped, stranding it non-terminal until a second post-expiry restart.
 *
 * Note: the original second guard `if (!isOurs && !leaseExpired && !legacyStale)
 * continue` was unreachable (the first `!isOurs && !leaseExpired` skip already
 * caught those cases), so `legacyStale` never influenced the action — it is
 * intentionally not modelled here.
 */
export function decideStartupRecovery(
  input: StartupRecoveryInput,
): StartupRecoveryDecision {
  const claimedBy = parseClaimedByTag(input.tags);
  const leaseExpires = parseLeaseExpiresTag(input.tags);
  const isOurs = claimedBy === input.workerId || claimedBy === null;
  const leaseExpired = leaseExpires !== null && input.now > leaseExpires;

  if (!isOurs && !leaseExpired) {
    return { action: "skip", isOurs, leaseExpired, claimedBy, leaseExpires };
  }
  if (input.tags.includes("delivery:pending")) {
    return {
      action: "reconcile-delivery",
      isOurs,
      leaseExpired,
      claimedBy,
      leaseExpires,
    };
  }
  return { action: "recover-failed", isOurs, leaseExpired, claimedBy, leaseExpires };
}

// --- Branch-per-task git flow (#47) ---

export interface TaskBranchOptions {
  /** Backoff in ms before each retry attempt after the first. Defaults to [500, 2000]. */
  fetchRetryDelaysMs?: number[];
  /**
   * Managed-checkout root (issue #139). Only working dirs under this root are
   * treated as branchable repos; anything else is `skipped`. Defaults to
   * {@link DEFAULT_REPOS_ROOT}. Point it at an isolated task tree so a task
   * can never branch a production checkout.
   */
  reposRoot?: string;
}

export interface TaskBranchResult {
  /** skipped: not a managed git repo; created: branch ready; fetch-failed: network error, no branch */
  action: "skipped" | "created" | "fetch-failed";
  branchName?: string;
  error?: string;
}

export interface BranchFinalizeResult {
  action: "skipped" | "no-changes" | "pr-created" | "push-failed";
  prUrl?: string;
  branchName?: string;
  error?: string;
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

/**
 * Pre-task: fetch origin and checkout a fresh branch `hugin/<taskId>` from
 * `origin/main`. Replaces the old `syncRepoBeforeTask` fast-forward approach.
 *
 * - Returns `skipped` for non-managed directories (outside `reposRoot`
 *   (default /home/magnus/repos/), not a git repo, no remote). Task proceeds
 *   normally.
 * - Returns `fetch-failed` on network errors. Task proceeds without branching
 *   (degraded mode, logged as warning).
 * - Returns `created` on success with `branchName` set.
 */
export async function checkoutTaskBranch(
  workingDir: string,
  taskId: string,
  options: TaskBranchOptions = {},
): Promise<TaskBranchResult> {
  // Canonicalize both sides before the prefix check: a raw `startsWith` guard
  // can be bypassed with `..` segments that string-match the isolated root but
  // resolve (via the OS `cwd`) onto a production checkout — the exact
  // re-pointing #139 exists to prevent. `path.sep`-anchoring also stops a
  // sibling dir that merely shares the root's string prefix (e.g.
  // `<root>-evil`).
  const reposRoot = path.resolve(normalizeRoot(options.reposRoot ?? DEFAULT_REPOS_ROOT));
  if (!path.resolve(workingDir).startsWith(`${reposRoot}${path.sep}`)) {
    return { action: "skipped" };
  }

  const isGit = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["rev-parse", "--git-dir"], {
      cwd: workingDir,
      stdio: "ignore",
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });

  if (!isGit) return { action: "skipped" };

  const hasRemote = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["remote", "get-url", "origin"], {
      cwd: workingDir,
      stdio: "ignore",
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });

  if (!hasRemote) return { action: "skipped" };

  // Fetch from origin with retries. Attempt 1 uses normal env; retries bypass
  // the system SSH config to sidestep strict-mode errors in the systemd-user
  // context (see issue #42).
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
      error: `git fetch origin failed in ${workingDir} after ${totalAttempts} attempts — proceeding without branch`,
    };
  }

  const branchName = `hugin/${taskId}`;

  const checkoutOk = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["checkout", "-b", branchName, "origin/main"], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(`Pre-task branch creation failed (exit ${code}) in ${workingDir}: ${output.trim()}`);
      }
      resolve(code === 0);
    });
    child.on("error", () => resolve(false));
  });

  if (!checkoutOk) {
    return {
      action: "fetch-failed",
      error: `Failed to create branch ${branchName} in ${workingDir}`,
    };
  }

  console.log(`Pre-task: checked out branch ${branchName} from origin/main in ${workingDir}`);
  return { action: "created", branchName };
}

/**
 * Post-task: finalize a task branch.
 *
 * 1. Auto-commits any uncommitted changes the task left behind.
 * 2. If no commits exist on the branch vs origin/main: cleans up the branch
 *    (read-only tasks like research spikes).
 * 3. If commits exist: pushes branch and opens a PR against main.
 *
 * Returns `pr-created` with `prUrl` on success, `no-changes` if nothing to
 * deliver, or `push-failed` on git/gh errors (non-fatal: task result is still
 * written to Munin).
 */
export async function finalizeTaskBranch(
  workingDir: string,
  branchName: string,
  prBody: string,
  allowedEgressHosts: string[],
): Promise<BranchFinalizeResult> {
  // Auto-commit uncommitted changes (task may have written files without committing)
  const isDirty = await new Promise<boolean>((resolve) => {
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

  if (isDirty) {
    const addOk = await new Promise<boolean>((resolve) => {
      const child = spawn("git", ["add", "-A"], {
        cwd: workingDir,
        stdio: "ignore",
        env: { ...process.env, HOME: "/home/magnus" },
      });
      child.on("close", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
    });

    if (addOk) {
      await new Promise<void>((resolve) => {
        const child = spawn(
          "git",
          ["commit", "-m", "hugin: auto-commit task output [skip ci]"],
          {
            cwd: workingDir,
            stdio: "ignore",
            env: { ...process.env, HOME: "/home/magnus" },
          },
        );
        child.on("close", () => resolve());
        child.on("error", () => resolve());
      });
    }
  }

  // Count commits on the branch that aren't on origin/main
  const commitsAhead = await new Promise<number>((resolve) => {
    const child = spawn("git", ["rev-list", "--count", "origin/main..HEAD"], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => resolve(code === 0 ? parseInt(out.trim(), 10) || 0 : 0));
    child.on("error", () => resolve(0));
  });

  if (commitsAhead === 0) {
    console.log(`Post-task: no changes on ${branchName} — cleaning up`);
    await cleanupLocalBranch(workingDir, branchName);
    return { action: "no-changes" };
  }

  // Egress check
  const remoteUrl = await new Promise<string | null>((resolve) => {
    const child = spawn("git", ["remote", "get-url", "--push", "origin"], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    child.on("error", () => resolve(null));
  });

  if (!remoteUrl || !isRemoteHostAllowed(remoteUrl, allowedEgressHosts)) {
    console.warn(`Post-task git push skipped in ${workingDir}: remote missing or not in egress allowlist`);
    return { action: "push-failed", branchName, error: "Remote not allowed by egress policy" };
  }

  // Push branch
  const pushOk = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["push", "-u", "origin", branchName], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(`Post-task git push failed (exit ${code}) in ${workingDir}: ${output.trim()}`);
      }
      resolve(code === 0);
    });
    child.on("error", () => resolve(false));
  });

  if (!pushOk) {
    return { action: "push-failed", branchName, error: "git push failed" };
  }

  // Open PR
  const taskId = branchName.replace(/^hugin\//, "");
  const prUrl = await createPullRequest(workingDir, branchName, taskId, prBody);
  if (!prUrl) {
    return { action: "push-failed", branchName, error: "gh pr create failed" };
  }

  console.log(`Post-task: PR created: ${prUrl}`);
  return { action: "pr-created", prUrl, branchName };
}

async function cleanupLocalBranch(workingDir: string, branchName: string): Promise<void> {
  // Detach HEAD so we can delete the branch we're on
  await new Promise<void>((resolve) => {
    const child = spawn("git", ["checkout", "--detach", "origin/main"], {
      cwd: workingDir,
      stdio: "ignore",
      env: { ...process.env, HOME: "/home/magnus" },
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });

  await new Promise<void>((resolve) => {
    const child = spawn("git", ["branch", "-d", branchName], {
      cwd: workingDir,
      stdio: "ignore",
      env: { ...process.env, HOME: "/home/magnus" },
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

async function createPullRequest(
  workingDir: string,
  branchName: string,
  taskId: string,
  body: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "gh",
      [
        "pr", "create",
        "--base", "main",
        "--head", branchName,
        "--title", `hugin: ${taskId}`,
        "--body", body,
      ],
      {
        cwd: workingDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: "/home/magnus" },
      },
    );
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(`gh pr create failed (exit ${code}): ${out.trim()}`);
        resolve(null);
        return;
      }
      // gh pr create prints the PR URL as the last line of stdout
      const lines = out.trim().split("\n");
      const url = lines[lines.length - 1]?.trim() ?? null;
      resolve(url?.startsWith("https://") ? url : null);
    });
    child.on("error", () => resolve(null));
  });
}

// --- Atomic task completion (#57) ---

// Minimal interface needed — avoids importing MuninClient which would create circular deps
interface TaskCompletionClient {
  write(namespace: string, key: string, content: string, tags: string[], expectedUpdatedAt?: string | undefined, classification?: string | undefined): Promise<unknown>;
  log(namespace: string, message: string): Promise<unknown>;
}

export interface TaskCompletionResult {
  structuredResultOk: boolean;
  structuredResultError?: unknown;
  // True only when `expectedUpdatedAt` was supplied and the terminal status
  // CAS write was rejected (another owner advanced the entry). The caller must
  // NOT treat the task as finalized — it has been re-owned (e.g. by startup
  // delivery reconciliation, Codex review #1).
  statusCasLost?: boolean;
}

/**
 * Atomically finalize a task by writing the terminal status FIRST (guaranteed),
 * then the structured result in a try/catch (non-fatal), then the log entry.
 *
 * This ordering ensures a task can never get stuck with the `running` tag if
 * the structured-result write (which calls Zod .parse() internally) throws.
 */
export async function finalizeTaskCompletion(
  client: TaskCompletionClient,
  taskNs: string,
  options: {
    statusContent: string;
    terminalTags: string[];
    classification?: string;
    writeStructuredResult: () => Promise<void>;
    logMessage: string;
    // When set, the terminal status write is a compare-and-swap against this
    // updated_at. A rejected CAS means ownership moved (single-owner model for
    // runtime-owned delivery, #68) — we bail WITHOUT writing structured/log so
    // the new owner's terminal state stands.
    expectedUpdatedAt?: string;
  },
): Promise<TaskCompletionResult> {
  // Status FIRST — guaranteed terminal flip even if structured-result write fails
  try {
    await client.write(
      taskNs,
      "status",
      options.statusContent,
      options.terminalTags,
      options.expectedUpdatedAt,
      options.classification,
    );
  } catch (err) {
    if (options.expectedUpdatedAt) {
      console.warn(
        `[${taskNs}] Terminal status CAS lost (ownership moved) — skipping finalize:`,
        err,
      );
      return { structuredResultOk: false, statusCasLost: true };
    }
    throw err;
  }

  let structuredResultOk = true;
  let structuredResultError: unknown;
  try {
    await options.writeStructuredResult();
  } catch (err) {
    structuredResultOk = false;
    structuredResultError = err;
    console.error(
      `[${taskNs}] Failed to write result-structured (task already in terminal state):`,
      err,
    );
  }

  await client.log(taskNs, options.logMessage);

  return { structuredResultOk, structuredResultError };
}

function isRemoteHostAllowed(remoteUrl: string, allowedHosts: string[]): boolean {
  const trimmed = remoteUrl.trim();
  let host: string | null = null;
  try {
    host = new URL(trimmed).hostname.toLowerCase();
  } catch {
    const scp = trimmed.match(/^[^@]+@([^:]+):/);
    if (scp?.[1]) host = scp[1].toLowerCase();
  }
  if (!host) return false;
  return allowedHosts.some((h) => {
    const n = h.trim().toLowerCase();
    if (n.startsWith("*.")) return host!.endsWith(n.slice(1));
    return host === n;
  });
}
