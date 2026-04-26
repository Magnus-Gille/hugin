import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrokerReconciler } from "../../src/broker/reconciliation.js";
import { BrokerTaskStore, ORCH_V1_TAG } from "../../src/broker/task-store.js";
import { DelegationJournal } from "../../src/broker/journal.js";
import type { MuninClient } from "../../src/munin-client.js";
import type { DelegationEnvelope } from "../../src/broker/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "broker-reconcile-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

class FakeMunin {
  inflight: { namespace: string; tags: string[] }[] = [];
  reads: Record<string, unknown> = {};
  writes: { namespace: string; key: string }[] = [];
  async write(namespace: string, key: string): Promise<Record<string, unknown>> {
    this.writes.push({ namespace, key });
    return { ok: true };
  }
  async read(namespace: string, key: string): Promise<unknown> {
    return this.reads[`${namespace}/${key}`] ?? null;
  }
  async query(opts: { tags?: string[] }): Promise<{ results: unknown[]; total: number }> {
    const filter = opts.tags ?? [];
    const results = this.inflight
      .filter((row) => filter.every((t) => row.tags.includes(t)))
      .map((row) => ({
        id: "1",
        namespace: row.namespace,
        key: "status",
        entry_type: "state",
        content_preview: "",
        tags: row.tags,
        created_at: "ts",
        updated_at: "ts",
      }));
    return { results, total: results.length };
  }
}

function envelope(taskId: string): DelegationEnvelope {
  return {
    envelope_version: 1,
    idempotency_key: "11111111-1111-4111-8111-111111111111",
    orchestrator_session_id: "sess-1",
    orchestrator_submitter: "claude-code",
    task_type: "summarize",
    prompt: "Summarize",
    alias_requested: "tiny",
    alias_map_version: 1,
    task_id: taskId,
    broker_principal: "claude-code",
    received_at: "2026-04-26T12:00:00Z",
    alias_resolved: {
      alias: "tiny",
      family: "one-shot",
      model_requested: "qwen2.5:3b",
      runtime: "ollama",
      runtime_row_id: "ollama-pi",
      host: "pi",
    },
    policy_version: "zdr-v1+rlv-v1",
  };
}

describe("BrokerReconciler.runOnce", () => {
  it("backfills delegation_submitted for tasks in Munin but missing from journal", async () => {
    const munin = new FakeMunin();
    munin.inflight = [{ namespace: "tasks/t1", tags: ["pending", ORCH_V1_TAG] }];
    munin.reads["tasks/t1/status"] = {
      content: JSON.stringify(envelope("t1")),
      tags: ["pending", ORCH_V1_TAG],
      created_at: "2026-04-26T12:00:00Z",
      updated_at: "2026-04-26T12:00:00Z",
    };
    const journal = new DelegationJournal({ path: path.join(tmpDir, "events.jsonl") });
    const taskStore = new BrokerTaskStore(munin as unknown as MuninClient);
    const reconciler = new BrokerReconciler({ taskStore, journal });

    const stats = await reconciler.runOnce();
    expect(stats.scanned).toBe(1);
    expect(stats.submittedBackfilled).toBe(1);
    const events = await journal.readAll();
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("delegation_submitted");
    expect(events[0]!.task_id).toBe("t1");
  });

  it("is idempotent — second run does not re-backfill", async () => {
    const munin = new FakeMunin();
    munin.inflight = [{ namespace: "tasks/t1", tags: ["pending", ORCH_V1_TAG] }];
    munin.reads["tasks/t1/status"] = {
      content: JSON.stringify(envelope("t1")),
      tags: ["pending", ORCH_V1_TAG],
      created_at: "2026-04-26T12:00:00Z",
      updated_at: "2026-04-26T12:00:00Z",
    };
    const journal = new DelegationJournal({ path: path.join(tmpDir, "events.jsonl") });
    const taskStore = new BrokerTaskStore(munin as unknown as MuninClient);
    const reconciler = new BrokerReconciler({ taskStore, journal });

    await reconciler.runOnce();
    const stats2 = await reconciler.runOnce();
    expect(stats2.submittedBackfilled).toBe(0);
    const events = await journal.readAll();
    expect(events).toHaveLength(1);
  });

  it("does nothing when no in-flight tasks", async () => {
    const munin = new FakeMunin();
    const journal = new DelegationJournal({ path: path.join(tmpDir, "events.jsonl") });
    const taskStore = new BrokerTaskStore(munin as unknown as MuninClient);
    const reconciler = new BrokerReconciler({ taskStore, journal });
    const stats = await reconciler.runOnce();
    expect(stats.scanned).toBe(0);
    expect(stats.submittedBackfilled).toBe(0);
  });

  it("counts errors and continues on bad envelopes", async () => {
    const munin = new FakeMunin();
    munin.inflight = [{ namespace: "tasks/bad", tags: ["pending", ORCH_V1_TAG] }];
    munin.reads["tasks/bad/status"] = {
      content: "not-json",
      tags: ["pending", ORCH_V1_TAG],
      created_at: "ts",
      updated_at: "ts",
    };
    const journal = new DelegationJournal({ path: path.join(tmpDir, "events.jsonl") });
    const taskStore = new BrokerTaskStore(munin as unknown as MuninClient);
    const reconciler = new BrokerReconciler({ taskStore, journal });
    const stats = await reconciler.runOnce();
    expect(stats.errors).toBe(1);
    expect(stats.submittedBackfilled).toBe(0);
  });
});
