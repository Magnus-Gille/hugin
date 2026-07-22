import { ON_DEP_FAILURE_PREFIX } from "./task-graph.js";

const RUNTIME_PREFIX = "runtime:";
const TYPE_PREFIX = "type:";
const AUTHORITY_PREFIX = "authority:";
const SENSITIVITY_PREFIX = "sensitivity:";
const ROUTING_PREFIX = "routing:";
// Durable MCP Broker identity/query tags must survive claim, renewal and the
// terminal flip. hugin_await/list/rate use them to keep the canonical task
// visible and principal-scoped after execution.
const BROKER_PREFIX = "broker:";
const ALIAS_PREFIX = "alias:";
const TASK_TYPE_PREFIX = "task-type:";
const TASK_TAXONOMY_PREFIX = "task-taxonomy:";
const RUNTIME_ROW_PREFIX = "runtime-row:";
const IDEMPOTENCY_PREFIX = "idempotency:";
// Runtime-owned artefact delivery (issue #68). `delivery:*` must survive lease
// renewal AND the terminal status flip: the nonterminal `delivery:pending`
// checkpoint and the terminal `delivery:verified`/`delivery:failed` markers are
// the source of truth for downstream consumers and for startup reconciliation.
const DELIVERY_PREFIX = "delivery:";
// Durable managed-repository publication recovery (issue #225). `publication:*`
// marks a completed task whose repository publication (push/PR) failed after
// the paid model work finished. It must survive the terminal status flip so
// operators can discover it, and it must survive the later recovery rewrite
// (`publication:failed` -> `publication:recovered`/`publication:abandoned`)
// so `buildTerminalStatusTags` does not silently drop it mid-transition.
const PUBLICATION_PREFIX = "publication:";
// Durable post-terminal learning capture. `pending` survives restart until
// the authoritative M5 ledger join and all idempotent registry writes finish.
const LEARNING_REGISTRY_PREFIX = "learning-registry:";
// Dispatcher-owned content-blind scheduler decision pointers. These bind the
// winning claim to create-only prediction/outcome evidence and therefore must
// survive every lifecycle rewrite until recovery can finish.
export const SCHEDULER_DECISION_PREFIX = "scheduler-decision:";
export const SCHEDULER_PREDICTION_DIGEST_PREFIX = "scheduler-prediction-sha256:";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface SchedulerDecisionPointer {
  decisionId: string;
  predictionDigest: string;
}

export function stripSchedulerDecisionPointers(tags: string[]): string[] {
  return tags.filter(
    (tag) => !tag.startsWith(SCHEDULER_DECISION_PREFIX)
      && !tag.startsWith(SCHEDULER_PREDICTION_DIGEST_PREFIX),
  );
}

/** Replace mutable pointer tags with the exact pair retained after a claim CAS. */
export function mergeClaimedSchedulerPointer(
  targetTags: string[],
  claimedSnapshotTags: string[],
): string[] {
  const claimedPointerTags = getClaimedPersistentStatusTags(claimedSnapshotTags)
    .filter((tag) => tag.startsWith(SCHEDULER_DECISION_PREFIX)
      || tag.startsWith(SCHEDULER_PREDICTION_DIGEST_PREFIX));
  return dedupeTags([
    ...stripSchedulerDecisionPointers(targetTags),
    ...claimedPointerTags,
  ]);
}

/** Running cancellation belongs to an active owner or claimed-task recovery. */
export function shouldDeferCancellationToClaimOwner(tags: string[]): boolean {
  return tags.includes("running");
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const tag of tags) {
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    deduped.push(tag);
  }

  return deduped;
}

function getRuntimeTag(tags: string[], runtimeFallback?: string): string | undefined {
  return tags.find((tag) => tag.startsWith(RUNTIME_PREFIX)) || runtimeFallback;
}

function collectPersistentStatusTags(
  tags: string[],
  runtimeFallback?: string,
  preserveClaimedSchedulerPointer = false,
): string[] {
  const runtimeTag = getRuntimeTag(tags, runtimeFallback);
  const typeTags = tags.filter((tag) => tag.startsWith(TYPE_PREFIX));
  const policyTags = tags.filter((tag) => tag.startsWith(ON_DEP_FAILURE_PREFIX));
  const authorityTags = tags.filter((tag) => tag.startsWith(AUTHORITY_PREFIX));
  const sensitivityTags = tags.filter((tag) => tag.startsWith(SENSITIVITY_PREFIX));
  const routingTags = tags.filter((tag) => tag.startsWith(ROUTING_PREFIX));
  const deliveryTags = tags.filter((tag) => tag.startsWith(DELIVERY_PREFIX));
  const publicationTags = tags.filter((tag) => tag.startsWith(PUBLICATION_PREFIX));
  const learningRegistryTags = tags.filter((tag) => tag.startsWith(LEARNING_REGISTRY_PREFIX));
  const brokerTags = tags.filter((tag) => tag.startsWith(BROKER_PREFIX));
  const aliasTags = tags.filter((tag) => tag.startsWith(ALIAS_PREFIX));
  const taskTypeTags = tags.filter((tag) => tag.startsWith(TASK_TYPE_PREFIX));
  const taskTaxonomyTags = tags.filter((tag) => tag.startsWith(TASK_TAXONOMY_PREFIX));
  const runtimeRowTags = tags.filter((tag) => tag.startsWith(RUNTIME_ROW_PREFIX));
  const idempotencyTags = tags.filter((tag) => tag.startsWith(IDEMPOTENCY_PREFIX));
  const rawSchedulerDecisionTags = tags.filter((tag) => tag.startsWith(SCHEDULER_DECISION_PREFIX));
  const rawSchedulerPredictionTags = tags.filter((tag) => tag.startsWith(SCHEDULER_PREDICTION_DIGEST_PREFIX));
  const schedulerDecisionTags = rawSchedulerDecisionTags.filter((tag) => {
    const value = tag.slice(SCHEDULER_DECISION_PREFIX.length);
    return UUID_PATTERN.test(value);
  });
  const schedulerPredictionTags = rawSchedulerPredictionTags.filter((tag) => {
    const value = tag.slice(SCHEDULER_PREDICTION_DIGEST_PREFIX.length);
    return SHA256_PATTERN.test(value);
  });
  const schedulerPointerTags = preserveClaimedSchedulerPointer
    && rawSchedulerDecisionTags.length === 1
    && rawSchedulerPredictionTags.length === 1
    && schedulerDecisionTags.length === 1
    && schedulerPredictionTags.length === 1
    ? [...schedulerDecisionTags, ...schedulerPredictionTags]
    : [];

  return dedupeTags([
    ...(runtimeTag ? [runtimeTag] : []),
    ...typeTags,
    ...policyTags,
    ...authorityTags,
    ...sensitivityTags,
    ...routingTags,
    ...deliveryTags,
    ...publicationTags,
    ...learningRegistryTags,
    ...brokerTags,
    ...aliasTags,
    ...taskTypeTags,
    ...taskTaxonomyTags,
    ...runtimeRowTags,
    ...idempotencyTags,
    ...schedulerPointerTags,
  ]);
}

/** Persistent metadata safe for pre-claim and generic lifecycle rewrites. */
export function getPersistentStatusTags(
  tags: string[],
  runtimeFallback?: string,
): string[] {
  return collectPersistentStatusTags(tags, runtimeFallback, false);
}

/** Persistent metadata from a status known to follow a successful claim CAS. */
export function getClaimedPersistentStatusTags(
  tags: string[],
  runtimeFallback?: string,
): string[] {
  return collectPersistentStatusTags(tags, runtimeFallback, true);
}

/**
 * Strip any caller-supplied scheduler pointers and attach exactly one
 * dispatcher-owned identity/digest pair before the claim CAS.
 */
export function attachSchedulerDecisionPointer(
  tags: string[],
  pointer: SchedulerDecisionPointer,
): string[] {
  if (!UUID_PATTERN.test(pointer.decisionId)) {
    throw new Error("scheduler decision id must be a UUID");
  }
  if (!SHA256_PATTERN.test(pointer.predictionDigest)) {
    throw new Error("scheduler prediction digest must be lowercase SHA-256");
  }
  const sanitized = stripSchedulerDecisionPointers(tags);
  return dedupeTags([
    ...sanitized,
    `${SCHEDULER_DECISION_PREFIX}${pointer.decisionId}`,
    `${SCHEDULER_PREDICTION_DIGEST_PREFIX}${pointer.predictionDigest}`,
  ]);
}

/** Build one running/reclaimed lease tag set from authoritative base tags. */
export function buildLeasedStatusTags(
  baseTags: string[],
  lifecycle: string,
  claimedBy: string,
  leaseExpires: string,
  preserveClaimedSchedulerPointer = false,
): string[] {
  return [
    lifecycle,
    ...(preserveClaimedSchedulerPointer
      ? getClaimedPersistentStatusTags(baseTags)
      : getPersistentStatusTags(baseTags)),
    `claimed_by:${claimedBy}`,
    `lease_expires:${leaseExpires}`,
  ];
}

export function buildTerminalStatusTags(
  status: "completed" | "failed" | "cancelled",
  tags: string[],
  runtimeFallback?: string
): string[] {
  return [status, ...getPersistentStatusTags(tags, runtimeFallback)];
}

export function buildClaimedTerminalStatusTags(
  status: "completed" | "failed" | "cancelled",
  tags: string[],
  runtimeFallback?: string,
): string[] {
  return [status, ...getClaimedPersistentStatusTags(tags, runtimeFallback)];
}

export function buildAwaitingApprovalTags(
  tags: string[],
  runtimeFallback?: string
): string[] {
  return ["awaiting-approval", ...getPersistentStatusTags(tags, runtimeFallback)];
}

export function buildPipelineParentSuccessTags(
  tags: string[],
  preserveClaimedSchedulerPointer = false,
): string[] {
  const terminalTags = preserveClaimedSchedulerPointer
    ? buildClaimedTerminalStatusTags("completed", tags, "runtime:pipeline")
    : buildTerminalStatusTags("completed", tags, "runtime:pipeline");
  return dedupeTags([...terminalTags, "type:pipeline"]);
}

export function buildPipelineParentCancelledTags(
  tags: string[],
  preserveClaimedSchedulerPointer = false,
): string[] {
  const terminalTags = preserveClaimedSchedulerPointer
    ? buildClaimedTerminalStatusTags("cancelled", tags, "runtime:pipeline")
    : buildTerminalStatusTags("cancelled", tags, "runtime:pipeline");
  return dedupeTags([...terminalTags, "type:pipeline"]);
}
