import { describe, expect, it } from "vitest";
import { MuninWriteRejectedError, type MuninEntry } from "../src/munin-client.js";
import {
  persistSchedulerPrediction,
  type SchedulerEvidenceStoreClient,
} from "../src/scheduler-evidence-store.js";

const taskNamespace = "tasks/20260723-001500-abcd";
const decisionId = "34f2d430-6c31-47de-860a-8b22bc97f4d4";

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

});
