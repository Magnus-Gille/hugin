import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  executeOllamaTask,
  isReasoningModel,
  type OllamaTaskConfig,
} from "../src/ollama-executor.js";

function makeTaskConfig(overrides?: Partial<OllamaTaskConfig>): OllamaTaskConfig {
  return {
    prompt: "Say hi",
    model: "qwen2.5:3b",
    ollamaBaseUrl: "http://ollama.test:11434",
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

function ndjsonResponse(lines: string[]): Response {
  return new Response(lines.join(""), {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

let tmpLogDir: string;

beforeEach(() => {
  tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-ollama-"));
});

afterEach(() => {
  fs.rmSync(tmpLogDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("isReasoningModel", () => {
  it("recognises qwen3 family (including qwen3.5)", () => {
    expect(isReasoningModel("qwen3:4b")).toBe(true);
    expect(isReasoningModel("qwen3.5:2b")).toBe(true);
    expect(isReasoningModel("QWEN3:14B")).toBe(true);
  });

  it("recognises deepseek-r1 and magistral", () => {
    expect(isReasoningModel("deepseek-r1:8b")).toBe(true);
    expect(isReasoningModel("magistral:24b")).toBe(true);
  });

  it("does not flag qwen2.5, llama3, mistral", () => {
    expect(isReasoningModel("qwen2.5:3b")).toBe(false);
    expect(isReasoningModel("llama3.2:3b")).toBe(false);
    expect(isReasoningModel("mistral:7b")).toBe(false);
  });

  it("excludes gpt-oss — it uses level-based think, not boolean", () => {
    expect(isReasoningModel("gpt-oss:20b")).toBe(false);
    expect(isReasoningModel("gpt-oss:120b")).toBe(false);
  });
});

describe("executeOllamaTask — endpoint selection", () => {
  it("uses /v1/chat/completions (OpenAI-compat) for non-reasoning models with no explicit reasoning", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "hi" } }],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          })}\n\n`,
          "data: [DONE]\n\n",
        ]),
      );

    const result = await executeOllamaTask(
      makeTaskConfig({ model: "qwen2.5:3b" }),
      "test-openai-compat",
      tmpLogDir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.resultText).toBe("hi");
    expect(result.promptTokens).toBe(5);
    expect(result.completionTokens).toBe(2);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://ollama.test:11434/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.think).toBeUndefined();
  });

  it("routes reasoning-family models to /api/chat with think:false by default", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        ndjsonResponse([
          `${JSON.stringify({ message: { content: "ok" }, done: false })}\n`,
          `${JSON.stringify({
            message: { content: "" },
            done: true,
            prompt_eval_count: 10,
            eval_count: 3,
            total_duration: 2_500_000_000,
            load_duration: 900_000_000,
          })}\n`,
        ]),
      );

    const result = await executeOllamaTask(
      makeTaskConfig({ model: "qwen3:4b" }),
      "test-native-default-off",
      tmpLogDir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.resultText).toContain("ok");
    expect(result.promptTokens).toBe(10);
    expect(result.completionTokens).toBe(3);
    expect(result.totalTokens).toBe(13);
    expect(result.inferenceMs).toBe(2500);
    expect(result.loadMs).toBe(900);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://ollama.test:11434/api/chat");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.think).toBe(false);
    expect(body.stream).toBe(true);
  });

  it("honours explicit reasoning:true on any model via /api/chat", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        ndjsonResponse([
          `${JSON.stringify({ message: { content: "answer" }, done: true, prompt_eval_count: 1, eval_count: 1 })}\n`,
        ]),
      );

    await executeOllamaTask(
      makeTaskConfig({ model: "qwen2.5:3b", reasoning: true }),
      "test-explicit-on",
      tmpLogDir,
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://ollama.test:11434/api/chat");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.think).toBe(true);
  });

  it("does not leak the native-endpoint banner into resultText/output", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      ndjsonResponse([
        `${JSON.stringify({ message: { content: "clean-answer" }, done: false })}\n`,
        `${JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 1, eval_count: 1 })}\n`,
      ]),
    );

    const result = await executeOllamaTask(
      makeTaskConfig({ model: "qwen3:4b" }),
      "test-banner-isolation",
      tmpLogDir,
    );

    expect(result.resultText).toBe("clean-answer");
    expect(result.output).not.toContain("/api/chat");
    expect(result.output).not.toContain("think:");
    // But the log file should still have the banner for operator debugging.
    const logContent = fs.readFileSync(result.logFile, "utf-8");
    expect(logContent).toContain("/api/chat");
  });

  it("parses the final NDJSON chunk when it arrives without a trailing newline", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      ndjsonResponse([
        `${JSON.stringify({ message: { content: "partial" }, done: false })}\n`,
        // Final chunk: no trailing \n on purpose.
        `${JSON.stringify({
          message: { content: " done" },
          done: true,
          prompt_eval_count: 7,
          eval_count: 4,
          total_duration: 1_000_000_000,
          load_duration: 100_000_000,
        })}`,
      ]),
    );

    const result = await executeOllamaTask(
      makeTaskConfig({ model: "qwen3:4b" }),
      "test-no-trailing-newline",
      tmpLogDir,
    );

    expect(result.resultText).toBe("partial done");
    expect(result.promptTokens).toBe(7);
    expect(result.completionTokens).toBe(4);
    expect(result.inferenceMs).toBe(1000);
    expect(result.loadMs).toBe(100);
  });

  it("honours explicit reasoning:false and overrides reasoning-family default (noop but explicit)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        ndjsonResponse([
          `${JSON.stringify({ message: { content: "fast" }, done: true, prompt_eval_count: 1, eval_count: 1 })}\n`,
        ]),
      );

    await executeOllamaTask(
      makeTaskConfig({ model: "qwen3.5:2b", reasoning: false }),
      "test-explicit-off",
      tmpLogDir,
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://ollama.test:11434/api/chat");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.think).toBe(false);
  });
});
