import { describe, expect, it } from "vitest";
import { MuninWriteRejectedError, type MuninEntry } from "../src/munin-client.js";
import {
  buildSchedulerClaimAttestation,
  buildSchedulerOutcomeAttestation,
} from "../src/scheduler-evidence-attestation.js";
import {
  hashSchedulerPrediction,
} from "../src/scheduler-evidence.js";
import {
  persistSchedulerClaimAttestation,
  persistSchedulerOutcome,
  persistSchedulerOutcomeAttestation,
  persistSchedulerPrediction,
  persistSchedulerWorkloadSnapshot,
  type SchedulerEvidenceStoreClient,
} from "../src/scheduler-evidence-store.js";
import {
  buildSchedulerWorkloadSnapshot,
  hashSchedulerWorkloadSnapshot,
} from "../src/scheduler-workload.js";

const taskNamespace = "tasks/20260723-001500-abcd";
const decisionId = "34f2d430-6c31-47de-860a-8b22bc97f4d4";
const secret = "dispatcher-authority-secret-32-bytes-minimum";

function prediction(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    decisionId,
    observedAt: "2026-07-22T22:15:00.000Z",
    champion: {
      policy: "complete-fifo-v1",
      taskRef: { namespace: taskNamespace, key: "status" },
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
      eligibleTasks: 2,
      pendingEnumerationComplete: true,
      runningEnumerationComplete: true,
      eligibilityAuthority: "legacy-unbound-group-sequence",
      estimatedWorkMinutes: null,
      missingEstimates: 2,
    },
    estimatorVersion: "scheduler-duration-v1",
    ...overrides,
  };
}

function outcome(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    decisionId,
    taskRef: { namespace: taskNamespace, key: "status" },
    terminalClass: "completed",
    clock: {
      serviceClock: "claim-to-release-v1",
      clockComplete: true,
      claimedAt: "2026-07-22T22:15:00.000Z",
      releasedAt: "2026-07-22T22:16:00.000Z",
      schedulerServiceSeconds: 60,
    },
    requestedRuntime: "codex",
    effectiveRuntime: "codex",
    championEstimateSeconds: null,
    absolutePredictionErrorSeconds: null,
    longJob: false,
    terminalResult: {
      namespace: taskNamespace,
      key: "result-structured",
      updatedAt: "2026-07-22T22:15:59.000Z",
      sha256: "a".repeat(64),
    },
    ...overrides,
  };
}

function workloadSnapshot() {
  return buildSchedulerWorkloadSnapshot({
    observedAt: "2026-07-22T22:15:00.000Z",
    bucketEnumerationComplete: {
      dispatchable: true,
      groupBlocked: true,
      pipelineBlocked: false,
      approvalGated: false,
      otherNonterminal: false,
      runningRemaining: true,
    },
    items: [{
      taskRef: { namespace: taskNamespace, key: "status" },
      buckets: ["dispatchable"],
      serviceEstimate: null,
    }],
  });
}

function attestations() {
  const predicted = prediction();
  const claim = buildSchedulerClaimAttestation({
    decisionId,
    taskRef: { namespace: taskNamespace, key: "status" },
    taskContent: "## Task: safe",
    preClaimUpdatedAt: "2026-07-22T22:14:59.000Z",
    claimedAt: "2026-07-22T22:15:00.000Z",
    predictionSha256: hashSchedulerPrediction(predicted),
    workerId: "hugin-test",
    processInstanceId: "hugin-test-123",
  }, secret);
  const completed = outcome();
  return {
    claim,
    outcome: completed,
    outcomeAttestation: buildSchedulerOutcomeAttestation({
      claimAttestation: claim,
      outcome: completed,
    }, secret),
  };
}

class FakeMunin implements SchedulerEvidenceStoreClient {
  readonly rows = new Map<string, MuninEntry & { found: true }>();
  readonly writes: Array<{ namespace: string; key: string; createIfAbsent?: boolean }> = [];

  async read(namespace: string, key: string): Promise<(MuninEntry & { found: true }) | null> {
    return this.rows.get(`${namespace}/${key}`) ?? null;
  }

  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    _expectedUpdatedAt?: string,
    classification?: string,
    createIfAbsent?: boolean,
  ): Promise<Record<string, unknown>> {
    this.writes.push({ namespace, key, createIfAbsent });
    const rowKey = `${namespace}/${key}`;
    if (createIfAbsent && this.rows.has(rowKey)) {
      throw new MuninWriteRejectedError(namespace, key, {
        error: "conflict",
        conflict_reason: "already_exists",
      });
    }
    this.rows.set(rowKey, {
      found: true,
      id: rowKey,
      namespace,
      key,
      content,
      tags: tags ?? [],
      classification,
      created_at: "2026-07-22T22:15:01.000Z",
      updated_at: "2026-07-22T22:15:01.000Z",
    });
    return { ok: true, status: createIfAbsent ? "created" : "updated" };
  }
}

describe("scheduler evidence store", () => {
  it("atomically creates a content-blind prediction", async () => {
    const munin = new FakeMunin();
    const value = prediction();

    expect(await persistSchedulerPrediction(munin, value)).toEqual({ status: "created" });
    expect(munin.writes[0]).toEqual({
      namespace: `scheduler/decisions/${decisionId}`,
      key: "prediction",
      createIfAbsent: true,
    });

    expect([...munin.rows.values()][0]?.classification).toBe("internal");
  });

  it("treats an exact immutable replay as reusable but refuses conflicting content", async () => {
    const munin = new FakeMunin();
    const value = prediction();
    await persistSchedulerPrediction(munin, value);

    expect(await persistSchedulerPrediction(munin, value)).toEqual({ status: "exact-existing" });
    await expect(persistSchedulerPrediction(munin, prediction({
      observedAt: "2026-07-22T22:16:00.000Z",
    }))).rejects.toThrow(/different prediction/);
  });

  it("creates outcomes separately and refuses a conflicting immutable replay", async () => {
    const munin = new FakeMunin();
    const value = outcome();

    expect(await persistSchedulerOutcome(munin, value)).toEqual({ status: "created" });
    expect(munin.writes[0]).toEqual({
      namespace: `scheduler/decisions/${decisionId}`,
      key: "outcome",
      createIfAbsent: true,
    });
    expect(await persistSchedulerOutcome(munin, value)).toEqual({ status: "exact-existing" });
    await expect(persistSchedulerOutcome(munin, {
      ...value,
      terminalClass: "failed",
    })).rejects.toThrow(/different outcome/);
  });

  it("creates a workload snapshot separately and refuses a conflicting replay", async () => {
    const munin = new FakeMunin();
    const value = workloadSnapshot();
    const digest = hashSchedulerWorkloadSnapshot(value);
    const boundPrediction = prediction({ workloadSnapshotSha256: digest });
    await persistSchedulerPrediction(munin, boundPrediction);

    expect(await persistSchedulerWorkloadSnapshot(munin, boundPrediction, value)).toEqual({
      status: "created",
    });
    expect(munin.writes[1]).toEqual({
      namespace: `scheduler/decisions/${decisionId}`,
      key: "workload-snapshot",
      createIfAbsent: true,
    });
    expect(await persistSchedulerWorkloadSnapshot(munin, boundPrediction, value)).toEqual({
      status: "exact-existing",
    });
    const changed = {
      ...value,
      observedAt: "2026-07-22T22:16:00.000Z",
    };
    await expect(persistSchedulerWorkloadSnapshot(
      munin,
      prediction({ workloadSnapshotSha256: hashSchedulerWorkloadSnapshot(changed) }),
      changed,
    )).rejects.toThrow(/matching stored prediction/);
    await expect(persistSchedulerWorkloadSnapshot(
      munin,
      boundPrediction,
      changed,
    )).rejects.toThrow(/digest does not match prediction/);
  });

  it("refuses workload evidence without the exact bound prediction already stored", async () => {
    const value = workloadSnapshot();
    const digest = hashSchedulerWorkloadSnapshot(value);
    const boundPrediction = prediction({ workloadSnapshotSha256: digest });

    await expect(persistSchedulerWorkloadSnapshot(
      new FakeMunin(),
      boundPrediction,
      value,
    )).rejects.toThrow(/matching stored prediction/);

    const munin = new FakeMunin();
    await persistSchedulerPrediction(munin, prediction({
      workloadSnapshotSha256: "f".repeat(64),
    }));
    await expect(persistSchedulerWorkloadSnapshot(
      munin,
      boundPrediction,
      value,
    )).rejects.toThrow(/matching stored prediction/);
  });

  it("creates claim and outcome attestations immutably and tags outcomes by runtime", async () => {
    const munin = new FakeMunin();
    const values = attestations();

    expect(await persistSchedulerClaimAttestation(munin, values.claim)).toEqual({
      status: "created",
    });
    expect(await persistSchedulerOutcomeAttestation(
      munin,
      values.outcomeAttestation,
      "codex",
    )).toEqual({ status: "created" });
    expect(munin.writes).toEqual([
      {
        namespace: `scheduler/decisions/${decisionId}`,
        key: "claim-attestation",
        createIfAbsent: true,
      },
      {
        namespace: `scheduler/decisions/${decisionId}`,
        key: "outcome-attestation",
        createIfAbsent: true,
      },
    ]);
    expect(munin.rows.get(
      `scheduler/decisions/${decisionId}/outcome-attestation`,
    )?.tags).toContain("scheduler-runtime:codex");

    expect(await persistSchedulerClaimAttestation(munin, values.claim)).toEqual({
      status: "exact-existing",
    });
    expect(await persistSchedulerOutcomeAttestation(
      munin,
      values.outcomeAttestation,
      "codex",
    )).toEqual({ status: "exact-existing" });
  });

  it("refuses conflicting immutable claim and outcome attestations", async () => {
    const munin = new FakeMunin();
    const values = attestations();
    await persistSchedulerClaimAttestation(munin, values.claim);
    await persistSchedulerOutcomeAttestation(munin, values.outcomeAttestation, "codex");

    await expect(persistSchedulerClaimAttestation(munin, {
      ...values.claim,
      hmacSha256: "b".repeat(64),
    })).rejects.toThrow(/different claim attestation/);
    await expect(persistSchedulerOutcomeAttestation(munin, {
      ...values.outcomeAttestation,
      hmacSha256: "c".repeat(64),
    }, "codex")).rejects.toThrow(/different outcome attestation/);
  });

});
