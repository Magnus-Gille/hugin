import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { buildBrokerApp, startBroker, type RunningBroker } from "../../src/broker/server.js";
import { BrokerTaskStore, ORCH_V1_TAG } from "../../src/broker/task-store.js";
import { DelegationJournal } from "../../src/broker/journal.js";
import { IdempotencyIndex } from "../../src/broker/idempotency.js";
import type { MuninClient } from "../../src/munin-client.js";

const SECRET = "a".repeat(64);

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
    keys: { "claude-code": SECRET },
    deps: { taskStore, journal, idempotency },
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

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    envelope_version: 1,
    idempotency_key: "11111111-1111-4111-8111-111111111111",
    orchestrator_session_id: "sess-1",
    orchestrator_submitter: "claude-code",
    task_type: "summarize",
    prompt: "Summarize the README.",
    alias_requested: "tiny",
    alias_map_version: 1,
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
    expect(body.task_id).toMatch(/^\d{8}-\d{6}-orch-[0-9a-f]{8}$/);
    expect(body.reused_idempotency).toBe(false);
    expect(harness.munin.writes).toHaveLength(1);
    expect(harness.munin.writes[0]!.tags).toContain(ORCH_V1_TAG);
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

  it("rejects invalid envelope shape", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({ envelope_version: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects harness alias without worktree", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest({ alias_requested: "pi-large-coder" })),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain("harness aliases require a worktree");
  });

  it("rejects worktree on non-harness alias", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(
        validRequest({
          alias_requested: "tiny",
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

  it("returns running for a pending task", async () => {
    harness.munin.reads["tasks/t1/status"] = {
      id: "1",
      namespace: "tasks/t1",
      key: "status",
      content: "envelope",
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
  });

  it("returns completed with structured result", async () => {
    harness.munin.reads["tasks/t1/status"] = {
      content: "envelope",
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

  it("returns failed with error result", async () => {
    harness.munin.reads["tasks/t1/status"] = {
      content: "envelope",
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
});

describe("POST /v1/delegate/rate", () => {
  it("appends rated event and returns 204", async () => {
    harness.munin.reads["tasks/t1/status"] = {
      content: "envelope",
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
    const events = await harness.journal.readAll();
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("delegation_rated");
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

  it("returns submitted tasks projected from journal", async () => {
    await fetch(`${harness.url}/v1/delegate/submit`, {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify(validRequest()),
    });
    const res = await fetch(`${harness.url}/v1/delegate/list`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.rows[0].envelope.alias_requested).toBe("tiny");
  });
});

describe("GET /v1/delegate/models", () => {
  it("returns alias map + runtime rows + policy_version", async () => {
    const res = await fetch(`${harness.url}/v1/delegate/models`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alias_map_version).toBe(1);
    expect(body.aliases.length).toBeGreaterThan(0);
    expect(body.runtime_rows.length).toBeGreaterThan(0);
    expect(body.policy_version).toBe("zdr-v1+rlv-v1");
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
      },
    });
    expect(app).toBeDefined();
  });
});
