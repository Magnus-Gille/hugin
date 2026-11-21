import { describe, expect, it } from "vitest";
import { MaintenanceDrain, MAX_HOLD_MS } from "../src/maintenance-drain.js";

function make() {
  let t = 1_000_000;
  let current: string | null = null;
  const d = new MaintenanceDrain(() => current, () => t);
  return {
    d,
    advance: (ms: number) => { t += ms; },
    setCurrent: (v: string | null) => { current = v; },
  };
}

describe("MaintenanceDrain", () => {
  it("starts open and admits claims", () => {
    const { d } = make();
    expect(d.tryEnterWork()).toBe(true);
    d.leaveWork();
    expect(d.snapshot().state).toBe("open");
    expect(d.snapshot().ready).toBe(false);
  });

  it("refuses every claim after drain acceptance, while an earlier claim is allowed to finish", () => {
    const { d, setCurrent } = make();
    expect(d.tryEnterWork()).toBe(true); // claim in flight before drain
    const snap = d.requestDrain();
    expect(snap.state).toBe("draining");
    expect(snap.ready).toBe(false); // busy: claim in flight
    expect(d.tryEnterWork()).toBe(false); // no new claim after acceptance
    setCurrent("tasks/a"); // the in-flight claim became the current task
    d.leaveWork();
    expect(d.snapshot().ready).toBe(false); // still busy: task running
    setCurrent(null);
    expect(d.snapshot().ready).toBe(true);
  });

  it("is ready immediately when idle", () => {
    const { d } = make();
    expect(d.requestDrain().ready).toBe(true);
  });

  it("reopens on resume and on hold expiry; hold is bounded", () => {
    const { d, advance } = make();
    d.requestDrain(10 * MAX_HOLD_MS);
    expect(d.snapshot().hold_expires_at).toBe(new Date(1_000_000 + MAX_HOLD_MS).toISOString());
    advance(MAX_HOLD_MS);
    expect(d.isDraining()).toBe(false);
    expect(d.tryEnterWork()).toBe(true);
    d.leaveWork();
    d.requestDrain();
    expect(d.resume().state).toBe("open");
  });

  it("repeated drain calls cannot hold admission past the cap, even across lease expiry", () => {
    const { d, advance } = make();
    d.requestDrain(MAX_HOLD_MS);
    advance(MAX_HOLD_MS - 1000);
    const again = d.requestDrain(MAX_HOLD_MS);
    expect(again.hold_expires_at).toBe(new Date(1_000_000 + MAX_HOLD_MS).toISOString());
    advance(1000);
    expect(d.isDraining()).toBe(false);
    // A periodic caller re-draining at expiry is refused until work has run.
    expect(d.requestDrain().state).toBe("open");
    expect(d.tryEnterWork()).toBe(true);
    d.leaveWork();
    expect(d.requestDrain().state).toBe("draining");
  });

  it("is not ready while extra activity (e.g. delivery reconcile) is busy", () => {
    let busy = true;
    const d = new MaintenanceDrain(() => null, () => 1, () => busy);
    expect(d.requestDrain().ready).toBe(false);
    busy = false;
    expect(d.snapshot().ready).toBe(true);
  });

  it("re-requesting extends the lease without resetting the request time", () => {
    const { d, advance } = make();
    const first = d.requestDrain(1000);
    advance(500);
    const second = d.requestDrain(1000);
    expect(second.drain_requested_at).toBe(first.drain_requested_at);
    expect(second.hold_expires_at).not.toBe(first.hold_expires_at);
  });

  it("waitUntilReady reports busy on timeout and never cancels", async () => {
    const { d, setCurrent, advance } = make();
    setCurrent("tasks/busy");
    d.requestDrain();
    const snap = await d.waitUntilReady(1000, 100, async (ms) => advance(ms));
    expect(snap.ready).toBe(false);
    expect(snap.state).toBe("draining");
    expect(snap.current_task).toBe("tasks/busy");
  });

  it("waitUntilReady returns as soon as the task finishes", async () => {
    const { d, setCurrent, advance } = make();
    setCurrent("tasks/x");
    d.requestDrain();
    let n = 0;
    const snap = await d.waitUntilReady(10_000, 100, async (ms) => {
      advance(ms);
      if (++n === 3) setCurrent(null);
    });
    expect(snap.ready).toBe(true);
  });
});

import { runAdmitted } from "../src/maintenance-drain.js";

describe("runAdmitted (claim racing a drain)", () => {
  it("lets an in-flight unit finish, then refuses new work without invoking it", async () => {
    const { d, setCurrent } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let executorsStarted = 0;

    // A dispatcher iteration is mid-claim when the drain is accepted.
    const inFlight = runAdmitted(d, async () => {
      await gate;
      executorsStarted++; // the already-admitted claim completes and starts its task
      setCurrent("tasks/admitted");
    });
    const snap = d.requestDrain();
    expect(snap.ready).toBe(false);

    // Anything arriving after acceptance never starts an executor.
    const late = await runAdmitted(d, async () => { executorsStarted++; });
    expect(late).toEqual({ admitted: false });

    release();
    await inFlight;
    expect(executorsStarted).toBe(1);
    expect(d.snapshot().ready).toBe(false); // admitted task still running: busy, not cancelled
    expect(d.snapshot().current_task).toBe("tasks/admitted");
    setCurrent(null);
    expect(d.snapshot().ready).toBe(true);
  });

  it("releases the in-flight count when the unit throws", async () => {
    const { d } = make();
    await expect(runAdmitted(d, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(d.requestDrain().ready).toBe(true);
  });
});
