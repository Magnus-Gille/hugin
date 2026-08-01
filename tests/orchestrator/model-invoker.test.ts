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

  it("threads opts.signal into WorkerRequest.signal (issue #110)", async () => {
    const capturedRequests: WorkerRequest[] = [];
    const mockExecutor: WorkerExecutor = {
      run: vi.fn(async (req: WorkerRequest) => {
        capturedRequests.push(req);
        return makeResult("out");
      }),
    };

    const invoker = createModelInvoker(roles, { timeoutMs: 5000 }, () => mockExecutor);
    const controller = new AbortController();

    await invoker.invoke("worker", "do it", { signal: controller.signal });
    expect(capturedRequests[0].signal).toBe(controller.signal);
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

  it("passes homeserver worker metadata to /delegate and uses planner model as delegator fallback", async () => {
    const homeserverRoles: Record<OrchestratorRole, RoleBinding> = {
      ...roles,
      planner: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
      worker: { provider: "homeserver", model: "mellum" },
    };
    const capturedRequests: WorkerRequest[] = [];
    const factoryCalls: Array<{ provider: string; role: OrchestratorRole | undefined }> = [];
    const mockExecutor: WorkerExecutor = {
      run: vi.fn(async (req: WorkerRequest) => {
        capturedRequests.push(req);
        return makeResult("out");
      }),
    };

    const invoker = createModelInvoker(
      homeserverRoles,
      { timeoutMs: 5000, maxTokens: 2048 },
      (provider, opts) => {
        factoryCalls.push({ provider, role: opts?.role });
        return mockExecutor;
      },
    );

    await invoker.invoke("worker", "leaf task", { taskType: "summarize" });

    expect(factoryCalls[0]).toEqual({ provider: "homeserver", role: "worker" });
    expect(capturedRequests[0]).toMatchObject({
      provider: "homeserver",
      model: "mellum",
      prompt: "leaf task",
      taskType: "summarize",
      delegatorModelId: "anthropic/claude-sonnet-4.6",
      maxTokens: 2048,
    });
  });

  it("pins an eligible worker leaf to Orin while retaining the configured M5 model as its fallback", async () => {
    const homeserverRoles: Record<OrchestratorRole, RoleBinding> = {
      ...roles,
      worker: { provider: "homeserver", model: "qwen3-30b-instruct" },
    };
    const capturedRequests: WorkerRequest[] = [];
    const mockExecutor: WorkerExecutor = {
      run: vi.fn(async (req: WorkerRequest) => {
        capturedRequests.push(req);
        return makeResult("out");
      }),
    };

    const invoker = createModelInvoker(homeserverRoles, { timeoutMs: 5000 }, () => mockExecutor);
    await invoker.invoke("worker", "classify this", {
      taskType: "classify",
      workerRoute: { nodeId: "orin", modelId: "qwen2.5-coder:3b" },
    });

    expect(capturedRequests[0]).toMatchObject({
      provider: "homeserver",
      model: "qwen2.5-coder:3b",
      nodeId: "orin",
      fallbackModel: "qwen3-30b-instruct",
      taskType: "classify",
    });
  });

  it("lets an explicit homeserver worker delegator model override the planner fallback", async () => {
    const homeserverRoles: Record<OrchestratorRole, RoleBinding> = {
      ...roles,
      planner: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
      worker: { provider: "homeserver", model: "mellum", delegatorModelId: "openai/gpt-5.5" },
    };
    const capturedRequests: WorkerRequest[] = [];
    const mockExecutor: WorkerExecutor = {
      run: vi.fn(async (req: WorkerRequest) => {
        capturedRequests.push(req);
        return makeResult("out");
      }),
    };

    const invoker = createModelInvoker(homeserverRoles, { timeoutMs: 5000 }, () => mockExecutor);
    await invoker.invoke("worker", "leaf task", {
      taskType: "summarize",
      delegatorModelId: "anthropic/claude-opus-4.5",
    });

    expect(capturedRequests[0].delegatorModelId).toBe("anthropic/claude-opus-4.5");
  });

  it("does not attach worker-only delegate metadata to planner calls", async () => {
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

    await invoker.invoke("planner", "plan", {
      taskType: "summarize",
      delegatorModelId: "anthropic/claude-opus-4.5",
    });

    expect(capturedRequests[0].taskType).toBeUndefined();
    expect(capturedRequests[0].delegatorModelId).toBeUndefined();
  });

  it("threads the local working directory and read-only profile into non-worker pi-harness requests", async () => {
    const piRoles: Record<OrchestratorRole, RoleBinding> = {
      ...roles,
      planner: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
    };
    const capturedRequests: WorkerRequest[] = [];
    const mockExecutor: WorkerExecutor = {
      run: vi.fn(async (req: WorkerRequest) => {
        capturedRequests.push(req);
        return makeResult("out");
      }),
    };

    const invoker = createModelInvoker(
      piRoles,
      {
        timeoutMs: 5000,
        workingDirectory: "/home/magnus/repos/hugin",
        permissionProfile: "trusted-code",
      },
      () => mockExecutor,
    );

    await invoker.invoke("planner", "plan locally");

    expect(capturedRequests[0]).toMatchObject({
      provider: "pi-harness",
      model: "qwen/qwen3-coder-next",
      cwd: "/home/magnus/repos/hugin",
      permissionProfile: "read-only",
    });
    expect(capturedRequests[0].worktree).toBeUndefined();
  });

  it("threads read-only pi-harness workers through the local cwd instead of a writable task binding", async () => {
    const piRoles: Record<OrchestratorRole, RoleBinding> = {
      ...roles,
      worker: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
    };
    const capturedRequests: WorkerRequest[] = [];
    const mockExecutor: WorkerExecutor = {
      run: vi.fn(async (req: WorkerRequest) => {
        capturedRequests.push(req);
        return makeResult("out");
      }),
    };

    const invoker = createModelInvoker(
      piRoles,
      {
        timeoutMs: 5000,
        workingDirectory: "/home/magnus/repos/hugin",
        permissionProfile: "read-only",
      },
      () => mockExecutor,
    );

    await invoker.invoke("worker", "inspect");

    expect(capturedRequests[0]).toMatchObject({
      provider: "pi-harness",
      model: "qwen/qwen3-coder-next",
      cwd: "/home/magnus/repos/hugin",
      permissionProfile: "read-only",
    });
    expect(capturedRequests[0].worktree).toBeUndefined();
  });

  it("threads the selected worktree binding only into pi-harness worker requests (issue #339)", async () => {
    const piRoles: Record<OrchestratorRole, RoleBinding> = {
      ...roles,
      worker: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
    };
    const capturedRequests: WorkerRequest[] = [];
    const mockExecutor: WorkerExecutor = {
      run: vi.fn(async (req: WorkerRequest) => {
        capturedRequests.push(req);
        return makeResult("out");
      }),
    };
    const worktree = {
      cwd: "/home/magnus/repos/hugin-worktree",
      expectedRevision: "a".repeat(40),
      branchName: "hugin/task-339",
      managedRoot: "/home/magnus/repos",
    };

    const invoker = createModelInvoker(
      piRoles,
      {
        timeoutMs: 5000,
        workingDirectory: "/home/magnus/repos/hugin",
        permissionProfile: "trusted-code",
        workerWorktree: worktree,
      },
      () => mockExecutor,
    );

    await invoker.invoke("worker", "edit");
    await invoker.invoke("planner", "plan");

    expect(capturedRequests[0].worktree).toEqual(worktree);
    expect(capturedRequests[1].worktree).toBeUndefined();
  });

  it("routes every pi-harness orchestrator role with the intended mutability", async () => {
    const piRoles: Record<OrchestratorRole, RoleBinding> = {
      planner: { provider: "pi-harness", model: "planner-pi" },
      worker: { provider: "pi-harness", model: "worker-pi" },
      verifier: { provider: "pi-harness", model: "verifier-pi" },
      synthesizer: { provider: "pi-harness", model: "synth-pi" },
    };
    const capturedRequests: WorkerRequest[] = [];
    const mockExecutor: WorkerExecutor = {
      run: vi.fn(async (req: WorkerRequest) => {
        capturedRequests.push(req);
        return makeResult("out");
      }),
    };
    const worktree = {
      cwd: "/home/magnus/repos/hugin-worktree",
      expectedRevision: "a".repeat(40),
      branchName: "hugin/task-339",
      managedRoot: "/home/magnus/repos",
    };

    const invoker = createModelInvoker(
      piRoles,
      {
        timeoutMs: 5000,
        workingDirectory: "/home/magnus/repos/hugin",
        permissionProfile: "trusted-code",
        workerWorktree: worktree,
      },
      () => mockExecutor,
    );

    await invoker.invoke("planner", "plan");
    await invoker.invoke("worker", "edit");
    await invoker.invoke("verifier", "verify");
    await invoker.invoke("synthesizer", "synthesize");

    expect(capturedRequests).toHaveLength(4);
    expect(capturedRequests[0]).toMatchObject({
      provider: "pi-harness",
      model: "planner-pi",
      cwd: "/home/magnus/repos/hugin",
      permissionProfile: "read-only",
    });
    expect(capturedRequests[0].worktree).toBeUndefined();
    expect(capturedRequests[1]).toMatchObject({
      provider: "pi-harness",
      model: "worker-pi",
      cwd: "/home/magnus/repos/hugin",
      permissionProfile: "trusted-code",
      worktree,
    });
    expect(capturedRequests[2]).toMatchObject({
      provider: "pi-harness",
      model: "verifier-pi",
      cwd: "/home/magnus/repos/hugin",
      permissionProfile: "read-only",
    });
    expect(capturedRequests[2].worktree).toBeUndefined();
    expect(capturedRequests[3]).toMatchObject({
      provider: "pi-harness",
      model: "synth-pi",
      cwd: "/home/magnus/repos/hugin",
      permissionProfile: "read-only",
    });
    expect(capturedRequests[3].worktree).toBeUndefined();
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
