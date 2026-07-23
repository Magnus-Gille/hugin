import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSchedulerClaimAttestation,
  buildSchedulerOutcomeAttestation,
} from "../src/scheduler-evidence-attestation.js";
import {
  hashSchedulerPrediction,
  type SchedulerDecisionOutcome,
} from "../src/scheduler-evidence.js";
import {
  loadVerifiedSchedulerOutcomeHistory,
  type SchedulerEvidenceHistoryClient,
} from "../src/scheduler-evidence-history.js";
import type {
  MuninEntry,
  MuninQueryResult,
  MuninReadRequest,
  MuninReadResult,
} from "../src/munin-client.js";

const secret = "dispatcher-authority-secret-32-bytes-minimum";
const decisionId = "34f2d430-6c31-47de-860a-8b22bc97f4d4";
const taskNamespace = "tasks/20260723-020000-abcd";
const decisionNamespace = `scheduler/decisions/${decisionId}`;
const statusContent = "## Task: safe\n\n- **Runtime:** codex\n\n### Prompt\nprivate";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function row(
  namespace: string,
  key: string,
  content: string,
  tags: string[] = [],
  updatedAt = "2026-07-23T02:00:10.000Z",
): MuninEntry & { found: true } {
  return {
    found: true,
    id: `${namespace}/${key}`,
    namespace,
    key,
    content,
    tags,
    classification: "internal",
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

function fixture() {
  const prediction = {
    schemaVersion: 1 as const,
    decisionId,
    observedAt: "2026-07-23T02:00:00.000Z",
    champion: {
      policy: "complete-fifo-v1" as const,
      taskRef: { namespace: taskNamespace, key: "status" as const },
      serviceEstimate: null,
    },
    challenger: {
      policy: "bounded-sejf-v1" as const,
      overdueThresholdSeconds: 1800,
      taskRef: null,
      reason: "insufficient-evidence" as const,
      evidenceReasons: ["estimate-missing" as const],
      serviceEstimate: null,
    },
    window: {
      eligibleTasks: 1,
      pendingEnumerationComplete: true,
      runningEnumerationComplete: true,
      eligibilityAuthority: "legacy-unbound-group-sequence" as const,
      estimatedWorkMinutes: null,
      missingEstimates: 1,
    },
    estimatorVersion: "scheduler-duration-v1" as const,
  };
  const result = {
    schemaVersion: 1 as const,
    taskId: "20260723-020000-abcd",
    taskNamespace,
    lifecycle: "completed" as const,
    outcome: "completed" as const,
    runtime: "codex" as const,
    executor: "codex",
    resultSource: "runtime",
    exitCode: 0,
    completedAt: "2026-07-23T02:00:09.000Z",
    bodyKind: "response" as const,
    bodyText: "done",
  };
  const resultContent = JSON.stringify(result);
  const claim = buildSchedulerClaimAttestation({
    decisionId,
    taskRef: prediction.champion.taskRef,
    taskContent: statusContent,
    preClaimUpdatedAt: "2026-07-23T01:59:59.000Z",
    claimedAt: "2026-07-23T02:00:00.000Z",
    predictionSha256: hashSchedulerPrediction(prediction),
    workerId: "hugin-test",
    processInstanceId: "hugin-test-123",
  }, secret);
  const outcome: SchedulerDecisionOutcome = {
    schemaVersion: 1,
    decisionId,
    taskRef: prediction.champion.taskRef,
    terminalClass: "completed",
    clock: {
      serviceClock: "claim-to-release-v1",
      clockComplete: true,
      claimedAt: "2026-07-23T02:00:00.000Z",
      releasedAt: "2026-07-23T02:00:10.000Z",
      schedulerServiceSeconds: 10,
    },
    requestedRuntime: "codex",
    effectiveRuntime: "codex",
    championEstimateSeconds: null,
    absolutePredictionErrorSeconds: null,
    longJob: false,
    terminalResult: {
      namespace: taskNamespace,
      key: "result-structured",
      updatedAt: "2026-07-23T02:00:09.000Z",
      sha256: sha256(resultContent),
    },
  };
  const outcomeAttestation = buildSchedulerOutcomeAttestation({
    claimAttestation: claim,
    outcome,
  }, secret);
  return {
    prediction,
    claim,
    outcome,
    outcomeAttestation,
    resultContent,
  };
}

class FakeHistoryClient implements SchedulerEvidenceHistoryClient {
  readonly rows = new Map<string, MuninEntry & { found: true }>();
  readonly queries: Array<{ tags?: string[]; limit?: number }> = [];

  constructor() {
    const value = fixture();
    for (const entry of [
      row(decisionNamespace, "prediction", JSON.stringify(value.prediction)),
      row(decisionNamespace, "claim-attestation", JSON.stringify(value.claim)),
      row(decisionNamespace, "outcome", JSON.stringify(value.outcome)),
      row(
        decisionNamespace,
        "outcome-attestation",
        JSON.stringify(value.outcomeAttestation),
        [
          "type:scheduler-outcome-attestation",
          "scheduler-runtime:codex",
          "scheduler-shadow:v1",
        ],
      ),
      row(taskNamespace, "status", statusContent),
      row(
        taskNamespace,
        "result-structured",
        value.resultContent,
        [],
        "2026-07-23T02:00:09.000Z",
      ),
    ]) {
      this.rows.set(`${entry.namespace}/${entry.key}`, entry);
    }
  }

  async query(opts: {
    tags?: string[];
    namespace?: string;
    limit?: number;
  }): Promise<{ results: MuninQueryResult[]; total: number }> {
    this.queries.push({ tags: opts.tags, limit: opts.limit });
    const results = [...this.rows.values()]
      .filter((entry) => entry.key === "outcome-attestation")
      .filter((entry) => (opts.tags ?? []).every((tag) => entry.tags.includes(tag)))
      .slice(0, opts.limit)
      .map((entry) => ({
        id: entry.id,
        namespace: entry.namespace,
        key: entry.key,
        entry_type: "memory",
        content_preview: "",
        tags: entry.tags,
        classification: entry.classification,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
      }));
    return { results, total: results.length };
  }

  async readBatch(reads: MuninReadRequest[]): Promise<MuninReadResult[]> {
    return reads.map(({ namespace, key }) =>
      this.rows.get(`${namespace}/${key}`) ?? { namespace, key, found: false });
  }
}

describe("verified scheduler evidence history", () => {
  it("hydrates only a complete authenticated chain bound to the exact current result", async () => {
    const munin = new FakeHistoryClient();

    const loaded = await loadVerifiedSchedulerOutcomeHistory(munin, secret, {
      windowSize: 24,
      runtimes: ["codex"],
    });

    expect(loaded.outcomes).toHaveLength(1);
    expect(loaded.outcomes[0]?.decisionId).toBe(decisionId);
    expect(loaded.rejected).toBe(0);
    expect(munin.queries).toEqual([{
      tags: [
        "type:scheduler-outcome-attestation",
        "scheduler-runtime:codex",
        "scheduler-shadow:v1",
      ],
      limit: 24,
    }]);
  });

  it("rejects crash gaps, forged attestations, and changed terminal revisions", async () => {
    for (const mutate of [
      (munin: FakeHistoryClient) => {
        munin.rows.delete(`${decisionNamespace}/claim-attestation`);
      },
      (munin: FakeHistoryClient) => {
        const key = `${decisionNamespace}/outcome-attestation`;
        const existing = munin.rows.get(key)!;
        const content = JSON.parse(existing.content);
        munin.rows.set(key, { ...existing, content: JSON.stringify({
          ...content,
          hmacSha256: "f".repeat(64),
        }) });
      },
      (munin: FakeHistoryClient) => {
        const key = `${taskNamespace}/result-structured`;
        const existing = munin.rows.get(key)!;
        munin.rows.set(key, { ...existing, content: `${existing.content}\n` });
      },
    ]) {
      const munin = new FakeHistoryClient();
      mutate(munin);
      const loaded = await loadVerifiedSchedulerOutcomeHistory(munin, secret, {
        windowSize: 24,
        runtimes: ["codex"],
      });
      expect(loaded.outcomes).toEqual([]);
      expect(loaded.rejected).toBe(1);
    }
  });
});
