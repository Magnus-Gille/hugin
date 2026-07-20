import { describe, expect, it } from "vitest";

import { runNegativeGate } from "../scripts/learning-task-joint-smoke.js";

/**
 * CI-runnable half of the issue #240 joint live-smoke gate
 * (docs/learning-task-handshake.md, "Joint live-smoke gate"). Drives one real
 * attempt through the real producer path (prepareDurableLearningTaskAttempt +
 * executeHomeserverTask) against a local loopback stub that advertises an
 * unsupported LearningTaskContract preflight. Never touches the production
 * gateway — see scripts/learning-task-joint-smoke.ts for the live-positive
 * half, which is intentionally excluded from this suite.
 */
describe("LearningTaskContract joint smoke — negative gate (local only)", () => {
  it("creates negative attempt evidence, makes no model call, and publishes no accepted output", async () => {
    const evidence = await runNegativeGate();

    expect(evidence.state).toBe("preflight-failed");
    expect(evidence.failureCode).toBe("preflight-failed");
    expect(evidence.delegateHit).toBe(false);
    expect(evidence.attemptStartPersisted).toBe(true);
    expect(evidence.preparedPersisted).toBe(false);
    expect(evidence.replayPersisted).toBe(false);
    expect(evidence.outcomePersisted).toBe(true);
    expect(evidence.executorResultText).toBeNull();
    expect(evidence.executorExitCode).not.toBe(0);
  }, 15_000);
});
