import { ON_DEP_FAILURE_PREFIX } from "./task-graph.js";

const RUNTIME_PREFIX = "runtime:";
const TYPE_PREFIX = "type:";

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

export function buildTerminalStatusTags(
  status: "completed" | "failed",
  tags: string[],
  runtimeFallback?: string
): string[] {
  const runtimeTag = getRuntimeTag(tags, runtimeFallback);
  const typeTags = tags.filter((tag) => tag.startsWith(TYPE_PREFIX));
  const policyTags = tags.filter((tag) => tag.startsWith(ON_DEP_FAILURE_PREFIX));

  return [
    status,
    ...dedupeTags([
      ...(runtimeTag ? [runtimeTag] : []),
      ...typeTags,
      ...policyTags,
    ]),
  ];
}

export function buildPipelineParentSuccessTags(tags: string[]): string[] {
  const terminalTags = buildTerminalStatusTags("completed", tags, "runtime:pipeline");
  return dedupeTags([...terminalTags, "type:pipeline"]);
}
