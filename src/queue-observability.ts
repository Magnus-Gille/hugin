import type { MuninQueryResult } from "./munin-client.js";

export const QUEUE_TRUNCATION_WARNING_INTERVAL_MS = 5 * 60 * 1000;

export interface PendingQueueSnapshot {
  pendingCount: number;
  /** undefined means empty; null means a pending row had an invalid timestamp. */
  oldestPendingCreatedAt?: string | null;
  paginationTruncated: boolean;
}

export interface QueueObservabilityFields {
  queue_depth: number;
  queue_depth_lower_bound: number;
  oldest_pending_age_s: number | null;
  pagination_truncated: boolean;
}

export function shouldWarnQueueTruncation(
  paginationTruncated: boolean,
  nowMs: number,
  lastWarningAtMs: number | null,
): boolean {
  if (!paginationTruncated) return false;
  return lastWarningAtMs === null ||
    nowMs - lastWarningAtMs >= QUEUE_TRUNCATION_WARNING_INTERVAL_MS;
}

export function snapshotPendingQueue(
  results: MuninQueryResult[],
  paginationTruncated: boolean,
): PendingQueueSnapshot {
  const pending = results.filter((result) => result.key === "status");
  let oldestPendingCreatedAt: string | undefined;
  let oldestEpochMs = Number.POSITIVE_INFINITY;

  for (const result of pending) {
    const epochMs = Date.parse(result.created_at);
    if (!Number.isFinite(epochMs)) {
      return {
        pendingCount: pending.length,
        oldestPendingCreatedAt: null,
        paginationTruncated,
      };
    }
    if (epochMs < oldestEpochMs) {
      oldestEpochMs = epochMs;
      oldestPendingCreatedAt = result.created_at;
    }
  }

  return {
    pendingCount: pending.length,
    ...(oldestPendingCreatedAt ? { oldestPendingCreatedAt } : {}),
    paginationTruncated,
  };
}

export function snapshotPendingQueueAfterClaim(
  results: MuninQueryResult[],
  paginationTruncated: boolean,
  claimedNamespace: string,
): PendingQueueSnapshot {
  return snapshotPendingQueue(
    results.filter((result) =>
      result.key !== "status" || result.namespace !== claimedNamespace
    ),
    paginationTruncated,
  );
}

export function buildQueueObservabilityFields(
  snapshot: PendingQueueSnapshot,
  nowMs: number = Date.now(),
): QueueObservabilityFields {
  let oldestPendingAgeSeconds: number | null = 0;
  if (snapshot.oldestPendingCreatedAt === null) {
    oldestPendingAgeSeconds = null;
  } else if (snapshot.oldestPendingCreatedAt !== undefined) {
    oldestPendingAgeSeconds = Math.max(
      0,
      Math.floor((nowMs - Date.parse(snapshot.oldestPendingCreatedAt)) / 1000),
    );
  }

  return {
    queue_depth: snapshot.pendingCount,
    queue_depth_lower_bound: snapshot.pendingCount,
    oldest_pending_age_s: oldestPendingAgeSeconds,
    pagination_truncated: snapshot.paginationTruncated,
  };
}
