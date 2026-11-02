import { createServer, request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBrokerApp } from "../../src/broker/server.js";
import { brokerExecutorCapabilities } from "../../src/broker/executor-capabilities.js";
import type { BrokerTaskStore } from "../../src/broker/task-store.js";
import type { DelegationJournal } from "../../src/broker/journal.js";
import type { IdempotencyIndex } from "../../src/broker/idempotency.js";
import type { LearningExperimentStore } from "../../src/learning/experiment-store.js";

const TOKEN = "a".repeat(64);
const OVER_LIMIT_BODY = Buffer.from(`{"body":"${"x".repeat(2 * 1024 * 1024)}"}`);
const OVER_LIMIT_LENGTH = OVER_LIMIT_BODY.length;

type RawRequest = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer;
};

let baseUrl = "";
let closeServer: (() => Promise<void>) | null = null;

beforeEach(async () => {
  const app = buildBrokerApp({
    host: "127.0.0.1",
    port: 0,
    keys: { codex: TOKEN },
    learningStore: {} as LearningExperimentStore,
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

function sendRaw({ method, path, headers = {}, body = Buffer.alloc(0) }: RawRequest): Promise<{
  status: number;
  body: Buffer;
}> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method,
      headers: {
        ...headers,
        "content-length": String(body.length),
        connection: "close",
      },
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks),
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function sendUnauthenticatedOversized(method: string, path: string): Promise<{
  status: number;
  body: Buffer;
}> {
  const url = new URL(path, baseUrl);
  const prefix = Buffer.from("{}");
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    let requestError: Error | null = null;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`timed out waiting for ${method} ${path} response`));
    }, 2_000);
    const finish = (result: { status: number; body: Buffer }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const req = httpRequest(url, {
      method,
      headers: {
        "content-type": "application/json",
        "content-length": String(OVER_LIMIT_LENGTH),
        connection: "close",
      },
      agent: false,
    }, (res) => {
      responseStarted = true;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        if (requestError && res.statusCode !== 401) {
          fail(requestError);
          return;
        }
        finish({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", (error) => {
      if (!responseStarted) {
        fail(error);
        return;
      }
      requestError = error;
    });
    req.end(prefix);
  });
}

const protectedRoutes = [
  ["POST", "/v1/delegate/submit"],
  ["POST", "/v1/delegate/await"],
  ["POST", "/v1/delegate/rate"],
  ["POST", "/v1/friction/report"],
  ["POST", "/v1/delegate/list"],
  ["GET", "/v1/delegate/list"],
  ["GET", "/v1/delegate/models"],
  ["POST", "/v1/learning/experiments/create"],
  ["POST", "/v1/learning/experiments/observe"],
  ["POST", "/v1/learning/experiments/rate"],
  ["POST", "/v1/learning/experiments/status"],
  ["POST", "/v1/learning/experiments/promote"],
] as const;

const unauthenticatedBodyCases = [
  ["malformed JSON", { "content-type": "application/json" }, Buffer.from("{")],
  [
    "corrupt compressed body",
    { "content-type": "application/json", "content-encoding": "gzip" },
    Buffer.from("not-a-gzip-stream"),
  ],
] as const;

describe("Broker request body boundaries", () => {
  for (const [label, headers, body] of unauthenticatedBodyCases) {
    it.each(protectedRoutes)(
      `rejects ${label} with 401 before parsing on %s %s`,
      async (method, path) => {
        const response = await sendRaw({ method, path, headers, body });
        expect(response.status).toBe(401);
      },
    );
  }

  it.each(protectedRoutes)(
    "rejects an unauthenticated over-limit body with 401 before parsing on %s %s",
    async (method, path) => {
      const response = await sendUnauthenticatedOversized(method, path);
      expect(response.status).toBe(401);
    },
  );

  it.each(protectedRoutes)("rejects malformed JSON on authenticated %s %s", async (method, path) => {
    const response = await sendRaw({
      method,
      path,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: Buffer.from("{"),
    });
    expect(response.status).toBe(400);
  });

  it.each(protectedRoutes)("rejects over-limit bodies on authenticated %s %s", async (method, path) => {
    const response = await sendRaw({
      method,
      path,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: OVER_LIMIT_BODY,
    });
    expect(response.status).toBe(413);
  });

  it("lets the unauthenticated health endpoint bypass body parsing", async () => {
    const response = await sendRaw({
      method: "GET",
      path: "/health",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{"),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString())).toMatchObject({
      status: "ok",
      service: "hugin-broker",
    });
  });

  it("returns 404 for an unknown route without auth or parsing", async () => {
    const response = await sendRaw({
      method: "POST",
      path: "/v1/unknown",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{"),
    });
    expect(response.status).toBe(404);
  });

  it("accepts a valid authenticated compressed request", async () => {
    const ordinary = await sendRaw({
      method: "GET",
      path: "/v1/delegate/models",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ordinary.status).toBe(200);

    const response = await sendRaw({
      method: "GET",
      path: "/v1/delegate/models",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: gzipSync(Buffer.from("{}")),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString())).toEqual(
      JSON.parse(ordinary.body.toString()),
    );
  });
});
