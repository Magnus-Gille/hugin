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
  DEFAULT_MAX_TOKENS,
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

  it("returns DirectModelExecutor for homeserver", () => {
    expect(createWorkerExecutor("homeserver")).toBeInstanceOf(DirectModelExecutor);
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

describe("DirectModelExecutor — homeserver provider (env-resolved base URL)", () => {
  it("resolves the base URL from HOMESERVER_GATEWAY_URL and sends bearer auth", async () => {
    vi.stubEnv("HOMESERVER_GATEWAY_URL", "http://100.76.72.59:8080");
    vi.stubEnv("HOMESERVER_GATEWAY_API_KEY", "hs-test-key");

    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return successResponse("local answer", 30, 40);
    }));

    const executor = new DirectModelExecutor();
    const result = await executor.run({
      provider: "homeserver",
      model: "qwen3-30b-instruct",
      prompt: "say hello",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("local answer");
    expect(capturedUrl).toBe("http://100.76.72.59:8080/v1/chat/completions");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer hs-test-key");
    // OpenRouter-only attribution headers must not leak to other providers.
    expect(headers["http-referer"]).toBeUndefined();
    expect(headers["x-title"]).toBeUndefined();
  });

  it("normalizes a trailing slash on the gateway root", async () => {
    vi.stubEnv("HOMESERVER_GATEWAY_URL", "http://gateway:8080/");
    vi.stubEnv("HOMESERVER_GATEWAY_API_KEY", "hs-test-key");

    let capturedUrl = "";
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return successResponse("ok");
    }));

    const result = await new DirectModelExecutor().run({
      provider: "homeserver",
      model: "mellum",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe("http://gateway:8080/v1/chat/completions");
  });

  it("returns ok=false with a distinct error when HOMESERVER_GATEWAY_URL is unset", async () => {
    // Explicitly delete — the ambient shell may export this var (it's the one
    // operators set), and unstubAllEnvs only reverts stubs.
    vi.stubEnv("HOMESERVER_GATEWAY_URL", undefined);
    vi.stubEnv("HOMESERVER_GATEWAY_API_KEY", "hs-test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DirectModelExecutor().run({
      provider: "homeserver",
      model: "qwen3-30b-instruct",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("HOMESERVER_GATEWAY_URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns ok=false and makes no request for a public (non-sovereign) gateway URL", async () => {
    vi.stubEnv("HOMESERVER_GATEWAY_URL", "https://example.com");
    vi.stubEnv("HOMESERVER_GATEWAY_API_KEY", "hs-test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DirectModelExecutor().run({
      provider: "homeserver",
      model: "qwen3-30b-instruct",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("HOMESERVER_GATEWAY_URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns ok=false when HOMESERVER_GATEWAY_API_KEY is unset", async () => {
    vi.stubEnv("HOMESERVER_GATEWAY_URL", "http://100.76.72.59:8080");
    vi.stubEnv("HOMESERVER_GATEWAY_API_KEY", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DirectModelExecutor().run({
      provider: "homeserver",
      model: "qwen3-30b-instruct",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "Missing API key: environment variable HOMESERVER_GATEWAY_API_KEY is not set",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the missing base URL first when BOTH env vars are missing", async () => {
    vi.stubEnv("HOMESERVER_GATEWAY_URL", undefined);
    vi.stubEnv("HOMESERVER_GATEWAY_API_KEY", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DirectModelExecutor().run({
      provider: "homeserver",
      model: "qwen3-30b-instruct",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "Missing base URL: environment variable HOMESERVER_GATEWAY_URL is not set",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("costUsd is an explicit 0 (not null) for gateway models in the pricing table", async () => {
    vi.stubEnv("HOMESERVER_GATEWAY_URL", "http://100.76.72.59:8080");
    vi.stubEnv("HOMESERVER_GATEWAY_API_KEY", "hs-test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(successResponse("answer", 100, 200)));

    const result = await new DirectModelExecutor().run({
      provider: "homeserver",
      model: "qwen3-coder-next-80b",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.costUsd).toBe(0);
  });
});

describe("DirectModelExecutor — max_tokens (issue #112)", () => {
  it("defaults max_tokens to DEFAULT_MAX_TOKENS (4096) when req.maxTokens is unset", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    let capturedBody: { max_tokens?: number } = {};
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return successResponse("ok");
    }));

    const executor = new DirectModelExecutor();
    await executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(capturedBody.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(DEFAULT_MAX_TOKENS).toBe(4096);
  });

  it("uses req.maxTokens override when provided", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    let capturedBody: { max_tokens?: number } = {};
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return successResponse("ok");
    }));

    const executor = new DirectModelExecutor();
    await executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      timeoutMs: 5000,
      maxTokens: 16384,
    });

    expect(capturedBody.max_tokens).toBe(16384);
  });
});

describe("DirectModelExecutor — finish_reason surfacing (issue #112)", () => {
  function responseWithFinish(content: string, finishReason: string): Response {
    return new Response(
      JSON.stringify({
        model: "some/model",
        choices: [{ message: { content }, finish_reason: finishReason }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  it("marks truncated=true when finish_reason is 'length'", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseWithFinish("partial answer", "length")));

    const executor = new DirectModelExecutor();
    const result = await executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      prompt: "write a long essay",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("partial answer");
    expect(result.truncated).toBe(true);
  });

  it("truncated is false when finish_reason is 'stop'", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseWithFinish("complete", "stop")));

    const executor = new DirectModelExecutor();
    const result = await executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("truncated is false when finish_reason is absent", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "some/model",
          choices: [{ message: { content: "answer" } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ));

    const executor = new DirectModelExecutor();
    const result = await executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(false);
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

describe("DirectModelExecutor — malformed response bodies (Fix #3)", () => {
  it("{choices:[null]} returns ok=false and does NOT throw", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [null] }), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    const executor = new DirectModelExecutor();
    const result = await executor.run({ provider: "openrouter", model: "deepseek/deepseek-v4-flash", prompt: "hi", timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(result.output).toBe("");
  });

  it("{choices:[{}]} returns ok=false and does NOT throw", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{}] }), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    const executor = new DirectModelExecutor();
    const result = await executor.run({ provider: "openrouter", model: "deepseek/deepseek-v4-flash", prompt: "hi", timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(result.output).toBe("");
  });

  it("{choices:[{message:{content:123}}]} returns ok=false and does NOT throw", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 123 } }] }), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    const executor = new DirectModelExecutor();
    const result = await executor.run({ provider: "openrouter", model: "deepseek/deepseek-v4-flash", prompt: "hi", timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(result.output).toBe("");
  });
});

describe("DirectModelExecutor — timeout/abort path", () => {
  it("returns ok=false with timeout error when the per-call timeout fires", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");

    // fetch that only rejects once its signal (the internal timeout controller)
    // aborts — i.e. a genuine timeout, not an immediate/external cancel.
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      }),
    ));

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

describe("DirectModelExecutor — external AbortSignal (issue #110)", () => {
  it("short-circuits without calling fetch when signal is already aborted", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(successResponse("should not happen"));
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    controller.abort();

    const executor = new DirectModelExecutor();
    const result = await executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      timeoutMs: 5000,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abort/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts the in-flight fetch when the external signal fires", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    // fetch mock that rejects with AbortError when its passed signal aborts.
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      }),
    ));

    const controller = new AbortController();
    const executor = new DirectModelExecutor();
    const pending = executor.run({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      prompt: "hi",
      timeoutMs: 60000, // long — the abort, not the timeout, must end the call
      signal: controller.signal,
    });

    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.output).toBe("");
    expect(result.error).toMatch(/abort/i);
  });
});

describe("DirectModelExecutor — abort-reason attribution is first-writer-wins (issue #110)", () => {
  it("reports 'aborted' when the external abort precedes the timeout, even if the timer fires before the fetch settles", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.useFakeTimers();
    try {
      // fetch rejects with AbortError only when its (internal) signal aborts,
      // and the rejection settles on a LATER macrotask (like real fetch teardown)
      // — long enough that the per-call timeout timer fires in between.
      vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            setTimeout(
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              100,
            );
          });
        }),
      ));

      const controller = new AbortController();
      const executor = new DirectModelExecutor();
      const pending = executor.run({
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
        prompt: "hi",
        timeoutMs: 50, // fires AFTER the external abort but BEFORE the rejection settles
        signal: controller.signal,
      });

      // External abort fires FIRST at t=0 → reason must lock to "external"…
      controller.abort();
      // …the timeout timer fires at t=50 (would flip timedOut), rejection at t=100.
      await vi.advanceTimersByTimeAsync(200);

      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/abort/i);
      expect(result.error).not.toMatch(/timed out/i);
    } finally {
      vi.useRealTimers();
    }
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

describe("PiHarnessExecutor — external AbortSignal (issue #110)", () => {
  it("does not spawn when the signal is already aborted", async () => {
    spawnBehaviors = [{ exitCode: 0, stdout: PI_JSONL_SUCCESS }];
    const controller = new AbortController();
    controller.abort();

    const executor = new PiHarnessExecutor();
    const result = await executor.run({
      provider: "pi-harness",
      model: "qwen/qwen3-coder-next",
      prompt: "hi",
      timeoutMs: 5000,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abort/i);
    expect(spawnCalls.length).toBe(0);
  });

  it("kills the child when the signal fires mid-run", async () => {
    // Child would run for 500ms; we abort well before that.
    spawnBehaviors = [{ exitCode: 0, stdout: PI_JSONL_SUCCESS, delayMs: 500 }];
    const controller = new AbortController();

    const executor = new PiHarnessExecutor();
    const pending = executor.run({
      provider: "pi-harness",
      model: "qwen/qwen3-coder-next",
      prompt: "hi",
      timeoutMs: 60000, // long — the abort, not the timeout, must end it
      signal: controller.signal,
    });

    // Let the spawn happen, then abort.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abort/i);
    expect(spawnCalls.length).toBe(1);
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

describe("DirectModelExecutor — provider token-count sanitation (review fix)", () => {
  it("drops fractional/negative usage counts to null instead of trusting them", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        model: "some/model",
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1234.5, completion_tokens: -3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const result = await new DirectModelExecutor().run({
      provider: "openrouter",
      model: "some/model",
      prompt: "hi",
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
  });
});
