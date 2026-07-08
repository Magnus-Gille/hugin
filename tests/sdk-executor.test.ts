import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock the agent SDK before importing the executor
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import {
  buildClaudePermissionOptions,
  executeSdkTask,
  formatChildStderr,
  type SdkTaskConfig,
} from "../src/sdk-executor.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

const mockedQuery = vi.mocked(query);

function makeTaskConfig(overrides?: Partial<SdkTaskConfig>): SdkTaskConfig {
  return {
    prompt: "Test prompt",
    workingDir: path.join(os.tmpdir(), "hugin-test-sdk"),
    timeoutMs: 30000,
    muninUrl: "http://localhost:3030",
    muninApiKey: "test-key",
    maxOutputChars: 5000,
    ...overrides,
  };
}

function createMockResultSuccess(resultText: string) {
  return {
    type: "result" as const,
    subtype: "success" as const,
    result: resultText,
    is_error: false,
    num_turns: 3,
    total_cost_usd: 0.015,
    duration_ms: 5000,
    duration_api_ms: 4500,
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: "test-uuid" as `${string}-${string}-${string}-${string}-${string}`,
    session_id: "test-session",
  };
}

function createMockResultError(errors: string[]) {
  return {
    type: "result" as const,
    subtype: "error_during_execution" as const,
    is_error: true,
    num_turns: 1,
    total_cost_usd: 0.002,
    duration_ms: 1000,
    duration_api_ms: 800,
    stop_reason: null,
    usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: "test-uuid-err" as `${string}-${string}-${string}-${string}-${string}`,
    session_id: "test-session",
  };
}

function createMockAssistantMessage(text: string) {
  return {
    type: "assistant" as const,
    message: {
      content: [{ type: "text", text }],
      id: "msg-1",
      model: "claude-sonnet-4-6",
      role: "assistant",
      type: "message",
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn",
    },
    parent_tool_use_id: null,
    uuid: "assistant-uuid" as `${string}-${string}-${string}-${string}-${string}`,
    session_id: "test-session",
  };
}

// Helper to create a mock async generator
function createMockQuery(messages: unknown[]) {
  let index = 0;
  const gen = {
    [Symbol.asyncIterator]() {
      return gen;
    },
    async next() {
      if (index < messages.length) {
        return { value: messages[index++], done: false };
      }
      return { value: undefined, done: true };
    },
    async return() {
      return { value: undefined, done: true };
    },
    async throw(e: unknown) {
      throw e;
    },
    close: vi.fn(),
    interrupt: vi.fn(),
    setPermissionMode: vi.fn(),
    setModel: vi.fn(),
    setMaxThinkingTokens: vi.fn(),
    applyFlagSettings: vi.fn(),
    initializationResult: vi.fn(),
    supportedCommands: vi.fn(),
    supportedModels: vi.fn(),
    supportedAgents: vi.fn(),
    mcpServerStatus: vi.fn(),
    accountInfo: vi.fn(),
    rewindFiles: vi.fn(),
    reconnectMcpServer: vi.fn(),
    toggleMcpServer: vi.fn(),
    setMcpServers: vi.fn(),
    streamInput: vi.fn(),
    stopTask: vi.fn(),
  };
  return gen;
}

let tmpLogDir: string;

beforeEach(() => {
  tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-logs-"));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpLogDir, { recursive: true, force: true });
});

describe("SDK executor", () => {
  it("builds read-only Claude permission options by default", () => {
    const options = buildClaudePermissionOptions();

    expect(options.permissionMode).toBe("dontAsk");
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.allowedTools).toContain("Read");
    expect(options.allowedTools).toContain("mcp__munin-memory__memory_query");
    expect(options.allowedTools).not.toContain("Bash");
    expect(options.allowedTools).not.toContain("Edit");
    expect(options.allowedTools).not.toContain("TodoWrite");
    expect(options.allowedTools).not.toContain("WebFetch");
  });

  it("builds bypass Claude permission options only for trusted-code", () => {
    expect(buildClaudePermissionOptions("trusted-code")).toEqual({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
  });

  it("should return structured result on success", async () => {
    const messages = [
      createMockAssistantMessage("Here is the result of your task."),
      createMockResultSuccess("Task completed successfully."),
    ];
    mockedQuery.mockReturnValue(createMockQuery(messages) as ReturnType<typeof query>);

    const result = await executeSdkTask(makeTaskConfig(), "test-task-1", tmpLogDir);

    expect(result.exitCode).toBe(0);
    expect(result.resultText).toBe("Task completed successfully.");
    expect(result.costUsd).toBe(0.015);
    expect(result.numTurns).toBe(3);
    expect(result.durationApiMs).toBe(4500);
    expect(result.output).toContain("Here is the result of your task.");

    // Verify log file was created
    expect(fs.existsSync(result.logFile)).toBe(true);
    const logContent = fs.readFileSync(result.logFile, "utf-8");
    expect(logContent).toContain("Hugin Task Log (SDK)");
    expect(logContent).toContain("agent-sdk");
  });

  it("should handle SDK error results", async () => {
    const messages = [
      createMockResultError(["Authentication failed"]),
    ];
    mockedQuery.mockReturnValue(createMockQuery(messages) as ReturnType<typeof query>);

    const result = await executeSdkTask(makeTaskConfig(), "test-task-err", tmpLogDir);

    expect(result.exitCode).toBe(1);
    expect(result.resultText).toBeNull();
    expect(result.output).toContain("SDK Error");
    expect(result.output).toContain("Authentication failed");
  });

  it("should handle SDK throw/crash", async () => {
    const gen = createMockQuery([]);
    // Override next to throw
    gen.next = async () => {
      throw new Error("SDK internal crash");
    };
    mockedQuery.mockReturnValue(gen as ReturnType<typeof query>);

    const result = await executeSdkTask(makeTaskConfig(), "test-task-crash", tmpLogDir);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("SDK Error: SDK internal crash");
  });

  it("should call query with read-only permissions by default", async () => {
    const messages = [createMockResultSuccess("Done")];
    mockedQuery.mockReturnValue(createMockQuery(messages) as ReturnType<typeof query>);

    const taskConfig = makeTaskConfig({
      prompt: "Do the thing",
    });
    await executeSdkTask(taskConfig, "test-task-opts", tmpLogDir);

    expect(mockedQuery).toHaveBeenCalledWith({
      prompt: "Do the thing",
      options: expect.objectContaining({
        cwd: taskConfig.workingDir,
        permissionMode: "dontAsk",
        allowedTools: expect.arrayContaining(["Read", "Grep"]),
        persistSession: false,
      }),
    });
    const call = mockedQuery.mock.calls[0]?.[0] as {
      options?: { allowDangerouslySkipPermissions?: boolean; allowedTools?: string[] };
    };
    expect(call.options?.allowDangerouslySkipPermissions).toBeUndefined();
    expect(call.options?.allowedTools).not.toContain("Bash");
  });

  it("should call query with bypass permissions for trusted-code tasks", async () => {
    const messages = [createMockResultSuccess("Done")];
    mockedQuery.mockReturnValue(createMockQuery(messages) as ReturnType<typeof query>);

    await executeSdkTask(
      makeTaskConfig({ permissionProfile: "trusted-code" }),
      "test-task-trusted-code",
      tmpLogDir,
    );

    expect(mockedQuery).toHaveBeenCalledWith({
      prompt: "Test prompt",
      options: expect.objectContaining({
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
      }),
    });
  });

  it("passes a stderr callback in query options", async () => {
    const messages = [createMockResultSuccess("Done")];
    mockedQuery.mockReturnValue(createMockQuery(messages) as ReturnType<typeof query>);

    await executeSdkTask(makeTaskConfig(), "test-task-stderr-cb", tmpLogDir);

    const call = mockedQuery.mock.calls[0]?.[0] as {
      options?: { stderr?: unknown };
    };
    expect(typeof call?.options?.stderr).toBe("function");
  });

  it("includes child stderr in output and log when the process fails", async () => {
    // Simulate: the query throws (process exited code 1), and stderr was captured
    // by the callback before the throw.
    let capturedStderrCb: ((data: string) => void) | undefined;
    const gen = createMockQuery([]);
    gen.next = async () => {
      // Invoke the stderr callback to simulate output from the child process
      capturedStderrCb?.("Error: authentication token expired\n");
      throw new Error("Claude Code process exited with code 1");
    };
    mockedQuery.mockImplementation(({ options }) => {
      capturedStderrCb = options?.stderr;
      return gen as ReturnType<typeof query>;
    });

    const result = await executeSdkTask(makeTaskConfig(), "test-task-stderr-content", tmpLogDir);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("[child stderr]");
    expect(result.output).toContain("authentication token expired");

    const logContent = fs.readFileSync(result.logFile, "utf-8");
    expect(logContent).toContain("[child stderr]");
    expect(logContent).toContain("authentication token expired");
  });

  it("does not include [child stderr] in output on success", async () => {
    let capturedStderrCb: ((data: string) => void) | undefined;
    const gen = createMockQuery([createMockResultSuccess("All good.")]);
    const originalNext = gen.next.bind(gen);
    gen.next = async () => {
      capturedStderrCb?.("some benign debug line\n");
      return originalNext();
    };
    mockedQuery.mockImplementation(({ options }) => {
      capturedStderrCb = options?.stderr;
      return gen as ReturnType<typeof query>;
    });

    const result = await executeSdkTask(makeTaskConfig(), "test-task-stderr-success", tmpLogDir);

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("[child stderr]");
  });

  it("forwards muninSessionId as mcp-session-id header to the Munin MCP server", async () => {
    const messages = [createMockResultSuccess("Done")];
    mockedQuery.mockReturnValue(createMockQuery(messages) as ReturnType<typeof query>);

    await executeSdkTask(
      makeTaskConfig({ muninSessionId: "task-scoped-session-123" }),
      "test-task-session",
      tmpLogDir,
    );

    const call = mockedQuery.mock.calls[0]?.[0] as {
      options?: { mcpServers?: Record<string, { headers?: Record<string, string> }> };
    };
    const muninServer = call?.options?.mcpServers?.["munin-memory"];
    expect(muninServer?.headers?.["mcp-session-id"]).toBe("task-scoped-session-123");
    expect(muninServer?.headers?.Authorization).toBe("Bearer test-key");
  });

  it("omits mcp-session-id header when muninSessionId is not provided", async () => {
    const messages = [createMockResultSuccess("Done")];
    mockedQuery.mockReturnValue(createMockQuery(messages) as ReturnType<typeof query>);

    await executeSdkTask(makeTaskConfig(), "test-task-no-session", tmpLogDir);

    const call = mockedQuery.mock.calls[0]?.[0] as {
      options?: { mcpServers?: Record<string, { headers?: Record<string, string> }> };
    };
    const muninServer = call?.options?.mcpServers?.["munin-memory"];
    expect(muninServer?.headers?.["mcp-session-id"]).toBeUndefined();
    expect(muninServer?.headers?.Authorization).toBe("Bearer test-key");
  });

  it("does not inject friction-mcp when HUGIN_FRICTION_INJECTION is unset", async () => {
    const previous = process.env.HUGIN_FRICTION_INJECTION;
    delete process.env.HUGIN_FRICTION_INJECTION;
    try {
      const messages = [createMockResultSuccess("Done")];
      mockedQuery.mockReturnValue(createMockQuery(messages) as ReturnType<typeof query>);

      await executeSdkTask(makeTaskConfig(), "test-friction-off", tmpLogDir);

      const call = mockedQuery.mock.calls[0]?.[0] as {
        options?: { mcpServers?: Record<string, unknown> };
      };
      expect(call?.options?.mcpServers?.["friction"]).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.HUGIN_FRICTION_INJECTION;
      else process.env.HUGIN_FRICTION_INJECTION = previous;
    }
  });

  it("injects friction-mcp as a stdio server when HUGIN_FRICTION_INJECTION=on", async () => {
    const previous = process.env.HUGIN_FRICTION_INJECTION;
    process.env.HUGIN_FRICTION_INJECTION = "on";
    try {
      const messages = [createMockResultSuccess("Done")];
      mockedQuery.mockReturnValue(createMockQuery(messages) as ReturnType<typeof query>);

      await executeSdkTask(
        makeTaskConfig({ model: "claude-sonnet-4-6" }),
        "test-friction-on",
        tmpLogDir,
      );

      const call = mockedQuery.mock.calls[0]?.[0] as {
        options?: {
          mcpServers?: Record<
            string,
            { type?: string; command?: string; args?: string[]; env?: Record<string, string> }
          >;
        };
      };
      const friction = call?.options?.mcpServers?.["friction"];
      expect(friction).toBeDefined();
      expect(friction?.type).toBe("stdio");
      expect(friction?.args?.[0]).toMatch(/friction-mcp\.js$/);
      expect(friction?.env?.MUNIN_URL).toBe("http://localhost:3030");
      expect(friction?.env?.MUNIN_API_KEY).toBe("test-key");
      expect(friction?.env?.HUGIN_FRICTION_TASK_ID).toBe("test-friction-on");
      expect(friction?.env?.HUGIN_FRICTION_MODEL_ID).toBe("claude-sonnet-4-6");
    } finally {
      if (previous === undefined) delete process.env.HUGIN_FRICTION_INJECTION;
      else process.env.HUGIN_FRICTION_INJECTION = previous;
    }
  });

  it("defaults HUGIN_FRICTION_MODEL_ID to 'unknown' when task.model is unset", async () => {
    const previous = process.env.HUGIN_FRICTION_INJECTION;
    process.env.HUGIN_FRICTION_INJECTION = "on";
    try {
      const messages = [createMockResultSuccess("Done")];
      mockedQuery.mockReturnValue(createMockQuery(messages) as ReturnType<typeof query>);

      await executeSdkTask(makeTaskConfig(), "test-friction-unknown-model", tmpLogDir);

      const call = mockedQuery.mock.calls[0]?.[0] as {
        options?: {
          mcpServers?: Record<string, { env?: Record<string, string> }>;
        };
      };
      expect(call?.options?.mcpServers?.["friction"]?.env?.HUGIN_FRICTION_MODEL_ID).toBe(
        "unknown",
      );
    } finally {
      if (previous === undefined) delete process.env.HUGIN_FRICTION_INJECTION;
      else process.env.HUGIN_FRICTION_INJECTION = previous;
    }
  });

  it("should create log file with header and footer", async () => {
    const messages = [createMockResultSuccess("Done")];
    mockedQuery.mockReturnValue(createMockQuery(messages) as ReturnType<typeof query>);

    const result = await executeSdkTask(makeTaskConfig(), "test-task-log", tmpLogDir);

    const logContent = fs.readFileSync(result.logFile, "utf-8");
    expect(logContent).toContain("=== Hugin Task Log (SDK) ===");
    expect(logContent).toContain("Runtime: claude (agent-sdk)");
    expect(logContent).toContain("Exit code:");
    expect(logContent).toContain("Duration:");
    expect(logContent).toContain("Cost:");
  });

  it("should handle timeout with two-stage abort", async () => {
    // Create a generator that hangs indefinitely
    const gen = createMockQuery([]);
    let aborted = false;
    gen.next = async () => {
      // Wait until abort, then throw
      return new Promise((_, reject) => {
        const interval = setInterval(() => {
          if (aborted) {
            clearInterval(interval);
            reject(new Error("aborted"));
          }
        }, 10);
      });
    };
    mockedQuery.mockImplementation(({ options }) => {
      // Monitor the abort signal
      options?.abortController?.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return gen as ReturnType<typeof query>;
    });

    const onTimeout = vi.fn().mockResolvedValue(undefined);
    const result = await executeSdkTask(
      makeTaskConfig({ timeoutMs: 200 }),
      "test-task-timeout",
      tmpLogDir,
      { onTimeout },
    );

    expect(result.exitCode).toBe("TIMEOUT");
    expect(onTimeout).toHaveBeenCalled();
    expect(result.output).toContain("TIMEOUT");
  });
});

describe("formatChildStderr", () => {
  it("returns null when exitCode is 0 (success), even with stderr content", () => {
    expect(formatChildStderr("some error output", 0)).toBeNull();
  });

  it("returns null when stderrBuf is empty", () => {
    expect(formatChildStderr("", 1)).toBeNull();
  });

  it("returns null when stderrBuf is whitespace-only", () => {
    expect(formatChildStderr("   \n\t  ", 1)).toBeNull();
  });

  it("returns formatted block on non-zero exit code with stderr content", () => {
    const result = formatChildStderr("Error: authentication failed\nCode: 1", 1);
    expect(result).not.toBeNull();
    expect(result).toContain("[child stderr]");
    expect(result).toContain("Error: authentication failed");
    expect(result).toContain("Code: 1");
  });

  it("returns formatted block on TIMEOUT exit code with stderr content", () => {
    const result = formatChildStderr("timeout details", "TIMEOUT");
    expect(result).not.toBeNull();
    expect(result).toContain("[child stderr]");
    expect(result).toContain("timeout details");
  });

  it("truncates stderrBuf to the last 4000 chars when it exceeds the cap", () => {
    // Build a string: 5000 A's followed by 1000 B's = 6000 chars total.
    // slice(-4000) keeps the last 4000: 3000 A's + 1000 B's.
    // The first 2000 A's are discarded, so the result must not start with the
    // leading A block but must contain the trailing B's.
    const prefix = "A".repeat(5000);
    const suffix = "B".repeat(1000);
    const stderrBuf = prefix + suffix;
    const result = formatChildStderr(stderrBuf, 1);
    expect(result).not.toBeNull();
    // The block must contain the tail (Bs)
    expect(result).toContain("B".repeat(100));
    // The captured content should be exactly 4000 chars (plus the wrapper lines)
    const match = result!.match(/\[child stderr\]\n([\s\S]*)\n$/);
    expect(match).not.toBeNull();
    expect(match![1]!.length).toBeLessThanOrEqual(4000);
  });
});

describe("SDK executor result format", () => {
  it("should produce result compatible with Munin result schema", async () => {
    const messages = [
      createMockAssistantMessage("I fixed the bug in auth.ts"),
      createMockResultSuccess("Fixed authentication bug by correcting token validation."),
    ];
    mockedQuery.mockReturnValue(createMockQuery(messages) as ReturnType<typeof query>);

    const result = await executeSdkTask(makeTaskConfig(), "test-format", tmpLogDir);

    // The result text should be usable directly in Munin write
    expect(result.resultText).toBeTruthy();
    expect(typeof result.resultText).toBe("string");
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
    expect(typeof result.numTurns).toBe("number");
  });
});
