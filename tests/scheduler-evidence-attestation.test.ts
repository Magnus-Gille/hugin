import { describe, expect, it } from "vitest";
import {
  buildSchedulerClaimAttestation,
  buildSchedulerOutcomeAttestation,
  hashSchedulerClaimAttestation,
  verifySchedulerClaimAttestation,
  verifySchedulerOutcomeAttestation,
} from "../src/scheduler-evidence-attestation.js";
import { buildCompleteSchedulerServiceClock } from "../src/scheduler-evidence.js";

const secret = "dispatcher-authority-secret-32-bytes-minimum";
const taskRef = { namespace: "tasks/20260723-010000-abcd", key: "status" as const };
const decisionId = "34f2d430-6c31-47de-860a-8b22bc97f4d4";
const predictionSha256 = "a".repeat(64);
const taskContent = "## Task: safe\n\n- **Runtime:** codex\n\n### Prompt\nredacted";

function claim() {
  return buildSchedulerClaimAttestation({
    decisionId,
    taskRef,
    taskContent,
    preClaimUpdatedAt: "2026-07-23T00:59:59.000Z",
    claimedAt: "2026-07-23T01:00:00.000Z",
    predictionSha256,
    workerId: "hugin-huginmunin",
    processInstanceId: "hugin-huginmunin-1234",
  }, secret);
}

function outcome() {
  return {
    schemaVersion: 1,
    decisionId,
    taskRef,
    terminalClass: "completed" as const,
    clock: buildCompleteSchedulerServiceClock(
      "2026-07-23T01:00:00.000Z",
      "2026-07-23T01:00:10.000Z",
    ),
    requestedRuntime: "codex" as const,
    effectiveRuntime: "codex" as const,
    championEstimateSeconds: null,
    absolutePredictionErrorSeconds: null,
    longJob: false,
    terminalResult: {
      namespace: taskRef.namespace,
      key: "result-structured" as const,
      updatedAt: "2026-07-23T01:00:09.999Z",
      sha256: "b".repeat(64),
    },
  };
}

describe("scheduler evidence attestations", () => {
  it("authenticates the exact successful claim transition without storing task content", () => {
    const attestation = claim();
    const verified = verifySchedulerClaimAttestation(JSON.stringify(attestation), {
      taskRef,
      taskContent,
      predictionSha256,
    }, secret);

    expect(verified).toMatchObject({
      decisionId,
      taskRef,
      preClaimUpdatedAt: "2026-07-23T00:59:59.000Z",
      claimedAt: "2026-07-23T01:00:00.000Z",
      predictionSha256,
    });
    expect(JSON.stringify(attestation)).not.toContain("### Prompt");
    expect(hashSchedulerClaimAttestation(attestation)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed on claim field, content, prediction, or MAC tampering", () => {
    const attestation = claim();
    for (const tampered of [
      { ...attestation, decisionId: "5f1848e1-d3fb-46bf-9121-e1f38e79d158" },
      { ...attestation, claimedAt: "2026-07-23T01:00:01.000Z" },
      { ...attestation, predictionSha256: "c".repeat(64) },
      { ...attestation, hmacSha256: "d".repeat(64) },
    ]) {
      expect(verifySchedulerClaimAttestation(JSON.stringify(tampered), {
        taskRef,
        taskContent,
        predictionSha256,
      }, secret)).toBeUndefined();
    }
    expect(verifySchedulerClaimAttestation(JSON.stringify(attestation), {
      taskRef,
      taskContent: `${taskContent}\nchanged`,
      predictionSha256,
    }, secret)).toBeUndefined();
  });

  it("binds an exact scheduler outcome to the authenticated claim", () => {
    const claimAttestation = claim();
    const terminalOutcome = outcome();
    const attestation = buildSchedulerOutcomeAttestation({
      claimAttestation,
      outcome: terminalOutcome,
    }, secret);

    expect(verifySchedulerOutcomeAttestation(JSON.stringify(attestation), {
      claimAttestation,
      outcome: terminalOutcome,
    }, secret)).toMatchObject({ decisionId });
    expect(verifySchedulerOutcomeAttestation(JSON.stringify(attestation), {
      claimAttestation,
      outcome: { ...terminalOutcome, terminalClass: "failed" },
    }, secret)).toBeUndefined();
    expect(verifySchedulerOutcomeAttestation(JSON.stringify(attestation), {
      claimAttestation: { ...claimAttestation, claimedAt: "2026-07-23T01:00:01.000Z" },
      outcome: terminalOutcome,
    }, secret)).toBeUndefined();
  });

  it("rejects weak secrets and cross-protocol MAC reuse", () => {
    expect(() => buildSchedulerClaimAttestation({
      decisionId,
      taskRef,
      taskContent,
      preClaimUpdatedAt: "2026-07-23T00:59:59.000Z",
      claimedAt: "2026-07-23T01:00:00.000Z",
      predictionSha256,
      workerId: "hugin-huginmunin",
      processInstanceId: "hugin-huginmunin-1234",
    }, "short")).toThrow(/at least 32/);

    const claimAttestation = claim();
    const terminalOutcome = outcome();
    const outcomeAttestation = buildSchedulerOutcomeAttestation({
      claimAttestation,
      outcome: terminalOutcome,
    }, secret);
    expect(verifySchedulerClaimAttestation(JSON.stringify({
      ...claimAttestation,
      hmacSha256: outcomeAttestation.hmacSha256,
    }), { taskRef, taskContent, predictionSha256 }, secret)).toBeUndefined();
  });
});
