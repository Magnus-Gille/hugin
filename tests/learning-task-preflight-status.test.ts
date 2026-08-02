import { describe, expect, it } from "vitest";

import {
  buildLearningTaskPreflightPanel,
  createLearningTaskPreflightStore,
  LEARNING_TASK_PREFLIGHT_FRESHNESS_MS,
} from "../src/learning-task-preflight-status.js";

describe("learning task preflight status", () => {
  it("builds an unknown panel before any authenticated preflight runs", () => {
    const store = createLearningTaskPreflightStore();

    expect(buildLearningTaskPreflightPanel(store.snapshot())).toMatchObject({
      kind: "status",
      state: "unknown",
    });
  });

  it("records a successful authenticated preflight without leaking content", () => {
    const store = createLearningTaskPreflightStore();
    store.record({
      checkedAt: "2026-08-01T10:00:00Z",
      outcome: "ok",
    });

    const panel = buildLearningTaskPreflightPanel(store.snapshot(), {
      now: () => new Date("2026-08-01T10:00:01Z"),
    });
    expect(panel).toMatchObject({
      kind: "status",
      state: "pass",
    });
    expect(String(panel.message)).toContain("2026-08-01T10:00:00Z");
    expect(JSON.stringify(panel)).not.toContain("token");
    expect(JSON.stringify(panel)).not.toContain("portal/me");
  });

  it("records a failed authenticated preflight using only a coarse error class", () => {
    const store = createLearningTaskPreflightStore();
    store.record({
      checkedAt: "2026-08-01T10:00:00Z",
      outcome: "failed",
      errorClass: "capability-downgrade",
      detail: "https://private.example/v1/capabilities/learning-task?token=secret",
    });

    const panel = buildLearningTaskPreflightPanel(store.snapshot(), {
      now: () => new Date("2026-08-01T10:00:01Z"),
    });
    expect(panel).toMatchObject({
      kind: "status",
      state: "fail",
    });
    expect(JSON.stringify(panel)).toContain("capability-downgrade");
    expect(String(panel.message)).toContain("2026-08-01T10:00:00Z");
    expect(JSON.stringify(panel)).not.toContain("private.example");
    expect(JSON.stringify(panel)).not.toContain("token=secret");
  });

  it("degrades a boundary-stale observation to unknown and reports its age", () => {
    const panel = buildLearningTaskPreflightPanel({
      checkedAt: "2026-08-01T10:00:00Z",
      outcome: "ok",
    }, {
      now: () => new Date("2026-08-01T10:15:00Z"),
    });

    expect(panel).toMatchObject({
      kind: "status",
      state: "unknown",
    });
    expect(String(panel.message)).toContain("2026-08-01T10:00:00Z");
    expect(String(panel.message)).toContain(`${LEARNING_TASK_PREFLIGHT_FRESHNESS_MS / 1000}s`);
  });

  it("treats malformed and future observation times as unknown", () => {
    const now = () => new Date("2026-08-01T10:00:00Z");

    expect(buildLearningTaskPreflightPanel({
      checkedAt: "not-a-date",
      outcome: "ok",
    }, { now })).toMatchObject({ state: "unknown" });
    expect(buildLearningTaskPreflightPanel({
      checkedAt: "2026-08-01T10:00:01Z",
      outcome: "failed",
      errorClass: "capability-downgrade",
    }, { now })).toMatchObject({ state: "unknown" });
  });
});
