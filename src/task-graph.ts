export const DEPENDS_ON_PREFIX = "depends-on:";
export const ON_DEP_FAILURE_PREFIX = "on-dep-failure:";
export const MAX_DEPENDENCIES = 10;

export type DependencyFailurePolicy = "fail" | "continue";
export type DependencyState = "completed" | "failed" | "pending" | "missing";

export interface BlockedTaskEvaluation {
  dependencyIds: string[];
  policy: DependencyFailurePolicy;
  completedIds: string[];
  failedIds: string[];
  waitingIds: string[];
  missingIds: string[];
  allCompleted: boolean;
  allTerminal: boolean;
  shouldPromote: boolean;
  shouldFail: boolean;
  failureReason?: string;
}

export function getDependencyIds(tags: string[]): string[] {
  return tags
    .filter((tag) => tag.startsWith(DEPENDS_ON_PREFIX))
    .map((tag) => tag.slice(DEPENDS_ON_PREFIX.length))
    .filter(Boolean);
}

export function getDependencyFailurePolicy(tags: string[]): DependencyFailurePolicy {
  const tag = tags.find((candidate) => candidate.startsWith(ON_DEP_FAILURE_PREFIX));
  const value = tag?.slice(ON_DEP_FAILURE_PREFIX.length).trim().toLowerCase();
  return value === "continue" ? "continue" : "fail";
}

export function buildPromotedTags(tags: string[]): string[] {
  return [
    ...tags.filter(
      (tag) => tag !== "blocked" && tag !== "pending" && !tag.startsWith(DEPENDS_ON_PREFIX)
    ),
    "pending",
  ];
}

export function evaluateBlockedTask(
  tags: string[],
  dependencyStates: Record<string, DependencyState>
): BlockedTaskEvaluation {
  const dependencyIds = getDependencyIds(tags);
  const policy = getDependencyFailurePolicy(tags);

  if (dependencyIds.length > MAX_DEPENDENCIES) {
    return {
      dependencyIds,
      policy,
      completedIds: [],
      failedIds: [],
      waitingIds: [],
      missingIds: [],
      allCompleted: false,
      allTerminal: false,
      shouldPromote: false,
      shouldFail: true,
      failureReason: `Task has ${dependencyIds.length} dependencies; max is ${MAX_DEPENDENCIES}`,
    };
  }

  const completedIds: string[] = [];
  const failedIds: string[] = [];
  const waitingIds: string[] = [];
  const missingIds: string[] = [];

  for (const dependencyId of dependencyIds) {
    const state = dependencyStates[dependencyId] || "missing";
    if (state === "completed") {
      completedIds.push(dependencyId);
    } else if (state === "failed") {
      failedIds.push(dependencyId);
    } else if (state === "missing") {
      missingIds.push(dependencyId);
    } else {
      waitingIds.push(dependencyId);
    }
  }

  const allCompleted = failedIds.length === 0 && waitingIds.length === 0 && missingIds.length === 0;
  // missing deps are terminal (they will never resolve), so don't count them as waiting
  const allTerminal = waitingIds.length === 0;
  const shouldFail = (failedIds.length > 0 || missingIds.length > 0) && policy === "fail";
  const shouldPromote = allCompleted || (policy === "continue" && allTerminal);

  let failureReason: string | undefined;
  if (shouldFail) {
    if (failedIds.length > 0) {
      failureReason = `Dependency ${failedIds[0]} failed`;
    } else {
      failureReason = `Dependency ${missingIds[0]} not found`;
    }
  }

  return {
    dependencyIds,
    policy,
    completedIds,
    failedIds,
    waitingIds,
    missingIds,
    allCompleted,
    allTerminal,
    shouldPromote,
    shouldFail,
    failureReason,
  };
}
