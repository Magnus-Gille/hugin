import type { MuninEntry, MuninReadResult } from "./munin-client.js";

export function getFoundBatchEntry(
  entry: MuninReadResult | undefined
): (MuninEntry & { found: true }) | null {
  return entry && entry.found ? entry : null;
}

export function extractTaskId(namespace: string): string {
  return namespace.replace(/^tasks\//, "");
}
