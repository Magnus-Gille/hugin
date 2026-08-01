import * as path from "node:path";
import type { RuntimeCapability } from "../runtime-registry.js";
import type { TaskBranchResult } from "../task-helpers.js";
import { buildManagedTaskWorktreeBinding } from "../task-helpers.js";
import type { RoleBinding } from "./model-invoker.js";
import type { OrchestratorRole } from "./plan.js";
import type {
  PiHarnessPermissionProfile,
  WorkerWorktreeBinding,
} from "./pi-harness-types.js";

export interface PiHarnessWorktreeBindingRequest {
  roles: Record<OrchestratorRole, RoleBinding>;
  capabilities?: RuntimeCapability[];
  permissionProfile?: PiHarnessPermissionProfile;
  branchResult: TaskBranchResult;
}

export type PiHarnessBindingAssessment =
  | {
      ok: true;
      needsBinding: false;
      effectiveWorkerPermissionProfile: PiHarnessPermissionProfile;
    }
  | {
      ok: true;
      needsBinding: true;
      effectiveWorkerPermissionProfile: PiHarnessPermissionProfile;
    }
  | {
      ok: false;
      reason: string;
      effectiveWorkerPermissionProfile: PiHarnessPermissionProfile;
    };

export function deriveEffectivePiHarnessWorkerPermissionProfile(
  input: Pick<PiHarnessWorktreeBindingRequest, "capabilities" | "permissionProfile">,
): PiHarnessPermissionProfile {
  return input.permissionProfile === "trusted-code" &&
    Boolean(input.capabilities?.includes("code"))
    ? "trusted-code"
    : "read-only";
}

export function assessPiHarnessWorktreeBindingRequest(
  input: PiHarnessWorktreeBindingRequest,
): PiHarnessBindingAssessment {
  const effectiveWorkerPermissionProfile = deriveEffectivePiHarnessWorkerPermissionProfile(input);
  const workerUsesPiHarness = input.roles.worker.provider === "pi-harness";
  if (!workerUsesPiHarness) {
    return { ok: true, needsBinding: false, effectiveWorkerPermissionProfile };
  }

  if (effectiveWorkerPermissionProfile !== "trusted-code") {
    return { ok: true, needsBinding: false, effectiveWorkerPermissionProfile };
  }

  if (!input.branchResult.branchName || !input.branchResult.baseCommit) {
    return {
      ok: false,
      reason:
        "pi-harness worker requires a managed task-branch checkout with a pinned base commit; " +
        "binding unavailable",
      effectiveWorkerPermissionProfile,
    };
  }

  return { ok: true, needsBinding: true, effectiveWorkerPermissionProfile };
}

function isContainedByRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function canDowngradeTrustedPiWorkerToReadOnly(input: {
  workingDir: string;
  reposRoot: string;
  allowedReadOnlyRoots?: string[];
}): boolean {
  if (!input.allowedReadOnlyRoots || input.allowedReadOnlyRoots.length === 0) {
    return false;
  }
  const resolvedWorkingDir = path.resolve(input.workingDir);
  const resolvedReposRoot = path.resolve(input.reposRoot);
  if (isContainedByRoot(resolvedWorkingDir, resolvedReposRoot)) {
    return false;
  }
  return input.allowedReadOnlyRoots
    .map((root) => path.resolve(root))
    .some((root) => isContainedByRoot(resolvedWorkingDir, root));
}

export async function preparePiHarnessWorktreeBinding(input: {
  roles: Record<OrchestratorRole, RoleBinding>;
  capabilities?: RuntimeCapability[];
  permissionProfile?: PiHarnessPermissionProfile;
  branchResult: TaskBranchResult;
  workingDir: string;
  reposRoot: string;
  allowedReadOnlyRoots?: string[];
  checkoutGateRefusalReason?: string;
  checkoutGateDegraded?: boolean;
}): Promise<
  | {
      ok: true;
      effectiveWorkerPermissionProfile: PiHarnessPermissionProfile;
      binding?: WorkerWorktreeBinding;
    }
  | {
      ok: false;
      reason: string;
      effectiveWorkerPermissionProfile: PiHarnessPermissionProfile;
    }
> {
  const effectiveWorkerPermissionProfile = deriveEffectivePiHarnessWorkerPermissionProfile(input);
  const workerUsesPiHarness = input.roles.worker.provider === "pi-harness";
  const bindingUnavailable = !input.branchResult.branchName || !input.branchResult.baseCommit;
  if (
    workerUsesPiHarness &&
    effectiveWorkerPermissionProfile === "trusted-code" &&
    bindingUnavailable &&
    canDowngradeTrustedPiWorkerToReadOnly(input)
  ) {
    return {
      ok: true,
      effectiveWorkerPermissionProfile: "read-only",
    };
  }

  const assessment = assessPiHarnessWorktreeBindingRequest(input);
  if (!assessment.ok) return assessment;
  if (!assessment.needsBinding) {
    return {
      ok: true,
      effectiveWorkerPermissionProfile: assessment.effectiveWorkerPermissionProfile,
    };
  }

  if (input.checkoutGateRefusalReason) {
    return {
      ok: false,
      reason:
        "pi-harness worker requires a verified managed task-branch checkout before model spending: " +
        input.checkoutGateRefusalReason,
      effectiveWorkerPermissionProfile: assessment.effectiveWorkerPermissionProfile,
    };
  }
  if (input.checkoutGateDegraded) {
    return {
      ok: false,
      reason:
        "pi-harness worker requires a verified managed task-branch checkout before model spending; " +
        "the dispatcher only has degraded read-only checkout state",
      effectiveWorkerPermissionProfile: assessment.effectiveWorkerPermissionProfile,
    };
  }

  const binding = await buildManagedTaskWorktreeBinding(
    input.workingDir,
    input.reposRoot,
    input.branchResult.branchName!,
    input.branchResult.baseCommit!,
  );
  if (!binding.ok) {
    return {
      ok: false,
      reason: binding.reason,
      effectiveWorkerPermissionProfile: assessment.effectiveWorkerPermissionProfile,
    };
  }
  return {
    ok: true,
    effectiveWorkerPermissionProfile: assessment.effectiveWorkerPermissionProfile,
    binding: binding.binding,
  };
}
