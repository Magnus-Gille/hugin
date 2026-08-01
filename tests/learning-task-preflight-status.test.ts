import { describe, expect, it } from "vitest";

import {
  buildLearningTaskPreflightPanel,
  createLearningTaskPreflightStore,
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

    const panel = buildLearningTaskPreflightPanel(store.snapshot());
    expect(panel).toMatchObject({
      kind: "status",
      state: "pass",
    });
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

    const panel = buildLearningTaskPreflightPanel(store.snapshot());
    expect(panel).toMatchObject({
      kind: "status",
      state: "fail",
    });
    expect(JSON.stringify(panel)).toContain("capability-downgrade");
    expect(JSON.stringify(panel)).not.toContain("private.example");
    expect(JSON.stringify(panel)).not.toContain("token=secret");
  });
});
