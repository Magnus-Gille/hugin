import { describe, expect, it } from "vitest";
import type { MuninEntry, MuninClient } from "../../src/munin-client.js";
import { BrokerTaskStore } from "../../src/broker/task-store.js";
import { BROKER_TASK_TYPE_TAXONOMY_VERSION } from "../../src/broker/task-type-metadata.js";
import type { DelegationEnvelope } from "../../src/broker/types.js";
import { buildDailyExamCandidate } from "../../src/learning/daily-task-exam-factory.js";
import { buildTerminalStatusTags } from "../../src/task-status-tags.js";

class PersistingMunin {
  status: MuninEntry | null = null;

  async write(
    namespace: string,
    key: string,
    content: string,
    tags: string[] = [],
    _expectedUpdatedAt?: string,
    classification = "internal",
  ): Promise<Record<string, unknown>> {
    if (key === "status") {
      this.status = {
        id: `${namespace}/${key}`,
        namespace,
        key,
        content,
        tags,
        classification,
        created_at: "2026-07-18T10:00:00.000Z",
        updated_at: "2026-07-18T10:00:00.000Z",
      };
    }
    return { ok: true };
  }
}

function brokerEnvelope(): DelegationEnvelope {
  return {
    envelope_version: 2,
    idempotency_key: "11111111-1111-4111-8111-111111111111",
    orchestrator_session_id: "sess-1",
    orchestrator_submitter: "claude-code",
    task_type: "summarize",
    prompt: "Summarize the release notes.",
    alias_requested: "m5",
    alias_map_version: 2,
    sensitivity: "internal",
    timeout_ms: 300_000,
    max_output_tokens: 4_096,
    acceptance: { mode: "l1_review" },
    allowed_destinations: ["m5"],
    tool_policy: { mode: "none" },
    budget: { max_attempts: 1, max_cost_usd: 0 },
    durability: "required",
    delivery: { mode: "munin" },
    escalation: { mode: "return_to_l1" },
    task_id: "broker-summarize-1",
    broker_principal: "claude-code",
    received_at: "2026-07-18T10:00:00.000Z",
    alias_resolved: {
      alias: "m5",
      family: "one-shot",
      model_requested: "gateway-selected",
      runtime: "homeserver",
      runtime_row_id: "homeserver-m5",
      host: "m5",
    },
    policy_version: "zdr-v1+rlv-v1",
  };
}

describe("Broker task type submit to harvest contract", () => {
  it("harvests summarize from the real Broker persistence path without a synthetic type tag", async () => {
    const munin = new PersistingMunin();
    const store = new BrokerTaskStore(munin as unknown as MuninClient);

    await store.submit({ envelope: brokerEnvelope() });

    expect(munin.status).not.toBeNull();
    const persisted = munin.status!;
    expect(persisted.tags).toContain("task-type:summarize");
    expect(persisted.tags).not.toContain("type:summarize");
    persisted.tags = buildTerminalStatusTags("completed", persisted.tags);

    const candidate = buildDailyExamCandidate({ status: persisted });

    expect(candidate.source).toMatchObject({
      taskType: "summarize",
      taskTypeTaxonomyVersion: BROKER_TASK_TYPE_TAXONOMY_VERSION,
      taskTypeSource: "broker-canonical",
    });
  });
});
