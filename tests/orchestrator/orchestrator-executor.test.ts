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
import type { VerdictStoreLike } from "../../src/orchestrator/verdict-store.js";
import type { LedgerClientLike } from "../../src/orchestrator/ledger-client.js";

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

  it("task timeout aborts the signal threaded into the engine (issue #110)", async () => {
    let capturedSignal: AbortSignal | undefined;
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (_role: string, _prompt: string, opts?: { signal?: AbortSignal }) => {
        capturedSignal = opts?.signal;
        // Outlast the 50ms task timeout so the timeout wins the race.
        await new Promise((r) => setTimeout(r, 500));
        return makeSuccessResult("late");
      }),
    };

    const result = await runOrchestratorTask(
      { ...defaultInput, timeoutMs: 50 },
      DEFAULT_ORCHESTRATOR_CONFIG,
      { invoker },
    );

    expect(result.exitCode).toBe("TIMEOUT");
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it("forwards deps.signal abort into the engine signal mid-run (issue #110)", async () => {
    const outer = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string, _prompt: string, opts?: { signal?: AbortSignal }) => {
        capturedSignal = opts?.signal;
        // Abort the operator/deps signal while the first (planner) call is in flight.
        outer.abort();
        await new Promise((r) => setTimeout(r, 10));
        if (role === "planner") {
          return makeSuccessResult(
            JSON.stringify({ strategy: "single", subtasks: [{ id: "t1", prompt: "Do it" }] }),
          );
        }
        return makeSuccessResult("worker output");
      }),
    };

    await runOrchestratorTask(defaultInput, DEFAULT_ORCHESTRATOR_CONFIG, {
      invoker,
      signal: outer.signal,
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
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

  // --- Context-ref injection (Codex review of #127, Medium) ---

  it("prepends injectedContext to the prompt reaching the engine", async () => {
    let plannerPrompt: string | undefined;
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string, prompt: string): Promise<WorkerResult> => {
        if (role === "planner") {
          plannerPrompt = prompt;
          return makeSuccessResult(
            JSON.stringify({ strategy: "single", subtasks: [{ id: "t1", prompt: "Do it" }] }),
          );
        }
        return makeSuccessResult("worker output");
      }),
    };

    await runOrchestratorTask(
      { ...defaultInput, injectedContext: "RESOLVED_CONTEXT_MARKER" },
      DEFAULT_ORCHESTRATOR_CONFIG,
      { invoker },
    );

    expect(plannerPrompt).toContain("RESOLVED_CONTEXT_MARKER");
  });

  it("private + OpenRouter with injectedContext → guard rejects, zero model calls, context never used (#111 handoff)", async () => {
    const invoker = buildMockInvoker({});
    const invokeSpy = vi.spyOn(invoker, "invoke");

    const result = await runOrchestratorTask(
      { ...defaultInput, sensitivity: "private", injectedContext: "PRIVATE_REF_CONTENT" },
      DEFAULT_ORCHESTRATOR_CONFIG, // openrouter roles
      { invoker },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("private");
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("private + all-Berget with injectedContext → admitted and context reaches the engine", async () => {
    const bergetConfig: OrchestratorConfig = {
      ...DEFAULT_ORCHESTRATOR_CONFIG,
      roles: {
        planner: { provider: "berget", model: "llama" },
        worker: { provider: "berget", model: "llama" },
        verifier: { provider: "berget", model: "llama" },
        synthesizer: { provider: "berget", model: "llama" },
      },
    };

    let plannerPrompt: string | undefined;
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string, prompt: string): Promise<WorkerResult> => {
        if (role === "planner") {
          plannerPrompt = prompt;
          return makeSuccessResult(
            JSON.stringify({ strategy: "single", subtasks: [{ id: "t1", prompt: "Do it" }] }),
          );
        }
        return makeSuccessResult("secure output");
      }),
    };

    const result = await runOrchestratorTask(
      { ...defaultInput, sensitivity: "private", injectedContext: "PRIVATE_REF_CONTENT" },
      bergetConfig,
      { invoker },
    );

    expect(result.exitCode).toBe(0);
    expect(plannerPrompt).toContain("PRIVATE_REF_CONTENT");
  });
});

// ---------------------------------------------------------------------------
// Verdict layer (V3/V4/V5/V8): outcomes, recording, adaptive confidence
// ---------------------------------------------------------------------------

function makeWorkerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    ok: true,
    output: "worker output",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    inputTokens: 10,
    outputTokens: 10,
    costUsd: 0.0001,
    latencyMs: 42,
    ...overrides,
  };
}

function makeVerdictStoreMock(): VerdictStoreLike & {
  record: ReturnType<typeof vi.fn>;
  recordBatch: ReturnType<typeof vi.fn>;
  loadRecommendations: ReturnType<typeof vi.fn>;
} {
  return {
    record: vi.fn(async () => {}),
    recordBatch: vi.fn(async () => {}),
    loadRecommendations: vi.fn(async () => new Map()),
  };
}

function makeLedgerClientMock(): LedgerClientLike & { getLedger: ReturnType<typeof vi.fn> } {
  return {
    getLedger: vi.fn(async () => null),
  };
}

/** A single-subtask plan with an explicit taskType, so verdict keys are predictable. */
function singleSubtaskPlan(taskType: string): string {
  return JSON.stringify({
    subtasks: [{ id: "1", prompt: "Do it", taskType }],
  });
}

describe("runOrchestratorTask — summary worker lines gain model + verdict marker (V8)", () => {
  it("includes the worker's model in each subtask outcome line", async () => {
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        return makeWorkerResult({ output: "result", model: "deepseek/deepseek-v4-flash" });
      }),
    };

    const result = await runOrchestratorTask(defaultInput, DEFAULT_ORCHESTRATOR_CONFIG, { invoker });

    expect(result.output).toContain("deepseek/deepseek-v4-flash");
  });

  it("marks a subtask outcome with an explicit failed verdict with a ✗ marker", async () => {
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        if (role === "verifier") return makeWorkerResult({ output: "FAIL - wrong" });
        return makeWorkerResult({ output: "result" });
      }),
    };
    const config: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG, verifyWorkers: true };

    const result = await runOrchestratorTask(defaultInput, config, { invoker });

    expect(result.output).toContain("✗");
  });

  it("does not show the verdict marker for a subtask that passed verification", async () => {
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        if (role === "verifier") return makeWorkerResult({ output: "PASS" });
        return makeWorkerResult({ output: "result" });
      }),
    };
    const config: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG, verifyWorkers: true };

    const result = await runOrchestratorTask(defaultInput, config, { invoker });

    expect(result.output).not.toContain("✗");
  });
});

describe("runOrchestratorTask — outcomes field (V8)", () => {
  it("carries the engine's outcomes through on a successful run", async () => {
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") {
          return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        }
        return makeWorkerResult({ output: "Great result" });
      }),
    };

    const result = await runOrchestratorTask(defaultInput, DEFAULT_ORCHESTRATOR_CONFIG, {
      invoker,
    });

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].subtask.taskType).toBe("summarize");
    expect(result.outcomes[0].result.ok).toBe(true);
  });

  it("outcomes is an empty array when the sensitivity guard rejects the task", async () => {
    const invoker: ModelInvoker = { invoke: vi.fn() };
    const result = await runOrchestratorTask(
      { ...defaultInput, sensitivity: "private" },
      DEFAULT_ORCHESTRATOR_CONFIG,
      { invoker },
    );
    expect(result.outcomes).toEqual([]);
  });

  it("outcomes is an empty array on timeout", async () => {
    const invoker: ModelInvoker = {
      invoke: vi.fn(async () => new Promise(() => {})),
    };
    const result = await runOrchestratorTask(
      { ...defaultInput, timeoutMs: 30 },
      DEFAULT_ORCHESTRATOR_CONFIG,
      { invoker },
    );
    expect(result.outcomes).toEqual([]);
  });
});

describe("runOrchestratorTask — verdict recording (Fix #1: verified/unverified separation, Fix #2: batched)", () => {
  it("records an 'unverified' event (NOT 'pass') for a successful subtask that was never checked by a verifier", async () => {
    // Fix #1 — the confidence-poisoning bug: a subtask that succeeded but was
    // never run through the verifier must NOT be recorded as quality signal.
    const verdictStore = makeVerdictStoreMock();
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        return makeWorkerResult({ output: "result", model: "deepseek/deepseek-v4-flash", latencyMs: 77 });
      }),
    };

    await runOrchestratorTask(defaultInput, DEFAULT_ORCHESTRATOR_CONFIG, {
      invoker,
      verdictStore,
    });

    expect(verdictStore.recordBatch).toHaveBeenCalledTimes(1);
    expect(verdictStore.recordBatch).toHaveBeenCalledWith([
      { modelId: "deepseek/deepseek-v4-flash", taskType: "summarize", event: "unverified", latencyMs: 77 },
    ]);
  });

  it("records a 'pass' event when the subtask WAS verified with an explicit ok verdict", async () => {
    const verdictStore = makeVerdictStoreMock();
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        if (role === "verifier") return makeWorkerResult({ output: "PASS - looks great" });
        return makeWorkerResult({ output: "result", model: "deepseek/deepseek-v4-flash", latencyMs: 77 });
      }),
    };
    const config: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG, verifyWorkers: true };

    await runOrchestratorTask(defaultInput, config, { invoker, verdictStore });

    expect(verdictStore.recordBatch).toHaveBeenCalledWith([
      { modelId: "deepseek/deepseek-v4-flash", taskType: "summarize", event: "pass", latencyMs: 77 },
    ]);
  });

  it("records an 'error' event for a failed (infra) worker outcome", async () => {
    const verdictStore = makeVerdictStoreMock();
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("code-review") });
        return {
          ok: false,
          output: "",
          provider: "openrouter",
          model: "deepseek/deepseek-v4-flash",
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          latencyMs: 30,
          error: "boom",
        };
      }),
    };

    await runOrchestratorTask(defaultInput, DEFAULT_ORCHESTRATOR_CONFIG, {
      invoker,
      verdictStore,
    });

    expect(verdictStore.recordBatch).toHaveBeenCalledWith([
      { modelId: "deepseek/deepseek-v4-flash", taskType: "code-review", event: "error", latencyMs: 30 },
    ]);
  });

  it("records a 'fail' event when the verifier gives an explicit failed verdict", async () => {
    const verdictStore = makeVerdictStoreMock();
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("qa-factual") });
        if (role === "verifier") return makeWorkerResult({ output: "FAIL - wrong answer" });
        return makeWorkerResult({ output: "result", latencyMs: 60 });
      }),
    };
    const config: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG, verifyWorkers: true };

    await runOrchestratorTask(defaultInput, config, { invoker, verdictStore });

    expect(verdictStore.recordBatch).toHaveBeenCalledWith([
      { modelId: "deepseek/deepseek-v4-flash", taskType: "qa-factual", event: "fail", latencyMs: 60 },
    ]);
  });

  it("batches ALL outcomes from a multi-subtask run into a SINGLE recordBatch call", async () => {
    const verdictStore = makeVerdictStoreMock();
    const PLAN_3 = JSON.stringify({
      subtasks: [
        { id: "1", prompt: "Step 1", taskType: "summarize" },
        { id: "2", prompt: "Step 2", taskType: "code-review" },
        { id: "3", prompt: "Step 3", taskType: "extract" },
      ],
    });
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: PLAN_3 });
        return makeWorkerResult({ output: "result" });
      }),
    };

    await runOrchestratorTask(defaultInput, DEFAULT_ORCHESTRATOR_CONFIG, { invoker, verdictStore });

    expect(verdictStore.recordBatch).toHaveBeenCalledTimes(1);
    const batch = verdictStore.recordBatch.mock.calls[0][0];
    expect(batch).toHaveLength(3);
  });

  it("does not attempt to record when deps.verdictStore is absent", async () => {
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("other") });
        return makeWorkerResult({ output: "result" });
      }),
    };
    // Should simply not throw / not attempt anything verdict-store related.
    const result = await runOrchestratorTask(defaultInput, DEFAULT_ORCHESTRATOR_CONFIG, { invoker });
    expect(result.exitCode).toBe(0);
  });
});

describe("runOrchestratorTask — verdict recording is TRULY fire-and-forget (Fix #2)", () => {
  it("a never-resolving verdictStore.recordBatch does not block runOrchestratorTask's return", async () => {
    const verdictStore: VerdictStoreLike = {
      record: vi.fn(async () => {}),
      recordBatch: vi.fn(() => new Promise<void>(() => { /* never resolves */ })),
      loadRecommendations: vi.fn(async () => new Map()),
    };
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        return makeWorkerResult({ output: "result" });
      }),
    };

    const result = await runOrchestratorTask(defaultInput, DEFAULT_ORCHESTRATOR_CONFIG, {
      invoker,
      verdictStore,
    });

    expect(result.exitCode).toBe(0);
  }, 2000);
});

describe("runOrchestratorTask — adaptive confidence source selection (V5)", () => {
  it("consults the verdict store (not the ledger) when the worker provider is NOT homeserver", async () => {
    const verdictStore = makeVerdictStoreMock();
    const ledgerClient = makeLedgerClientMock();
    verdictStore.loadRecommendations.mockResolvedValue(
      new Map([["deepseek/deepseek-v4-flash|summarize", { recommendation: "delegate-local", unverifiedPasses: 0 }]]),
    );

    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        return makeWorkerResult({ output: "result" });
      }),
    };
    const config: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG, adaptiveVerify: true };

    await runOrchestratorTask(defaultInput, config, { invoker, verdictStore, ledgerClient });

    expect(verdictStore.loadRecommendations).toHaveBeenCalledTimes(1);
    expect(ledgerClient.getLedger).not.toHaveBeenCalled();
    // recommendation was delegate-local → verifier is skipped (trusted).
    expect(invoker.invoke).not.toHaveBeenCalledWith(
      "verifier",
      expect.anything(),
      expect.anything(),
    );
  });

  it("consults the ledger (not the verdict store) when the worker provider is homeserver", async () => {
    const verdictStore = makeVerdictStoreMock();
    const ledgerClient = makeLedgerClientMock();
    ledgerClient.getLedger.mockResolvedValue({
      report: [
        {
          taskType: "summarize",
          modelId: "qwen3-30b-instruct",
          verdict: "viable",
          attempts: 10,
          passes: 9,
          fails: 1,
          errors: 0,
          successRate: 0.9,
          frozen: false,
          recommendation: "delegate-local",
        },
      ],
    });

    const homeserverConfig: OrchestratorConfig = {
      ...DEFAULT_ORCHESTRATOR_CONFIG,
      adaptiveVerify: true,
      roles: {
        ...DEFAULT_ORCHESTRATOR_CONFIG.roles,
        worker: { provider: "homeserver", model: "qwen3-30b-instruct" },
      },
    };

    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        return makeWorkerResult({ output: "result", provider: "homeserver", model: "qwen3-30b-instruct" });
      }),
    };

    await runOrchestratorTask(defaultInput, homeserverConfig, {
      invoker,
      verdictStore,
      ledgerClient,
    });

    expect(ledgerClient.getLedger).toHaveBeenCalledTimes(1);
    expect(verdictStore.loadRecommendations).not.toHaveBeenCalled();
  });

  it("does not consult the store/ledger for confidence when adaptiveVerify is off (recording still happens)", async () => {
    const verdictStore = makeVerdictStoreMock();
    const ledgerClient = makeLedgerClientMock();

    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        return makeWorkerResult({ output: "result" });
      }),
    };

    await runOrchestratorTask(defaultInput, DEFAULT_ORCHESTRATOR_CONFIG, {
      invoker,
      verdictStore,
      ledgerClient,
    });

    expect(verdictStore.loadRecommendations).not.toHaveBeenCalled();
    expect(ledgerClient.getLedger).not.toHaveBeenCalled();
    expect(verdictStore.recordBatch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// buildConfidenceFn fail direction: missing source → ALWAYS null → verify
// (Fix #9)
// ---------------------------------------------------------------------------

describe("runOrchestratorTask — buildConfidenceFn fails toward verify, never toward silent skip (Fix #9)", () => {
  it("adaptiveVerify on + non-homeserver worker + verdictStore MISSING → still verifies (fail-closed toward caution)", async () => {
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        if (role === "verifier") return makeWorkerResult({ output: "PASS" });
        return makeWorkerResult({ output: "result" });
      }),
    };
    const config: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG, adaptiveVerify: true };

    // No verdictStore supplied at all.
    await runOrchestratorTask(defaultInput, config, { invoker });

    expect(invoker.invoke).toHaveBeenCalledWith("verifier", expect.anything(), expect.anything());
  });

  it("adaptiveVerify on + homeserver worker + ledgerClient MISSING → still verifies (fail-closed toward caution)", async () => {
    const homeserverConfig: OrchestratorConfig = {
      ...DEFAULT_ORCHESTRATOR_CONFIG,
      adaptiveVerify: true,
      roles: {
        ...DEFAULT_ORCHESTRATOR_CONFIG.roles,
        worker: { provider: "homeserver", model: "qwen3-30b-instruct" },
      },
    };
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        if (role === "verifier") return makeWorkerResult({ output: "PASS" });
        return makeWorkerResult({ output: "result", provider: "homeserver", model: "qwen3-30b-instruct" });
      }),
    };

    // No ledgerClient supplied at all.
    await runOrchestratorTask(defaultInput, homeserverConfig, { invoker });

    expect(invoker.invoke).toHaveBeenCalledWith("verifier", expect.anything(), expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Re-probe gate: breaks the delegate-local absorbing state (Fix #1 / V5)
// ---------------------------------------------------------------------------

describe("runOrchestratorTask — re-probe gate on a long unverified streak (Fix #1)", () => {
  it("delegate-local recommendation but unverifiedPasses >= default threshold (10) → re-probes (verifies)", async () => {
    const verdictStore = makeVerdictStoreMock();
    verdictStore.loadRecommendations.mockResolvedValue(
      new Map([
        ["deepseek/deepseek-v4-flash|summarize", { recommendation: "delegate-local", unverifiedPasses: 10 }],
      ]),
    );
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        if (role === "verifier") return makeWorkerResult({ output: "PASS" });
        return makeWorkerResult({ output: "result" });
      }),
    };
    const config: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG, adaptiveVerify: true };

    await runOrchestratorTask(defaultInput, config, { invoker, verdictStore });

    expect(invoker.invoke).toHaveBeenCalledWith("verifier", expect.anything(), expect.anything());
  });

  it("delegate-local recommendation with unverifiedPasses BELOW the threshold → stays trusted (no verify)", async () => {
    const verdictStore = makeVerdictStoreMock();
    verdictStore.loadRecommendations.mockResolvedValue(
      new Map([
        ["deepseek/deepseek-v4-flash|summarize", { recommendation: "delegate-local", unverifiedPasses: 3 }],
      ]),
    );
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        return makeWorkerResult({ output: "result" });
      }),
    };
    const config: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG, adaptiveVerify: true };

    await runOrchestratorTask(defaultInput, config, { invoker, verdictStore });

    expect(invoker.invoke).not.toHaveBeenCalledWith("verifier", expect.anything(), expect.anything());
  });

  it("respects a HUGIN_ORCH_REPROBE_UNVERIFIED override", async () => {
    vi.stubEnv("HUGIN_ORCH_REPROBE_UNVERIFIED", "2");
    try {
      const verdictStore = makeVerdictStoreMock();
      verdictStore.loadRecommendations.mockResolvedValue(
        new Map([
          ["deepseek/deepseek-v4-flash|summarize", { recommendation: "delegate-local", unverifiedPasses: 2 }],
        ]),
      );
      const invoker: ModelInvoker = {
        invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
          if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
          if (role === "verifier") return makeWorkerResult({ output: "PASS" });
          return makeWorkerResult({ output: "result" });
        }),
      };
      const config: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG, adaptiveVerify: true };

      await runOrchestratorTask(defaultInput, config, { invoker, verdictStore });

      expect(invoker.invoke).toHaveBeenCalledWith("verifier", expect.anything(), expect.anything());
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("homeserver/ledger-backed workers are NOT subject to the re-probe gate (ledger rows have no unverifiedPasses concept)", async () => {
    const ledgerClient = makeLedgerClientMock();
    ledgerClient.getLedger.mockResolvedValue({
      report: [
        {
          taskType: "summarize",
          modelId: "qwen3-30b-instruct",
          verdict: "viable",
          attempts: 100,
          passes: 95,
          fails: 5,
          errors: 0,
          successRate: 0.95,
          frozen: false,
          recommendation: "delegate-local",
        },
      ],
    });
    const homeserverConfig: OrchestratorConfig = {
      ...DEFAULT_ORCHESTRATOR_CONFIG,
      adaptiveVerify: true,
      roles: {
        ...DEFAULT_ORCHESTRATOR_CONFIG.roles,
        worker: { provider: "homeserver", model: "qwen3-30b-instruct" },
      },
    };
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
        if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
        return makeWorkerResult({ output: "result", provider: "homeserver", model: "qwen3-30b-instruct" });
      }),
    };

    await runOrchestratorTask(defaultInput, homeserverConfig, { invoker, ledgerClient });

    expect(invoker.invoke).not.toHaveBeenCalledWith("verifier", expect.anything(), expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Abort race (Fix #3): an abort during the confidence-source await must not
// be lost.
// ---------------------------------------------------------------------------

describe("runOrchestratorTask — abort during the confidence-source load is not lost (Fix #3)", () => {
  it("aborting deps.signal WHILE the verdict-store read is in flight still aborts the engine signal", async () => {
    const verdictStore = makeVerdictStoreMock();
    let resolveRecommendations!: (map: Map<string, unknown>) => void;
    verdictStore.loadRecommendations.mockImplementation(
      () => new Promise((resolve) => { resolveRecommendations = resolve; }),
    );

    const outer = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (_role: string, _prompt: string, opts?: { signal?: AbortSignal }): Promise<WorkerResult> => {
        capturedSignal = opts?.signal;
        return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
      }),
    };
    const config: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG, adaptiveVerify: true };

    const runPromise = runOrchestratorTask(defaultInput, config, {
      invoker,
      verdictStore,
      signal: outer.signal,
    });

    // Abort WHILE buildConfidenceFn's internal await is still pending.
    outer.abort();
    // Now let the confidence-source read resolve, so the run can proceed.
    resolveRecommendations(new Map());

    await runPromise;

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Confidence-source load is time-bounded (Fix #3): a hanging store/ledger
// read must not stall the task — degrade to null (fail toward verify) after
// a bounded deadline.
// ---------------------------------------------------------------------------

describe("runOrchestratorTask — confidence-source load is bounded by a deadline (Fix #3)", () => {
  it("a verdict store read that never resolves times out to null (fail toward verify), never hangs the task", async () => {
    vi.useFakeTimers();
    try {
      const verdictStore = makeVerdictStoreMock();
      verdictStore.loadRecommendations.mockImplementation(() => new Promise(() => { /* never resolves */ }));

      const invoker: ModelInvoker = {
        invoke: vi.fn(async (role: string): Promise<WorkerResult> => {
          if (role === "planner") return makeWorkerResult({ output: singleSubtaskPlan("summarize") });
          if (role === "verifier") return makeWorkerResult({ output: "PASS" });
          return makeWorkerResult({ output: "result" });
        }),
      };
      const config: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG, adaptiveVerify: true };

      // A generous task-level timeout so ONLY the confidence-source deadline
      // is exercised in this test (not a race against the outer timeout).
      const runPromise = runOrchestratorTask({ ...defaultInput, timeoutMs: 60_000 }, config, {
        invoker,
        verdictStore,
      });

      await vi.advanceTimersByTimeAsync(6_000);
      const result = await runPromise;

      // No signal from the store → fail-open toward verify: the verifier
      // role must have been invoked despite the confidence source hanging.
      expect(invoker.invoke).toHaveBeenCalledWith("verifier", expect.anything(), expect.anything());
      expect(result.exitCode).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
