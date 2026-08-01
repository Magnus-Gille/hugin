import { describe, it, expect } from "vitest";
import type { RoleBinding } from "../../src/orchestrator/model-invoker.js";
import type { OrchestratorRole } from "../../src/orchestrator/plan.js";
import { assessPiHarnessWorktreeBindingRequest } from "../../src/orchestrator/pi-harness-admission.js";

const baseRoles: Record<OrchestratorRole, RoleBinding> = {
  planner: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
  worker: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
  verifier: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
  synthesizer: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
};

describe("assessPiHarnessWorktreeBindingRequest", () => {
  it("allows pi-harness on non-worker orchestrator roles without requiring a writable binding", () => {
    const result = assessPiHarnessWorktreeBindingRequest({
      roles: {
        ...baseRoles,
        planner: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
      },
      capabilities: ["code"],
      permissionProfile: "trusted-code",
      branchResult: { action: "created", branchName: "hugin/task-339", baseCommit: "a".repeat(40) },
    });

    expect(result).toEqual({ ok: true, needsBinding: false });
  });

  it("allows read-only pi-harness workers without requiring a writable binding", () => {
    const result = assessPiHarnessWorktreeBindingRequest({
      roles: {
        ...baseRoles,
        worker: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
      },
      capabilities: ["code"],
      permissionProfile: "read-only",
      branchResult: { action: "created", branchName: "hugin/task-339", baseCommit: "a".repeat(40) },
    });

    expect(result).toEqual({ ok: true, needsBinding: false });
  });

  it("refuses pi-harness when the managed task-branch binding is unavailable", () => {
    const result = assessPiHarnessWorktreeBindingRequest({
      roles: {
        ...baseRoles,
        worker: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
      },
      capabilities: ["code"],
      permissionProfile: "trusted-code",
      branchResult: { action: "skipped" },
    });

    expect(result).toEqual({
      ok: false,
      reason:
        "pi-harness worker requires a managed task-branch checkout with a pinned base commit; binding unavailable",
    });
  });

  it("accepts non-pi worker layouts without requiring a binding", () => {
    const result = assessPiHarnessWorktreeBindingRequest({
      roles: baseRoles,
      capabilities: ["structured-output"],
      permissionProfile: "read-only",
      branchResult: { action: "skipped" },
    });

    expect(result).toEqual({ ok: true, needsBinding: false });
  });

  it("accepts a writable pi-harness worker when checkout evidence is present", () => {
    const result = assessPiHarnessWorktreeBindingRequest({
      roles: {
        ...baseRoles,
        worker: { provider: "pi-harness", model: "qwen/qwen3-coder-next" },
      },
      capabilities: ["tools", "code"],
      permissionProfile: "trusted-code",
      branchResult: {
        action: "created",
        branchName: "hugin/task-339",
        baseCommit: "a".repeat(40),
      },
    });

    expect(result).toEqual({ ok: true, needsBinding: true });
  });
});
