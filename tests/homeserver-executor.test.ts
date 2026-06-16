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
        decisionReason: "viable (4/5 pass)",
        outcome: "pass",
        score: 1,
        output: "1998",
        ledgerId: "ledger-123",
        metrics: { promptTokens: 45, completionTokens: 3, latencyMs: 820 },
      }),
    );

    const result = await executeHomeserverTask(
      makeTaskConfig({ path: "delegate", taskType: "extract", frontierModelId: "anthropic/claude-opus-4-5" }),
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
    expect(result.promptTokens).toBe(45);
    expect(result.completionTokens).toBe(3);
    expect(result.totalTokens).toBe(48);
    expect(result.inferenceMs).toBe(820);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://m5.test:8080/delegate");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.taskType).toBe("extract");
    expect(body.modelId).toBe("qwen3-coder");
    expect(body.frontierModelId).toBe("anthropic/claude-opus-4-5");
    expect(typeof body.prompt).toBe("string");
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
});
