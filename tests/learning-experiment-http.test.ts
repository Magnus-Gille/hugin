import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBrokerApp } from "../src/broker/server.js";
import { brokerExecutorCapabilities } from "../src/broker/executor-capabilities.js";
import type { BrokerTaskStore } from "../src/broker/task-store.js";
import type { DelegationJournal } from "../src/broker/journal.js";
import type { IdempotencyIndex } from "../src/broker/idempotency.js";
import type { MuninClient, MuninEntry } from "../src/munin-client.js";
import { LearningExperimentStore } from "../src/learning/experiment-store.js";
import { makeExperimentInput, makeObservation } from "./fixtures/learning.js";

const CODEX_TOKEN = "a".repeat(64);
const CLAUDE_TOKEN = "b".repeat(64);

class FakeMunin {
  entries = new Map<string, MuninEntry & { found: true }>();
  revision = 0;

  async read(namespace: string, key: string) {
    return this.entries.get(`${namespace}/${key}`) ?? null;
  }

  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
  ): Promise<Record<string, unknown>> {
    const id = `${namespace}/${key}`;
    const existing = this.entries.get(id);
    if (expectedUpdatedAt && existing?.updated_at !== expectedUpdatedAt) {
      throw new Error("CAS conflict");
    }
    const timestamp = `2026-07-13T12:00:${String(++this.revision).padStart(2, "0")}.000Z`;
    this.entries.set(id, {
      id,
      namespace,
      key,
      content,
      tags: tags ?? [],
      classification,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
      found: true,
    });
    return { ok: true };
  }
}

let baseUrl = "";
let closeServer: (() => Promise<void>) | null = null;

beforeEach(async () => {
  const munin = new FakeMunin();
  const app = buildBrokerApp({
    host: "127.0.0.1",
    port: 0,
    keys: { codex: CODEX_TOKEN, "claude-code": CLAUDE_TOKEN },
    learningStore: new LearningExperimentStore(munin as unknown as MuninClient),
    deps: {
      taskStore: {} as BrokerTaskStore,
      journal: {} as DelegationJournal,
      idempotency: {} as IdempotencyIndex,
      executorCapabilities: brokerExecutorCapabilities({ homeserverEnabled: true }),
    },
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

afterEach(async () => {
  await closeServer?.();
  closeServer = null;
});

function headers(token = CODEX_TOKEN): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function post(path: string, body: unknown, token = CODEX_TOKEN): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body),
  });
}

describe("Broker continuous-learning HTTP API", () => {
  it("requires Broker authentication", async () => {
    const response = await fetch(`${baseUrl}/v1/learning/experiments/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ experiment_id: "wave-six-edit-deadline" }),
    });
    expect(response.status).toBe(401);
  });

  it("runs a matched experiment through to a promotion-ready decision", async () => {
    const experiment = makeExperimentInput();
    const created = await post("/v1/learning/experiments/create", experiment);
    expect(created.status).toBe(201);

    for (const sample of ["case-1", "case-2"]) {
      for (const arm of ["champion", "challenger"] as const) {
        const observed = await post(
          "/v1/learning/experiments/observe",
          makeObservation(sample, arm),
        );
        expect(observed.status).toBe(200);
      }
    }

    const status = await post("/v1/learning/experiments/status", {
      experiment_id: "wave-six-edit-deadline",
    });
    expect(status.status).toBe(200);
    const body = await status.json() as {
      state: { status: string; evaluation: { decision: string; matchedPairs: number } };
    };
    expect(body.state.status).toBe("promotion-ready");
    expect(body.state.evaluation).toMatchObject({
      decision: "promotion-ready",
      matchedPairs: 2,
    });

    const promoted = await post("/v1/learning/experiments/promote", {
      experiment_id: "wave-six-edit-deadline",
      configuration_fingerprint: experiment.challenger.fingerprint,
      applied_ref: "gille-inference@abc123",
    });
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({
      state: { status: "promoted" },
      champion: {
        sourceExperimentId: "wave-six-edit-deadline",
        appliedRef: "gille-inference@abc123",
      },
    });
  });

  it("isolates experiment state by authenticated principal", async () => {
    expect((await post("/v1/learning/experiments/create", makeExperimentInput())).status).toBe(201);
    const other = await post(
      "/v1/learning/experiments/status",
      { experiment_id: "wave-six-edit-deadline" },
      CLAUDE_TOKEN,
    );
    expect(other.status).toBe(404);
  });

  it("adds a later product rating through a dedicated authenticated endpoint", async () => {
    expect((await post("/v1/learning/experiments/create", makeExperimentInput())).status).toBe(201);
    const observation = makeObservation("case-1", "champion", {
      product_outcome: "unrated",
      human_review_seconds: undefined,
    });
    expect((await post("/v1/learning/experiments/observe", observation)).status).toBe(200);

    const rated = await post("/v1/learning/experiments/rate", {
      experiment_id: observation.experiment_id,
      run_id: observation.run_id,
      product_outcome: "accepted-unchanged",
      human_review_seconds: 15,
    });
    expect(rated.status).toBe(200);
    expect(await rated.json()).toMatchObject({
      reused: false,
      state: {
        observations: [{
          run_id: observation.run_id,
          product_outcome: "accepted-unchanged",
          human_review_seconds: 15,
          product_rated_by: "codex",
        }],
      },
    });
  });
});
