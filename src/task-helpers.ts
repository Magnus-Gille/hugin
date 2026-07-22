import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

function compareTaskClaimOrder(
  a: MuninQueryResult,
  b: MuninQueryResult,
): number {
  const aCreatedAtMs = Date.parse(a.created_at);
  const bCreatedAtMs = Date.parse(b.created_at);
  const aCreatedAtValid = Number.isFinite(aCreatedAtMs);
  const bCreatedAtValid = Number.isFinite(bCreatedAtMs);
  if (aCreatedAtValid !== bCreatedAtValid) return aCreatedAtValid ? -1 : 1;
  if (aCreatedAtValid && bCreatedAtValid) {
    if (aCreatedAtMs !== bCreatedAtMs) return aCreatedAtMs - bCreatedAtMs;
  } else if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? -1 : 1;
  }
  return a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0;
}

/**
 * Select the oldest pending task from a batch of query results (FIFO ordering).
 * Filters to key === "status" entries and orders by (created_at, namespace).
 */
export function pickEarliestTask(
  results: MuninQueryResult[],
): MuninQueryResult | undefined {
  const statusEntries = results.filter((r) => r.key === "status");
  if (statusEntries.length === 0) return undefined;
  return statusEntries.reduce((earliest, r) =>
    compareTaskClaimOrder(r, earliest) < 0 ? r : earliest,
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
  // Work in deterministic FIFO order (earliest first, then stable task namespace)
  const statusEntries = pendingTasks.filter((r) => r.key === "status");
  if (statusEntries.length === 0) return undefined;

  const sorted = [...statusEntries].sort(compareTaskClaimOrder);

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
  /** Explicit remote branch name for disconnected or unusual repositories. */
  baseBranchOverride?: string;
  /** Pin the resolved base before the agent runs so later evidence cannot trust an agent-mutated ref. */
  captureBaseCommit?: boolean;
}

export interface TaskBranchResult {
  /** skipped: not a managed git repo; created: branch ready; fetch-failed: network error, no branch */
  action: "skipped" | "created" | "fetch-failed";
  branchName?: string;
  baseBranch?: string;
  baseCommit?: string;
  error?: string;
}

export interface BranchFinalizeResult {
  action: "skipped" | "no-changes" | "pr-created" | "push-failed";
  prUrl?: string;
  branchName?: string;
  repositoryChange?: RepositoryChangeEvidence;
  repositoryChangeError?: string;
  error?: string;
}

export interface RepositoryOutcomeEvidence {
  state:
    | "not-managed"
    | "checkout-failed"
    | "not-finalized"
    | "no-changes"
    | "changes-present"
    | "publication-failed"
    // Issue #236: the pre-execution clean-verification gate refused to run a
    // mutation-capable task against this checkout — either the managed
    // checkout itself could not be prepared, or it was prepared but found
    // dirty/unverified even after an explicit recovery attempt. Reached only
    // via {@link prepareManagedCheckout}, never by a bare checkout-failed.
    | "checkout-contaminated";
  baseBranch?: string;
  baseCommit?: string;
}

/** Derive the machine-readable repository outcome without trusting agent prose. */
export function deriveRepositoryOutcome(
  branch: TaskBranchResult,
  finalizeAction?: BranchFinalizeResult["action"],
  gateRefused?: boolean,
): RepositoryOutcomeEvidence {
  const base = {
    ...(branch.baseBranch ? { baseBranch: branch.baseBranch } : {}),
    ...(branch.baseCommit ? { baseCommit: branch.baseCommit } : {}),
  };
  if (gateRefused) return { state: "checkout-contaminated", ...base };
  if (branch.action === "skipped") return { state: "not-managed" };
  if (branch.action === "fetch-failed") return { state: "checkout-failed" };
  if (!branch.baseBranch || !branch.baseCommit) {
    return { state: "not-finalized", ...base };
  }
  if (finalizeAction === "no-changes") return { state: "no-changes", ...base };
  if (finalizeAction === "pr-created") return { state: "changes-present", ...base };
  if (finalizeAction === "push-failed") return { state: "publication-failed", ...base };
  return { state: "not-finalized", ...base };
}

/**
 * Content-blind binding for turning a completed managed-repository task into a
 * reproducible evaluation candidate. The task prompt/result remain in Munin;
 * this record only pins the exact before/after trees and their changed paths.
 */
export interface RepositoryChangeEvidence {
  baseBranch: string;
  baseCommit: string;
  headCommit: string;
  changedFiles: string[];
  diffSha256: string;
}

export interface BranchFinalizeOptions {
  /** Capture exact before/after repository evidence for the daily exam factory. */
  captureRepositoryChange?: boolean;
  /** Resolved remote branch returned by checkoutTaskBranch. */
  baseBranch?: string;
  /** Pre-agent base commit returned by checkoutTaskBranch. */
  baseCommit?: string;
}

const DEFAULT_FETCH_RETRY_DELAYS_MS = [500, 2000];
const GIT_COMMIT_ID = /^[0-9a-f]{40,64}$/;

export interface ParsedBaseBranchOverride {
  baseBranch?: string;
  error?: string;
}

/**
 * Validate a branch name without invoking a shell. This mirrors Git's
 * check-ref-format restrictions and additionally requires a branch name (not
 * an `origin/*` or `refs/*` ref) so Hugin can construct one canonical remote
 * tracking ref for every subsequent operation.
 */
export function isValidBaseBranchName(value: string): boolean {
  if (!value || value !== value.trim() || value.length > 255) return false;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value === "@" ||
    value.toUpperCase() === "HEAD" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.startsWith("origin/") ||
    value.startsWith("refs/") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    /[\x00-\x20\x7f~^:?*[\]\\]/.test(value)
  ) {
    return false;
  }
  return value.split("/").every(
    (component) =>
      component.length > 0 &&
      !component.startsWith(".") &&
      !component.endsWith(".lock"),
  );
}

/** Parse and validate the optional `Base branch:` task field. */
export function parseBaseBranchOverride(content: string): ParsedBaseBranchOverride {
  // Task metadata ends at `### Prompt`; prompt prose must never be able to
  // select Git control-plane state by merely mentioning this field.
  const metadata = content.split(/^###\s*Prompt\s*$/im, 1)[0] ?? "";
  const raw = metadata.match(/\*\*Base branch:\*\*\s*(.+)/i)?.[1]?.trim();
  if (!raw) return {};
  if (!isValidBaseBranchName(raw)) {
    return {
      error:
        `invalid Base branch override ${JSON.stringify(raw)}; provide a branch name ` +
        "such as main, master, or release/stable (not an origin/* or refs/* ref)",
    };
  }
  return { baseBranch: raw };
}

interface ResolvedBaseBranch {
  baseBranch: string;
  baseCommit: string;
  source: "override" | "origin-head" | "remote-head";
}

async function verifyRemoteBaseBranch(
  workingDir: string,
  baseBranch: string,
): Promise<{ baseCommit?: string; error?: string }> {
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  const base = await runGitCapture(workingDir, [
    "rev-parse", "--verify", `${remoteRef}^{commit}`,
  ]);
  const baseCommit = base.stdout.toString("utf8").trim().toLowerCase();
  if (!base.ok || !GIT_COMMIT_ID.test(baseCommit)) {
    return {
      error: `${remoteRef} has no valid commit: ${base.stderr || "invalid commit id"}`,
    };
  }
  return { baseCommit };
}

async function resolveRepositoryBaseBranch(
  workingDir: string,
  override: string | undefined,
): Promise<{ resolved?: ResolvedBaseBranch; error?: string }> {
  if (override) {
    if (!isValidBaseBranchName(override)) {
      return { error: `invalid base-branch override ${JSON.stringify(override)}` };
    }
    const verified = await verifyRemoteBaseBranch(workingDir, override);
    if (!verified.baseCommit) {
      return {
        error:
          `explicit base branch ${JSON.stringify(override)} is unavailable: ` +
          (verified.error || "unknown error"),
      };
    }
    return {
      resolved: {
        baseBranch: override,
        baseCommit: verified.baseCommit,
        source: "override",
      },
    };
  }

  const symbolic = await runGitCapture(workingDir, [
    "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD",
  ]);
  if (symbolic.ok) {
    const candidate = symbolic.stdout.toString("utf8").trim();
    if (candidate.startsWith("origin/")) {
      const branch = candidate.slice("origin/".length);
      if (isValidBaseBranchName(branch)) {
        const verified = await verifyRemoteBaseBranch(workingDir, branch);
        if (verified.baseCommit) {
          return {
            resolved: {
              baseBranch: branch,
              baseCommit: verified.baseCommit,
              source: "origin-head",
            },
          };
        }
      }
    }
  }

  const remoteHead = await runGitCapture(workingDir, [
    "ls-remote", "--symref", "origin", "HEAD",
  ]);
  if (remoteHead.ok) {
    for (const line of remoteHead.stdout.toString("utf8").split("\n")) {
      const match = line.match(/^ref:\s+refs\/heads\/(.+)\tHEAD$/);
      const branch = match?.[1];
      if (!branch || !isValidBaseBranchName(branch)) continue;
      const verified = await verifyRemoteBaseBranch(workingDir, branch);
      if (verified.baseCommit) {
        return {
          resolved: {
            baseBranch: branch,
            baseCommit: verified.baseCommit,
            source: "remote-head",
          },
        };
      }
    }
  }

  return {
    error:
      "could not resolve a valid origin default branch from origin/HEAD or remote HEAD; " +
      "set an explicit Base branch task field",
  };
}

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
 * Pre-task: fetch origin, resolve its default branch, and checkout a fresh
 * `hugin/<taskId>` branch from that exact remote-tracking ref. Replaces the old
 * `syncRepoBeforeTask` fast-forward approach.
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
  if (
    options.baseBranchOverride !== undefined &&
    !isValidBaseBranchName(options.baseBranchOverride)
  ) {
    return {
      action: "fetch-failed",
      error: `Invalid base-branch override ${JSON.stringify(options.baseBranchOverride)}`,
    };
  }
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

  if (!fetchOk && !options.baseBranchOverride) {
    return {
      action: "fetch-failed",
      error: `git fetch origin failed in ${workingDir} after ${totalAttempts} attempts — proceeding without branch`,
    };
  }
  if (!fetchOk) {
    console.warn(
      `Pre-task git fetch failed in ${workingDir}; attempting explicit base branch ` +
        `${JSON.stringify(options.baseBranchOverride)} from the existing remote-tracking ref`,
    );
  }

  const baseResolution = await resolveRepositoryBaseBranch(
    workingDir,
    options.baseBranchOverride,
  );
  if (!baseResolution.resolved) {
    return {
      action: "fetch-failed",
      error: `Failed to resolve repository base branch: ${baseResolution.error || "unknown error"}`,
    };
  }
  const { baseBranch, baseCommit, source } = baseResolution.resolved;
  const baseRef = `origin/${baseBranch}`;

  const branchName = `hugin/${taskId}`;

  const checkoutOk = await new Promise<boolean>((resolve) => {
    const child = spawn("git", ["checkout", "-b", branchName, baseRef], {
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

  console.log(
    `Pre-task: checked out branch ${branchName} from ${baseRef} ` +
      `(resolved via ${source}) in ${workingDir}`,
  );
  return {
    action: "created",
    branchName,
    baseBranch,
    baseCommit: options.captureBaseCommit ? baseCommit : undefined,
  };
}

/**
 * Post-task: finalize a task branch.
 *
 * 1. Auto-commits any uncommitted changes the task left behind.
 * 2. If no commits exist on the branch vs the resolved base: cleans up the branch
 *    (read-only tasks like research spikes).
 * 3. If commits exist: pushes branch and opens a PR against that same base.
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
  options: BranchFinalizeOptions = {},
): Promise<BranchFinalizeResult> {
  const baseBranch = options.baseBranch ?? "main";
  if (!isValidBaseBranchName(baseBranch)) {
    return {
      action: "push-failed",
      branchName,
      error: `Invalid resolved base branch ${JSON.stringify(baseBranch)}`,
    };
  }
  const baseRef = `origin/${baseBranch}`;
  const pinnedBaseCommit = options.baseCommit?.trim().toLowerCase();
  const comparisonBase = pinnedBaseCommit && GIT_COMMIT_ID.test(pinnedBaseCommit)
    ? pinnedBaseCommit
    : baseRef;

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
          ["commit", "-m", "hugin: auto-commit task output"],
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

  // Count commits on the branch that aren't on the resolved remote base.
  const commitsAhead = await new Promise<number | null>((resolve) => {
    const child = spawn("git", ["rev-list", "--count", `${comparisonBase}..HEAD`], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => {
      if (code !== 0 || !/^\d+$/.test(out.trim())) {
        resolve(null);
        return;
      }
      resolve(parseInt(out.trim(), 10));
    });
    child.on("error", () => resolve(null));
  });

  if (commitsAhead === null) {
    return {
      action: "push-failed",
      branchName,
      error: `Failed to compare task branch against pinned base ${comparisonBase}`,
    };
  }

  if (commitsAhead === 0) {
    console.log(`Post-task: no changes on ${branchName} — cleaning up`);
    await cleanupLocalBranch(workingDir, branchName, comparisonBase);
    return { action: "no-changes" };
  }

  let repositoryChange: RepositoryChangeEvidence | undefined;
  let repositoryChangeError: string | undefined;
  if (options.captureRepositoryChange) {
    const captured = await captureRepositoryChange(
      workingDir,
      baseBranch,
      options.baseCommit,
    );
    repositoryChange = captured.evidence;
    repositoryChangeError = captured.error;
    if (repositoryChangeError) {
      // Evidence capture must never discard a successful task or prevent its
      // PR from being delivered. The harvester will quarantine this task until
      // the missing binding is repaired independently.
      console.warn(
        `Post-task repository evidence unavailable for ${branchName}: ${repositoryChangeError}`,
      );
    }
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
    return {
      action: "push-failed",
      branchName,
      repositoryChange,
      repositoryChangeError,
      error: "Remote not allowed by egress policy",
    };
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
    return {
      action: "push-failed",
      branchName,
      repositoryChange,
      repositoryChangeError,
      error: "git push failed",
    };
  }

  // Open PR
  const taskId = branchName.replace(/^hugin\//, "");
  const prUrl = await createPullRequest(
    workingDir,
    branchName,
    baseBranch,
    taskId,
    prBody,
  );
  if (!prUrl) {
    return {
      action: "push-failed",
      branchName,
      repositoryChange,
      repositoryChangeError,
      error: "gh pr create failed",
    };
  }

  console.log(`Post-task: PR created: ${prUrl}`);
  return {
    action: "pr-created",
    prUrl,
    branchName,
    repositoryChange,
    repositoryChangeError,
  };
}

async function runGitCapture(
  workingDir: string,
  args: string[],
): Promise<{ ok: boolean; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({
      ok: code === 0,
      stdout: Buffer.concat(stdout),
      stderr: stderr.trim(),
    }));
    child.on("error", (err) => resolve({
      ok: false,
      stdout: Buffer.alloc(0),
      stderr: err.message,
    }));
  });
}

async function captureRepositoryChange(
  workingDir: string,
  baseBranch: string,
  preTaskBaseCommit: string | undefined,
): Promise<{ evidence?: RepositoryChangeEvidence; error?: string }> {
  const baseCommit = preTaskBaseCommit?.trim().toLowerCase();
  if (!baseCommit || !/^[0-9a-f]{40,64}$/.test(baseCommit)) {
    return { error: "pre-task base commit is unavailable or invalid" };
  }
  const head = await runGitCapture(workingDir, ["rev-parse", "HEAD"]);
  if (!head.ok) return { error: `git rev-parse HEAD failed: ${head.stderr || "unknown"}` };
  const headCommit = head.stdout.toString("utf8").trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(headCommit)) {
    return { error: "git returned an invalid head commit id" };
  }
  if (baseCommit === headCommit) return { error: "base and head commits are identical" };

  const range = `${baseCommit}..${headCommit}`;
  const names = await runGitCapture(workingDir, [
    "diff", "--name-only", "-z", "--no-ext-diff", range,
  ]);
  if (!names.ok) return { error: `git diff --name-only failed: ${names.stderr || "unknown"}` };
  const changedFiles = names.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (changedFiles.length === 0) return { error: "commit range contains no changed files" };
  if (changedFiles.some((file) => path.isAbsolute(file) || file.split("/").includes(".."))) {
    return { error: "git returned an unsafe changed-file path" };
  }

  const diff = await runGitCapture(workingDir, [
    "diff", "--binary", "--no-ext-diff", "--no-textconv", range,
  ]);
  if (!diff.ok) return { error: `git diff --binary failed: ${diff.stderr || "unknown"}` };
  if (diff.stdout.length === 0) return { error: "commit range contains an empty diff" };

  return {
    evidence: {
      baseBranch,
      baseCommit,
      headCommit,
      changedFiles,
      diffSha256: createHash("sha256").update(diff.stdout).digest("hex"),
    },
  };
}

async function cleanupLocalBranch(
  workingDir: string,
  branchName: string,
  detachTarget: string,
): Promise<void> {
  // Detach HEAD so we can delete the branch we're on
  await new Promise<void>((resolve) => {
    const child = spawn("git", ["checkout", "--detach", detachTarget], {
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
  baseBranch: string,
  taskId: string,
  body: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "gh",
      [
        "pr", "create",
        "--base", baseBranch,
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

// --- Checkout contamination detection + clean-verification gate (#236) ---
//
// `checkoutTaskBranch` above is non-fatal by design: a fetch/resolve/checkout
// failure returns `fetch-failed` and the CALLER decides what to do. Historically
// the caller just proceeded anyway (logged a warning, executed the agent
// against whatever was already on disk). Because a managed working directory
// is REUSED across tasks (one directory per repo, not per task), that leaves a
// durable hole: a task whose checkout failed — or whose `checkout -b` silently
// carried over an earlier task's uncommitted files instead of conflicting —
// can execute against, and `finalizeTaskBranch` can auto-commit and publish,
// state that has nothing to do with the current task. A later task then
// inherits the same contaminated directory.
//
// The functions below give the pre-task seam in index.ts a durable
// contamination marker plus a verification gate: a managed task's checkout is
// only ever trusted once it is independently proven clean at the exact
// resolved base commit, and a mutation-capable task whose checkout cannot be
// proven clean — even after one explicit, verified recovery attempt — is
// refused before any executor runs. A read-only task (one whose runtime
// cannot itself write, per Hugin's own permission-profile/runtime gating) may
// still proceed in an explicitly logged degraded mode, since it cannot
// compound the contamination.

/** Durable, git-native contamination marker for a reused managed working directory. */
export interface CheckoutContaminationRecord {
  contaminatedAt: string;
  taskId: string;
  reason: string;
}

// Stored in the repository's own `.git/config` (via `git config --local`):
// scoped to exactly this reused working directory, invisible to `git add -A`
// and `git diff` (git never treats its own metadata directory as trackable
// content), and durable across dispatcher restarts. `--local` always resolves
// relative to `cwd`, so this can never leak into a different checkout.
const CONTAMINATION_CONFIG_KEY = "hugin.checkout-contaminated";

function sanitizeContaminationField(value: string): string {
  return value.replace(/[\r\n|]+/g, " ").trim();
}

function encodeContaminationRecord(record: CheckoutContaminationRecord): string {
  return [
    record.contaminatedAt,
    sanitizeContaminationField(record.taskId),
    sanitizeContaminationField(record.reason),
  ].join("|");
}

function decodeContaminationRecord(raw: string): CheckoutContaminationRecord | null {
  const parts = raw.split("|");
  if (parts.length < 3) return null;
  const [contaminatedAt, taskId, ...reasonParts] = parts;
  return { contaminatedAt, taskId, reason: reasonParts.join("|") };
}

/** Durably mark a managed working directory CONTAMINATED. Best-effort return value only — callers must still fail closed on the caller-visible outcome, never on whether the marker write itself succeeded. */
export async function markCheckoutContaminated(
  workingDir: string,
  taskId: string,
  reason: string,
): Promise<boolean> {
  const record: CheckoutContaminationRecord = {
    contaminatedAt: new Date().toISOString(),
    taskId,
    reason,
  };
  const result = await runGitCapture(workingDir, [
    "config", "--local", CONTAMINATION_CONFIG_KEY, encodeContaminationRecord(record),
  ]);
  if (!result.ok) {
    console.error(
      `Failed to durably mark checkout contaminated in ${workingDir}: ${result.stderr || "unknown error"}`,
    );
  }
  return result.ok;
}

/** Read the durable contamination marker, if any. Never throws. */
export async function readCheckoutContamination(
  workingDir: string,
): Promise<CheckoutContaminationRecord | null> {
  const result = await runGitCapture(workingDir, [
    "config", "--local", "--get", CONTAMINATION_CONFIG_KEY,
  ]);
  if (!result.ok) return null;
  const raw = result.stdout.toString("utf8").trim();
  if (!raw) return null;
  return decodeContaminationRecord(raw);
}

/**
 * Explicitly clear the durable contamination marker. Callers must only call
 * this AFTER independently verifying the checkout is clean — never merely
 * because a recovery step reported success (see {@link prepareManagedCheckout}).
 */
export async function clearCheckoutContamination(workingDir: string): Promise<void> {
  // --unset-all succeeds even when the key was never set — "no longer
  // present" is the only postcondition this needs, not "was present before".
  await runGitCapture(workingDir, ["config", "--local", "--unset-all", CONTAMINATION_CONFIG_KEY]);
}

export interface CleanCheckoutVerification {
  clean: boolean;
  reason?: string;
  headCommit?: string;
}

/**
 * Verify the working tree has no dirty/untracked state and HEAD matches the
 * expected commit. Run immediately after `checkoutTaskBranch` succeeds and
 * before any executor runs: `git checkout -b` does not require a clean tree
 * to succeed, so a prior task's uncommitted leftovers can survive onto the
 * new branch without the checkout step itself failing.
 */
export async function verifyCleanCheckout(
  workingDir: string,
  expectedCommit: string,
): Promise<CleanCheckoutVerification> {
  const normalizedExpected = expectedCommit.trim().toLowerCase();
  if (!GIT_COMMIT_ID.test(normalizedExpected)) {
    return {
      clean: false,
      reason: `expected commit ${JSON.stringify(expectedCommit)} is not a valid commit id`,
    };
  }
  // `--ignored` is deliberate (M5 review, #236): plain `--porcelain` never
  // reports gitignored paths, so a prior task's leftover ignored garbage
  // (e.g. a stale `.env`, build cache, or partial `node_modules`) would
  // otherwise verify as "clean" and never trigger `recoverCleanCheckout`
  // (whose `git clean -fdx` DOES remove ignored files) — silently leaving
  // untracked-but-invisible state for the next task to inherit.
  const status = await runGitCapture(workingDir, ["status", "--porcelain", "--ignored"]);
  if (!status.ok) {
    return { clean: false, reason: `git status failed: ${status.stderr || "unknown error"}` };
  }
  if (status.stdout.toString("utf8").trim().length > 0) {
    return { clean: false, reason: "working tree has uncommitted, untracked, or ignored leftover state" };
  }
  const head = await runGitCapture(workingDir, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    return { clean: false, reason: `git rev-parse HEAD failed: ${head.stderr || "unknown error"}` };
  }
  const headCommit = head.stdout.toString("utf8").trim().toLowerCase();
  if (!GIT_COMMIT_ID.test(headCommit) || headCommit !== normalizedExpected) {
    return {
      clean: false,
      reason: `HEAD ${headCommit || "(empty)"} does not match resolved base commit ${normalizedExpected}`,
      headCommit,
    };
  }
  return { clean: true, headCommit };
}

async function runGitVoid(workingDir: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    child.on("close", (code) => resolve({ ok: code === 0, output }));
    child.on("error", (err) => resolve({ ok: false, output: err.message }));
  });
}

/**
 * Explicit, verified-by-the-caller recovery: hard-reset the working tree to
 * `targetCommit` and remove untracked/ignored files. Only ever touches the
 * LOCAL working directory (no push, no remote mutation) — the remote is the
 * source of truth this recovers back to. Callers must re-run
 * {@link verifyCleanCheckout} afterward; this function never asserts its own
 * success is sufficient.
 */
export async function recoverCleanCheckout(
  workingDir: string,
  targetCommit: string,
): Promise<{ ok: boolean; reason?: string }> {
  const normalizedTarget = targetCommit.trim().toLowerCase();
  if (!GIT_COMMIT_ID.test(normalizedTarget)) {
    return { ok: false, reason: `recovery target ${JSON.stringify(targetCommit)} is not a valid commit id` };
  }
  const reset = await runGitVoid(workingDir, ["reset", "--hard", normalizedTarget]);
  if (!reset.ok) {
    return { ok: false, reason: `git reset --hard ${normalizedTarget} failed: ${reset.output.trim()}` };
  }
  const clean = await runGitVoid(workingDir, ["clean", "-fdx"]);
  if (!clean.ok) {
    return { ok: false, reason: `git clean -fdx failed: ${clean.output.trim()}` };
  }
  return { ok: true };
}

export interface ManagedCheckoutGateOptions extends TaskBranchOptions {
  /**
   * Whether THIS task's runtime/permission profile can itself write to the
   * working directory. Read-only tasks may proceed in explicit degraded mode
   * against an unverified checkout (AC: "distinguish read-only tasks where
   * degraded execution is explicitly permitted"); mutation-capable tasks
   * never may.
   */
  mutationCapable: boolean;
}

export interface ManagedCheckoutGateResult {
  /** The underlying checkout attempt — unchanged semantics, still feeds `deriveRepositoryOutcome`. */
  branch: TaskBranchResult;
  /** Set only when a mutation-capable task must be refused before any executor runs. */
  refusalReason?: string;
  /** True when a contaminated/unverified checkout was explicitly cleaned and reverified before this task proceeded. */
  recovered?: boolean;
  /** True when execution proceeded in explicit degraded mode against an unverified/unresolved checkout because this task cannot mutate it. Callers must skip publication (finalizeTaskBranch) whenever this is true — a read-only task must never have a PRIOR task's leftover dirty state auto-committed and published in its name. */
  degraded?: boolean;
  degradedReason?: string;
  /** The pre-existing durable marker, if the working directory was already contaminated when this task started (context for logging/results, not a gating input — the checkout is always independently reverified regardless). */
  priorContamination?: CheckoutContaminationRecord | null;
}

/**
 * Pre-execution isolation/verification gate around the managed-checkout seam.
 * Wraps {@link checkoutTaskBranch} with a durable contamination marker and a
 * clean-at-the-resolved-commit verification, so a managed task only ever
 * executes once its checkout is proven trustworthy:
 *
 * - `skipped` (not a managed repo): gate does not apply, unchanged behavior.
 * - Checkout itself could not be prepared (`fetch-failed`): mutation-capable →
 *   mark contaminated + refuse (no safe target to recover to). Read-only →
 *   explicit degraded pass-through.
 * - Checkout created but NOT verified clean at the pinned base commit:
 *   mutation-capable → mark contaminated, attempt exactly one explicit
 *   reset+clean recovery, re-verify; refuse if still unverified. Read-only →
 *   explicit degraded pass-through (contamination left marked for the next
 *   mutation-capable task to recover).
 * - Verified clean: any pre-existing marker is explicitly cleared (never
 *   assumed) and the task proceeds normally.
 */
export async function prepareManagedCheckout(
  workingDir: string,
  taskId: string,
  options: ManagedCheckoutGateOptions,
): Promise<ManagedCheckoutGateResult> {
  const { mutationCapable, ...checkoutOptions } = options;
  const branch = await checkoutTaskBranch(workingDir, taskId, {
    ...checkoutOptions,
    captureBaseCommit: true,
  });

  if (branch.action === "skipped") {
    return { branch };
  }

  const priorContamination = await readCheckoutContamination(workingDir);

  // Detection and marking are UNCONDITIONAL — a proven-untrustworthy checkout
  // is durably recorded regardless of whether the discovering task can itself
  // mutate the tree, so the evidence survives for whichever task (read-only or
  // mutation-capable) looks at this directory next. Only the RECOVERY attempt
  // below is gated on `mutationCapable`.
  if (branch.action === "fetch-failed") {
    const reason = branch.error ?? "managed checkout failed";
    await markCheckoutContaminated(workingDir, taskId, reason);
    if (!mutationCapable) {
      return {
        branch,
        degraded: true,
        degradedReason: `checkout failed (${reason}); proceeding read-only against the existing working tree`,
        priorContamination,
      };
    }
    return {
      branch,
      refusalReason: `Managed checkout failed and the working directory state cannot be trusted: ${reason}`,
      priorContamination,
    };
  }

  const expectedCommit = branch.baseCommit;
  if (!expectedCommit) {
    // captureBaseCommit is always forced true above; this should be
    // unreachable, but never assume a checkout is safe without evidence.
    const reason = "resolved checkout has no pinned base commit to verify against";
    await markCheckoutContaminated(workingDir, taskId, reason);
    if (!mutationCapable) {
      return { branch, degraded: true, degradedReason: reason, priorContamination };
    }
    return { branch, refusalReason: reason, priorContamination };
  }

  let verification = await verifyCleanCheckout(workingDir, expectedCommit);
  if (verification.clean) {
    // Explicit + verified: only ever clear a PRIOR marker once THIS checkout
    // has been independently proven clean at the intended commit — never
    // merely because no marker blocked us from getting this far.
    await clearCheckoutContamination(workingDir);
    return { branch, priorContamination };
  }

  const dirtyReason = verification.reason ?? "checkout is not clean";
  await markCheckoutContaminated(workingDir, taskId, dirtyReason);
  if (!mutationCapable) {
    return {
      branch,
      degraded: true,
      degradedReason: `checkout unverified (${dirtyReason}); proceeding read-only against the existing working tree`,
      priorContamination,
    };
  }

  const recovery = await recoverCleanCheckout(workingDir, expectedCommit);
  if (recovery.ok) {
    verification = await verifyCleanCheckout(workingDir, expectedCommit);
  }

  if (!recovery.ok || !verification.clean) {
    return {
      branch,
      refusalReason:
        `Managed checkout could not be verified clean at ${expectedCommit} after an explicit recovery attempt: ` +
        (verification.reason ?? recovery.reason ?? "unknown recovery failure"),
      priorContamination,
    };
  }

  await clearCheckoutContamination(workingDir);
  return { branch, recovered: true, priorContamination };
}

// --- Publication failure recovery (#225) ---
//
// A managed task's paid model work and its repository publication (push +
// PR) are separate facts. `finalizeTaskBranch` above can return `push-failed`
// AFTER an exact commit already exists on the task branch — e.g. GitHub
// denies the configured identity write access, or `gh pr create` fails
// transiently. The model work must never be re-run just to retry that last
// step. The functions below give an authorized operator (never the primary
// execution loop) an idempotent, git/gh-only path back to a durable
// publication outcome, driven entirely by a `PublicationRecoveryRecord`
// persisted at push-failed time — never by re-invoking any executor.

export const PUBLICATION_FAILED_TAG = "publication:failed";
export const PUBLICATION_RECOVERED_TAG = "publication:recovered";
export const PUBLICATION_ABANDONED_TAG = "publication:abandoned";

/**
 * Durable, content-blind record of a publication failure: enough to retry
 * ONLY the push/PR step, never the model. `headCommit` is only present when
 * repository-change evidence was captured before the failure (it never is,
 * for example, when the pre-push branch-vs-base comparison itself failed) —
 * without it, {@link recoverPublication} cannot safely verify partial success
 * and refuses to touch git.
 */
export interface PublicationRecoveryRecord {
  schemaVersion: 1;
  taskId: string;
  taskNamespace: string;
  workingDir: string;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  headCommit?: string;
  prBody: string;
  allowedEgressHosts: string[];
  failureReason: string;
  attempts: number;
  firstFailedAt: string;
  lastAttemptAt: string;
  lastError?: string;
}

export interface BuildPublicationRecoveryRecordInput {
  taskId: string;
  taskNamespace: string;
  workingDir: string;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  headCommit?: string;
  prBody: string;
  allowedEgressHosts: string[];
  failureReason: string;
  now?: Date;
}

/** Construct the initial durable record at the moment publication fails. */
export function buildPublicationRecoveryRecord(
  input: BuildPublicationRecoveryRecordInput,
): PublicationRecoveryRecord {
  const nowIso = (input.now ?? new Date()).toISOString();
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    taskNamespace: input.taskNamespace,
    workingDir: input.workingDir,
    branchName: input.branchName,
    baseBranch: input.baseBranch,
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
    prBody: input.prBody,
    allowedEgressHosts: input.allowedEgressHosts,
    failureReason: input.failureReason,
    attempts: 0,
    firstFailedAt: nowIso,
    lastAttemptAt: nowIso,
  };
}

export type PublicationRecoveryOutcome =
  | "published"
  | "reconciled"
  | "failed"
  | "abandoned";

export interface PublicationRecoveryAttemptResult {
  outcome: PublicationRecoveryOutcome;
  /** Set for `published` (freshly created) and `reconciled` (found existing). */
  prUrl?: string;
  /** The verified exact head commit the outcome refers to. */
  headCommit?: string;
  /** Present for `failed`: a retryable git/gh error. */
  error?: string;
  /** Present for `abandoned`: why recovery refused to touch git at all. */
  reason?: string;
}

async function findExistingPullRequest(
  workingDir: string,
  branchName: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "gh",
      ["pr", "list", "--head", branchName, "--state", "all", "--json", "url", "--limit", "1"],
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
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(out.trim() || "[]") as Array<{ url?: unknown }>;
        const url = parsed[0]?.url;
        resolve(typeof url === "string" && url.startsWith("https://") ? url : null);
      } catch {
        resolve(null);
      }
    });
    child.on("error", () => resolve(null));
  });
}

/**
 * Retry ONLY the publication step for a previously failed managed-repository
 * task, from a durable {@link PublicationRecoveryRecord}. Never runs an
 * executor and never re-derives the diff — it only inspects and, if safe,
 * advances the exact branch/commit that already exists.
 *
 * Reconciliation-first: before pushing or creating anything, it checks
 * whether the remote already has the recorded exact commit and whether a PR
 * already exists for the branch. This makes repeated recovery attempts
 * (including a second call after a first `published`/`reconciled` result)
 * idempotent at the git/gh level — a retry can never open a second PR for a
 * publication that already succeeded.
 *
 * Refuses to touch git (returns `abandoned`) whenever it cannot verify the
 * local branch still points at the exact recorded head — the safest failure
 * mode when a checkout was reused by a later task or evidence was never
 * captured.
 */
export async function recoverPublication(
  record: PublicationRecoveryRecord,
): Promise<PublicationRecoveryAttemptResult> {
  if (!isValidBaseBranchName(record.baseBranch)) {
    return { outcome: "abandoned", reason: `invalid recorded base branch ${JSON.stringify(record.baseBranch)}` };
  }
  if (!record.branchName.startsWith("hugin/") || !GIT_COMMIT_ID.test(record.baseCommit)) {
    return { outcome: "abandoned", reason: "recovery record is missing a valid branch name or base commit" };
  }
  if (!record.headCommit) {
    return {
      outcome: "abandoned",
      reason:
        "no repository-change evidence was captured before the failure — the exact head commit is " +
        "unknown, so recovery cannot safely verify what would be published",
    };
  }

  // Verify the local branch still exists and points at the exact recorded
  // head. A mismatch means the working directory was reused by a later task
  // (or the branch was deleted) — the completed commit is no longer safely
  // reachable from this checkout, so recovery must not guess.
  const localHead = await runGitCapture(record.workingDir, [
    "rev-parse", "--verify", `refs/heads/${record.branchName}^{commit}`,
  ]);
  const localHeadCommit = localHead.stdout.toString("utf8").trim().toLowerCase();
  if (!localHead.ok || !GIT_COMMIT_ID.test(localHeadCommit)) {
    return {
      outcome: "abandoned",
      reason: `local branch ${record.branchName} no longer exists in ${record.workingDir}`,
    };
  }
  if (localHeadCommit !== record.headCommit) {
    return {
      outcome: "abandoned",
      reason:
        `local branch ${record.branchName} now points at ${localHeadCommit}, not the recorded ` +
        `head ${record.headCommit} — the checkout was reused; publication cannot be safely recovered`,
    };
  }

  // Reconciliation first (Codex-reviewed, #225): an existing PR for this
  // branch — in ANY state — means a prior attempt already published, so a
  // retry must never call `gh pr create` again. No base/body cross-check is
  // needed: `branchName` is always `hugin/<taskId>`, unique per task
  // throughout this codebase, so any PR found here can only be this task's.
  // A residual check-then-create race (a PR appearing between this check and
  // `createPullRequest` below) is not a duplicate-publish risk either — GitHub
  // rejects a second open PR for the same head branch, so `createPullRequest`
  // returns null and this attempt reports `failed` (retryable); it never
  // reports a false `published`, and the next recovery attempt reconciles
  // against the PR that actually exists.
  const existingPr = await findExistingPullRequest(record.workingDir, record.branchName);
  if (existingPr) {
    return { outcome: "reconciled", prUrl: existingPr, headCommit: record.headCommit };
  }

  const remoteUrl = await new Promise<string | null>((resolve) => {
    const child = spawn("git", ["remote", "get-url", "--push", "origin"], {
      cwd: record.workingDir,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, HOME: "/home/magnus" },
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    child.on("error", () => resolve(null));
  });
  if (!remoteUrl || !isRemoteHostAllowed(remoteUrl, record.allowedEgressHosts)) {
    return { outcome: "failed", headCommit: record.headCommit, error: "Remote not allowed by egress policy" };
  }

  // Push only if the remote doesn't already have the exact recorded commit —
  // the other half of partial-success reconciliation (branch pushed, PR
  // creation failed).
  const remoteBranch = await runGitCapture(record.workingDir, [
    "ls-remote", "origin", `refs/heads/${record.branchName}`,
  ]);
  const remoteHeadCommit = remoteBranch.ok
    ? remoteBranch.stdout.toString("utf8").trim().split(/\s+/)[0]?.toLowerCase()
    : undefined;
  if (remoteHeadCommit !== record.headCommit) {
    const pushOk = await new Promise<boolean>((resolve) => {
      const child = spawn("git", ["push", "-u", "origin", record.branchName], {
        cwd: record.workingDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: "/home/magnus" },
      });
      child.on("close", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
    });
    if (!pushOk) {
      return { outcome: "failed", headCommit: record.headCommit, error: "git push failed" };
    }
  }

  const prUrl = await createPullRequest(
    record.workingDir,
    record.branchName,
    record.baseBranch,
    record.taskId,
    record.prBody,
  );
  if (!prUrl) {
    return { outcome: "failed", headCommit: record.headCommit, error: "gh pr create failed" };
  }

  return { outcome: "published", prUrl, headCommit: record.headCommit };
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
