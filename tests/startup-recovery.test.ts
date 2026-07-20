import { describe, it, expect } from "vitest";
import { decideStartupRecovery } from "../src/task-helpers.js";

// Regression coverage for issue #77 (crash mid-delivery: orphaned
// delivery:pending never auto-reconciles). The fix makes the dispatcher's
// worker identity HOST-stable (no PID), so a restarted process recognises the
// dead incarnation's in-flight tasks as "ours" and reconciles them at startup
// instead of skipping while the dead worker's lease is still live.

const HOST_WORKER = "hugin-hugin-node"; // host-stable id (post-#77)
const OLD_PID_WORKER = "hugin-hugin-node-221281"; // pre-#77 PID-derived id
const FOREIGN_WORKER = "hugin-otherhost"; // a genuinely different live worker
const NOW = 1_700_000_000_000;

function tags(opts: {
  claimedBy?: string;
  leaseExpiresMs?: number | null;
  deliveryPending?: boolean;
}): string[] {
  const t = ["running", "runtime:claude"];
  if (opts.claimedBy) t.push(`claimed_by:${opts.claimedBy}`);
  if (opts.leaseExpiresMs != null) t.push(`lease_expires:${opts.leaseExpiresMs}`);
  if (opts.deliveryPending) t.push("delivery:pending");
  return t;
}

describe("decideStartupRecovery (#77 liveness)", () => {
  it("THE #77 FIX: a delivery:pending checkpoint left by our own crashed incarnation, with a still-live lease, reconciles (does NOT skip)", () => {
    // Post-fix, a claim writes the HOST-stable id (`hugin-hugin-node`, no PID).
    // After kill -9 + systemd restart the new process has the SAME workerId, so
    // isOurs=true and — even though the dead worker's lease is still live
    // (RestartSec 10s « lease 120s) — the gate falls through to reconcile.
    const decision = decideStartupRecovery({
      tags: tags({
        claimedBy: HOST_WORKER, // dead incarnation, host-stable id
        leaseExpiresMs: NOW + 108_000, // lease still live
        deliveryPending: true,
      }),
      workerId: HOST_WORKER,
      now: NOW,
    });
    expect(decision.action).toBe("reconcile-delivery");
    expect(decision.isOurs).toBe(true);
    expect(decision.leaseExpired).toBe(false);
  });

  it("documents the OLD #77 BUG: a PID-derived id differs from the restarted process, so a still-live-leased delivery:pending was skipped (stranded)", () => {
    // Pre-fix, the dead incarnation's tag was `claimed_by:hugin-hugin-node-221281`
    // and the restarted process had a NEW pid → a different workerId. isOurs=false
    // + lease still live → "skip". The reaper also skipped delivery:pending, so
    // the task was orphaned until a 2nd, post-expiry restart. Simulated here with
    // mismatched ids to lock in why the host-stable id was necessary.
    const decision = decideStartupRecovery({
      tags: tags({
        claimedBy: OLD_PID_WORKER, // hugin-hugin-node-221281
        leaseExpiresMs: NOW + 108_000,
        deliveryPending: true,
      }),
      workerId: "hugin-hugin-node-559300", // restarted process, new pid
      now: NOW,
    });
    expect(decision.action).toBe("skip");
    expect(decision.isOurs).toBe(false);
  });

  it("reconciles our own delivery:pending checkpoint even when the lease has expired", () => {
    const decision = decideStartupRecovery({
      tags: tags({
        claimedBy: HOST_WORKER,
        leaseExpiresMs: NOW - 5_000,
        deliveryPending: true,
      }),
      workerId: HOST_WORKER,
      now: NOW,
    });
    expect(decision.action).toBe("reconcile-delivery");
  });

  it("recovers our own non-delivery task as failed (dispatcher restart)", () => {
    const decision = decideStartupRecovery({
      tags: tags({ claimedBy: HOST_WORKER, leaseExpiresMs: NOW + 60_000 }),
      workerId: HOST_WORKER,
      now: NOW,
    });
    expect(decision.action).toBe("recover-failed");
    expect(decision.isOurs).toBe(true);
  });

  it("recovers a legacy unclaimed task (no claimed_by, no lease) as failed", () => {
    const decision = decideStartupRecovery({
      tags: tags({}),
      workerId: HOST_WORKER,
      now: NOW,
    });
    expect(decision.action).toBe("recover-failed");
    expect(decision.isOurs).toBe(true); // claimedBy === null → treated as ours
    expect(decision.claimedBy).toBeNull();
  });

  it("SKIPS a task owned by a genuinely different live worker (lease still valid)", () => {
    const decision = decideStartupRecovery({
      tags: tags({ claimedBy: FOREIGN_WORKER, leaseExpiresMs: NOW + 60_000 }),
      workerId: HOST_WORKER,
      now: NOW,
    });
    expect(decision.action).toBe("skip");
    expect(decision.isOurs).toBe(false);
  });

  it("recovers a foreign worker's task once its lease has expired", () => {
    const decision = decideStartupRecovery({
      tags: tags({ claimedBy: FOREIGN_WORKER, leaseExpiresMs: NOW - 1_000 }),
      workerId: HOST_WORKER,
      now: NOW,
    });
    expect(decision.action).toBe("recover-failed");
    expect(decision.leaseExpired).toBe(true);
  });

  it("reconciles a foreign worker's expired delivery:pending checkpoint (cross-host crash)", () => {
    const decision = decideStartupRecovery({
      tags: tags({
        claimedBy: FOREIGN_WORKER,
        leaseExpiresMs: NOW - 1_000,
        deliveryPending: true,
      }),
      workerId: HOST_WORKER,
      now: NOW,
    });
    expect(decision.action).toBe("reconcile-delivery");
  });
});
