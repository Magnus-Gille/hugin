import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { buildBrokerApp, startBroker, type RunningBroker } from "../../src/broker/server.js";
import { BrokerTaskStore, ORCH_V1_TAG } from "../../src/broker/task-store.js";
import { DelegationJournal } from "../../src/broker/journal.js";
import { IdempotencyIndex } from "../../src/broker/idempotency.js";
import { brokerExecutorCapabilities } from "../../src/broker/executor-capabilities.js";
import type { MuninClient } from "../../src/munin-client.js";

const SECRET = "a".repeat(64);
const OTHER_SECRET = "b".repeat(64);

class FakeMunin {
  writes: Array<{ namespace: string; key: string; content: string; tags?: string[] }> = [];
  reads: Record<string, unknown> = {};
  queryReturn: { results: unknown[]; total: number } = { results: [], total: 0 };
  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    _expectedUpdatedAt?: string,
    _classification?: string,
  ): Promise<Record<string, unknown>> {
    this.writes.push({ namespace, key, content, tags });
    this.reads[`${namespace}/${key}`] = {
      namespace, key, content, tags: tags ?? [],
      created_at: "2026-07-11T12:00:00.000Z",
      updated_at: "2026-07-11T12:00:00.000Z",
    };
    return { ok: true };
  }
  async read(namespace: string, key: string): Promise<unknown> {
    return this.reads[`${namespace}/${key}`] ?? null;
  }
  async query(): Promise<{ results: unknown[]; total: number }> {
    return this.queryReturn;
  }
}

interface Harness {
  broker: RunningBroker;
  munin: FakeMunin;
  journal: DelegationJournal;
  idempotency: IdempotencyIndex;
  url: string;
  tmpDir: string;
}

let harness: Harness;

beforeEach(async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "broker-handlers-"));
  const munin = new FakeMunin();
  const journal = new DelegationJournal({ path: path.join(tmpDir, "events.jsonl") });
  const idempotency = new IdempotencyIndex();
  const taskStore = new BrokerTaskStore(munin as unknown as MuninClient);
  const broker = await startBroker({
    host: "127.0.0.1",
    port: 0,
    keys: { "claude-code": SECRET, codex: OTHER_SECRET },
    deps: {
      taskStore,
      journal,
      idempotency,
      executorCapabilities: brokerExecutorCapabilities({ homeserverEnabled: true }),
    },
  });
  const addr = broker.server.address() as AddressInfo;
  harness = {
    broker,
    munin,
    journal,
    idempotency,
    tmpDir,
    url: `http://127.0.0.1:${addr.port}`,
  };
});

afterEach(async () => {
  await harness.broker.close();
  rmSync(harness.tmpDir, { recursive: true, force: true });
});

function authHeader(): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${SECRET}`,
  };
}

function otherAuthHeader(): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${OTHER_SECRET}`,
  };
}

function historicalBrokerStatus(principal = "claude-code"): string {
  return JSON.stringify({ broker_principal: principal });
}

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    envelope_version: 2,
    idempotency_key: "11111111-1111-4111-8111-111111111111",
    orchestrator_session_id: "sess-1",
    orchestrator_submitter: "claude-code",
    task_type: "summarize",
    prompt: "Summarize the README.",
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
    ...overrides,
  };
}

describe("buildBrokerApp", () => {
  it("exposes /health unauthenticated", async () => {
    const res = await fetch(`${harness.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service).toBe("hugin-broker");
    expect(body.principals).toContain("claude-code");
  });

  it("rejects /v1/delegate/submit without auth", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validRequest()),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/delegate/submit", () => {
  it("accepts a valid envelope, returns 202 with task_id", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest()),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.task_id).toMatch(/^mcp-m5-[0-9a-f]{24}$/);
    expect(body.reused_idempotency).toBe(false);
    expect(harness.munin.writes).toHaveLength(1);
    expect(harness.munin.writes[0]!.tags).toContain("broker:mcp-v2");
    expect(harness.munin.writes[0]!.tags).not.toContain("orch-v1");
  });

  it("returns 200 reused_idempotency on retry with same payload", async () => {
    const req = validRequest();
    const r1 = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(req),
    });
    const b1 = await r1.json();
    const r2 = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(req),
    });
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2.task_id).toBe(b1.task_id);
    expect(b2.reused_idempotency).toBe(true);
    expect(harness.munin.writes).toHaveLength(1);
  });

  it("propagates warnings on the in-memory idempotency retry path (#184)", async () => {
    const req = validRequest({
      task_type: "classify",
      prompt: "Classify this ticket as bug or feature.",
    });
    const r1 = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(req),
    });
    expect(r1.status).toBe(202);
    const b1 = await r1.json();
    expect(b1.warnings).toEqual([
      "judgment-type task submitted without verifier or rubric — capability evidence will be weak",
    ]);

    const r2 = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(req),
    });
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2.reused_idempotency).toBe(true);
    expect(b2.warnings).toEqual([
      "judgment-type task submitted without verifier or rubric — capability evidence will be weak",
    ]);
  });

  it("includes a warnings array for a judgment task_type submitted with default l1_review and no rubric (#184)", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest({
        task_type: "classify",
        prompt: "Classify this ticket as bug or feature.",
      })),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.warnings).toEqual([
      "judgment-type task submitted without verifier or rubric — capability evidence will be weak",
    ]);
  });

  it("omits warnings when a judgment task_type carries an explicit verifier (#184)", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest({
        task_type: "classify",
        prompt: "Classify this ticket as bug or feature.",
        acceptance: { mode: "verifier", verifier: { type: "nonEmpty" } },
      })),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.warnings).toBeUndefined();
  });

  it("omits warnings when a judgment task_type's prompt has a rubric section (#184)", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest({
        task_type: "triage",
        prompt: "Triage this issue.\n\n## Rubric\n- p0: data loss\n- p1: broken feature",
      })),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.warnings).toBeUndefined();
  });

  it("never warns for a non-judgment task_type (#184)", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest({ task_type: "summarize", prompt: "Summarize the README." })),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.warnings).toBeUndefined();
  });

  it("reuses the persisted task after a fresh Broker instance and ignores MCP session rotation", async () => {
    const first = validRequest();
    const firstResponse = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST", headers: authHeader(), body: JSON.stringify(first),
    });
    const accepted = await firstResponse.json();

    const restarted = await startBroker({
      host: "127.0.0.1",
      port: 0,
      keys: { "claude-code": SECRET },
      deps: {
        taskStore: new BrokerTaskStore(harness.munin as unknown as MuninClient),
        journal: harness.journal,
        idempotency: new IdempotencyIndex(),
        executorCapabilities: brokerExecutorCapabilities({ homeserverEnabled: true }),
      },
    });
    try {
      const addr = restarted.server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/delegate/submit`, {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify(validRequest({ orchestrator_session_id: "new-mcp-session" })),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        task_id: accepted.task_id,
        reused_idempotency: true,
      });
      expect(harness.munin.writes.filter((write) => write.key === "status")).toHaveLength(1);

      const collision = await fetch(`http://127.0.0.1:${addr.port}/v1/delegate/submit`, {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify(validRequest({ prompt: "different", orchestrator_session_id: "third" })),
      });
      expect(collision.status).toBe(409);
    } finally {
      await restarted.close();
    }
  });

  it("propagates warnings on the persisted-envelope reuse path after a fresh Broker instance (#184)", async () => {
    const first = validRequest({
      task_type: "triage",
      prompt: "Triage this issue and assign a severity.",
    });
    const firstResponse = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST", headers: authHeader(), body: JSON.stringify(first),
    });
    expect((await firstResponse.json()).warnings).toEqual([
      "judgment-type task submitted without verifier or rubric — capability evidence will be weak",
    ]);

    const restarted = await startBroker({
      host: "127.0.0.1",
      port: 0,
      keys: { "claude-code": SECRET },
      deps: {
        taskStore: new BrokerTaskStore(harness.munin as unknown as MuninClient),
        journal: harness.journal,
        idempotency: new IdempotencyIndex(),
        executorCapabilities: brokerExecutorCapabilities({ homeserverEnabled: true }),
      },
    });
    try {
      const addr = restarted.server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/delegate/submit`, {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify(first),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reused_idempotency).toBe(true);
      expect(body.warnings).toEqual([
        "judgment-type task submitted without verifier or rubric — capability evidence will be weak",
      ]);
    } finally {
      await restarted.close();
    }
  });

  it("returns 409 collision when key reused with different payload", async () => {
    const r1 = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest({ prompt: "first" })),
    });
    expect(r1.status).toBe(202);
    const r2 = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest({ prompt: "second" })),
    });
    expect(r2.status).toBe(409);
    const body = await r2.json();
    expect(body.error).toBe("policy_rejected");
    expect(body.existing_task_id).toBeDefined();
  });

  it("scopes concurrent idempotency reservations by authenticated principal", async () => {
    const claude = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest()),
    });
    const codex = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: otherAuthHeader(),
      body: JSON.stringify(validRequest({ orchestrator_submitter: "codex" })),
    });
    expect(claude.status).toBe(202);
    expect(codex.status).toBe(202);
    expect((await claude.json()).task_id).not.toBe((await codex.json()).task_id);
  });

  it("rejects invalid envelope shape", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({ envelope_version: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it.each([
    { timeout_ms: 900_001 },
    { max_output_tokens: 32_769 },
  ])("rejects an unbounded leaf budget before persistence: %j", async (budget) => {
    const res = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest(budget)),
    });
    expect(res.status).toBe(400);
    expect(harness.munin.writes).toHaveLength(0);
  });

  it("rejects an unknown or malformed verifier before durable state", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest({
        acceptance: { mode: "verifier", verifier: { type: "arbitrary-code", command: "rm" } },
      })),
    });
    expect(res.status).toBe(400);
    expect(harness.munin.writes).toHaveLength(0);
  });

  it.each(["tiny", "medium", "pi-large-coder"])(
    "rejects configured alias %s when no live Broker executor exists",
    async (alias) => {
      const res = await fetch(`${harness.url}/v1/delegate/submit`, {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify(validRequest({ alias_requested: alias })),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("alias_unavailable");
      expect(body.reason).toBe("no_executor_implemented");
      expect(body.retryable).toBe(false);
      expect(body.executable_aliases).toEqual(["m5"]);
      expect(harness.munin.writes).toHaveLength(0);
      expect(await harness.journal.readAll()).toEqual([]);

      // Availability rejection happens before idempotency reservation: the
      // same logical key remains usable for an executable alias.
      const supported = await fetch(`${harness.url}/v1/delegate/submit`, {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify(validRequest()),
      });
      expect(supported.status).toBe(202);
      expect(harness.munin.writes).toHaveLength(1);
    },
  );

  it("rejects alias-map version skew before creating durable state", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest({ alias_map_version: 99 })),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("policy_rejected");
    expect(body.alias_map_version).toBe(2);
    expect(harness.munin.writes).toHaveLength(0);
  });

  it("rejects worktree on non-harness alias", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(
        validRequest({
          alias_requested: "m5",
          worktree: { repo: "hugin", base_ref: "main" },
        }),
      ),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/delegate/await", () => {
  it("returns unknown for missing task", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/await`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({ task_id: "nope" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("unknown");
  });

  it("returns running for a pending task with empty lease info", async () => {
    harness.munin.reads["tasks/t1/status"] = {
      id: "1",
      namespace: "tasks/t1",
      key: "status",
      content: historicalBrokerStatus(),
      tags: ["pending", ORCH_V1_TAG],
      created_at: "ts",
      updated_at: "ts",
    };
    const res = await fetch(`${harness.url}/v1/delegate/await`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({ task_id: "t1" }),
    });
    const body = await res.json();
    expect(body.status).toBe("running");
    expect(body.lease.claimed_by).toBeNull();
    expect(body.lease.lease_expires_at).toBeNull();
    expect(body.orphan_suspected).toBe(false);
  });

  it("populates lease info from claimed_by/lease_expires tags on a running task (F4)", async () => {
    const future = Date.now() + 600_000;
    harness.munin.reads["tasks/t1/status"] = {
      id: "1",
      namespace: "tasks/t1",
      key: "status",
      content: historicalBrokerStatus(),
      tags: [
        "running",
        ORCH_V1_TAG,
        "claimed_by:orch-worker-A",
        `lease_expires:${future}`,
      ],
      created_at: "2026-04-26T12:00:00Z",
      updated_at: "2026-04-26T12:00:01Z",
    };
    const res = await fetch(`${harness.url}/v1/delegate/await`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({ task_id: "t1" }),
    });
    const body = await res.json();
    expect(body.status).toBe("running");
    expect(body.lease.claimed_by).toBe("orch-worker-A");
    expect(body.lease.claimed_at).toBe("2026-04-26T12:00:01Z");
    expect(body.lease.lease_expires_at).toBe(new Date(future).toISOString());
    expect(body.orphan_suspected).toBe(false);
  });

  it("flags orphan_suspected when the lease has already expired (F4)", async () => {
    const past = Date.now() - 600_000;
    harness.munin.reads["tasks/t1/status"] = {
      id: "1",
      namespace: "tasks/t1",
      key: "status",
      content: historicalBrokerStatus(),
      tags: [
        "running",
        ORCH_V1_TAG,
        "claimed_by:orch-worker-stale",
        `lease_expires:${past}`,
      ],
      created_at: "2026-04-26T12:00:00Z",
      updated_at: "2026-04-26T12:00:01Z",
    };
    const res = await fetch(`${harness.url}/v1/delegate/await`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({ task_id: "t1" }),
    });
    const body = await res.json();
    expect(body.status).toBe("running");
    expect(body.lease.claimed_by).toBe("orch-worker-stale");
    expect(body.orphan_suspected).toBe(true);
  });

  it("returns completed with structured result", async () => {
    harness.munin.reads["tasks/t1/status"] = {
      content: historicalBrokerStatus(),
      tags: ["completed", ORCH_V1_TAG],
      created_at: "ts",
      updated_at: "ts",
    };
    harness.munin.reads["tasks/t1/result-structured"] = {
      content: JSON.stringify({ task_id: "t1", result_schema_version: 1 }),
    };
    const res = await fetch(`${harness.url}/v1/delegate/await`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({ task_id: "t1" }),
    });
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.result.task_id).toBe("t1");
  });

  // Durable-handoff evidence (#164) — the #165 gate criterion that nothing
  // recorded before: did a result outlive the session that asked for it?
  it("records a durable handoff when a LATER session collects the terminal result", async () => {
    const submit = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest({ orchestrator_session_id: "session-A" })),
    });
    const { task_id } = await submit.json();

    const statusKey = `tasks/${task_id}/status`;
    const stored = harness.munin.reads[statusKey] as { content: string };
    harness.munin.reads[statusKey] = { ...stored, tags: ["completed", "broker:mcp-v2"] };
    harness.munin.reads[`tasks/${task_id}/result-structured`] = {
      content: JSON.stringify({ task_id, bodyText: "ok" }),
    };

    // A DIFFERENT MCP process collects the result: the original conductor is gone.
    const res = await fetch(`${harness.url}/v1/delegate/await`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({ task_id, orchestrator_session_id: "session-B" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("completed");

    // The write is fire-and-forget, so let the microtask queue drain.
    await vi.waitFor(() => {
      const obs = harness.munin.writes.find(
        (w) => w.key === "await-observation" && w.namespace === `tasks/${task_id}`
      );
      expect(obs).toBeDefined();
      const parsed = JSON.parse(obs!.content);
      expect(parsed.durableHandoff).toBe(true);
      expect(parsed.terminalCollected).toBe(true);
      expect(parsed.submitSessionId).toBe("session-A");
    });
  });

  it("does not claim a handoff when the submitting session collects its own result", async () => {
    const submit = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest({ orchestrator_session_id: "session-A" })),
    });
    const { task_id } = await submit.json();
    const statusKey = `tasks/${task_id}/status`;
    const stored = harness.munin.reads[statusKey] as { content: string };
    harness.munin.reads[statusKey] = { ...stored, tags: ["completed", "broker:mcp-v2"] };
    harness.munin.reads[`tasks/${task_id}/result-structured`] = {
      content: JSON.stringify({ task_id, bodyText: "ok" }),
    };

    await fetch(`${harness.url}/v1/delegate/await`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({ task_id, orchestrator_session_id: "session-A" }),
    });

    await vi.waitFor(() => {
      const obs = harness.munin.writes.find((w) => w.key === "await-observation");
      expect(obs).toBeDefined();
      const parsed = JSON.parse(obs!.content);
      expect(parsed.terminalCollected).toBe(true);
      expect(parsed.durableHandoff).toBe(false); // same session — nothing proven
    });
  });

  // Evidence collection must never be able to break the thing it observes.
  it("still answers the await when the observation write throws", async () => {
    harness.munin.reads["tasks/t1/status"] = {
      content: historicalBrokerStatus(),
      tags: ["completed", ORCH_V1_TAG],
      created_at: "ts",
      updated_at: "ts",
    };
    harness.munin.reads["tasks/t1/result-structured"] = {
      content: JSON.stringify({ task_id: "t1", result_schema_version: 1 }),
    };
    const originalWrite = harness.munin.write.bind(harness.munin);
    harness.munin.write = vi.fn(async (ns: string, key: string, ...rest: unknown[]) => {
      if (key === "await-observation") throw new Error("munin down");
      return originalWrite(ns, key, ...(rest as [string, string[], unknown, unknown]));
    }) as typeof harness.munin.write;

    const res = await fetch(`${harness.url}/v1/delegate/await`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({ task_id: "t1", orchestrator_session_id: "session-B" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("completed");
  });

  it("recovers ownership from a valid canonical envelope if old terminal tags lost the marker", async () => {
    const submit = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST", headers: authHeader(), body: JSON.stringify(validRequest()),
    });
    const { task_id } = await submit.json();
    const statusKey = `tasks/${task_id}/status`;
    const stored = harness.munin.reads[statusKey] as { content: string };
    harness.munin.reads[statusKey] = {
      ...stored,
      tags: ["completed", "runtime:homeserver"],
      updated_at: "2026-07-11T15:34:31Z",
    };
    harness.munin.reads[`tasks/${task_id}/result-structured`] = {
      content: JSON.stringify({ task_id, bodyText: "ok" }),
    };
    const res = await fetch(`${harness.url}/v1/delegate/await`, {
      method: "POST", headers: authHeader(), body: JSON.stringify({ task_id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "completed",
      result: { task_id, bodyText: "ok" },
    });
  });

  it("returns failed with error result", async () => {
    harness.munin.reads["tasks/t1/status"] = {
      content: historicalBrokerStatus(),
      tags: ["failed", ORCH_V1_TAG],
      created_at: "ts",
      updated_at: "ts",
    };
    harness.munin.reads["tasks/t1/result-error"] = {
      content: JSON.stringify({ task_id: "t1", kind: "internal", message: "boom", retryable: true }),
    };
    const res = await fetch(`${harness.url}/v1/delegate/await`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({ task_id: "t1" }),
    });
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.error.kind).toBe("internal");
  });

  it("returns a cancelled canonical task as terminal instead of running", async () => {
    const submit = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST", headers: authHeader(), body: JSON.stringify(validRequest()),
    });
    const { task_id } = await submit.json();
    const statusKey = `tasks/${task_id}/status`;
    const stored = harness.munin.reads[statusKey] as { content: string };
    harness.munin.reads[statusKey] = {
      ...stored, tags: ["cancelled", "runtime:homeserver", "broker:mcp-v2"],
      updated_at: "ts",
    };
    harness.munin.reads[`tasks/${task_id}/result-structured`] = {
      content: JSON.stringify({ outcome: "cancelled", bodyText: "operator cancelled" }),
      tags: ["result-structured"], created_at: "ts", updated_at: "ts",
    };
    const res = await fetch(`${harness.url}/v1/delegate/await`, {
      method: "POST", headers: authHeader(), body: JSON.stringify({ task_id }),
    });
    expect(await res.json()).toMatchObject({
      status: "failed",
      result: { outcome: "cancelled" },
      error: { kind: "cancelled", retryable: false },
    });
  });

  it("prevents one principal from awaiting another principal's canonical result", async () => {
    const submit = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST", headers: authHeader(), body: JSON.stringify(validRequest()),
    });
    const { task_id } = await submit.json();
    const res = await fetch(`${harness.url}/v1/delegate/await`, {
      method: "POST", headers: otherAuthHeader(), body: JSON.stringify({ task_id }),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/delegate/rate", () => {
  it("writes product feedback to the canonical task and returns 204", async () => {
    harness.munin.reads["tasks/t1/status"] = {
      content: historicalBrokerStatus(),
      tags: ["completed", ORCH_V1_TAG],
      created_at: "ts",
      updated_at: "ts",
    };
    const res = await fetch(`${harness.url}/v1/delegate/rate`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        task_id: "t1",
        rating: "pass",
        rating_reason: "looked right",
        verification_outcome: "accepted_unchanged",
      }),
    });
    expect(res.status).toBe(204);
    expect(harness.munin.writes.at(-1)?.key).toBe("feedback");
    expect(JSON.parse(harness.munin.writes.at(-1)!.content)).toMatchObject({
      task_id: "t1",
      rating: "pass",
      rated_by: "claude-code",
    });
  });

  it("returns 404 if task not found", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/rate`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        task_id: "nope",
        rating: "pass",
        rating_reason: "x",
        verification_outcome: "accepted_unchanged",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("prevents another Broker principal from poisoning canonical product feedback", async () => {
    const submit = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST", headers: authHeader(), body: JSON.stringify(validRequest()),
    });
    const { task_id } = await submit.json();
    const res = await fetch(`${harness.url}/v1/delegate/rate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${OTHER_SECRET}` },
      body: JSON.stringify({
        task_id, rating: "wrong", rating_reason: "poison", verification_outcome: "discarded",
      }),
    });
    expect(res.status).toBe(403);
    expect(harness.munin.writes.some((write) => write.key === "feedback")).toBe(false);
  });

  it("rejects feedback before the canonical task is terminal", async () => {
    const submit = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST", headers: authHeader(), body: JSON.stringify(validRequest()),
    });
    const { task_id } = await submit.json();
    const res = await fetch(`${harness.url}/v1/delegate/rate`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        task_id, rating: "pass", rating_reason: "too early",
        verification_outcome: "accepted_unchanged",
      }),
    });
    expect(res.status).toBe(409);
    expect(harness.munin.writes.some((write) => write.key === "feedback")).toBe(false);
  });
});

describe("GET /v1/delegate/list", () => {
  it("returns empty rows when journal is empty", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/list`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const body = await res.json();
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns submitted canonical tasks from Munin", async () => {
    await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest()),
    });
    const submitted = harness.munin.writes.find((write) => write.key === "status")!;
    harness.munin.queryReturn = {
      results: [{ namespace: submitted.namespace, key: "status", tags: submitted.tags }],
      total: 1,
    };
    const res = await fetch(`${harness.url}/v1/delegate/list`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.rows[0].alias).toBe("m5");
  });

  it("marks the returned total as truncated when Munin capped candidate discovery", async () => {
    await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest()),
    });
    const submitted = harness.munin.writes.find((write) => write.key === "status")!;
    harness.munin.queryReturn = {
      results: [{ namespace: submitted.namespace, key: "status", tags: submitted.tags }],
      total: 101,
    };

    const res = await fetch(`${harness.url}/v1/delegate/list`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const body = await res.json();

    expect(body.rows).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.truncated).toBe(true);
  });

  it("lists only canonical tasks owned by the authenticated principal", async () => {
    await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST", headers: authHeader(), body: JSON.stringify(validRequest()),
    });
    await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST", headers: otherAuthHeader(),
      body: JSON.stringify(validRequest({ orchestrator_submitter: "codex" })),
    });
    const statuses = harness.munin.writes.filter((write) => write.key === "status");
    harness.munin.queryReturn = {
      results: statuses.map((write) => ({
        namespace: write.namespace, key: "status", tags: write.tags,
      })),
      total: statuses.length,
    };
    const claude = await fetch(`${harness.url}/v1/delegate/list`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const codex = await fetch(`${harness.url}/v1/delegate/list`, {
      headers: { authorization: `Bearer ${OTHER_SECRET}` },
    });
    expect((await claude.json()).rows).toHaveLength(1);
    expect((await codex.json()).rows).toHaveLength(1);
  });

  it("keeps historical orch-v1 journal rows readable without new dual writes", async () => {
    await harness.journal.append({
      event_schema_version: 1,
      event_type: "delegation_submitted",
      event_ts: "2026-04-26T12:00:00Z",
      task_id: "legacy-orch-task",
      envelope: {
        envelope_version: 1,
        idempotency_key: "11111111-1111-4111-8111-111111111111",
        orchestrator_session_id: "legacy",
        orchestrator_submitter: "claude-code",
        task_type: "summarize",
        prompt: "legacy",
        alias_requested: "large-reasoning",
        alias_map_version: 1,
        task_id: "legacy-orch-task",
        broker_principal: "claude-code",
        received_at: "2026-04-26T12:00:00Z",
        alias_resolved: {
          alias: "large-reasoning", family: "one-shot", model_requested: "openai/gpt-oss-120b",
          runtime: "openrouter", runtime_row_id: "openrouter", host: "openrouter",
        },
        policy_version: "zdr-v1+rlv-v1",
      },
      prompt_chars: 6,
      prompt_sha256: "legacy",
    } as never);
    const res = await fetch(`${harness.url}/v1/delegate/list`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].task_id).toBe("legacy-orch-task");
    expect(body.rows[0].envelope.alias_requested).toBe("large-reasoning");
  });

  // #181: a task that is visible right after submission must stay visible
  // after a rating event (hugin_rate) is appended, including under an
  // explicit since_ts filter — the acceptance criterion from the issue.
  it("keeps a rated task visible under since_ts even when the query window no longer contains its status entry", async () => {
    const submit = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST", headers: authHeader(), body: JSON.stringify(validRequest()),
    });
    const { task_id } = await submit.json();
    const statusEntry = harness.munin.reads[`tasks/${task_id}/status`] as {
      content: string; tags: string[];
    };
    // Mark it terminal so hugin_rate is allowed to write feedback.
    harness.munin.reads[`tasks/${task_id}/status`] = { ...statusEntry, tags: ["completed"] };

    const rate = await fetch(`${harness.url}/v1/delegate/rate`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        task_id, rating: "pass", rating_reason: "correct", verification_outcome: "accepted_unchanged",
      }),
    });
    expect(rate.status).toBe(204);

    // Simulate the Munin-side truncated query window after rating: only the
    // co-tagged `feedback` entry survived the cap, not the `status` entry.
    harness.munin.queryReturn = {
      results: [
        { namespace: `tasks/${task_id}`, key: "feedback", tags: ["broker:mcp-v2", "feedback"] },
      ],
      total: 1,
    };

    const res = await fetch(
      `${harness.url}/v1/delegate/list?since_ts=${encodeURIComponent("2000-01-01T00:00:00Z")}`,
      { headers: { authorization: `Bearer ${SECRET}` } },
    );
    const body = await res.json();
    expect(body.rows.map((r: { task_id: string }) => r.task_id)).toContain(task_id);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /v1/delegate/models", () => {
  it("advertises only aliases and runtime rows backed by a live executor", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/models`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alias_map_version).toBe(2);
    expect(body.aliases.map((entry: { alias: string }) => entry.alias)).toEqual([
      "m5",
    ]);
    expect(body.runtime_rows.map((row: { id: string }) => row.id)).toEqual([
      "homeserver-m5",
    ]);
    expect(body.policy_version).toBe("zdr-v1+rlv-v1");
  });

  it("advertises nothing and rejects m5 when its executor is disabled", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "broker-disabled-"));
    const munin = new FakeMunin();
    const broker = await startBroker({
      host: "127.0.0.1",
      port: 0,
      keys: { "claude-code": SECRET },
      deps: {
        taskStore: new BrokerTaskStore(munin as unknown as MuninClient),
        journal: new DelegationJournal({ path: path.join(tmpDir, "events.jsonl") }),
        idempotency: new IdempotencyIndex(),
        executorCapabilities: brokerExecutorCapabilities({
          homeserverEnabled: false,
        }),
      },
    });
    try {
      const addr = broker.server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      const models = await fetch(`${url}/v1/delegate/models`, {
        headers: { authorization: `Bearer ${SECRET}` },
      });
      const modelBody = await models.json();
      expect(modelBody.aliases).toEqual([]);
      expect(modelBody.runtime_rows).toEqual([]);

      const submit = await fetch(`${url}/v1/delegate/submit`, {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify(validRequest()),
      });
      expect(submit.status).toBe(503);
      expect(await submit.json()).toMatchObject({
        error: "alias_unavailable",
        reason: "executor_disabled",
        retryable: true,
        executable_aliases: [],
      });
      expect(munin.writes).toHaveLength(0);
    } finally {
      await broker.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("buildBrokerApp (in-process)", () => {
  it("constructs an Express app with all routes", () => {
    const app = buildBrokerApp({
      host: "127.0.0.1",
      port: 0,
      keys: { "claude-code": SECRET },
      deps: {
        taskStore: new BrokerTaskStore(new FakeMunin() as unknown as MuninClient),
        journal: new DelegationJournal({
          path: path.join(harness.tmpDir, "ignored.jsonl"),
        }),
        idempotency: new IdempotencyIndex(),
        executorCapabilities: brokerExecutorCapabilities({
          homeserverEnabled: true,
        }),
      },
    });
    expect(app).toBeDefined();
  });
});
