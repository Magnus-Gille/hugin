import { describe, it, expect } from "vitest";
import { shouldReapExpiredLease } from "../src/task-helpers.js";

const NS = "tasks/20260416-100000-a3f1";
const OTHER_WORKER = "hugin-other-pid-42";
const NOW = 1_700_000_000_000;

function tagsWithLease(expiresAtMs: number, claimedBy = OTHER_WORKER): string[] {
  return [
    "running",
    "runtime:claude",
    `claimed_by:${claimedBy}`,
    `lease_expires:${expiresAtMs}`,
  ];
}

describe("shouldReapExpiredLease", () => {
  it("reaps when lease expired by more than a second", () => {
    const decision = shouldReapExpiredLease({
      tags: tagsWithLease(NOW - 5_000),
      namespace: NS,
      currentTask: null,
      now: NOW,
    });
    expect(decision.reap).toBe(true);
    expect(decision.claimedBy).toBe(OTHER_WORKER);
    expect(decision.leaseExpires).toBe(NOW - 5_000);
    expect(decision.expiredByMs).toBe(5_000);
    expect(decision.skipReason).toBe("");
  });

  it("does not reap when lease is still valid", () => {
    const decision = shouldReapExpiredLease({
      tags: tagsWithLease(NOW + 30_000),
      namespace: NS,
      currentTask: null,
      now: NOW,
    });
    expect(decision.reap).toBe(false);
    expect(decision.skipReason).toBe("lease-valid");
  });

  it("does not reap when lease expires exactly now", () => {
    const decision = shouldReapExpiredLease({
      tags: tagsWithLease(NOW),
      namespace: NS,
      currentTask: null,
      now: NOW,
    });
    expect(decision.reap).toBe(false);
    expect(decision.skipReason).toBe("lease-valid");
  });

  it("skips the currently-executing task on this worker", () => {
    const decision = shouldReapExpiredLease({
      tags: tagsWithLease(NOW - 60_000, "hugin-self-pid-1"),
      namespace: NS,
      currentTask: NS,
      now: NOW,
    });
    expect(decision.reap).toBe(false);
    expect(decision.skipReason).toBe("currently-executing");
  });

  it("skips tasks missing lease metadata (legacy)", () => {
    const decision = shouldReapExpiredLease({
      tags: ["running", "runtime:claude"],
      namespace: NS,
      currentTask: null,
      now: NOW,
    });
    expect(decision.reap).toBe(false);
    expect(decision.leaseExpires).toBeNull();
    expect(decision.claimedBy).toBeNull();
    expect(decision.skipReason).toBe("no-lease-metadata");
  });

  it("skips tasks with a malformed lease_expires tag", () => {
    const decision = shouldReapExpiredLease({
      tags: [
        "running",
        "runtime:claude",
        "claimed_by:hugin-x",
        "lease_expires:not-a-timestamp",
      ],
      namespace: NS,
      currentTask: null,
      now: NOW,
    });
    expect(decision.reap).toBe(false);
    expect(decision.leaseExpires).toBeNull();
    expect(decision.skipReason).toBe("no-lease-metadata");
  });

  it("accepts ISO 8601 lease_expires values (legacy tag format)", () => {
    const expires = new Date(NOW - 10_000).toISOString();
    const decision = shouldReapExpiredLease({
      tags: [
        "running",
        "runtime:claude",
        `claimed_by:${OTHER_WORKER}`,
        `lease_expires:${expires}`,
      ],
      namespace: NS,
      currentTask: null,
      now: NOW,
    });
    expect(decision.reap).toBe(true);
    expect(decision.leaseExpires).toBe(NOW - 10_000);
    expect(decision.expiredByMs).toBe(10_000);
  });

  it("reaps foreign-worker tasks with expired leases", () => {
    const decision = shouldReapExpiredLease({
      tags: tagsWithLease(NOW - 120_000, "hugin-dead-worker"),
      namespace: NS,
      currentTask: "tasks/other-task-running-here",
      now: NOW,
    });
    expect(decision.reap).toBe(true);
    expect(decision.claimedBy).toBe("hugin-dead-worker");
  });

  it("reaps our own expired tasks if we're no longer running them", () => {
    // Self-owned namespace but we've moved on to a different task: means this
    // one crashed without cleaning up. Should be reaped.
    const decision = shouldReapExpiredLease({
      tags: tagsWithLease(NOW - 1_000, "hugin-self"),
      namespace: NS,
      currentTask: "tasks/different-task",
      now: NOW,
    });
    expect(decision.reap).toBe(true);
  });
});
