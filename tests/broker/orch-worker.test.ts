import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrchWorker, buildClaimTags } from "../../src/broker/orch-worker.js";
import {
  BrokerTaskStore,
  ORCH_V1_TAG,
  RESULT_ERROR_KEY,
  RESULT_STRUCTURED_KEY,
  STATUS_KEY,
  buildSubmitTags,
} from "../../src/broker/task-store.js";
import { DelegationJournal } from "../../src/broker/journal.js";
import type {
  DelegationEnvelope,
  DelegationError,
} from "../../src/broker/types.js";
import type { OpenRouterClient } from "../../src/openrouter-client.js";
import type {
  MuninClient,
  MuninEntry,
  MuninQueryResult,
} from "../../src/munin-client.js";

interface WriteCall {
  namespace: string;
  key: string;
  content: string;
  tags?: string[];
  expectedUpdatedAt?: string;
  classification?: string;
}

class FakeMunin {
  writes: WriteCall[] = [];
  // Per-key store keyed by `namespace/key` → MuninEntry
  store = new Map<string, MuninEntry>();
  // What query() returns; tests set this directly to control selection.
  queryResults: MuninQueryResult[] = [];
  // If true, the next write() rejects (simulates CAS conflict).
  rejectNextWrite: { remaining: number; error: Error } | null = null;

  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
  ): Promise<Record<string, unknown>> {
    if (this.rejectNextWrite && this.rejectNextWrite.remaining > 0) {
      this.rejectNextWrite.remaining--;
      throw this.rejectNextWrite.error;
    }
    const k = `${namespace}/${key}`;
    const now = new Date().toISOString();
    const prior = this.store.get(k);
    const entry: MuninEntry = {
      id: prior?.id ?? `id-${k}-${this.writes.length}`,
      namespace,
      key,
      content,
      tags: tags ?? [],
      classification,
      created_at: prior?.created_at ?? now,
      updated_at: `t${this.writes.length + 1}`,
    };
    this.store.set(k, entry);
    this.writes.push({ namespace, key, content, tags, expectedUpdatedAt, classification });
    return { ok: true };
  }

  async read(
    namespace: string,
    key: string,
  ): Promise<(MuninEntry & { found: true }) | null> {
    const entry = this.store.get(`${namespace}/${key}`);
    return entry ? ({ ...entry, found: true } as MuninEntry & { found: true }) : null;
  }

  async query(_opts: {
    query: string;
    tags?: string[];
    namespace?: string;
    limit?: number;
    entry_type?: string;
  }): Promise<{ results: MuninQueryResult[]; total: number }> {
    return { results: this.queryResults, total: this.queryResults.length };
  }
}

function makeEnvelope(taskId: string, overrides: Partial<DelegationEnvelope> = {}): DelegationEnvelope {
  return {
    envelope_version: 1,
    idempotency_key: "11111111-1111-4111-8111-111111111111",
    orchestrator_session_id: "sess-1",
    orchestrator_submitter: "claude-code",
    task_type: "summarize",
    prompt: "Summarize the README.",
    alias_requested: "large-reasoning",
    alias_map_version: 1,
    task_id: taskId,
    broker_principal: "claude-code",
    received_at: "2026-04-26T12:00:00Z",
    alias_resolved: {
      alias: "large-reasoning",
      family: "one-shot",
      model_requested: "openai/gpt-oss-120b",
      runtime: "openrouter",
      runtime_row_id: "openrouter",
      host: "openrouter",
      reasoning_level: "medium",
    },
    policy_version: "zdr-v1+rlv-v1",
    ...overrides,
  };
}

function seedPendingTask(
  munin: FakeMunin,
  envelope: DelegationEnvelope,
  createdAt: string,
): MuninQueryResult {
  const ns = `tasks/${envelope.task_id}`;
  const tags = buildSubmitTags(envelope);
  const content = JSON.stringify(envelope);
  const entry: MuninEntry = {
    id: `id-${envelope.task_id}`,
    namespace: ns,
    key: STATUS_KEY,
    content,
    tags,
    created_at: createdAt,
    updated_at: createdAt,
  };
  munin.store.set(`${ns}/${STATUS_KEY}`, entry);
  return {
    id: entry.id,
    namespace: ns,
    key: STATUS_KEY,
    entry_type: "state",
    content_preview: content.slice(0, 80),
    tags,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function stubClient(
  handler: (req: { model: string; prompt: string }) => Promise<{
    output: string;
    finishReason: string;
    modelEffective: string;
    usage: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    raw: unknown;
  }>,
): OpenRouterClient {
  return { chat: handler } as unknown as OpenRouterClient;
}

let tmpDir: string;
let journalPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "orch-worker-test-"));
  journalPath = path.join(tmpDir, "events.jsonl");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("OrchWorker.runOnce", () => {
  it("returns idle when no pending tasks exist", async () => {
    const munin = new FakeMunin();
    const taskStore = new BrokerTaskStore(munin as unknown as MuninClient);
    const journal = new DelegationJournal({ path: journalPath });
    const client = stubClient(async () => {
      throw new Error("should not be called");
    });
    const worker = new OrchWorker({
      munin: munin as unknown as MuninClient,
      taskStore,
      journal,
      openrouterClient: client,
      workerId: "w1",
    });

    const tick = await worker.runOnce();
    expect(tick.outcome).toBe("idle");
    expect(munin.writes.length).toBe(0);
  });

  it("claims a pending openrouter task, executes it, and writes result + status flip", async () => {
    const munin = new FakeMunin();
    const env = makeEnvelope("20260426-120000-orch-aaaa1111");
    const queryRow = seedPendingTask(munin, env, "2026-04-26T12:00:00Z");
    munin.queryResults = [queryRow];

    const taskStore = new BrokerTaskStore(munin as unknown as MuninClient);
    const journal = new DelegationJournal({ path: journalPath });
    const client = stubClient(async (req) => ({
      output: "the answer",
      finishReason: "stop",
      modelEffective: req.model,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      raw: {},
    }));

    const worker = new OrchWorker({
      munin: munin as unknown as MuninClient,
      taskStore,
      journal,
      openrouterClient: client,
      workerId: "worker-A",
      now: () => new Date("2026-04-26T12:00:01Z"),
    });

    const tick = await worker.runOnce();
    expect(tick.outcome).toBe("completed");
    expect(tick.task_id).toBe(env.task_id);

    // Three writes expected: claim (running + lease), result-structured, status-flip-completed.
    const ns = `tasks/${env.task_id}`;
    const writesForTask = munin.writes.filter((w) => w.namespace === ns);
    expect(writesForTask.length).toBe(3);

    const claim = writesForTask[0]!;
    expect(claim.key).toBe(STATUS_KEY);
    expect(claim.tags).toContain("running");
    expect(claim.tags).toContain("claimed_by:worker-A");
    expect(claim.tags?.some((t) => t.startsWith("lease_expires:"))).toBe(true);
    expect(claim.expectedUpdatedAt).toBe("2026-04-26T12:00:00Z");

    const resultWrite = writesForTask[1]!;
    expect(resultWrite.key).toBe(RESULT_STRUCTURED_KEY);
    const parsedResult = JSON.parse(resultWrite.content);
    expect(parsedResult.output).toBe("the answer");
    expect(parsedResult.runtime_effective).toBe("openrouter");

    const flip = writesForTask[2]!;
    expect(flip.key).toBe(STATUS_KEY);
    expect(flip.tags).toContain("completed");
    expect(flip.tags).not.toContain("running");

    // Journal got a delegation_completed event with telemetry.
    const events = await journal.readAll();
    const completed = events.filter((e) => e.event_type === "delegation_completed");
    expect(completed.length).toBe(1);
    const e = completed[0]!;
    if (e.event_type !== "delegation_completed") throw new Error("type narrow");
    expect(e.outcome).toBe("completed");
    expect(e.task_id).toBe(env.task_id);
    expect(e.total_tokens).toBe(15);
    expect(e.runtime_effective).toBe("openrouter");
  });

  it("writes result-error and flips to failed when the executor returns an error", async () => {
    const munin = new FakeMunin();
    const env = makeEnvelope("20260426-120000-orch-bbbb2222");
    munin.queryResults = [seedPendingTask(munin, env, "2026-04-26T12:00:00Z")];

    const taskStore = new BrokerTaskStore(munin as unknown as MuninClient);
    const journal = new DelegationJournal({ path: journalPath });
    const client = stubClient(async () => ({
      output: "",
      finishReason: "length",
      modelEffective: "openai/gpt-oss-120b",
      usage: { prompt_tokens: 8, completion_tokens: 0, total_tokens: 8 },
      raw: {},
    }));

    const worker = new OrchWorker({
      munin: munin as unknown as MuninClient,
      taskStore,
      journal,
      openrouterClient: client,
      workerId: "worker-A",
    });

    const tick = await worker.runOnce();
    expect(tick.outcome).toBe("failed");

    const ns = `tasks/${env.task_id}`;
    const writesForTask = munin.writes.filter((w) => w.namespace === ns);
    // claim + result-error + status flip → 3 writes
    expect(writesForTask.length).toBe(3);
    expect(writesForTask[1]!.key).toBe(RESULT_ERROR_KEY);
    const err = JSON.parse(writesForTask[1]!.content) as DelegationError;
    expect(err.kind).toBe("executor_failed");
    expect(err.message).toContain("empty completion");
    expect(writesForTask[2]!.tags).toContain("failed");

    const events = await journal.readAll();
    const completed = events.find((e) => e.event_type === "delegation_completed");
    expect(completed).toBeDefined();
    if (completed?.event_type !== "delegation_completed") throw new Error("type narrow");
    expect(completed.outcome).toBe("failed");
    expect(completed.error_kind).toBe("executor_failed");
  });

  it("skips tasks whose resolved runtime is not openrouter", async () => {
    const munin = new FakeMunin();
    const env = makeEnvelope("20260426-120000-orch-cccc3333", {
      alias_resolved: {
        alias: "pi-large-coder",
        family: "harness",
        harness: "pi",
        model_requested: "qwen/qwen3-coder-next",
        runtime: "openrouter",
        runtime_row_id: "openrouter",
        host: "openrouter",
      },
    });
    munin.queryResults = [seedPendingTask(munin, env, "2026-04-26T12:00:00Z")];

    const taskStore = new BrokerTaskStore(munin as unknown as MuninClient);
    const journal = new DelegationJournal({ path: journalPath });
    let chatCalled = false;
    const client = stubClient(async () => {
      chatCalled = true;
      throw new Error("should not be called");
    });

    const worker = new OrchWorker({
      munin: munin as unknown as MuninClient,
      taskStore,
      journal,
      openrouterClient: client,
      workerId: "w1",
    });

    const tick = await worker.runOnce();
    expect(tick.outcome).toBe("skipped");
    expect(chatCalled).toBe(false);
    // No writes — task stays pending for a future executor.
    expect(munin.writes.length).toBe(0);
  });

  it("returns claimed_lost when the CAS write fails", async () => {
    const munin = new FakeMunin();
    const env = makeEnvelope("20260426-120000-orch-dddd4444");
    munin.queryResults = [seedPendingTask(munin, env, "2026-04-26T12:00:00Z")];
    munin.rejectNextWrite = {
      remaining: 1,
      error: new Error("Munin write rejected for tasks/.../status: cas_conflict — updated_at mismatch"),
    };

    const taskStore = new BrokerTaskStore(munin as unknown as MuninClient);
    const journal = new DelegationJournal({ path: journalPath });
    const client = stubClient(async () => {
      throw new Error("should not be called");
    });

    const worker = new OrchWorker({
      munin: munin as unknown as MuninClient,
      taskStore,
      journal,
      openrouterClient: client,
      workerId: "w1",
    });

    const tick = await worker.runOnce();
    expect(tick.outcome).toBe("claimed_lost");
  });

  it("flips an unparseable envelope straight to failed without claiming", async () => {
    const munin = new FakeMunin();
    const ns = "tasks/20260426-120000-orch-eeee5555";
    const tags = ["pending", "runtime:openrouter", "alias:large-reasoning", ORCH_V1_TAG];
    const entry: MuninEntry = {
      id: "id-bad",
      namespace: ns,
      key: STATUS_KEY,
      content: "{not valid json",
      tags,
      created_at: "2026-04-26T12:00:00Z",
      updated_at: "2026-04-26T12:00:00Z",
    };
    munin.store.set(`${ns}/${STATUS_KEY}`, entry);
    munin.queryResults = [
      {
        id: entry.id,
        namespace: ns,
        key: STATUS_KEY,
        entry_type: "state",
        content_preview: entry.content,
        tags,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
      },
    ];

    const taskStore = new BrokerTaskStore(munin as unknown as MuninClient);
    const journal = new DelegationJournal({ path: journalPath });
    const client = stubClient(async () => {
      throw new Error("should not be called");
    });

    const worker = new OrchWorker({
      munin: munin as unknown as MuninClient,
      taskStore,
      journal,
      openrouterClient: client,
      workerId: "w1",
    });

    const tick = await worker.runOnce();
    expect(tick.outcome).toBe("error");
    const writesForTask = munin.writes.filter((w) => w.namespace === ns);
    // result-error + status-flip-failed (no running claim).
    expect(writesForTask.length).toBe(2);
    expect(writesForTask[0]!.key).toBe(RESULT_ERROR_KEY);
    expect(writesForTask[1]!.tags).toContain("failed");
  });

  it("picks the FIFO oldest pending task when several are queued", async () => {
    const munin = new FakeMunin();
    const env1 = makeEnvelope("20260426-120000-orch-old00001");
    const env2 = makeEnvelope("20260426-120100-orch-new00002");
    // Insert in reversed timestamp order to prove sort.
    munin.queryResults = [
      seedPendingTask(munin, env2, "2026-04-26T12:01:00Z"),
      seedPendingTask(munin, env1, "2026-04-26T12:00:00Z"),
    ];

    const taskStore = new BrokerTaskStore(munin as unknown as MuninClient);
    const journal = new DelegationJournal({ path: journalPath });
    const client = stubClient(async (req) => ({
      output: "ok",
      finishReason: "stop",
      modelEffective: req.model,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      raw: {},
    }));

    const worker = new OrchWorker({
      munin: munin as unknown as MuninClient,
      taskStore,
      journal,
      openrouterClient: client,
      workerId: "w1",
    });

    const tick = await worker.runOnce();
    expect(tick.outcome).toBe("completed");
    expect(tick.task_id).toBe(env1.task_id);
  });
});

describe("buildClaimTags", () => {
  it("strips lifecycle + prior lease tags and adds the new ones", () => {
    const out = buildClaimTags(
      [
        "pending",
        "runtime:openrouter",
        "alias:tiny",
        ORCH_V1_TAG,
        "claimed_by:old-worker",
        "lease_expires:1234",
      ],
      "new-worker",
      9999,
    );
    expect(out).toContain("running");
    expect(out).not.toContain("pending");
    expect(out).toContain("runtime:openrouter");
    expect(out).toContain("alias:tiny");
    expect(out).toContain(ORCH_V1_TAG);
    expect(out).toContain("claimed_by:new-worker");
    expect(out).toContain("lease_expires:9999");
    // No leftover prior lease.
    expect(out).not.toContain("claimed_by:old-worker");
    expect(out).not.toContain("lease_expires:1234");
  });
});
