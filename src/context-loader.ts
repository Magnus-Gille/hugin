/**
 * Context reference resolver for task context injection.
 *
 * Fetches Munin entries listed in a task's Context-refs field, concatenates
 * them, and truncates to budget. Surfaces per-ref classification metadata
 * and computes maxSensitivity across resolved refs for upstream policy
 * enforcement (e.g., runtime sensitivity checks).
 */

import type { MuninClient } from "./munin-client.js";
import {
  maxSensitivity,
  muninClassificationToSensitivity,
  namespaceFallbackSensitivity,
  type Sensitivity,
} from "./sensitivity.js";

const DEFAULT_BUDGET_CHARS = 8_000;

export interface ContextResolution {
  /** Concatenated context string to inject into prompt */
  content: string;
  /** Refs that were requested */
  refsRequested: string[];
  /** Refs that returned content */
  refsResolved: string[];
  /** Refs that were absent in Munin */
  refsMissing: string[];
  /** Total characters before truncation */
  totalChars: number;
  /** Whether truncation was applied */
  truncated: boolean;
  /** Maximum sensitivity across resolved refs */
  maxSensitivity?: Sensitivity;
  /** Per-ref metadata */
  refs: Array<{
    ref: string;
    namespace: string;
    key: string;
    classification?: string;
    sensitivity: Sensitivity;
  }>;
}

/**
 * Parse a Context-refs string into [namespace, key] tuples.
 *
 * Format: "ns1/key1, ns2/key2" — the last path segment is the key,
 * everything before it is the namespace.
 */
function parseRef(ref: string): { namespace: string; key: string } | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;

  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) return null; // Need at least "ns/key"

  return {
    namespace: trimmed.slice(0, lastSlash),
    key: trimmed.slice(lastSlash + 1),
  };
}

/**
 * Resolve context references from Munin and concatenate into a single string.
 */
export async function resolveContextRefs(
  refList: string[],
  budget: number | undefined,
  munin: MuninClient,
): Promise<ContextResolution> {
  const maxChars = budget ?? DEFAULT_BUDGET_CHARS;
  const refsRequested = refList.map((r) => r.trim()).filter(Boolean);
  const refsResolved: string[] = [];
  const refsMissing: string[] = [];
  const sections: string[] = [];
  const resolvedRefs: ContextResolution["refs"] = [];
  let maxSens: Sensitivity | undefined;

  for (const refStr of refsRequested) {
    const parsed = parseRef(refStr);
    if (!parsed) {
      console.warn(`Invalid context ref syntax: "${refStr}" (expected namespace/key)`);
      refsMissing.push(refStr);
      continue;
    }

    try {
      const entry = await munin.read(parsed.namespace, parsed.key);
      if (entry) {
        const sensitivity =
          muninClassificationToSensitivity(entry.classification) ||
          namespaceFallbackSensitivity(parsed.namespace);
        refsResolved.push(refStr);
        sections.push(`### ${refStr}\n${entry.content}`);
        resolvedRefs.push({
          ref: refStr,
          namespace: parsed.namespace,
          key: parsed.key,
          classification: entry.classification,
          sensitivity,
        });
        maxSens = maxSensitivity(maxSens, sensitivity);
      } else {
        refsMissing.push(refStr);
        console.warn(`Context ref not found in Munin: ${refStr}`);
      }
    } catch (err) {
      refsMissing.push(refStr);
      console.warn(`Error reading context ref ${refStr}:`, err);
    }
  }

  const joined = sections.join("\n\n---\n\n");
  const totalChars = joined.length;
  const truncated = totalChars > maxChars;
  const content = truncated ? joined.slice(0, maxChars) + "\n\n[...truncated]" : joined;

  return {
    content,
    refsRequested,
    refsResolved,
    refsMissing,
    totalChars,
    truncated,
    maxSensitivity: maxSens,
    refs: resolvedRefs,
  };
}
