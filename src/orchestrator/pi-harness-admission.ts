import type { RuntimeCapability } from "../runtime-registry.js";
import type { TaskBranchResult } from "../task-helpers.js";
import { buildManagedTaskWorktreeBinding } from "../task-helpers.js";
import type { RoleBinding } from "./model-invoker.js";
import type { OrchestratorRole } from "./plan.js";
import type { WorkerWorktreeBinding } from "./worker-executor.js";

export interface PiHarnessWorktreeBindingRequest {
  roles: Record<OrchestratorRole, RoleBinding>;
  capabilities?: RuntimeCapability[];
  permissionProfile?: "read-only" | "trusted-code";
  branchResult: TaskBranchResult;
}

export type PiHarnessBindingAssessment =
  | { ok: true; needsBinding: false }
  | { ok: true; needsBinding: true }
  | { ok: false; reason: string };

export function assessPiHarnessWorktreeBindingRequest(
  input: PiHarnessWorktreeBindingRequest,
): PiHarnessBindingAssessment {
  const nonWorkerPiRoles = (["planner", "verifier", "synthesizer"] as const)
    .filter((role) => input.roles[role].provider === "pi-harness");
  if (nonWorkerPiRoles.length > 0) {
    return {
      ok: false,
      reason:
        `pi-harness is only supported for the orchestrator worker role; found on ` +
        nonWorkerPiRoles.join(", "),
    };
  }

  if (input.roles.worker.provider !== "pi-harness") {
    return { ok: true, needsBinding: false };
  }

  const writable =
    input.permissionProfile === "trusted-code" &&
    Boolean(input.capabilities?.includes("code"));
  if (!writable) {
    return {
      ok: false,
      reason:
        "pi-harness worker requires the effective trusted-code + code-capability contract; " +
        "read-only tasks cannot bind a writable task worktree",
    };
  }

  if (
    input.branchResult.action !== "created" ||
    !input.branchResult.branchName ||
    !input.branchResult.baseCommit
  ) {
    return {
      ok: false,
      reason:
        "pi-harness worker requires a managed task-branch checkout with a pinned base commit; " +
        "binding unavailable",
    };
  }

  return { ok: true, needsBinding: true };
}

export async function preparePiHarnessWorktreeBinding(input: {
  roles: Record<OrchestratorRole, RoleBinding>;
  capabilities?: RuntimeCapability[];
  permissionProfile?: "read-only" | "trusted-code";
  branchResult: TaskBranchResult;
  workingDir: string;
  reposRoot: string;
  checkoutGateRefusalReason?: string;
  checkoutGateDegraded?: boolean;
}): Promise<{ ok: true; binding?: WorkerWorktreeBinding } | { ok: false; reason: string }> {
  const assessment = assessPiHarnessWorktreeBindingRequest(input);
  if (!assessment.ok) return assessment;
  if (!assessment.needsBinding) return { ok: true };

  if (input.checkoutGateRefusalReason) {
    return {
      ok: false,
      reason:
        "pi-harness worker requires a verified managed task-branch checkout before model spending: " +
        input.checkoutGateRefusalReason,
    };
  }
  if (input.checkoutGateDegraded) {
    return {
      ok: false,
      reason:
        "pi-harness worker requires a verified managed task-branch checkout before model spending; " +
        "the dispatcher only has degraded read-only checkout state",
    };
  }

  const binding = await buildManagedTaskWorktreeBinding(
    input.workingDir,
    input.reposRoot,
    input.branchResult.branchName!,
    input.branchResult.baseCommit!,
  );
  if (!binding.ok) return binding;
  return { ok: true, binding: binding.binding };
}
