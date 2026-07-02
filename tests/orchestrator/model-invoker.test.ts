import { describe, it, expect, vi } from "vitest";
import type { WorkerExecutor, WorkerRequest, WorkerResult } from "../../src/orchestrator/worker-executor.js";
import { createModelInvoker } from "../../src/orchestrator/model-invoker.js";
import type { OrchestratorRole } from "../../src/orchestrator/plan.js";
import type { RoleBinding } from "../../src/orchestrator/model-invoker.js";

function makeResult(output: string, costUsd: number | null = 0.001): WorkerResult {
  return {
    ok: true,
    output,
    provider: "openrouter",
    model: "test-model",
    inputTokens: 100,
    outputTokens: 50,
    costUsd,
    latencyMs: 42,
  };
}

describe("createModelInvoker", () => {
  const roles: Record<OrchestratorRole, RoleBinding> = {
    planner: { provider: "openrouter", model: "planner-model" },
    worker: { provider: "berget", model: "worker-model" },
    verifier: { provider: "openrouter", model: "verifier-model" },
    synthesizer: { provider: "openrouter", model: "synth-model" },
  };

  it("builds correct WorkerRequest and returns executor result", async () => {
    const capturedRequests: WorkerRequest[] = [];
    const mockExecutor: WorkerExecutor = {
      run: vi.fn(async (req: WorkerRequest) => {
        capturedRequests.push(req);
        return makeResult("worker output");
      }),
    };

    const invoker = createModelInvoker(
      roles,
      { timeoutMs: 30000, maxOutputChars: 10000 },
      (_provider) => mockExecutor,
    );

    const result = await invoker.invoke("worker", "do the thing");

    expect(result.ok).toBe(true);
    expect(result.output).toBe("worker output");

    expect(capturedRequests).toHaveLength(1);
    const req = capturedRequests[0];
    expect(req.provider).toBe("berget");
    expect(req.model).toBe("worker-model");
    expect(req.prompt).toBe("do the thing");
    expect(req.timeoutMs).toBe(30000);
    expect(req.maxOutputChars).toBe(10000);
  });

  it("threads defaults.maxTokens into the WorkerRequest (issue #112)", async () => {
    const capturedRequests: WorkerRequest[] = [];
    const mockExecutor: WorkerExecutor = {
      run: vi.fn(async (req: WorkerRequest) => {
        capturedRequests.push(req);
        return makeResult("out");
      }),
    };

    const invoker = createModelInvoker(
      roles,
      { timeoutMs: 5000, maxTokens: 8192 },
      () => mockExecutor,
    );

    await invoker.invoke("worker", "do it");
    expect(capturedRequests[0].maxTokens).toBe(8192);
  });

  it("per-role binding maxTokens overrides the shared default (issue #112)", async () => {
    const perRoleRoles: Record<OrchestratorRole, RoleBinding> = {
      ...roles,
      synthesizer: { provider: "openrouter", model: "synth-model", maxTokens: 32000 },
    };
    const capturedRequests: WorkerRequest[] = [];
    const mockExecutor: WorkerExecutor = {
      run: vi.fn(async (req: WorkerRequest) => {
        capturedRequests.push(req);
        return makeResult("out");
      }),
    };

    const invoker = createModelInvoker(
      perRoleRoles,
      { timeoutMs: 5000, maxTokens: 8192 },
      () => mockExecutor,
    );

    await invoker.invoke("worker", "w"); // no per-role → shared default
    await invoker.invoke("synthesizer", "s"); // per-role override

    expect(capturedRequests[0].maxTokens).toBe(8192);
    expect(capturedRequests[1].maxTokens).toBe(32000);
  });

  it("passes systemPrompt when provided", async () => {
    const capturedRequests: WorkerRequest[] = [];
    const mockExecutor: WorkerExecutor = {
      run: vi.fn(async (req: WorkerRequest) => {
        capturedRequests.push(req);
        return makeResult("out");
      }),
    };

    const invoker = createModelInvoker(
      roles,
      { timeoutMs: 5000 },
      () => mockExecutor,
    );

    await invoker.invoke("planner", "plan something", { systemPrompt: "You are a planner." });
    expect(capturedRequests[0].systemPrompt).toBe("You are a planner.");
  });

  it("routes different roles to different providers/models", async () => {
    const capturedRequests: WorkerRequest[] = [];
    const mockExecutor: WorkerExecutor = {
      run: vi.fn(async (req: WorkerRequest) => {
        capturedRequests.push(req);
        return makeResult("out");
      }),
    };

    const invoker = createModelInvoker(roles, { timeoutMs: 5000 }, () => mockExecutor);

    await invoker.invoke("planner", "plan");
    await invoker.invoke("synthesizer", "synth");

    expect(capturedRequests[0].model).toBe("planner-model");
    expect(capturedRequests[0].provider).toBe("openrouter");
    expect(capturedRequests[1].model).toBe("synth-model");
  });

  it("returns executor result unchanged (propagates failures)", async () => {
    const failResult: WorkerResult = {
      ok: false,
      output: "",
      provider: "openrouter",
      model: "x",
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      latencyMs: 10,
      error: "network error",
    };
    const mockExecutor: WorkerExecutor = { run: vi.fn(async () => failResult) };

    const invoker = createModelInvoker(roles, { timeoutMs: 5000 }, () => mockExecutor);
    const result = await invoker.invoke("worker", "fail me");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("network error");
  });
});
