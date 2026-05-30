/**
 * Eligibility helpers for autonomous dependency-bump tasks (#26).
 *
 * Pure functions — no I/O, no side effects.
 * The driver script (scripts/submit-dep-bumps.sh) re-implements these in
 * Python 3 for inline bash use; this module provides the same logic in
 * TypeScript for unit testing and future programmatic callers.
 */

/**
 * A Munin memory_query JSON-RPC response shape (minimal — only what we need).
 */
interface MuninQueryRpcResponse {
  result?: {
    content?: Array<{ text?: string }>;
  };
}

/**
 * A Munin memory_read JSON-RPC response shape (minimal).
 */
interface MuninReadRpcResponse {
  result?: {
    content?: Array<{ text?: string }>;
  };
}

/**
 * Extract repo names from a Munin memory_query response for namespace
 * "security/repos".  Returns each unique repo slug found in namespaces
 * matching `security/repos/<repo>`, sorted ascending.
 */
export function parseReposFromQueryResponse(raw: unknown): string[] {
  const resp = raw as MuninQueryRpcResponse;
  const text = resp?.result?.content?.[0]?.text ?? "{}";
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const entries = (data.results as Array<Record<string, unknown>>) ?? [];
  const repos = new Set<string>();
  for (const entry of entries) {
    const ns = entry.namespace;
    if (typeof ns === "string") {
      const m = ns.match(/^security\/repos\/([^/]+)$/);
      if (m) repos.add(m[1]);
    }
  }
  return [...repos].sort();
}

/**
 * Extract the fixable vulnerability count from a Munin memory_read response
 * for a `security/repos/<repo>/audit` entry.
 *
 * The security scanner writes audit results in one of two formats:
 *   - JSON with a top-level `"fixable": N` field (preferred)
 *   - Plain text with pattern `fixable: N`
 *
 * Returns 0 if the entry is not found, not parseable, or reports no fixable issues.
 */
export function parseFixableCount(raw: unknown): number {
  const resp = raw as MuninReadRpcResponse;
  const text = resp?.result?.content?.[0]?.text ?? "{}";
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return 0;
  }
  if (!data.found) return 0;
  const content = typeof data.content === "string" ? data.content : "";

  // Try JSON field `"fixable": N` in the content string
  const jsonMatch = content.match(/"fixable":\s*(\d+)/);
  if (jsonMatch) return parseInt(jsonMatch[1], 10);

  // Try plain text `fixable: N` or `fixable N`
  const textMatch = content.match(/\bfixable[:\s]+(\d+)/i);
  if (textMatch) return parseInt(textMatch[1], 10);

  return 0;
}

/**
 * Given a Munin query response and a map of repo→fixable counts,
 * return the list of repos that are eligible for a dep-bump task.
 *
 * Eligibility: fixable count > 0.
 */
export function filterEligibleRepos(
  repos: string[],
  fixableCounts: Map<string, number>,
): string[] {
  return repos.filter((r) => (fixableCounts.get(r) ?? 0) > 0);
}
