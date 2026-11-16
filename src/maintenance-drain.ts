/**
 * Maintenance drain (HUGIN-417).
 *
 * A small in-memory admission gate that lets an owner-invoked deploy adapter
 * stop the dispatcher from *starting* new work before a service restart,
 * without cancelling anything already admitted.
 *
 * Invariants:
 * - Closing admission is synchronous. Node is single threaded, so a unit of work
 *   (a dispatcher loop iteration, or a reaper pass that can touch tasks) that
 *   called `tryEnterWork()` before the close is "in flight" and finishes; every
 *   later call is refused. No executor can start after the close is accepted.
 *   Gating whole iterations (not just the claim write) also keeps multi-write
 *   terminalisation/reconcile sequences from being cut by a restart.
 * - Drain never cancels, fails or replays work. `ready` is only true once no
 *   claim is in flight and no task is current.
 * - The gate is a bounded lease, never a latch: it reopens when the hold
 *   expires (total hold is capped across repeated requests until work is
 *   admitted again), on explicit resume, and on process restart (state is not
 *   persisted). A vanished deploy adapter therefore cannot wedge the queue.
 * - It is purely a claim gate. It does not read or write autonomy/arming state.
 */

export const DEFAULT_HOLD_MS = 15 * 60_000;
export const MAX_HOLD_MS = 60 * 60_000;
export const MAX_WAIT_MS = 10 * 60_000;

export type MaintenanceState = "open" | "draining";

export interface MaintenanceSnapshot {
  state: MaintenanceState;
  /** True only when draining and nothing is claiming or executing. */
  ready: boolean;
  work_in_flight: number;
  current_task: string | null;
  drain_requested_at: string | null;
  hold_expires_at: string | null;
}

export class MaintenanceDrain {
  private draining = false;
  private workInFlight = 0;
  private requestedAtMs: number | null = null;
  private holdExpiresAtMs: number | null = null;
  /** Start of the current uninterrupted drain chain (survives lease expiry; see requestDrain). */
  private chainStartMs: number | null = null;

  constructor(
    private readonly getCurrentTask: () => string | null,
    private readonly now: () => number = Date.now,
    /** Other activity that must also be quiescent (e.g. a delivery reconcile). */
    private readonly extraBusy: () => boolean = () => false,
  ) {}

  /** Lazily reopen once the hold lease has expired. */
  private expireIfDue(): void {
    if (this.draining && this.holdExpiresAtMs !== null && this.now() >= this.holdExpiresAtMs) {
      this.reopen();
    }
  }

  private reopen(): void {
    this.draining = false;
    this.requestedAtMs = null;
    this.holdExpiresAtMs = null;
  }

  /**
   * Close admission (idempotent). Re-requesting extends the lease but never
   * beyond MAX_HOLD_MS from the first request, so repeated calls cannot wedge
   * the queue indefinitely.
   */
  requestDrain(holdMs: number = DEFAULT_HOLD_MS): MaintenanceSnapshot {
    this.expireIfDue();
    const bounded = Math.min(Math.max(1, Math.floor(holdMs)), MAX_HOLD_MS);
    if (this.chainStartMs === null) this.chainStartMs = this.now();
    // The cap is measured from the start of the chain, which survives lease
    // expiry and is only reset by an explicit resume or by work actually being
    // admitted. Periodic drain calls therefore cannot starve the queue: once
    // the cap is spent the request is refused until work has run again.
    const expires = Math.min(this.now() + bounded, this.chainStartMs + MAX_HOLD_MS);
    if (expires <= this.now()) return this.snapshot();
    if (!this.draining) this.requestedAtMs = this.now();
    this.draining = true;
    this.holdExpiresAtMs = expires;
    return this.snapshot();
  }

  /** Reopen admission. Never touches running work. */
  resume(): MaintenanceSnapshot {
    this.reopen();
    this.chainStartMs = null;
    return this.snapshot();
  }

  isDraining(): boolean {
    this.expireIfDue();
    return this.draining;
  }

  /** Call before any unit of work that may claim/execute/reconcile tasks; pair with `leaveWork`. */
  tryEnterWork(): boolean {
    this.expireIfDue();
    if (this.draining) return false;
    this.workInFlight++;
    // Admission was observed open: a new drain starts a fresh hold chain.
    this.chainStartMs = null;
    return true;
  }

  leaveWork(): void {
    if (this.workInFlight > 0) this.workInFlight--;
  }

  snapshot(): MaintenanceSnapshot {
    this.expireIfDue();
    const currentTask = this.getCurrentTask();
    return {
      state: this.draining ? "draining" : "open",
      ready:
        this.draining && this.workInFlight === 0 && currentTask === null && !this.extraBusy(),
      work_in_flight: this.workInFlight,
      current_task: currentTask,
      drain_requested_at: this.requestedAtMs === null ? null : new Date(this.requestedAtMs).toISOString(),
      hold_expires_at: this.holdExpiresAtMs === null ? null : new Date(this.holdExpiresAtMs).toISOString(),
    };
  }

  /**
   * Wait until ready or `timeoutMs` elapses. Returns the final snapshot; a
   * timeout is reported by `ready === false` and cancels nothing.
   */
  async waitUntilReady(
    timeoutMs: number,
    pollMs = 250,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ): Promise<MaintenanceSnapshot> {
    const deadline = this.now() + Math.min(Math.max(0, timeoutMs), MAX_WAIT_MS);
    let snap = this.snapshot();
    while (!snap.ready && snap.state === "draining" && this.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(1, deadline - this.now())));
      snap = this.snapshot();
    }
    return snap;
  }
}

/**
 * Run `work` as admitted work. Returns `{ admitted: false }` without invoking
 * `work` when admission is closed; otherwise the unit is counted in flight until
 * it settles (including on throw).
 */
export async function runAdmitted<T>(
  drain: MaintenanceDrain,
  work: () => Promise<T>,
): Promise<{ admitted: false } | { admitted: true; value: T }> {
  if (!drain.tryEnterWork()) return { admitted: false };
  try {
    return { admitted: true, value: await work() };
  } finally {
    drain.leaveWork();
  }
}
