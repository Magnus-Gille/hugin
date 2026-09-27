import { describe, expect, it } from "vitest";
import {
  WORKER_LIVENESS_CLOCK_SKEW_TOLERANCE_MS,
  WORKER_LIVENESS_MIN_THRESHOLD_MS,
  WORKER_LIVENESS_STALE_MULTIPLIER,
  assessWorkerLiveness,
  computeWorkerLivenessThresholdMs,
} from "../src/worker-liveness.js";

const NOW = new Date("2026-09-27T12:00:00.000Z");
const POLL_INTERVAL_MS = 30_000;

function isoOffset(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function heartbeatJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    worker_id: "huginmunin",
    process_instance_id: "abc123",
    polled_at: isoOffset(0),
    current_task: null,
    ...overrides,
  });
}

describe("computeWorkerLivenessThresholdMs", () => {
  it("is max(3 * pollIntervalMs, 180_000)", () => {
    expect(computeWorkerLivenessThresholdMs(30_000)).toBe(180_000);
    expect(computeWorkerLivenessThresholdMs(100_000)).toBe(300_000);
  });

  it("matches the exported constants", () => {
    expect(WORKER_LIVENESS_STALE_MULTIPLIER).toBe(3);
    expect(WORKER_LIVENESS_MIN_THRESHOLD_MS).toBe(180_000);
    expect(computeWorkerLivenessThresholdMs(POLL_INTERVAL_MS)).toBe(
      Math.max(WORKER_LIVENESS_STALE_MULTIPLIER * POLL_INTERVAL_MS, WORKER_LIVENESS_MIN_THRESHOLD_MS),
    );
  });
});

describe("assessWorkerLiveness", () => {
  it("reports healthy-idle for a fresh heartbeat with no current task", () => {
    const result = assessWorkerLiveness({
      heartbeat: heartbeatJson({ current_task: null }),
      now: NOW,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(result.state).toBe("healthy-idle");
    expect(result.attention).toBe(false);
    expect(result.workerId).toBe("huginmunin");
    expect(result.currentTask).toBeNull();
    expect(result.thresholdMs).toBe(180_000);
    expect(result.ageMs).toBe(0);
  });

  it("reports healthy-busy when current_task is set within the threshold", () => {
    const result = assessWorkerLiveness({
      heartbeat: heartbeatJson({ current_task: "tasks/long-running-task", polled_at: isoOffset(60_000) }),
      now: NOW,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(result.state).toBe("healthy-busy");
    expect(result.attention).toBe(false);
    expect(result.currentTask).toBe("tasks/long-running-task");
  });

  it("reports stale when the heartbeat age exceeds the threshold", () => {
    const result = assessWorkerLiveness({
      heartbeat: heartbeatJson({ polled_at: isoOffset(200_000) }),
      now: NOW,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(result.state).toBe("stale");
    expect(result.ageMs).toBe(200_000);
  });

  it("is healthy exactly at the threshold boundary", () => {
    const result = assessWorkerLiveness({
      heartbeat: heartbeatJson({ polled_at: isoOffset(180_000) }),
      now: NOW,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(result.state).toBe("healthy-idle");
  });

  it("is stale just over the threshold boundary", () => {
    const result = assessWorkerLiveness({
      heartbeat: heartbeatJson({ polled_at: isoOffset(180_001) }),
      now: NOW,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(result.state).toBe("stale");
  });

  it("reports absent for null heartbeat", () => {
    const result = assessWorkerLiveness({
      heartbeat: null,
      now: NOW,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(result.state).toBe("absent");
    expect(result.ageMs).toBeNull();
    expect(result.workerId).toBeNull();
  });

  it("reports absent for undefined heartbeat", () => {
    const result = assessWorkerLiveness({
      heartbeat: undefined,
      now: NOW,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(result.state).toBe("absent");
  });

  it("reports malformed for non-JSON string content", () => {
    const result = assessWorkerLiveness({
      heartbeat: "not json {{{",
      now: NOW,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(result.state).toBe("malformed");
  });

  it("reports malformed when required fields are missing", () => {
    const result = assessWorkerLiveness({
      heartbeat: JSON.stringify({ worker_id: "huginmunin" }),
      now: NOW,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(result.state).toBe("malformed");
  });

  it("reports malformed when the parsed value is not an object", () => {
    const result = assessWorkerLiveness({
      heartbeat: JSON.stringify(["array", "not", "object"]),
      now: NOW,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(result.state).toBe("malformed");
  });

  it("reports malformed for a future polled_at beyond clock-skew tolerance", () => {
    const result = assessWorkerLiveness({
      heartbeat: heartbeatJson({ polled_at: isoOffset(-(WORKER_LIVENESS_CLOCK_SKEW_TOLERANCE_MS + 1)) }),
      now: NOW,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(result.state).toBe("malformed");
  });

  it("stays healthy for a future polled_at within clock-skew tolerance", () => {
    const result = assessWorkerLiveness({
      heartbeat: heartbeatJson({ polled_at: isoOffset(-1_000) }),
      now: NOW,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(result.state).toBe("healthy-idle");
  });

  it("is content-blind: no prompt-shaped fields leak into the assessment", () => {
    const result = assessWorkerLiveness({
      heartbeat: heartbeatJson({ current_task: "tasks/abc", prompt: "leaked secret prompt text" }),
      now: NOW,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(JSON.stringify(result)).not.toContain("leaked secret prompt text");
  });

  describe("attention", () => {
    it("is true for stale with pendingCount > 0", () => {
      const result = assessWorkerLiveness({
        heartbeat: heartbeatJson({ polled_at: isoOffset(200_000) }),
        now: NOW,
        pollIntervalMs: POLL_INTERVAL_MS,
        pendingCount: 3,
      });
      expect(result.attention).toBe(true);
    });

    it("is false for stale with pendingCount === 0", () => {
      const result = assessWorkerLiveness({
        heartbeat: heartbeatJson({ polled_at: isoOffset(200_000) }),
        now: NOW,
        pollIntervalMs: POLL_INTERVAL_MS,
        pendingCount: 0,
      });
      expect(result.attention).toBe(false);
    });

    it("is true for stale with pendingCount unknown", () => {
      const result = assessWorkerLiveness({
        heartbeat: heartbeatJson({ polled_at: isoOffset(200_000) }),
        now: NOW,
        pollIntervalMs: POLL_INTERVAL_MS,
      });
      expect(result.attention).toBe(true);
    });

    it("is false for absent with pendingCount 0", () => {
      const result = assessWorkerLiveness({
        heartbeat: null,
        now: NOW,
        pollIntervalMs: POLL_INTERVAL_MS,
        pendingCount: 0,
      });
      expect(result.attention).toBe(false);
    });

    it("is true for malformed with pendingCount > 0", () => {
      const result = assessWorkerLiveness({
        heartbeat: "not json",
        now: NOW,
        pollIntervalMs: POLL_INTERVAL_MS,
        pendingCount: 5,
      });
      expect(result.attention).toBe(true);
    });

    it("is false for healthy-idle regardless of pendingCount", () => {
      const result = assessWorkerLiveness({
        heartbeat: heartbeatJson(),
        now: NOW,
        pollIntervalMs: POLL_INTERVAL_MS,
        pendingCount: 10,
      });
      expect(result.attention).toBe(false);
    });
  });
});
