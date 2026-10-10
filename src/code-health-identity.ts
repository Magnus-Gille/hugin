import { createHash, randomUUID } from "node:crypto";
import type { TaskType } from "./broker/task-type-metadata.js";
import type { CodeHealthEnvelope } from "./task-result-schema.js";

export const CODE_HEALTH_ATTEMPT_PREFIX = "code-health-attempt:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const PILOT_REPOSITORIES = Object.freeze({
  sagascript: Object.freeze({ owner: "Magnus-Gille", name: "sagascript" }),
  "gille-inference": Object.freeze({ owner: "Magnus-Gille", name: "gille-inference" }),
});

export type CodeHealthRepo = (typeof PILOT_REPOSITORIES)[keyof typeof PILOT_REPOSITORIES];
export interface CodeHealthIdentityBinding {
  taskId: string;
  taskNamespace: string;
  attemptId: string;
  repo: CodeHealthRepo;
}
export type CodeHealthExecutionFact =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "not_started_refused";

export function classifyCodeHealthContext(context: string | undefined): CodeHealthRepo | null {
  if (!context || !context.startsWith("repo:")) return null;
  const slug = context.slice("repo:".length);
  if (!Object.hasOwn(PILOT_REPOSITORIES, slug)) return null;
  return PILOT_REPOSITORIES[slug as keyof typeof PILOT_REPOSITORIES];
}

export function isCodeHealthEligible(input: {
  enabled: boolean;
  context: string | undefined;
  capabilities: readonly string[] | undefined;
}): boolean {
  return input.enabled
    && classifyCodeHealthContext(input.context) !== null
    && input.capabilities?.includes("code") === true;
}

export function createCodeHealthAttemptId(): string {
  return randomUUID();
}

export function stripCodeHealthAttemptTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => !tag.startsWith(CODE_HEALTH_ATTEMPT_PREFIX));
}

export function attachCodeHealthAttemptTag(tags: readonly string[], attemptId: string): string[] {
  if (!UUID_PATTERN.test(attemptId)) throw new Error("code-health attempt id must be a UUID");
  return [...stripCodeHealthAttemptTags(tags), `${CODE_HEALTH_ATTEMPT_PREFIX}${attemptId}`];
}

export function buildCodeHealthClaimTags(input: {
  tags: readonly string[];
  enabled: boolean;
  context: string | undefined;
  capabilities: readonly string[] | undefined;
  createAttemptId?: () => string;
}): { tags: string[]; attemptId: string | null } {
  const cleanTags = stripCodeHealthAttemptTags(input.tags);
  if (!isCodeHealthEligible(input)) return { tags: cleanTags, attemptId: null };
  const attemptId = (input.createAttemptId ?? createCodeHealthAttemptId)();
  return { tags: attachCodeHealthAttemptTag(cleanTags, attemptId), attemptId };
}

export function getCodeHealthAttemptId(tags: readonly string[]): string | null {
  const values = tags
    .filter((tag) => tag.startsWith(CODE_HEALTH_ATTEMPT_PREFIX))
    .map((tag) => tag.slice(CODE_HEALTH_ATTEMPT_PREFIX.length));
  return values.length === 1 && UUID_PATTERN.test(values[0]) ? values[0] : null;
}

export function buildCodeHealthIdentityBinding(input: {
  taskNamespace: string;
  taskId: string;
  context: string | undefined;
  capabilities: readonly string[] | undefined;
  enabled: boolean;
  tags: readonly string[];
}): CodeHealthIdentityBinding | null {
  if (!isCodeHealthEligible(input)) return null;
  const attemptId = getCodeHealthAttemptId(input.tags);
  const repo = classifyCodeHealthContext(input.context);
  return attemptId && repo
    ? { taskId: input.taskId, taskNamespace: input.taskNamespace, attemptId, repo }
    : null;
}

export function createNotStartedRefusalIdentity(taskNamespace: string, rejectedStatusRevision: string): {
  kind: "not-started-refused";
  notStartedId: string;
  rejectedStatusRevisionSha256: string;
} {
  const rejectedStatusRevisionSha256 = createHash("sha256")
    .update(rejectedStatusRevision, "utf8")
    .digest("hex");
  const notStartedId = createHash("sha256")
    .update(`hugin-code-health-not-started-v1\0${taskNamespace}\0${rejectedStatusRevision}`, "utf8")
    .digest("hex");
  return { kind: "not-started-refused", notStartedId, rejectedStatusRevisionSha256 };
}

export interface CodeHealthPlannedChildInput {
  plannerId: string;
  taskType: TaskType;
  outcome?: "planned" | "completed" | "failed" | "cancelled" | "timed_out";
}

export function buildCodeHealthEnvelope(input: {
  taskNamespace: string;
  taskId: string;
  attemptId?: string;
  notStartedIdentity?: ReturnType<typeof createNotStartedRefusalIdentity>;
  repo: CodeHealthRepo;
  beforeSha?: string | null;
  afterSha?: string | null;
  executionFact: CodeHealthExecutionFact;
  assessmentState?: "missing" | "partial" | "complete";
  observationRefs?: string[];
  assessmentRefs?: string[];
  requestedModel?: string | null;
  /** A typed executor response can populate this in a later integration. */
  observedModel?: string | null;
  plannedChildren?: readonly CodeHealthPlannedChildInput[];
}): CodeHealthEnvelope {
  const identity = input.executionFact === "not_started_refused"
    ? input.notStartedIdentity
    : input.attemptId && UUID_PATTERN.test(input.attemptId)
      ? { kind: "attempt" as const, attemptId: input.attemptId }
      : undefined;
  if (!identity) throw new Error("code-health envelope requires the lifecycle-appropriate Hugin identity");
  if (input.executionFact === "not_started_refused" && identity.kind !== "not-started-refused") {
    throw new Error("not-started refusal requires a rejected-revision identity");
  }
  if (input.executionFact !== "not_started_refused" && identity.kind !== "attempt") {
    throw new Error("executed lifecycle requires the accepted attempt identity");
  }
  const safeModel = (value: string | null | undefined): string | null => (
    value && value.length <= 128 && /^[A-Za-z0-9._:/-]+$/.test(value) ? value : null
  );
  const safeSha = (value: string | null | undefined): string | null => (
    value && SHA_PATTERN.test(value) ? value.toLowerCase() : null
  );
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    taskNamespace: input.taskNamespace,
    identity,
    repo: input.repo,
    beforeSha: safeSha(input.beforeSha),
    afterSha: safeSha(input.afterSha),
    executionFact: input.executionFact,
    assessmentState: input.assessmentState ?? "missing",
    observationRefs: input.observationRefs ?? [],
    assessmentRefs: input.assessmentRefs ?? [],
    taskClass: null,
    requestedModel: safeModel(input.requestedModel),
    // Generic Hugin executor metadata may only echo the request; never treat it as observed.
    observedModel: safeModel(input.observedModel),
    plannedChildren: (input.plannedChildren ?? []).slice(0, 32).map((child) => ({
      identitySha256: createHash("sha256")
        .update(`hugin-code-health-child-v1\0${input.attemptId ?? input.notStartedIdentity?.notStartedId}\0${child.plannerId}`, "utf8")
        .digest("hex"),
      taskType: child.taskType,
      outcome: child.outcome ?? "planned",
    })),
    plannedChildrenOmitted: Math.max(0, (input.plannedChildren?.length ?? 0) - 32),
  };
}

export function buildCodeHealthLifecycleEnvelope(input: {
  enabled: boolean;
  taskNamespace: string;
  taskId: string;
  context: string | undefined;
  capabilities: readonly string[] | undefined;
  tags: readonly string[];
  statusRevision: string;
  executionFact: CodeHealthExecutionFact;
  requestedModel?: string | null;
  beforeSha?: string | null;
  afterSha?: string | null;
  plannedChildren?: readonly CodeHealthPlannedChildInput[];
}): CodeHealthEnvelope | undefined {
  if (!isCodeHealthEligible(input)) return undefined;
  const repo = classifyCodeHealthContext(input.context);
  if (!repo) return undefined;
  if (input.executionFact === "not_started_refused") {
    return buildCodeHealthEnvelope({
      taskNamespace: input.taskNamespace,
      taskId: input.taskId,
      notStartedIdentity: createNotStartedRefusalIdentity(input.taskNamespace, input.statusRevision),
      repo,
      executionFact: input.executionFact,
      requestedModel: input.requestedModel,
    });
  }
  const binding = buildCodeHealthIdentityBinding({
    taskNamespace: input.taskNamespace,
    taskId: input.taskId,
    context: input.context,
    capabilities: input.capabilities,
    tags: input.tags,
    enabled: input.enabled,
  });
  if (!binding) return undefined;
  return buildCodeHealthEnvelope({
    ...binding,
    executionFact: input.executionFact,
    requestedModel: input.requestedModel,
    beforeSha: input.beforeSha,
    afterSha: input.afterSha,
    plannedChildren: input.plannedChildren,
  });
}
