import { ON_DEP_FAILURE_PREFIX } from "./task-graph.js";

const RUNTIME_PREFIX = "runtime:";
const TYPE_PREFIX = "type:";
const AUTHORITY_PREFIX = "authority:";
const SENSITIVITY_PREFIX = "sensitivity:";
const ROUTING_PREFIX = "routing:";
// Runtime-owned artefact delivery (issue #68). `delivery:*` must survive lease
// renewal AND the terminal status flip: the nonterminal `delivery:pending`
// checkpoint and the terminal `delivery:verified`/`delivery:failed` markers are
// the source of truth for downstream consumers and for startup reconciliation.
const DELIVERY_PREFIX = "delivery:";

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

function getPersistentTags(tags: string[], runtimeFallback?: string): string[] {
  const runtimeTag = getRuntimeTag(tags, runtimeFallback);
  const typeTags = tags.filter((tag) => tag.startsWith(TYPE_PREFIX));
  const policyTags = tags.filter((tag) => tag.startsWith(ON_DEP_FAILURE_PREFIX));
  const authorityTags = tags.filter((tag) => tag.startsWith(AUTHORITY_PREFIX));
  const sensitivityTags = tags.filter((tag) => tag.startsWith(SENSITIVITY_PREFIX));
  const routingTags = tags.filter((tag) => tag.startsWith(ROUTING_PREFIX));
  const deliveryTags = tags.filter((tag) => tag.startsWith(DELIVERY_PREFIX));

  return dedupeTags([
    ...(runtimeTag ? [runtimeTag] : []),
    ...typeTags,
    ...policyTags,
    ...authorityTags,
    ...sensitivityTags,
    ...routingTags,
    ...deliveryTags,
  ]);
}

export function buildTerminalStatusTags(
  status: "completed" | "failed" | "cancelled",
  tags: string[],
  runtimeFallback?: string
): string[] {
  return [status, ...getPersistentTags(tags, runtimeFallback)];
}

export function buildAwaitingApprovalTags(
  tags: string[],
  runtimeFallback?: string
): string[] {
  return ["awaiting-approval", ...getPersistentTags(tags, runtimeFallback)];
}

export function buildPipelineParentSuccessTags(tags: string[]): string[] {
  const terminalTags = buildTerminalStatusTags("completed", tags, "runtime:pipeline");
  return dedupeTags([...terminalTags, "type:pipeline"]);
}

export function buildPipelineParentCancelledTags(tags: string[]): string[] {
  const terminalTags = buildTerminalStatusTags("cancelled", tags, "runtime:pipeline");
  return dedupeTags([...terminalTags, "type:pipeline"]);
}
