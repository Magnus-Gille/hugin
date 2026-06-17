/**
 * Tests for the orchestrator worker-executor layer.
 *
 * DirectModelExecutor tests mock global fetch.
 * PiHarnessExecutor tests mock node:child_process spawn using the same
 * pattern as tests/repo-sync.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mock node:child_process before importing the module
// ---------------------------------------------------------------------------

interface SpawnBehavior {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  /** If true, emit an 'error' event instead of 'close'. */
  spawnError?: string;
  /** Delay close by this many ms (to test timeouts). */
  delayMs?: number;
}

const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
let spawnBehaviors: SpawnBehavior[] = [];
let spawnCallIndex = 0;

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(_signal?: string) {
    this.killed = true;
    // Emit close after kill so the promise resolves
    setImmediate(() => this.emit("close", null));
  }
}

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    const child = new MockChildProcess();
    const behavior = spawnBehaviors[spawnCallIndex] ?? { exitCode: 0 };
    spawnCallIndex++;

    const fire = () => {
      if (behavior.spawnError) {
        child.emit("error", new Error(behavior.spawnError));
        return;
      }
      if (behavior.stdout) {
        child.stdout.emit("data", Buffer.from(behavior.stdout));
      }
      if (behavior.stderr) {
        child.stderr.emit("data", Buffer.from(behavior.stderr));
      }
      child.emit("close", behavior.exitCode);
    };

    if (behavior.delayMs) {
      setTimeout(fire, behavior.delayMs);
    } else {
      setImmediate(fire);
    }

    return child;
  },
}));

// Import AFTER mocking so the mock is in place when the module loads
const {
  createWorkerExecutor,
  DirectModelExecutor,
  PiHarnessExecutor,
  DEFAULT_MAX_OUTPUT_CHARS,
} = await import("../../src/orchestrator/worker-executor.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function successResponse(content: string, inputTokens = 10, outputTokens = 20): Response {
  return new Response(
    JSON.stringify({
      model: "some/model",
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function errorResponse(status: number, body = "bad request"): Response {
  return new Response(body, { status });
}

beforeEach(() => {
  spawnCalls.length = 0;
  spawnBehaviors = [];
  spawnCallIndex = 0;
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// createWorkerExecutor factory
// ---------------------------------------------------------------------------

describe("createWorkerExecutor", () => {
  it("returns PiHarnessExecutor for pi-harness", () => {
    const exec = createWorkerExecutor("pi-harness");
    expect(exec).toBeInstanceOf(PiHarnessExecutor);
  });

  it("returns DirectModelExecutor for openrouter", () => {
    expect(createWorkerExecutor("openrouter")).toBeInstanceOf(DirectModelExecutor);
  });

  it("returns DirectModelExecutor for berget", () => {
    expect(createWorkerExecutor("berget")).toBeInstanceOf(DirectModelExecutor);
  });

  it("returns DirectModelExecutor for unknown provider (handled as error in run)", () => {
    expect(createWorkerExecutor("unknown-xyz")).toBeInstanceOf(DirectModelExecutor);
  });
});

// ---------------------------------------------------------------------------
// DirectModelExecutor
// ---------------------------------------------------------------------------

describe("DirectModelExecutor — success path", () => {
  it("returns ok=true with output, token counts, and costUsd computed from pricing", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");

    const executor = new DirectModelExecutor();
    // Inject fetch mock via global
    const fetchMock = vi.fn().mockResolvedValue(successResponse("hello world", 100, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash", // in model-pricing snapshot
      prompt: "say hello",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello world");
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("deepseek/deepseek-v4-flash");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(200);
    // deepseek-v4-flash: 0.09/M in, 0.18/M out
    // 100/1e6*0.09 + 200/1e6*0.18 = 0.000009 + 0.000036 = 0.000045
    expect(result.costUsd).toBeCloseTo(0.000045, 8);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("sends system prompt when provided", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");

    let capturedBody: unknown;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return successResponse("ok");
    }));

    const executor = new DirectModelExecutor();
    await executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      prompt: "user question",
      systemPrompt: "be concise",
      timeoutMs: 5000,
    });

    const body = capturedBody as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]).toEqual({ role: "system", content: "be concise" });
    expect(body.messages[1]).toEqual({ role: "user", content: "user question" });
  });

  it("sends OpenRouter referer and x-title headers", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("OPENROUTER_REFERER", "https://my.app");
    vi.stubEnv("OPENROUTER_APP_TITLE", "my-app");

    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return successResponse("ok");
    }));

    const executor = new DirectModelExecutor();
    await executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(capturedHeaders["http-referer"]).toBe("https://my.app");
    expect(capturedHeaders["x-title"]).toBe("my-app");
  });

  it("costUsd is null for unknown model not in pricing snapshot", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(successResponse("answer", 50, 60)));

    const executor = new DirectModelExecutor();
    const result = await executor.run({
      provider: "openrouter",
      model: "unknown/model-not-in-snapshot",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.costUsd).toBeNull();
  });

  it("truncates output to maxOutputChars", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const longContent = "x".repeat(200);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(successResponse(longContent)));

    const executor = new DirectModelExecutor();
    const result = await executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      timeoutMs: 5000,
      maxOutputChars: 50,
    });

    expect(result.ok).toBe(true);
    expect(result.output.length).toBe(50);
  });
});

describe("DirectModelExecutor — HTTP error path", () => {
  it("returns ok=false with error set and does not throw", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(500, "internal error")));

    const executor = new DirectModelExecutor();
    const result = await executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/500/);
    expect(result.output).toBe("");
    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
    expect(result.costUsd).toBeNull();
  });

  it("returns ok=false on 401", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(401, "Unauthorized")));

    const executor = new DirectModelExecutor();
    const result = await executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/401/);
  });
});

describe("DirectModelExecutor — missing API key path", () => {
  it("returns ok=false with clear error when env var is missing", async () => {
    // Ensure the env var is not set
    delete process.env.OPENROUTER_API_KEY;

    const executor = new DirectModelExecutor();
    const result = await executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/OPENROUTER_API_KEY/);
    expect(result.output).toBe("");
  });

  it("returns ok=false for unknown provider without touching network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const executor = new DirectModelExecutor();
    const result = await executor.run({
      provider: "no-such-provider",
      model: "some/model",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown provider/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DirectModelExecutor — timeout/abort path", () => {
  it("returns ok=false with timeout error when fetch is aborted", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );

    const executor = new DirectModelExecutor();
    const result = await executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      timeoutMs: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(result.output).toBe("");
  });
});

// ---------------------------------------------------------------------------
// PiHarnessExecutor
// ---------------------------------------------------------------------------

const PI_JSONL_SUCCESS = [
  JSON.stringify({ type: "assistant", content: "the answer" }),
  JSON.stringify({ type: "usage", usage: { input_tokens: 50, output_tokens: 30 } }),
].join("\n") + "\n";

describe("PiHarnessExecutor — success path", () => {
  it("parses JSONL output and returns ok=true with content and token counts", async () => {
    spawnBehaviors = [{ exitCode: 0, stdout: PI_JSONL_SUCCESS }];

    const executor = new PiHarnessExecutor();
    const result = await executor.run({
      provider: "pi-harness",
      model: "qwen/qwen3-coder-next",
      prompt: "write a function",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("the answer");
    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(30);
    expect(result.provider).toBe("pi-harness");
    expect(result.model).toBe("qwen/qwen3-coder-next");
    // model not in pricing snapshot → null cost
    expect(result.costUsd).toBeNull();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("builds args from registry (harnessFlags + mode + model + prompt)", async () => {
    spawnBehaviors = [{ exitCode: 0, stdout: PI_JSONL_SUCCESS }];

    const executor = new PiHarnessExecutor();
    await executor.run({
      provider: "pi-harness",
      model: "qwen/qwen3-coder-next",
      prompt: "hello",
      timeoutMs: 5000,
    });

    expect(spawnCalls).toHaveLength(1);
    const { cmd, args } = spawnCalls[0];
    // harnessCmd from registry
    expect(cmd).toBe("pi");
    // harnessFlags present
    expect(args).toContain("--no-session");
    expect(args).toContain("--provider");
    expect(args).toContain("openrouter");
    // mode and model flags
    expect(args).toContain("--mode");
    expect(args).toContain("json");
    expect(args).toContain("--model");
    expect(args).toContain("qwen/qwen3-coder-next");
    // prompt flag
    expect(args).toContain("-p");
    expect(args).toContain("hello");
  });

  it("uses alternate_tokens field if content field absent (text field)", async () => {
    const jsonl = JSON.stringify({ type: "result", text: "text field result" }) + "\n";
    spawnBehaviors = [{ exitCode: 0, stdout: jsonl }];

    const executor = new PiHarnessExecutor();
    const result = await executor.run({
      provider: "pi-harness",
      model: "qwen/qwen3-coder-next",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("text field result");
  });
});

describe("PiHarnessExecutor — non-zero exit path", () => {
  it("returns ok=false with stderr in error, does not throw", async () => {
    spawnBehaviors = [
      { exitCode: 1, stdout: "", stderr: "model not found" },
    ];

    const executor = new PiHarnessExecutor();
    const result = await executor.run({
      provider: "pi-harness",
      model: "qwen/qwen3-coder-next",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/code 1/);
    expect(result.error).toMatch(/model not found/);
    expect(result.output).toBe("");
  });

  it("returns ok=false on spawn error", async () => {
    spawnBehaviors = [
      { exitCode: 1, spawnError: "ENOENT: pi not found" },
    ];

    const executor = new PiHarnessExecutor();
    const result = await executor.run({
      provider: "pi-harness",
      model: "qwen/qwen3-coder-next",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/pi not found/);
  });
});

describe("PiHarnessExecutor — timeout path", () => {
  it("kills the child and returns ok=false with timeout error", async () => {
    // delayMs > timeoutMs so the kill fires first
    spawnBehaviors = [{ exitCode: 0, stdout: PI_JSONL_SUCCESS, delayMs: 500 }];

    const executor = new PiHarnessExecutor();
    const result = await executor.run({
      provider: "pi-harness",
      model: "qwen/qwen3-coder-next",
      prompt: "hi",
      timeoutMs: 10, // very short
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });
});

// ---------------------------------------------------------------------------
// PiHarnessExecutor — pi v3 event schema (smoke-test format lock)
// ---------------------------------------------------------------------------

// Real pi --mode json output uses a v3 event schema: message_start + message_end
// events carry the assistant content and usage inside a `message` envelope.
const PI_V3_JSONL = [
  JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "pong" }],
      usage: { input: 9, output: 1 },
    },
  }),
].join("\n") + "\n";

describe("PiHarnessExecutor — pi v3 event schema", () => {
  it("extracts output and token counts from message_start/message_end events", async () => {
    spawnBehaviors = [{ exitCode: 0, stdout: PI_V3_JSONL }];

    const executor = new PiHarnessExecutor();
    const result = await executor.run({
      provider: "pi-harness",
      model: "qwen/qwen3-coder-next",
      prompt: "ping",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("pong");
    expect(result.inputTokens).toBe(9);
    expect(result.outputTokens).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_MAX_OUTPUT_CHARS constant
// ---------------------------------------------------------------------------

describe("DEFAULT_MAX_OUTPUT_CHARS", () => {
  it("is 50_000", () => {
    expect(DEFAULT_MAX_OUTPUT_CHARS).toBe(50_000);
  });
});
