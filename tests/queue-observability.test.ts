import { describe, expect, it } from "vitest";
import type { MuninQueryResult } from "../src/munin-client.js";
import {
  buildQueueObservabilityFields,
  QUEUE_TRUNCATION_WARNING_INTERVAL_MS,
  shouldWarnQueueTruncation,
  snapshotPendingQueue,
  snapshotPendingQueueAfterClaim,
} from "../src/queue-observability.js";

function makeEntry(
  namespace: string,
  createdAt: string,
  key: string = "status",
): MuninQueryResult {
  return {
    id: `id-${namespace}-${key}`,
    namespace,
    key,
    entry_type: "state",
    content_preview: "must not appear in observability",
    tags: ["pending"],
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe("pending queue observability", () => {
  it("projects content-blind pending count and advancing oldest age", () => {
    const snapshot = snapshotPendingQueue([
      makeEntry("tasks/newer", "2026-07-21T20:04:00.000Z"),
      makeEntry("tasks/oldest", "2026-07-21T20:00:00.000Z"),
      makeEntry("tasks/oldest", "2026-07-21T19:00:00.000Z", "result"),
    ], false);

    expect(buildQueueObservabilityFields(
      snapshot,
      Date.parse("2026-07-21T20:05:00.000Z"),
    )).toEqual({
      queue_depth: 2,
      queue_depth_lower_bound: 2,
      oldest_pending_age_s: 300,
      pagination_truncated: false,
    });
  });

  it("reports an empty queue with zero age", () => {
    const snapshot = snapshotPendingQueue([], false);

    expect(buildQueueObservabilityFields(snapshot, Date.now())).toEqual({
      queue_depth: 0,
      queue_depth_lower_bound: 0,
      oldest_pending_age_s: 0,
      pagination_truncated: false,
    });
  });

  it("removes an accepted claim from the live pending count and oldest age", () => {
    const oldest = makeEntry("tasks/oldest", "2026-07-21T20:00:00.000Z");
    const remaining = makeEntry("tasks/remaining", "2026-07-21T20:04:00.000Z");

    const snapshot = snapshotPendingQueueAfterClaim(
      [oldest, remaining],
      false,
      oldest.namespace,
    );

    expect(buildQueueObservabilityFields(
      snapshot,
      Date.parse("2026-07-21T20:05:00.000Z"),
    )).toMatchObject({
      queue_depth: 1,
      oldest_pending_age_s: 60,
    });
  });

  it("marks the visible pending count as a lower bound when pagination truncates", () => {
    const snapshot = snapshotPendingQueue([
      makeEntry("tasks/visible", "2026-07-21T20:00:00.000Z"),
    ], true);

    expect(buildQueueObservabilityFields(
      snapshot,
      Date.parse("2026-07-21T20:00:01.000Z"),
    )).toMatchObject({
      queue_depth: 1,
      queue_depth_lower_bound: 1,
      oldest_pending_age_s: 1,
      pagination_truncated: true,
    });
  });

  it("rate-limits warnings while an overflowing timestamp bucket persists", () => {
    const firstWarningAt = Date.parse("2026-07-21T20:00:00.000Z");

    expect(shouldWarnQueueTruncation(true, firstWarningAt, null)).toBe(true);
    expect(shouldWarnQueueTruncation(
      true,
      firstWarningAt + QUEUE_TRUNCATION_WARNING_INTERVAL_MS - 1,
      firstWarningAt,
    )).toBe(false);
    expect(shouldWarnQueueTruncation(
      true,
      firstWarningAt + QUEUE_TRUNCATION_WARNING_INTERVAL_MS,
      firstWarningAt,
    )).toBe(true);
    expect(shouldWarnQueueTruncation(false, firstWarningAt, null)).toBe(false);
  });
});
