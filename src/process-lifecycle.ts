import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export const DEFAULT_PROCESS_TERM_GRACE_MS = 10_000;
export const DEFAULT_PROCESS_KILL_WAIT_MS = 5_000;
const DEFAULT_PROCESS_POLL_INTERVAL_MS = 50;
const activeOwnedProcesses = new Set<OwnedProcessLifecycle>();
let ownedProcessAdmissionClosed = false;

export type OwnedProcessSignal = NodeJS.Signals;

export type ProcessCleanupResult =
  | { ok: true }
  | { ok: false; error: string };

export class OwnedProcessAdmissionClosedError extends Error {
  constructor() {
    super("Hugin shutdown has closed owned-process admission");
    this.name = "OwnedProcessAdmissionClosedError";
  }
}

function assertOwnedProcessAdmissionOpen(): void {
  if (ownedProcessAdmissionClosed) throw new OwnedProcessAdmissionClosedError();
}

/** Close process admission synchronously before shutdown snapshots active groups. */
export function closeOwnedProcessAdmission(): void {
  ownedProcessAdmissionClosed = true;
}

/** Read-only admission status for executors that launch SDK-owned children. */
export function isOwnedProcessAdmissionOpen(): boolean {
  return !ownedProcessAdmissionClosed;
}

/** A successful leader exit is not task success if its owned group could not be verified gone. */
export function exitCodeAfterCleanup(code: number | null, cleanup: ProcessCleanupResult): number {
  return cleanup.ok ? code ?? 1 : 1;
}

export interface OwnedProcessLifecycleOptions {
  termGraceMs?: number;
  killWaitMs?: number;
  pollIntervalMs?: number;
  spawnWaitMs?: number;
  /** Test seam; production signals only the POSIX group identified by child.pid. */
  signalGroup?: (pid: number, signal: OwnedProcessSignal) => void;
  /** Test seam; production probes only the POSIX group identified by child.pid. */
  probeGroup?: (pid: number) => boolean;
}

export interface ManagedOwnedProcess {
  child: ChildProcess;
  lifecycle: OwnedProcessLifecycle;
}

/** Bound the stdio-drain wait if an escaped child keeps inherited pipes open. */
export function waitForChildCloseBounded(
  child: ChildProcess,
  alreadyClosed: boolean,
  waitMs = 250,
): Promise<void> {
  if (alreadyClosed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.removeListener("close", done);
      resolve();
    };
    const timer = setTimeout(done, waitMs);
    child.once("close", done);
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function describeFailure(stage: string, error: unknown): string {
  const code = errorCode(error);
  return code ? `${stage} failed (${code})` : `${stage} failed`;
}

function defaultSignalGroup(pid: number, signal: OwnedProcessSignal): void {
  process.kill(-pid, signal);
}

function defaultProbeGroup(pid: number): boolean {
  process.kill(-pid, 0);
  return true;
}

/**
 * Owns one successfully spawned POSIX process group. The leader PID is captured
 * only from the child's successful `spawn` event. Once group disappearance is
 * observed the numeric handle is retired permanently, preventing later cleanup
 * retries from signaling it. POSIX cannot eliminate a PID-reuse race between a
 * liveness check and a signal.
 */
export class OwnedProcessLifecycle {
  private readonly termGraceMs: number;
  private readonly killWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly spawnWaitMs: number;
  private readonly signalGroup: (pid: number, signal: OwnedProcessSignal) => void;
  private readonly probeGroup: (pid: number) => boolean;
  private readonly spawned: Promise<void>;
  private resolveSpawned!: () => void;
  private spawnState: "pending" | "spawned" | "failed" = "pending";
  private terminationRequested = false;
  private pendingTerminationTimedOut = false;
  private pid: number | null = null;
  private retired = false;
  private cleanupPromise: Promise<ProcessCleanupResult> | null = null;
  private groupCleanupPromise: Promise<ProcessCleanupResult> | null = null;
  private readonly cleanupFailureListeners = new Set<(result: ProcessCleanupResult) => void>();
  private cleanupFailureResult: ProcessCleanupResult | null = null;

  constructor(
    private readonly child: ChildProcess,
    options: OwnedProcessLifecycleOptions = {},
  ) {
    assertOwnedProcessAdmissionOpen();
    this.termGraceMs = options.termGraceMs ?? DEFAULT_PROCESS_TERM_GRACE_MS;
    this.killWaitMs = options.killWaitMs ?? DEFAULT_PROCESS_KILL_WAIT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_PROCESS_POLL_INTERVAL_MS;
    this.spawnWaitMs = options.spawnWaitMs ?? 2_000;
    this.signalGroup = options.signalGroup ?? defaultSignalGroup;
    this.probeGroup = options.probeGroup ?? defaultProbeGroup;
    this.spawned = new Promise<void>((resolve) => { this.resolveSpawned = resolve; });
    // Track the launch from construction, not just after `spawn`, so shutdown
    // cannot miss a child in the small spawn-event window.
    activeOwnedProcesses.add(this);

    child.once("spawn", () => {
      this.spawnState = "spawned";
      const candidatePid = child.pid;
      if (Number.isSafeInteger(candidatePid) && candidatePid! > 1) {
        this.pid = candidatePid!;
      }
      this.resolveSpawned();
      if (this.terminationRequested && this.pendingTerminationTimedOut) {
        void this.startGroupTermination();
      }
    });
    child.once("error", () => {
      if (this.spawnState !== "pending") return;
      this.spawnState = "failed";
      activeOwnedProcesses.delete(this);
      this.cleanupFailureListeners.clear();
      this.resolveSpawned();
    });

    // A clean leader exit can still leave background descendants in the group.
    // Start cleanup at `exit`, before inherited stdio can delay `close`.
    child.once("exit", () => { void this.terminate(); });
    child.once("close", () => { void this.terminate(); });
  }

  /** Send SIGTERM synchronously, then escalate and verify group disappearance. */
  terminate(): Promise<ProcessCleanupResult> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.terminationRequested = true;
    if (this.spawnState === "spawned" && this.pid !== null) {
      this.cleanupPromise = this.startGroupTermination();
    } else {
      this.cleanupPromise = this.terminateAndVerify();
    }
    void this.cleanupPromise.then((result) => {
      if (result.ok) activeOwnedProcesses.delete(this);
      else if (this.spawnState === "failed") activeOwnedProcesses.delete(this);
      this.notifyCleanupFailure(result);
    });
    return this.cleanupPromise;
  }

  cleanup(): Promise<ProcessCleanupResult> {
    return this.terminate();
  }

  /** Let an executor settle if bounded cleanup fails before the child emits exit. */
  onCleanupFailure(listener: (result: ProcessCleanupResult) => void): () => void {
    this.cleanupFailureListeners.add(listener);
    if (this.cleanupFailureResult) {
      listener(this.cleanupFailureResult);
    } else if (this.cleanupPromise) {
      void this.cleanupPromise.then((result) => {
        if (result.ok) this.cleanupFailureListeners.delete(listener);
        else this.notifyCleanupFailure(result);
      });
    }
    return () => this.cleanupFailureListeners.delete(listener);
  }

  private notifyCleanupFailure(result: ProcessCleanupResult): void {
    if (result.ok || this.cleanupFailureResult) return;
    this.cleanupFailureResult = result;
    for (const listener of this.cleanupFailureListeners) listener(result);
    this.cleanupFailureListeners.clear();
  }

  private retire(): void {
    this.retired = true;
    this.pid = null;
  }

  private send(signal: OwnedProcessSignal): "sent" | "gone" | { failed: string } {
    if (this.retired || this.pid === null) return "gone";
    try {
      this.signalGroup(this.pid, signal);
      return "sent";
    } catch (error) {
      if (errorCode(error) === "ESRCH") {
        this.retire();
        return "gone";
      }
      return { failed: describeFailure(`Process-group ${signal}`, error) };
    }
  }

  private probe(): "present" | "gone" | { failed: string } {
    if (this.retired || this.pid === null) return "gone";
    try {
      if (!this.probeGroup(this.pid)) {
        this.retire();
        return "gone";
      }
      return "present";
    } catch (error) {
      if (errorCode(error) === "ESRCH") {
        this.retire();
        return "gone";
      }
      return { failed: describeFailure("Process-group verification", error) };
    }
  }

  private async waitUntilGone(waitMs: number): Promise<"gone" | "present" | { failed: string }> {
    const deadline = Date.now() + waitMs;
    let lastFailure: string | null = null;
    while (true) {
      const status = this.probe();
      if (status === "gone") return "gone";
      if (typeof status === "object") lastFailure = status.failed;
      if (Date.now() >= deadline) {
        return lastFailure ? { failed: lastFailure } : "present";
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now()))));
    }
  }

  private async terminateAndVerify(): Promise<ProcessCleanupResult> {
    let spawnTimer: ReturnType<typeof setTimeout> | undefined;
    const spawnedInTime = await Promise.race([
      this.spawned.then(() => true),
      new Promise<boolean>((resolve) => { spawnTimer = setTimeout(() => resolve(false), this.spawnWaitMs); }),
    ]);
    if (spawnTimer) clearTimeout(spawnTimer);
    if (!spawnedInTime && this.spawnState === "pending") {
      this.pendingTerminationTimedOut = true;
      return { ok: false, error: `Owned child did not report spawn or error within ${this.spawnWaitMs}ms` };
    }
    if (this.spawnState === "failed") return { ok: true };
    if (this.pid === null) return { ok: false, error: "Owned process group unavailable after successful spawn" };

    return this.startGroupTermination();
  }

  private startGroupTermination(): Promise<ProcessCleanupResult> {
    if (this.groupCleanupPromise) return this.groupCleanupPromise;
    const term = this.send("SIGTERM");
    this.groupCleanupPromise = this.finishAfterTerm(term);
    void this.groupCleanupPromise.then((result) => {
      if (result.ok) {
        activeOwnedProcesses.delete(this);
        this.cleanupFailureListeners.clear();
      }
      this.notifyCleanupFailure(result);
    });
    return this.groupCleanupPromise;
  }

  private async finishAfterTerm(term: "sent" | "gone" | { failed: string }): Promise<ProcessCleanupResult> {
    if (term === "gone") return { ok: true };
    const termResult = await this.waitUntilGone(this.termGraceMs);
    if (termResult === "gone") return { ok: true };

    const kill = this.send("SIGKILL");
    if (kill === "gone") return { ok: true };
    const killResult = await this.waitUntilGone(this.killWaitMs);
    if (killResult === "gone") return { ok: true };

    const failure = typeof killResult === "object"
      ? killResult.failed
      : typeof termResult === "object"
        ? termResult.failed
        : kill && typeof kill === "object"
          ? kill.failed
          : term && typeof term === "object"
            ? term.failed
            : `Owned process group remained after SIGKILL verification window (${this.killWaitMs}ms)`;
    return { ok: false, error: failure };
  }
}

export function createOwnedProcessLifecycle(
  child: ChildProcess,
  options?: OwnedProcessLifecycleOptions,
): OwnedProcessLifecycle {
  return new OwnedProcessLifecycle(child, options);
}

/** Stop every Hugin-owned process group before dispatcher shutdown completes. */
export async function terminateAllOwnedProcesses(): Promise<ProcessCleanupResult[]> {
  closeOwnedProcessAdmission();
  return Promise.all([...activeOwnedProcesses].map((lifecycle) => lifecycle.terminate()));
}

/** Start termination before invoking an external write whose latency is not owned here. */
export function terminateBeforePersistence(
  lifecycle: OwnedProcessLifecycle,
  persist: () => Promise<unknown>,
  onPersistenceError: (error: unknown) => void,
): Promise<void> {
  void lifecycle.terminate();
  try {
    return Promise.resolve(persist()).then(() => undefined).catch((error: unknown) => {
      onPersistenceError(error);
    });
  } catch (error) {
    onPersistenceError(error);
    return Promise.resolve();
  }
}

/** Bound waiting for persistence; callers must ensure a late write cannot overwrite terminal state. */
export async function waitForPersistenceBounded(
  persistence: Promise<unknown>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.resolve(persistence).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        onTimeout();
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Spawn an executable in a fresh POSIX session/process group owned by Hugin. */
export function spawnOwnedProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  lifecycleOptions?: OwnedProcessLifecycleOptions,
): ManagedOwnedProcess {
  assertOwnedProcessAdmissionOpen();
  if (process.platform === "win32") {
    throw new Error("Owned process-group execution requires POSIX support");
  }
  const child = spawn(command, [...args], { ...options, detached: true });
  return { child, lifecycle: new OwnedProcessLifecycle(child, lifecycleOptions) };
}

export const __test__ = {
  defaultSignalGroup,
  defaultProbeGroup,
  resetOwnedProcessAdmission: () => { ownedProcessAdmissionClosed = false; },
};
