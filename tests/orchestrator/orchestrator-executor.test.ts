import { describe, it, expect, vi } from "vitest";
import {
  runOrchestratorTask,
  type OrchestratorTaskInput,
} from "../../src/orchestrator/orchestrator-executor.js";
import {
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorConfig,
} from "../../src/orchestrator/engine.js";
import type { ModelInvoker } from "../../src/orchestrator/model-invoker.js";
import type { WorkerResult } from "../../src/orchestrator/worker-executor.js";

// ---------------------------------------------------------------------------
// Mock invoker helpers
// ---------------------------------------------------------------------------

function makeSuccessResult(output: string, costUsd: number = 0.0001): WorkerResult {
  return {
    ok: true,
    output,
    costUsd,
    latencyMs: 10,
  };
}

/**
 * Build a mock ModelInvoker that returns canned responses for each role.
 * The planner response must be a valid plan JSON that parsePlan can handle;
 * we produce a simple single-subtask plan so workers get one call.
 */
function buildMockInvoker(opts: {
  plannerOutput?: string;
  workerOutput?: string;
  neverResolve?: boolean;
}): ModelInvoker {
  const plannerJson = opts.plannerOutput ??
    JSON.stringify({
      strategy: "parallel",
      subtasks: [{ id: "t1", title: "Do the thing", prompt: "Do the thing" }],
    });

  const invoke = vi.fn(
    async (role: string): Promise<WorkerResult> => {
      if (opts.neverResolve) {
        // Never resolves — used to test timeout
        return new Promise(() => { /* intentionally never resolves */ });
      }
      if (role === "planner") {
        return makeSuccessResult(plannerJson, 0.0002);
      }
      // worker / verifier / synthesizer
      return makeSuccessResult(opts.workerOutput ?? "Worker output here", 0.0001);
    },
  );

  return { invoke };
}

const defaultInput: OrchestratorTaskInput = {
  prompt: "Summarize the topic",
  sensitivity: "internal",
  timeoutMs: 5000,
  maxOutputChars: 10000,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runOrchestratorTask", () => {
  it("happy path: exitCode 0, resultText set, costUsd summed, onLog called", async () => {
    const invoker = buildMockInvoker({ workerOutput: "Great result" });
    const logLines: string[] = [];

    const result = await runOrchestratorTask(
      defaultInput,
      DEFAULT_ORCHESTRATOR_CONFIG,
      { invoker, onLog: (line) => logLines.push(line) },
    );

    expect(result.exitCode).toBe(0);
    expect(result.resultText).toBe("Great result");
    expect(result.costUsd).toBeTypeOf("number");
    expect(result.costUsd).toBeGreaterThan(0);
    // onLog should have been called at least once
    expect(logLines.length).toBeGreaterThan(0);
    // output should contain the result
    expect(result.output).toContain("Orchestration Result");
  });

  it("renders a Warnings section when a worker output was truncated (issue #112)", async () => {
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") {
          return makeSuccessResult(
            JSON.stringify({ strategy: "single", subtasks: [{ id: "t1", prompt: "Do it" }] }),
            0.0002,
          );
        }
        // Worker returns a length-truncated result.
        return { ...makeSuccessResult("partial worker output"), truncated: true };
      }),
    };

    const result = await runOrchestratorTask(defaultInput, DEFAULT_ORCHESTRATOR_CONFIG, { invoker });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Warnings");
    expect(result.output.toLowerCase()).toContain("truncat");
  });

  it("sensitivity guard blocks private+openrouter — invoker.invoke never called", async () => {
    const invoker = buildMockInvoker({});
    const invokeSpy = vi.spyOn(invoker, "invoke");

    // Default config uses openrouter — should be blocked for private
    const result = await runOrchestratorTask(
      { ...defaultInput, sensitivity: "private" },
      DEFAULT_ORCHESTRATOR_CONFIG,
      { invoker },
    );

    expect(result.exitCode).toBe(1);
    expect(result.resultText).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(result.output).toContain("private");
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("timeout path: invoker that never resolves + tiny timeoutMs → exitCode TIMEOUT", async () => {
    const invoker = buildMockInvoker({ neverResolve: true });

    const result = await runOrchestratorTask(
      { ...defaultInput, timeoutMs: 50 },
      DEFAULT_ORCHESTRATOR_CONFIG,
      { invoker },
    );

    expect(result.exitCode).toBe("TIMEOUT");
    expect(result.resultText).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(result.output).toContain("timed out");
  });

  it("aborted signal before execution → exitCode 1, no model calls", async () => {
    const invoker = buildMockInvoker({});
    const invokeSpy = vi.spyOn(invoker, "invoke");
    const controller = new AbortController();
    controller.abort();

    const result = await runOrchestratorTask(
      defaultInput,
      DEFAULT_ORCHESTRATOR_CONFIG,
      { invoker, signal: controller.signal },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("aborted");
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("engine failure: all workers fail → exitCode 1", async () => {
    const failingInvoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") {
          return makeSuccessResult(
            JSON.stringify({
              strategy: "parallel",
              subtasks: [{ id: "t1", title: "Task", prompt: "Do it" }],
            }),
          );
        }
        // Worker fails
        return {
          ok: false,
          output: "",
          error: "Model error",
          costUsd: null,
          latencyMs: 5,
        };
      }),
    };

    const result = await runOrchestratorTask(
      defaultInput,
      DEFAULT_ORCHESTRATOR_CONFIG,
      { invoker: failingInvoker },
    );

    expect(result.exitCode).toBe(1);
  });

  it("output is truncated to maxOutputChars", async () => {
    const invoker = buildMockInvoker({ workerOutput: "X".repeat(5000) });

    const result = await runOrchestratorTask(
      { ...defaultInput, maxOutputChars: 100 },
      DEFAULT_ORCHESTRATOR_CONFIG,
      { invoker },
    );

    expect(result.output.length).toBeLessThanOrEqual(100);
  });

  it("private+berget config is allowed (sensitivity guard passes)", async () => {
    const bergetConfig: OrchestratorConfig = {
      ...DEFAULT_ORCHESTRATOR_CONFIG,
      roles: {
        planner: { provider: "berget", model: "llama" },
        worker: { provider: "berget", model: "llama" },
        verifier: { provider: "berget", model: "llama" },
        synthesizer: { provider: "berget", model: "llama" },
      },
    };

    const invoker = buildMockInvoker({ workerOutput: "Secure result" });
    const result = await runOrchestratorTask(
      { ...defaultInput, sensitivity: "private" },
      bergetConfig,
      { invoker },
    );

    // Guard should pass; result depends on invoker behavior
    expect(result.exitCode).toBe(0);
    expect(result.resultText).toBe("Secure result");
  });
});
