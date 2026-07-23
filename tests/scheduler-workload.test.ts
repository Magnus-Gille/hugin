import { describe, expect, it } from "vitest";
import {
  buildSchedulerWorkloadSnapshot,
  schedulerWorkloadSnapshotSchema,
  type SchedulerWorkloadBucketKey,
} from "../src/scheduler-workload.js";

const observedAt = "2026-07-23T08:00:00.000Z";
const completeBuckets = {
  dispatchable: true,
  groupBlocked: true,
  pipelineBlocked: true,
  approvalGated: true,
  otherNonterminal: true,
  runningRemaining: true,
};

function estimate(seconds: number, historyThrough = "2026-07-23T07:59:00.000Z") {
  return {
    seconds,
    estimatorVersion: "scheduler-duration-v1",
    serviceClock: "claim-to-release-v1",
    source: "verified-terminal-history",
    sampleCount: 3,
    historyThrough,
    historyThroughDecisionId: "34f2d430-6c31-47de-860a-8b22bc97f4d4",
  };
}

function item(
  suffix: string,
  buckets: SchedulerWorkloadBucketKey[],
  serviceEstimate: unknown | null,
  runningElapsedSeconds?: number,
) {
  return {
    taskRef: {
      namespace: `tasks/20260723-080000-${suffix}`,
      key: "status" as const,
    },
    buckets,
    serviceEstimate,
    ...(runningElapsedSeconds === undefined ? {} : { runningElapsedSeconds }),
  };
}

describe("scheduler work-minute snapshots", () => {
  it("keeps overlapping diagnostic buckets but deduplicates possible total work", () => {
    const snapshot = buildSchedulerWorkloadSnapshot({
      observedAt,
      bucketEnumerationComplete: completeBuckets,
      items: [
        item("aaaa", ["dispatchable", "approvalGated"], estimate(120)),
        item("bbbb", ["groupBlocked"], estimate(60)),
      ],
    });

    expect(snapshot.buckets.dispatchable).toEqual({
      taskCount: 1,
      knownWorkMinutes: 2,
      estimatedWorkMinutes: 2,
      missingEstimates: 0,
      enumerationComplete: true,
    });
    expect(snapshot.buckets.approvalGated.estimatedWorkMinutes).toBe(2);
    expect(snapshot.buckets.groupBlocked.estimatedWorkMinutes).toBe(1);
    expect(snapshot.possibleTotalWork).toEqual({
      taskCount: 2,
      knownWorkMinutes: 3,
      estimatedWorkMinutes: 3,
      missingEstimates: 0,
      enumerationComplete: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("tasks/");
  });

  it("retains a known lower bound but refuses a total for missing or truncated evidence", () => {
    const snapshot = buildSchedulerWorkloadSnapshot({
      observedAt,
      bucketEnumerationComplete: {
        ...completeBuckets,
        dispatchable: false,
      },
      items: [
        item("aaaa", ["dispatchable"], estimate(120)),
        item("bbbb", ["dispatchable"], null),
      ],
    });

    expect(snapshot.buckets.dispatchable).toEqual({
      taskCount: 2,
      knownWorkMinutes: 2,
      estimatedWorkMinutes: null,
      missingEstimates: 1,
      enumerationComplete: false,
    });
    expect(snapshot.possibleTotalWork).toEqual({
      taskCount: 2,
      knownWorkMinutes: 2,
      estimatedWorkMinutes: null,
      missingEstimates: 1,
      enumerationComplete: false,
    });
  });

  it("uses running remainder, rejects future estimates, and fails duplicate conflicts closed", () => {
    const snapshot = buildSchedulerWorkloadSnapshot({
      observedAt,
      bucketEnumerationComplete: completeBuckets,
      items: [
        item("aaaa", ["runningRemaining"], estimate(120), 30),
        item(
          "bbbb",
          ["otherNonterminal"],
          estimate(60, "2026-07-23T08:01:00.000Z"),
        ),
        item("cccc", ["dispatchable"], estimate(60)),
        item("cccc", ["approvalGated"], estimate(120)),
      ],
    });

    expect(snapshot.buckets.runningRemaining).toMatchObject({
      taskCount: 1,
      knownWorkMinutes: 1.5,
      estimatedWorkMinutes: 1.5,
      missingEstimates: 0,
    });
    expect(snapshot.buckets.otherNonterminal).toMatchObject({
      knownWorkMinutes: 0,
      estimatedWorkMinutes: null,
      missingEstimates: 1,
    });
    expect(snapshot.buckets.dispatchable).toMatchObject({
      taskCount: 1,
      knownWorkMinutes: 0,
      estimatedWorkMinutes: null,
      missingEstimates: 1,
    });
    expect(snapshot.buckets.approvalGated).toMatchObject({
      taskCount: 1,
      knownWorkMinutes: 0,
      estimatedWorkMinutes: null,
      missingEstimates: 1,
    });
    expect(snapshot.possibleTotalWork).toMatchObject({
      taskCount: 3,
      knownWorkMinutes: 1.5,
      estimatedWorkMinutes: null,
      missingEstimates: 2,
    });
  });

  it("rejects malformed clocks and contradictory complete totals", () => {
    expect(() => buildSchedulerWorkloadSnapshot({
      observedAt,
      bucketEnumerationComplete: completeBuckets,
      items: [
        item("aaaa", ["runningRemaining"], estimate(60), -1),
      ],
    })).toThrow();

    const valid = buildSchedulerWorkloadSnapshot({
      observedAt,
      bucketEnumerationComplete: completeBuckets,
      items: [item("aaaa", ["dispatchable"], estimate(60))],
    });
    expect(() => schedulerWorkloadSnapshotSchema.parse({
      ...valid,
      possibleTotalWork: {
        ...valid.possibleTotalWork,
        missingEstimates: 1,
        estimatedWorkMinutes: 1,
      },
    })).toThrow(/estimated total requires complete enumeration and estimates/);
  });
});
