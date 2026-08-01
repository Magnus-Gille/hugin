import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import type { RoleBinding } from "../src/orchestrator/model-invoker.js";
import type { OrchestratorRole } from "../src/orchestrator/plan.js";
import type { WorkerExecutor, WorkerResult } from "../src/orchestrator/worker-executor.js";

interface SpawnBehavior {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  spawnError?: string;
}

const spawnCalls: Array<{
  cmd: string;
  args: string[];
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown };
}> = [];
let spawnBehaviors: SpawnBehavior[] = [];
let spawnCallIndex = 0;
const realpathResults = new Map<string, { value?: string; error?: Error & { code?: string } }>();

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    spawnCalls.push({ cmd, args, options });
    const child = new MockChildProcess();
    const behavior = spawnBehaviors[spawnCallIndex] ?? { exitCode: 0 };
    spawnCallIndex++;

    setImmediate(() => {
      if (behavior.spawnError) {
        child.emit("error", new Error(behavior.spawnError));
        return;
      }
      if (behavior.stdout) child.stdout.emit("data", Buffer.from(behavior.stdout));
      if (behavior.stderr) child.stderr.emit("data", Buffer.from(behavior.stderr));
      child.emit("close", behavior.exitCode);
    });

    return child;
  },
}));

vi.mock("node:fs/promises", () => ({
  realpath: async (input: string) => {
    const key = path.resolve(input);
    const entry = realpathResults.get(key);
    if (entry?.error) throw entry.error;
    return entry?.value ?? key;
  },
}));

const taskHelpers = await import("../src/task-helpers.js");
const admission = await import("../src/orchestrator/pi-harness-admission.js");
const { createModelInvoker } = await import("../src/orchestrator/model-invoker.js");

const MANAGED_ROOT = "/home/magnus/repos";
const WORKTREE = `${MANAGED_ROOT}/demo`;
const WORKTREE_SUBDIR = `${WORKTREE}/src`;
const READ_ONLY_CWD = "/home/magnus/workspace/demo-readonly";
const BRANCH_NAME = "hugin/task-339";
const EXPECTED_REVISION = "a".repeat(40);

const baseRoles: Record<OrchestratorRole, RoleBinding> = {
  planner: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
  worker: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
  verifier: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
  synthesizer: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
};

function setRealpath(
  rawPath: string,
  value: string = rawPath,
  error?: Error & { code?: string },
) {
  realpathResults.set(path.resolve(rawPath), error ? { error } : { value });
}

function primeDefaultRealpaths() {
  setRealpath(MANAGED_ROOT);
  setRealpath(WORKTREE);
  setRealpath(WORKTREE_SUBDIR);
  setRealpath(READ_ONLY_CWD);
}

function cleanBuilderBehaviors(head = EXPECTED_REVISION) {
  return [
    { exitCode: 0, stdout: `${WORKTREE}\n` },
    { exitCode: 0, stdout: `${BRANCH_NAME}\n` },
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: `${head}\n` },
  ];
}

function makeBindingResult() {
  return {
    cwd: WORKTREE,
    expectedRevision: EXPECTED_REVISION,
    branchName: BRANCH_NAME,
    managedRoot: MANAGED_ROOT,
  };
}

beforeEach(() => {
  spawnCalls.length = 0;
  spawnBehaviors = [];
  spawnCallIndex = 0;
  realpathResults.clear();
  primeDefaultRealpaths();
  vi.restoreAllMocks();
});

describe("buildManagedTaskWorktreeBinding", () => {
  it("rejects a non-SHA expected revision without touching git", async () => {
    const result = await taskHelpers.buildManagedTaskWorktreeBinding(
      WORKTREE,
      MANAGED_ROOT,
      BRANCH_NAME,
      "not-a-commit",
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not a full commit id");
    expect(spawnCalls).toHaveLength(0);
  });

  it("rejects a missing selected worktree path at realpath time", async () => {
    const missing = `${MANAGED_ROOT}/missing`;
    const err = new Error("ENOENT") as Error & { code?: string };
    err.code = "ENOENT";
    setRealpath(missing, missing, err);

    const result = await taskHelpers.buildManagedTaskWorktreeBinding(
      missing,
      MANAGED_ROOT,
      BRANCH_NAME,
      EXPECTED_REVISION,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not exist");
    expect(spawnCalls).toHaveLength(0);
  });

  it("requires the selected worktree to be a strict descendant of the managed repos root", async () => {
    const result = await taskHelpers.buildManagedTaskWorktreeBinding(
      MANAGED_ROOT,
      MANAGED_ROOT,
      BRANCH_NAME,
      EXPECTED_REVISION,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("beneath the configured managed repos root");
    expect(spawnCalls).toHaveLength(0);
  });

  it("rejects a selected worktree that resolves outside the managed repos root", async () => {
    const outside = "/home/magnus/workspace/demo";
    setRealpath(outside);

    const result = await taskHelpers.buildManagedTaskWorktreeBinding(
      outside,
      MANAGED_ROOT,
      BRANCH_NAME,
      EXPECTED_REVISION,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("beneath the configured managed repos root");
    expect(spawnCalls).toHaveLength(0);
  });

  it("rejects a selected path that is only a subdirectory of the git toplevel", async () => {
    spawnBehaviors = [{ exitCode: 0, stdout: `${WORKTREE}\n` }];

    const result = await taskHelpers.buildManagedTaskWorktreeBinding(
      WORKTREE_SUBDIR,
      MANAGED_ROOT,
      BRANCH_NAME,
      EXPECTED_REVISION,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("exact git toplevel selected for this task");
    expect(spawnCalls).toHaveLength(1);
  });

  it("rejects a selected worktree whose branch identity no longer matches the task branch", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: `${WORKTREE}\n` },
      { exitCode: 0, stdout: "main\n" },
    ];

    const result = await taskHelpers.buildManagedTaskWorktreeBinding(
      WORKTREE,
      MANAGED_ROOT,
      BRANCH_NAME,
      EXPECTED_REVISION,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("instead of the task branch");
    expect(result.reason).toContain(BRANCH_NAME);
    expect(spawnCalls).toHaveLength(2);
  });

  it("rejects a selected worktree whose HEAD no longer matches the pinned base revision", async () => {
    const otherRevision = "b".repeat(40);
    spawnBehaviors = cleanBuilderBehaviors(otherRevision);

    const result = await taskHelpers.buildManagedTaskWorktreeBinding(
      WORKTREE,
      MANAGED_ROOT,
      BRANCH_NAME,
      EXPECTED_REVISION,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain(otherRevision);
    expect(result.reason).toContain(EXPECTED_REVISION);
    expect(spawnCalls).toHaveLength(4);
  });

  it("rejects a selected worktree that is not clean at the pinned base revision", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: `${WORKTREE}\n` },
      { exitCode: 0, stdout: `${BRANCH_NAME}\n` },
      { exitCode: 0, stdout: "M src/index.ts\n" },
    ];

    const result = await taskHelpers.buildManagedTaskWorktreeBinding(
      WORKTREE,
      MANAGED_ROOT,
      BRANCH_NAME,
      EXPECTED_REVISION,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("uncommitted or untracked");
    expect(spawnCalls).toHaveLength(3);
  });
});

describe("preparePiHarnessWorktreeBinding", () => {
  it("does not require a writable binding for read-only pi-harness workers", async () => {
    const spy = vi.spyOn(taskHelpers, "buildManagedTaskWorktreeBinding");

    const result = await admission.preparePiHarnessWorktreeBinding({
      roles: {
        ...baseRoles,
        worker: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
      },
      capabilities: ["code"],
      permissionProfile: "read-only",
      branchResult: { action: "skipped" },
      workingDir: WORKTREE,
      reposRoot: MANAGED_ROOT,
    });

    expect(result).toEqual({ ok: true, effectiveWorkerPermissionProfile: "read-only" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not require a writable binding for non-worker pi-harness roles", async () => {
    const spy = vi.spyOn(taskHelpers, "buildManagedTaskWorktreeBinding");

    const result = await admission.preparePiHarnessWorktreeBinding({
      roles: {
        ...baseRoles,
        planner: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
      },
      capabilities: ["tools", "code"],
      permissionProfile: "trusted-code",
      branchResult: { action: "skipped" },
      workingDir: READ_ONLY_CWD,
      reposRoot: MANAGED_ROOT,
    });

    expect(result).toEqual({ ok: true, effectiveWorkerPermissionProfile: "trusted-code" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("degrades a trusted-code request without the code capability before any binding or refusal path is consulted", async () => {
    const spy = vi.spyOn(taskHelpers, "buildManagedTaskWorktreeBinding");

    const result = await admission.preparePiHarnessWorktreeBinding({
      roles: {
        ...baseRoles,
        worker: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
      },
      capabilities: ["tools"],
      permissionProfile: "trusted-code",
      branchResult: { action: "skipped" },
      workingDir: WORKTREE,
      reposRoot: MANAGED_ROOT,
      checkoutGateRefusalReason: "dirty checkout",
    });

    expect(result).toEqual({ ok: true, effectiveWorkerPermissionProfile: "read-only" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses before builder spend when the dispatcher checkout gate already refused the task", async () => {
    const spy = vi.spyOn(taskHelpers, "buildManagedTaskWorktreeBinding");

    const result = await admission.preparePiHarnessWorktreeBinding({
      roles: {
        ...baseRoles,
        worker: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
      },
      capabilities: ["tools", "code"],
      permissionProfile: "trusted-code",
      branchResult: { action: "created", branchName: BRANCH_NAME, baseCommit: EXPECTED_REVISION },
      workingDir: WORKTREE,
      reposRoot: MANAGED_ROOT,
      checkoutGateRefusalReason: "checkout is contaminated",
    });

    expect(result).toEqual({
      ok: false,
      reason:
        "pi-harness worker requires a verified managed task-branch checkout before model spending: " +
        "checkout is contaminated",
      effectiveWorkerPermissionProfile: "trusted-code",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses before builder spend when the dispatcher only has degraded read-only checkout state", async () => {
    const spy = vi.spyOn(taskHelpers, "buildManagedTaskWorktreeBinding");

    const result = await admission.preparePiHarnessWorktreeBinding({
      roles: {
        ...baseRoles,
        worker: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
      },
      capabilities: ["tools", "code"],
      permissionProfile: "trusted-code",
      branchResult: { action: "created", branchName: BRANCH_NAME, baseCommit: EXPECTED_REVISION },
      workingDir: WORKTREE,
      reposRoot: MANAGED_ROOT,
      checkoutGateDegraded: true,
    });

    expect(result).toEqual({
      ok: false,
      reason:
        "pi-harness worker requires a verified managed task-branch checkout before model spending; " +
        "the dispatcher only has degraded read-only checkout state",
      effectiveWorkerPermissionProfile: "trusted-code",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("supports reused/recovered branch identities whenever branch name and base commit are still pinned", async () => {
    const spy = vi.spyOn(taskHelpers, "buildManagedTaskWorktreeBinding").mockResolvedValue({
      ok: true,
      binding: makeBindingResult(),
    });

    const result = await admission.preparePiHarnessWorktreeBinding({
      roles: {
        ...baseRoles,
        worker: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
      },
      capabilities: ["tools", "code"],
      permissionProfile: "trusted-code",
      branchResult: {
        action: "fetch-failed",
        branchName: BRANCH_NAME,
        baseCommit: EXPECTED_REVISION,
        error: "branch already existed and was reused",
      },
      workingDir: WORKTREE,
      reposRoot: MANAGED_ROOT,
    });

    expect(result).toEqual({
      ok: true,
      effectiveWorkerPermissionProfile: "trusted-code",
      binding: makeBindingResult(),
    });
    expect(spy).toHaveBeenCalledWith(WORKTREE, MANAGED_ROOT, BRANCH_NAME, EXPECTED_REVISION);
  });

  it("propagates builder failures when a writable pi-harness worker cannot be bound", async () => {
    const spy = vi.spyOn(taskHelpers, "buildManagedTaskWorktreeBinding").mockResolvedValue({
      ok: false,
      reason: "selected worktree path could not be verified clean",
    });

    const result = await admission.preparePiHarnessWorktreeBinding({
      roles: {
        ...baseRoles,
        worker: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
      },
      capabilities: ["tools", "code"],
      permissionProfile: "trusted-code",
      branchResult: { action: "created", branchName: BRANCH_NAME, baseCommit: EXPECTED_REVISION },
      workingDir: WORKTREE,
      reposRoot: MANAGED_ROOT,
    });

    expect(result).toEqual({
      ok: false,
      reason: "selected worktree path could not be verified clean",
      effectiveWorkerPermissionProfile: "trusted-code",
    });
    expect(spy).toHaveBeenCalledWith(WORKTREE, MANAGED_ROOT, BRANCH_NAME, EXPECTED_REVISION);
  });

  it("blocks model invocation entirely when dispatch refusal happens before writable pi-harness admission", async () => {
    const executor: WorkerExecutor = {
      run: vi.fn(async () => ({
        ok: true,
        output: "should not run",
        provider: "pi-harness",
        model: "qwen/qwen3-coder-next",
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        latencyMs: 1,
      } satisfies WorkerResult)),
    };

    const binding = await admission.preparePiHarnessWorktreeBinding({
      roles: {
        ...baseRoles,
        worker: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
      },
      capabilities: ["tools", "code"],
      permissionProfile: "trusted-code",
      branchResult: { action: "created", branchName: BRANCH_NAME, baseCommit: EXPECTED_REVISION },
      workingDir: WORKTREE,
      reposRoot: MANAGED_ROOT,
      checkoutGateRefusalReason: "dirty checkout",
    });

    if (binding.ok) {
      const invoker = createModelInvoker(
        {
          ...baseRoles,
          worker: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
        },
        {
          timeoutMs: 5000,
          workingDirectory: WORKTREE,
          permissionProfile: binding.effectiveWorkerPermissionProfile,
          workerWorktree: binding.binding,
        },
        () => executor,
      );
      await invoker.invoke("worker", "edit this");
    }

    expect(binding.ok).toBe(false);
    expect(executor.run).not.toHaveBeenCalled();
  });

  it("keeps both planner and worker executable as read-only when trusted-code was requested without the code capability", async () => {
    const executorCalls: unknown[] = [];
    const executor: WorkerExecutor = {
      run: vi.fn(async (req) => {
        executorCalls.push(req);
        return {
          ok: true,
          output: "ok",
          provider: String(req.provider),
          model: String(req.model),
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          latencyMs: 1,
        } satisfies WorkerResult;
      }),
    };

    const binding = await admission.preparePiHarnessWorktreeBinding({
      roles: {
        planner: { provider: "pi-harness", model: "planner-pi" },
        worker: { provider: "pi-harness", model: "worker-pi" },
        verifier: { provider: "openrouter", model: "verifier" },
        synthesizer: { provider: "openrouter", model: "synth" },
      },
      capabilities: ["tools"],
      permissionProfile: "trusted-code",
      branchResult: { action: "skipped" },
      workingDir: READ_ONLY_CWD,
      reposRoot: MANAGED_ROOT,
      checkoutGateRefusalReason: "dirty checkout",
    });

    expect(binding).toEqual({ ok: true, effectiveWorkerPermissionProfile: "read-only" });
    if (!binding.ok) return;

    const invoker = createModelInvoker(
      {
        planner: { provider: "pi-harness", model: "planner-pi" },
        worker: { provider: "pi-harness", model: "worker-pi" },
        verifier: { provider: "openrouter", model: "verifier" },
        synthesizer: { provider: "openrouter", model: "synth" },
      },
      {
        timeoutMs: 5000,
        workingDirectory: READ_ONLY_CWD,
        permissionProfile: binding.effectiveWorkerPermissionProfile,
        workerWorktree: binding.binding,
      },
      () => executor,
    );

    await invoker.invoke("planner", "plan");
    await invoker.invoke("worker", "inspect");

    expect(executorCalls).toMatchObject([
      {
        provider: "pi-harness",
        model: "planner-pi",
        cwd: READ_ONLY_CWD,
        permissionProfile: "read-only",
      },
      {
        provider: "pi-harness",
        model: "worker-pi",
        cwd: READ_ONLY_CWD,
        permissionProfile: "read-only",
      },
    ]);
    expect((executorCalls[0] as { worktree?: unknown }).worktree).toBeUndefined();
    expect((executorCalls[1] as { worktree?: unknown }).worktree).toBeUndefined();
  });
});
