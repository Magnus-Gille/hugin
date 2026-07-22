import { describe, expect, it } from "vitest";
import {
  buildRollingMedianDurationEstimate,
  buildCompleteSchedulerServiceClock,
  hashSchedulerOutcome,
  hashSchedulerPrediction,
  schedulerDecisionOutcomeSchema,
  schedulerDecisionPredictionSchema,
  schedulerServiceClockEvidenceSchema,
} from "../src/scheduler-evidence.js";

const taskRef = { namespace: "tasks/20260722-230000-abcd", key: "status" as const };
const decisionId = "34f2d430-6c31-47de-860a-8b22bc97f4d4";

function estimate(seconds: number, historyThrough = "2026-07-22T20:00:00.000Z") {
  return {
    seconds,
    estimatorVersion: "scheduler-duration-v1",
    serviceClock: "claim-to-release-v1",
    source: "verified-terminal-history",
    sampleCount: 4,
    historyThrough,
    historyThroughDecisionId: "12953e2e-dfb0-44eb-abda-2725d12fa2fa",
  } as const;
}

function outcome(
  id: string,
  terminalClass: "completed" | "failed" | "timed-out" | "cancelled",
  seconds: number,
  releasedAt: string,
) {
  return {
    schemaVersion: 1,
    decisionId: id,
    taskRef,
    terminalClass,
    clock: buildCompleteSchedulerServiceClock(
      new Date(Date.parse(releasedAt) - seconds * 1000).toISOString(),
      releasedAt,
    ),
    requestedRuntime: "codex",
    effectiveRuntime: "codex",
    championEstimateSeconds: null,
    absolutePredictionErrorSeconds: null,
    longJob: false,
    terminalResult: {
      namespace: taskRef.namespace,
      key: "result-structured",
      updatedAt: releasedAt,
      sha256: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    },
  };
}

describe("scheduler evidence", () => {
  it("accepts a content-blind abstaining prediction and hashes it deterministically", () => {
    const prediction = schedulerDecisionPredictionSchema.parse({
      schemaVersion: 1,
      decisionId,
      observedAt: "2026-07-22T21:00:00.000Z",
      champion: {
        policy: "complete-fifo-v1",
        taskRef,
        serviceEstimate: null,
      },
      challenger: {
        policy: "bounded-sejf-v1",
        overdueThresholdSeconds: 1800,
        taskRef: null,
        reason: "insufficient-evidence",
        evidenceReasons: ["estimate-missing"],
        serviceEstimate: null,
      },
      window: {
        eligibleTasks: 1,
        pendingEnumerationComplete: true,
        runningEnumerationComplete: true,
        eligibilityAuthority: "legacy-unbound-group-sequence",
        estimatedWorkMinutes: null,
        missingEstimates: 1,
      },
      estimatorVersion: "scheduler-duration-v1",
    });

    expect(hashSchedulerPrediction(prediction)).toBe(hashSchedulerPrediction({
      ...prediction,
      window: { ...prediction.window },
    }));
    expect(hashSchedulerPrediction(prediction)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects free-form challenger reasons and unsafe task references", () => {
    const base = {
      schemaVersion: 1,
      decisionId,
      observedAt: "2026-07-22T21:00:00.000Z",
      champion: { policy: "complete-fifo-v1", taskRef, serviceEstimate: null },
      challenger: {
        policy: "bounded-sejf-v1",
        overdueThresholdSeconds: 1800,
        taskRef: null,
        reason: "prompt said this is urgent",
        evidenceReasons: ["estimate-missing"],
        serviceEstimate: null,
      },
      window: {
        eligibleTasks: 1,
        pendingEnumerationComplete: true,
        runningEnumerationComplete: true,
        eligibilityAuthority: "legacy-unbound-group-sequence",
        estimatedWorkMinutes: null,
        missingEstimates: 1,
      },
      estimatorVersion: "scheduler-duration-v1",
    };
    expect(schedulerDecisionPredictionSchema.safeParse(base).success).toBe(false);
    expect(schedulerDecisionPredictionSchema.safeParse({
      ...base,
      challenger: { ...base.challenger, reason: "insufficient-evidence" },
      champion: {
        ...base.champion,
        taskRef: { namespace: "projects/private-customer", key: "status" },
      },
    }).success).toBe(false);
  });

  it("rejects missing-estimate selection bias and future history", () => {
    const base = {
      schemaVersion: 1,
      decisionId,
      observedAt: "2026-07-22T21:00:00.000Z",
      champion: {
        policy: "complete-fifo-v1",
        taskRef,
        serviceEstimate: estimate(10),
      },
      challenger: {
        policy: "bounded-sejf-v1",
        overdueThresholdSeconds: 1800,
        taskRef,
        reason: "shortest-estimate",
        evidenceReasons: [],
        serviceEstimate: estimate(5),
      },
      window: {
        eligibleTasks: 1,
        pendingEnumerationComplete: true,
        runningEnumerationComplete: true,
        eligibilityAuthority: "legacy-unbound-group-sequence",
        estimatedWorkMinutes: 1,
        missingEstimates: 1,
      },
      estimatorVersion: "scheduler-duration-v1",
    };
    expect(schedulerDecisionPredictionSchema.safeParse(base).success).toBe(false);
    expect(schedulerDecisionPredictionSchema.safeParse({
      ...base,
      window: { ...base.window, missingEstimates: 2 },
    }).success).toBe(false);
    expect(schedulerDecisionPredictionSchema.safeParse({
      ...base,
      window: { ...base.window, missingEstimates: 0 },
      champion: { ...base.champion, serviceEstimate: null },
    }).success).toBe(false);
    expect(schedulerDecisionPredictionSchema.safeParse({
      ...base,
      window: {
        ...base.window,
        missingEstimates: 0,
        estimatedWorkMinutes: null,
      },
    }).success).toBe(false);
    expect(schedulerDecisionPredictionSchema.safeParse({
      ...base,
      window: { ...base.window, missingEstimates: 0 },
      champion: {
        ...base.champion,
        serviceEstimate: estimate(10, "2026-07-22T21:30:00.000Z"),
      },
    }).success).toBe(false);
  });

  it("models complete and explicitly incomplete claim-to-release clocks", () => {
    expect(buildCompleteSchedulerServiceClock(
      "2026-07-22T21:00:00.000Z",
      "2026-07-22T21:08:00.000Z",
    )).toMatchObject({ clockComplete: true, schedulerServiceSeconds: 480 });

    expect(schedulerServiceClockEvidenceSchema.parse({
      serviceClock: "claim-to-release-v1",
      clockComplete: false,
      claimedAt: "2026-07-22T21:00:00.000Z",
      incompleteReason: "release-boundary-unavailable",
    }).clockComplete).toBe(false);
  });

  it("uses every complete terminal class and numeric median in the bounded window", () => {
    const samples = [
      outcome("00000000-0000-4000-8000-000000000001", "completed", 10, "2026-07-22T20:01:00.000Z"),
      outcome("00000000-0000-4000-8000-000000000002", "failed", 2, "2026-07-22T20:02:00.000Z"),
      outcome("00000000-0000-4000-8000-000000000003", "timed-out", 100, "2026-07-22T20:03:00.000Z"),
      outcome("00000000-0000-4000-8000-000000000004", "cancelled", 8, "2026-07-22T20:04:00.000Z"),
      outcome("00000000-0000-4000-8000-000000000005", "completed", 6, "2026-07-22T20:05:00.000Z"),
    ];

    expect(buildRollingMedianDurationEstimate(samples, {
      minimumSamples: 4,
      windowSize: 4,
    })).toEqual({
      seconds: 7,
      estimatorVersion: "scheduler-duration-v1",
      serviceClock: "claim-to-release-v1",
      source: "verified-terminal-history",
      sampleCount: 4,
      historyThrough: "2026-07-22T20:05:00.000Z",
      historyThroughDecisionId: "00000000-0000-4000-8000-000000000005",
    });
  });

  it("uses stable identity to make equal-timestamp windows order-independent", () => {
    const releasedAt = "2026-07-22T20:05:00.000Z";
    const samples = [
      outcome("00000000-0000-4000-8000-000000000003", "completed", 100, releasedAt),
      outcome("00000000-0000-4000-8000-000000000001", "completed", 1, releasedAt),
      outcome("00000000-0000-4000-8000-000000000002", "failed", 2, releasedAt),
    ];
    const options = { minimumSamples: 2, windowSize: 2 };
    expect(buildRollingMedianDurationEstimate(samples, options)).toEqual(
      buildRollingMedianDurationEstimate([...samples].reverse(), options),
    );
    expect(buildRollingMedianDurationEstimate([...samples, samples[0]], options)?.sampleCount).toBe(2);
    expect(() => buildRollingMedianDurationEstimate([
      samples[0],
      { ...samples[0], terminalClass: "failed" },
    ], options)).toThrow(/conflicting scheduler outcomes/);
  });

  it("censors incomplete clocks and returns null below the sample floor", () => {
    const incomplete = {
      ...outcome(
        "00000000-0000-4000-8000-000000000006",
        "failed",
        5,
        "2026-07-22T20:05:00.000Z",
      ),
      clock: {
        serviceClock: "claim-to-release-v1",
        clockComplete: false,
        claimedAt: "2026-07-22T20:00:00.000Z",
        incompleteReason: "release-boundary-unavailable",
      },
    };
    const estimate = buildRollingMedianDurationEstimate([incomplete], {
      minimumSamples: 1,
      windowSize: 10,
    });
    expect(estimate).toBeNull();
  });

  it("binds outcomes to the exact terminal structured-result revision and hash", () => {
    const parsed = schedulerDecisionOutcomeSchema.parse({
      schemaVersion: 1,
      decisionId,
      taskRef,
      terminalClass: "completed",
      clock: {
        serviceClock: "claim-to-release-v1",
        clockComplete: true,
        claimedAt: "2026-07-22T21:00:00.000Z",
        releasedAt: "2026-07-22T21:08:00.000Z",
        schedulerServiceSeconds: 480,
      },
      requestedRuntime: "codex",
      effectiveRuntime: "codex",
      championEstimateSeconds: null,
      absolutePredictionErrorSeconds: null,
      longJob: false,
      terminalResult: {
        namespace: taskRef.namespace,
        key: "result-structured",
        updatedAt: "2026-07-22T21:07:59.000Z",
        sha256: "c".repeat(64),
      },
    });
    expect(parsed.terminalResult.sha256).toHaveLength(64);
    expect(hashSchedulerOutcome(parsed)).toMatch(/^[0-9a-f]{64}$/);
  });
});
