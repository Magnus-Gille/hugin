import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  executeHomeserverTask,
  loadHomeserverGatewayConfig,
  type HomeserverTaskConfig,
} from "../src/homeserver-executor.js";

function makeTaskConfig(overrides?: Partial<HomeserverTaskConfig>): HomeserverTaskConfig {
  return {
    prompt: "Extract the year from: born 1998.",
    gatewayBaseUrl: "http://m5.test:8080",
    apiKey: "owner-key",
    path: "chat",
    model: "qwen3-coder",
    timeoutMs: 30_000,
    maxOutputChars: 5_000,
    ...overrides,
  };
}

function sseResponse(lines: string[]): Response {
  return new Response(lines.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function jsonResponse(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A streaming SSE response whose bytes are split exactly at the given chunk boundaries. */
function streamResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

let tmpLogDir: string;

beforeEach(() => {
  tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-homeserver-"));
});

afterEach(() => {
  fs.rmSync(tmpLogDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("loadHomeserverGatewayConfig", () => {
  it("returns null when HOMESERVER_GATEWAY_URL is unset", () => {
    expect(loadHomeserverGatewayConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("parses base URL (stripping trailing slash) and api key", () => {
    const cfg = loadHomeserverGatewayConfig({
      HOMESERVER_GATEWAY_URL: "http://127.0.0.1:8080/",
      HOMESERVER_GATEWAY_API_KEY: "k1",
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ baseUrl: "http://127.0.0.1:8080", apiKey: "k1" });
  });

  it("treats a missing api key as empty (keyless loopback gateway)", () => {
    const cfg = loadHomeserverGatewayConfig({
      HOMESERVER_GATEWAY_URL: "http://127.0.0.1:8080",
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ baseUrl: "http://127.0.0.1:8080", apiKey: "" });
  });

  it("allows a keyless gateway on loopback (localhost / 127.0.0.1 / ::1)", () => {
    for (const url of ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"]) {
      expect(loadHomeserverGatewayConfig({ HOMESERVER_GATEWAY_URL: url } as NodeJS.ProcessEnv))
        .toEqual({ baseUrl: url, apiKey: "" });
    }
  });

  it("REFUSES a keyless gateway on a non-loopback host (returns null)", () => {
    expect(loadHomeserverGatewayConfig({ HOMESERVER_GATEWAY_URL: "http://10.0.0.5:8080" } as NodeJS.ProcessEnv)).toBeNull();
    expect(loadHomeserverGatewayConfig({ HOMESERVER_GATEWAY_URL: "http://m5.lan:8080" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("allows a non-loopback gateway when a key is provided", () => {
    expect(loadHomeserverGatewayConfig({
      HOMESERVER_GATEWAY_URL: "http://10.0.0.5:8080",
      HOMESERVER_GATEWAY_API_KEY: "k",
    } as NodeJS.ProcessEnv)).toEqual({ baseUrl: "http://10.0.0.5:8080", apiKey: "k" });
  });

  it("refuses a public or path-bearing gateway even with a key", () => {
    for (const url of [
      "https://example.com",
      "http://10.0.0.5:8080/v1",
      "http://user@10.0.0.5:8080",
      "ftp://10.0.0.5:8080",
    ]) {
      expect(loadHomeserverGatewayConfig({
        HOMESERVER_GATEWAY_URL: url,
        HOMESERVER_GATEWAY_API_KEY: "k",
      } as NodeJS.ProcessEnv)).toBeNull();
    }
  });
});

describe("executeHomeserverTask — chat path", () => {
  it("streams /v1/chat/completions with Bearer auth and captures usage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "19" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "98" } }] })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
        })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );

    const result = await executeHomeserverTask(makeTaskConfig(), "chat-ok", tmpLogDir);

    expect(result.exitCode).toBe(0);
    expect(result.resultText).toBe("1998");
    expect(result.promptTokens).toBe(12);
    expect(result.completionTokens).toBe(2);
    expect(result.totalTokens).toBe(14);
    expect(result.backpressure).toBe("none");
    expect(result.delegated).toBeNull(); // chat path carries no delegate metadata

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://m5.test:8080/v1/chat/completions");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer owner-key");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.stream).toBe(true);
    expect(body.model).toBe("qwen3-coder");
  });

  it("omits the Authorization header on a keyless gateway", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sseResponse(["data: [DONE]\n\n"]));

    await executeHomeserverTask(makeTaskConfig({ apiKey: "" }), "chat-keyless", tmpLogDir);

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("executeHomeserverTask — delegate path", () => {
  it("POSTs /delegate and maps the DelegationOutcome", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        delegated: true,
        escalate: false,
        taskType: "extract",
        modelId: "qwen3-coder",
        nodeId: "m5",
        decisionReason: "viable (4/5 pass)",
        outcome: "pass",
        score: 1,
        output: "1998",
        ledgerId: "ledger-123",
        verifierNotes: "numeric match",
        metrics: { promptTokens: 45, completionTokens: 3, latencyMs: 820 },
      }),
    );

    const result = await executeHomeserverTask(
      makeTaskConfig({
        path: "delegate",
        taskType: "extract",
        systemPrompt: "Return only the extracted year.",
        maxTokens: 128,
        modelId: "qwen3-coder",
        frontierModelId: "anthropic/claude-opus-4-5",
        verifier: { type: "numeric", expected: 1998 },
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "year_result",
            schema: {
              type: "object",
              properties: { year: { type: "number" } },
              required: ["year"],
              additionalProperties: false,
            },
            strict: true,
          },
        },
        delegatorModelId: "anthropic/claude-sonnet-4-5",
        premiumBaselineModelId: "anthropic/claude-opus-4-5",
      }),
      "delegate-ok",
      tmpLogDir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.resultText).toBe("1998");
    expect(result.delegated).toBe(true);
    expect(result.escalated).toBe(false);
    expect(result.outcome).toBe("pass");
    expect(result.score).toBe(1);
    expect(result.ledgerId).toBe("ledger-123");
    expect(result.decisionReason).toBe("viable (4/5 pass)");
    expect(result.taskType).toBe("extract");
    expect(result.modelId).toBe("qwen3-coder");
    expect(result.nodeId).toBe("m5");
    expect(result.verifierNotes).toBe("numeric match");
    expect(result.promptTokens).toBe(45);
    expect(result.completionTokens).toBe(3);
    expect(result.totalTokens).toBe(48);
    expect(result.inferenceMs).toBe(820);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://m5.test:8080/delegate");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.taskType).toBe("extract");
    expect(typeof body.prompt).toBe("string");
    expect(body.systemPrompt).toBe("Return only the extracted year.");
    expect(body.maxTokens).toBe(128);
    expect(body.modelId).toBe("qwen3-coder");
    expect(body.frontierModelId).toBe("anthropic/claude-opus-4-5");
    expect(body.verifier).toEqual({ type: "numeric", expected: 1998 });
    expect(body.responseFormat).toEqual({
      type: "json_schema",
      json_schema: {
        name: "year_result",
        schema: {
          type: "object",
          properties: { year: { type: "number" } },
          required: ["year"],
          additionalProperties: false,
        },
        strict: true,
      },
    });
    expect(body.delegatorModelId).toBe("anthropic/claude-sonnet-4-5");
    expect(body.premiumBaselineModelId).toBe("anthropic/claude-opus-4-5");
  });

  // Issue #163: the direct path already carried the flat delegation fields, but
  // dropped the gateway's policy/cost-version trace and never validated the
  // response — so a single out-of-contract value could throw inside
  // buildStructuredTaskResult and lose the result of a paid run.
  it("captures the gateway's route-policy and price-catalog provenance (#163)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        delegated: true, escalate: false, outcome: "unverified", output: "PROV_OK",
        nodeId: "m5", modelId: "mellum", taskType: "qa-factual",
        ledgerId: "487bae49-e751-4fc8-a10c-8f12f6aa59a4",
        formatRetried: false,
        delegatePolicy: {
          mode: "shadow", action: "shadow", reason: "no verifier-backed lane",
          evidence: { verifier: "answerIs" },
        },
        costTrace: {
          id: "fc5e98f9-2d7c-4792-b2c3-c936d29d44fb",
          priceCatalogVersion: "2026-07-08",
        },
      }),
    );

    const result = await executeHomeserverTask(
      makeTaskConfig({ path: "delegate", taskType: "qa-factual" }), "delegate-prov", tmpLogDir,
    );

    const p = result.provenance!;
    expect(p.ledgerId).toBe("487bae49-e751-4fc8-a10c-8f12f6aa59a4");
    expect(p.nodeId).toBe("m5");
    expect(p.verifier).toBe("answerIs");
    expect(p.policyMode).toBe("shadow");
    expect(p.policyAction).toBe("shadow");
    expect(p.policyReason).toBe("no verifier-backed lane");
    expect(p.priceCatalogVersion).toBe("2026-07-08");
    expect(p.costTraceId).toBe("fc5e98f9-2d7c-4792-b2c3-c936d29d44fb");
    expect(p.formatRetried).toBe(false);
    // The pre-existing flat fields keep working for current consumers.
    expect(result.ledgerId).toBe("487bae49-e751-4fc8-a10c-8f12f6aa59a4");
    expect(result.nodeId).toBe("m5");
  });

  it("drops an out-of-contract gateway score instead of poisoning the result (#163)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      // A non-numeric score would previously flow straight into
      // runtimeMetadata.delegation.score (z.number()) and throw inside
      // buildStructuredTaskResult — losing the whole result of a paid run.
      jsonResponse({ delegated: true, outcome: "pass", score: "high", output: "ok", ledgerId: "l-1" }),
    );

    const result = await executeHomeserverTask(
      makeTaskConfig({ path: "delegate" }), "delegate-badscore", tmpLogDir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.resultText).toBe("ok");
    expect(result.score).toBeNull(); // dropped, not coerced, not thrown
    expect(result.provenance?.score).toBeUndefined();
    expect(result.provenance?.ledgerId).toBe("l-1");
  });

  it("omits optional /delegate fields that are not present", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ delegated: true, outcome: "unverified", output: "1998" }),
    );

    await executeHomeserverTask(makeTaskConfig({ path: "delegate", taskType: "extract" }), "delegate-min", tmpLogDir);

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      prompt: expect.any(String),
      taskType: "extract",
    });
  });

  it("maps outcome 'fail'/'error' to a non-zero exit code, but 'unverified' to 0", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ delegated: true, outcome: "fail", score: 0, output: "nope" }),
    );
    const failR = await executeHomeserverTask(makeTaskConfig({ path: "delegate" }), "delegate-fail", tmpLogDir);
    expect(failR.exitCode).toBe(1);
    expect(failR.outcome).toBe("fail");

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ delegated: true, outcome: "error", output: "" }),
    );
    const errR = await executeHomeserverTask(makeTaskConfig({ path: "delegate" }), "delegate-error", tmpLogDir);
    expect(errR.exitCode).toBe(1);

    // 'unverified' is the gateway's normal success-without-grading case — must stay exit 0.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ delegated: true, outcome: "unverified", output: "ran ok" }),
    );
    const unvR = await executeHomeserverTask(makeTaskConfig({ path: "delegate" }), "delegate-unverified", tmpLogDir);
    expect(unvR.exitCode).toBe(0);
    expect(unvR.resultText).toBe("ran ok");
  });
});

describe("executeHomeserverTask — backpressure & errors", () => {
  it("flags 503 as admission backpressure and parses Retry-After", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("owner preempted the GPU", { status: 503, headers: { "Retry-After": "5" } }),
    );

    const result = await executeHomeserverTask(makeTaskConfig(), "bp-503", tmpLogDir);

    expect(result.exitCode).toBe(1);
    expect(result.backpressure).toBe("admission");
    expect(result.retryAfterS).toBe(5);
    expect(result.resultText).toBeNull();
  });

  it("flags 429 as quota backpressure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: { message: "rpm exceeded" } }, 429),
    );

    const result = await executeHomeserverTask(makeTaskConfig(), "bp-429", tmpLogDir);

    expect(result.backpressure).toBe("quota");
    expect(result.exitCode).toBe(1);
  });

  it("surfaces 401 as the exit code without backpressure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: { message: "invalid api key" } }, 401),
    );

    const result = await executeHomeserverTask(makeTaskConfig(), "auth-401", tmpLogDir);

    expect(result.exitCode).toBe(401);
    expect(result.backpressure).toBe("none");
    expect(result.output).toContain("401");
  });

  it("parses an HTTP-date Retry-After on 503 (not just delta-seconds)", async () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("busy", { status: 503, headers: { "Retry-After": future } }),
    );
    const r = await executeHomeserverTask(makeTaskConfig(), "bp-503-date", tmpLogDir);
    expect(r.backpressure).toBe("admission");
    expect(r.retryAfterS).not.toBeNull();
    expect(r.retryAfterS!).toBeGreaterThanOrEqual(0);
    expect(r.retryAfterS!).toBeLessThanOrEqual(31);
  });
});

describe("executeHomeserverTask — streaming edge cases", () => {
  it("reassembles SSE frames split across byte chunks and parses a final chunk with no trailing newline", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      streamResponse([
        'data: {"choices":[{"delta":{"content":"hel', // frame split mid-JSON
        'lo"}}]}\n\n',
        // final usage frame, deliberately NOT newline-terminated
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
      ]),
    );
    const r = await executeHomeserverTask(makeTaskConfig(), "chat-split", tmpLogDir);
    expect(r.exitCode).toBe(0);
    expect(r.resultText).toBe("hello");
    expect(r.totalTokens).toBe(4);
  });

  it("returns cleanly (no crash) when a 200 chat response has no body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    const r = await executeHomeserverTask(makeTaskConfig(), "chat-nobody", tmpLogDir);
    expect(r.resultText).toBeNull();
    expect(r.output).toContain("no response body");
  });
});
