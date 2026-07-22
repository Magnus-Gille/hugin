import { describe, expect, it } from "vitest";
import {
  buildSchedulerDecisionPrediction,
  buildSchedulerDecisionOutcomeFromTerminalResult,
  buildRollingMedianDurationEstimate,
  buildCompleteSchedulerServiceClock,
  hashSchedulerOutcome,
  hashSchedulerPrediction,
  schedulerDecisionOutcomeSchema,
  schedulerDecisionPredictionSchema,
  schedulerServiceClockEvidenceSchema,
  resolveSchedulerRuntimeEstimates,
  SchedulerRuntimeEstimatorCache,
} from "../src/scheduler-evidence.js";
import { createHash } from "node:crypto";

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
  it("keeps the FIFO champion unchanged when shadow ranking is toggled", () => {
    const candidates = [
      {
        taskRef,
        createdAt: "2026-07-22T20:50:00.000Z",
        serviceEstimate: estimate(600),
      },
      {
        taskRef: { namespace: "tasks/20260722-230001-efgh", key: "status" as const },
        createdAt: "2026-07-22T20:55:00.000Z",
        serviceEstimate: estimate(60),
      },
    ];
    const base = {
      decisionId,
      observedAt: "2026-07-22T21:00:00.000Z",
      championTaskRef: taskRef,
      candidates,
      pendingEnumerationComplete: true,
      runningEnumerationComplete: true,
    };

    const disabled = buildSchedulerDecisionPrediction({ ...base, shadowEnabled: false });
    const enabled = buildSchedulerDecisionPrediction({ ...base, shadowEnabled: true });

    expect(disabled.champion.taskRef).toEqual(taskRef);
    expect(enabled.champion.taskRef).toEqual(taskRef);
    expect(disabled.challenger).toMatchObject({
      taskRef: null,
      reason: "insufficient-evidence",
      evidenceReasons: ["estimate-missing", "shadow-disabled"],
    });
    expect(enabled.challenger).toMatchObject({
      taskRef: candidates[1].taskRef,
      reason: "shortest-estimate",
      serviceEstimate: estimate(60),
    });
  });

  it("enforces the 30-minute bound before choosing the shortest estimate", () => {
    const overdue = {
      taskRef,
      createdAt: "2026-07-22T20:29:59.999Z",
      serviceEstimate: estimate(600),
    };
    const shorter = {
      taskRef: { namespace: "tasks/20260722-230001-efgh", key: "status" as const },
      createdAt: "2026-07-22T20:59:00.000Z",
      serviceEstimate: estimate(30),
    };
    const prediction = buildSchedulerDecisionPrediction({
      decisionId,
      observedAt: "2026-07-22T21:00:00.000Z",
      championTaskRef: taskRef,
      candidates: [overdue, shorter],
      pendingEnumerationComplete: true,
      runningEnumerationComplete: true,
      shadowEnabled: true,
    });

    expect(prediction.challenger).toMatchObject({
      taskRef,
      reason: "oldest-overdue",
      serviceEstimate: estimate(600),
    });
  });

  it("abstains deterministically for missing estimates and truncated windows", () => {
    const missing = buildSchedulerDecisionPrediction({
      decisionId,
      observedAt: "2026-07-22T21:00:00.000Z",
      championTaskRef: taskRef,
      candidates: [{
        taskRef,
        createdAt: "not-a-time",
        serviceEstimate: null,
      }],
      pendingEnumerationComplete: false,
      runningEnumerationComplete: true,
      shadowEnabled: true,
    });

    expect(missing.challenger).toEqual({
      policy: "bounded-sejf-v1",
      overdueThresholdSeconds: 1800,
      taskRef: null,
      reason: "insufficient-evidence",
      evidenceReasons: ["window-truncated", "estimate-missing"],
      serviceEstimate: null,
    });
    expect(missing.window).toMatchObject({
      missingEstimates: 1,
      estimatedWorkMinutes: null,
    });
  });

  it("abstains on mixed estimator versions or look-ahead history", () => {
    for (const badEstimate of [
      { ...estimate(10), estimatorVersion: "scheduler-duration-v2" },
      estimate(10, "2026-07-22T21:00:00.001Z"),
    ]) {
      const prediction = buildSchedulerDecisionPrediction({
        decisionId,
        observedAt: "2026-07-22T21:00:00.000Z",
        championTaskRef: taskRef,
        candidates: [{
          taskRef,
          createdAt: "2026-07-22T20:59:00.000Z",
          serviceEstimate: badEstimate,
        }],
        pendingEnumerationComplete: true,
        runningEnumerationComplete: true,
        shadowEnabled: true,
      });

      expect(prediction.challenger).toMatchObject({
        reason: "insufficient-evidence",
        evidenceReasons: ["estimate-missing", "estimator-version-mismatch"],
      });
    }
  });

  it("treats future-dated candidates as invalid timing evidence", () => {
    const prediction = buildSchedulerDecisionPrediction({
      decisionId,
      observedAt: "2026-07-22T21:00:00.000Z",
      championTaskRef: taskRef,
      candidates: [{
        taskRef,
        createdAt: "2026-07-22T21:00:00.001Z",
        serviceEstimate: estimate(10),
      }],
      pendingEnumerationComplete: true,
      runningEnumerationComplete: true,
      shadowEnabled: true,
    });

    expect(prediction.challenger).toMatchObject({
      reason: "insufficient-evidence",
      evidenceReasons: ["candidate-timestamp-invalid"],
    });
  });

  it("skips disabled lookups and memoizes enabled runtime estimates for large queues", () => {
    const runtimes = Array.from({ length: 4_000 }, (_, index) =>
      index % 2 === 0 ? "codex" as const : "claude" as const,
    );
    let lookups = 0;
    const lookup = (runtime: "codex" | "claude") => {
      lookups += 1;
      return estimate(runtime === "codex" ? 10 : 20);
    };

    expect(resolveSchedulerRuntimeEstimates(runtimes, false, lookup)).toEqual(
      Array.from({ length: 4_000 }, () => null),
    );
    expect(lookups).toBe(0);

    const resolved = resolveSchedulerRuntimeEstimates(runtimes, true, lookup);
    expect(lookups).toBe(2);
    expect(resolved[0]?.seconds).toBe(10);
    expect(resolved[1]?.seconds).toBe(20);
  });

  it("uses only live-process created outcomes in the runtime estimator cache", () => {
    const cache = new SchedulerRuntimeEstimatorCache({ minimumSamples: 2, windowSize: 3 });
    const first = outcome(
      "00000000-0000-4000-8000-000000000001",
      "completed",
      10,
      "2026-07-22T20:01:00.000Z",
    );
    const second = outcome(
      "00000000-0000-4000-8000-000000000002",
      "failed",
      20,
      "2026-07-22T20:02:00.000Z",
    );

    expect(cache.get("codex")).toBeNull();
    cache.recordCreated(first);
    expect(cache.get("codex")).toBeNull();
    cache.recordCreated(second);
    expect(cache.get("codex")).toMatchObject({ seconds: 15, sampleCount: 2 });
    expect(cache.get("claude")).toBeNull();
    expect(() => cache.recordCreated({ ...second, terminalClass: "completed" })).toThrow(
      /conflicting scheduler outcomes/,
    );
  });

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
    expect(schedulerDecisionPredictionSchema.safeParse({
      ...prediction,
      challenger: {
        ...prediction.challenger,
        evidenceReasons: ["estimate-missing", "window-truncated"],
      },
    }).success).toBe(false);
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

  it("derives a complete long-job outcome from the exact durable terminal result", () => {
    const terminalContent = JSON.stringify({
      schemaVersion: 1,
      taskId: "20260722-230000-abcd",
      taskNamespace: taskRef.namespace,
      lifecycle: "failed",
      outcome: "timed_out",
      runtime: "codex",
      executor: "codex",
      resultSource: "codex",
      exitCode: "TIMEOUT",
      completedAt: "2026-07-22T21:31:41.000Z",
      bodyKind: "error",
      bodyText: "timed out",
    });
    const prediction = schedulerDecisionPredictionSchema.parse({
      schemaVersion: 1,
      decisionId,
      observedAt: "2026-07-22T21:00:00.000Z",
      champion: { policy: "complete-fifo-v1", taskRef, serviceEstimate: null },
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

    expect(buildSchedulerDecisionOutcomeFromTerminalResult({
      prediction,
      claimedAt: "2026-07-22T21:00:00.000Z",
      releasedAt: "2026-07-22T21:31:41.000Z",
      requestedRuntime: "codex",
      effectiveRuntime: "codex",
      taskType: "code-fix",
      terminalResult: {
        namespace: taskRef.namespace,
        key: "result-structured",
        updatedAt: "2026-07-22T21:31:40.000Z",
        sha256: createHash("sha256").update(terminalContent, "utf8").digest("hex"),
        result: JSON.parse(terminalContent),
      },
    })).toMatchObject({
      decisionId,
      terminalClass: "timed-out",
      clock: { clockComplete: true, schedulerServiceSeconds: 1901 },
      longJob: true,
      terminalResult: {
        sha256: createHash("sha256").update(terminalContent, "utf8").digest("hex"),
      },
    });
  });

  it("marks a missing exact claim boundary incomplete and rejects cross-task results", () => {
    const prediction = schedulerDecisionPredictionSchema.parse({
      schemaVersion: 1,
      decisionId,
      observedAt: "2026-07-22T21:00:00.000Z",
      champion: { policy: "complete-fifo-v1", taskRef, serviceEstimate: null },
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
    const terminal = {
      schemaVersion: 1,
      taskId: "20260722-230000-abcd",
      taskNamespace: taskRef.namespace,
      lifecycle: "completed",
      outcome: "completed",
      runtime: "codex",
      executor: "codex",
      resultSource: "codex",
      exitCode: 0,
      completedAt: "2026-07-22T21:01:00.000Z",
      bodyKind: "response",
      bodyText: "ok",
    };
    const input = {
      prediction,
      claimedAt: null,
      releasedAt: "2026-07-22T21:01:01.000Z",
      requestedRuntime: "codex" as const,
      effectiveRuntime: "codex" as const,
      terminalResult: {
        namespace: taskRef.namespace,
        key: "result-structured" as const,
        updatedAt: "2026-07-22T21:01:00.000Z",
        sha256: createHash("sha256").update(JSON.stringify(terminal), "utf8").digest("hex"),
        result: terminal,
      },
    };
    expect(buildSchedulerDecisionOutcomeFromTerminalResult(input)).toMatchObject({
      clock: { clockComplete: false, incompleteReason: "claim-boundary-unavailable" },
      longJob: false,
      absolutePredictionErrorSeconds: null,
    });
    expect(buildSchedulerDecisionOutcomeFromTerminalResult({
      ...input,
      claimedAt: "2026-07-22T21:02:00.000Z",
    })).toMatchObject({
      clock: { clockComplete: false, incompleteReason: "release-boundary-unavailable" },
      longJob: false,
    });
    expect(() => buildSchedulerDecisionOutcomeFromTerminalResult({
      ...input,
      terminalResult: { ...input.terminalResult, namespace: "tasks/other" },
    })).toThrow(/champion task/);
  });
});
