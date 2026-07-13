import type { MuninClient, MuninQueryResult } from "./munin-client.js";

/** Munin's documented hard cap for one memory_query response. */
export const MUNIN_QUERY_MAX = 50;

export interface MuninFilterQueryOptions {
  tags?: string[];
  namespace?: string;
  entry_type?: string;
  since?: string;
  until?: string;
}

export interface MuninPaginatedQueryResult {
  results: MuninQueryResult[];
  /**
   * True only when an exact updated_at bucket itself reaches Munin's cap.
   * Without a composite cursor, that bucket cannot be proven complete.
   */
  truncated: boolean;
}

function normalizeIsoTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const epochMs = Date.parse(value);
  return Number.isNaN(epochMs) ? value : new Date(epochMs).toISOString();
}

function resultIdentity(result: MuninQueryResult): string {
  if (typeof result.id === "string" && result.id.length > 0) return result.id;
  return [result.namespace, result.key ?? "", result.updated_at ?? ""].join("\0");
}

function addResults(
  destination: Map<string, MuninQueryResult>,
  results: MuninQueryResult[],
): void {
  for (const result of results) destination.set(resultIdentity(result), result);
}

/**
 * Enumerate a tag/filter-scoped Munin corpus despite memory_query's 50-row cap.
 *
 * This deliberately omits `query`, selecting Munin's filter-only mode. That
 * mode is ordered by `updated_at DESC`; query-based search is relevance-ranked
 * and therefore cannot be paged safely with a timestamp cursor (#183).
 *
 * Each full page gets a second, exact-timestamp boundary probe. That probe
 * recovers rows hidden behind the page boundary when several entries share the
 * same millisecond. If the exact bucket itself reaches 50 rows, the API has no
 * composite `(updated_at, id)` cursor with which to prove completeness, so the
 * result stays useful but honestly reports `truncated: true`.
 */
export async function queryAllMuninEntries(
  munin: Pick<MuninClient, "query">,
  options: MuninFilterQueryOptions,
): Promise<MuninPaginatedQueryResult> {
  const since = normalizeIsoTimestamp(options.since);
  let until = normalizeIsoTimestamp(options.until);
  const unique = new Map<string, MuninQueryResult>();
  let truncated = false;

  while (true) {
    const page = await munin.query({
      tags: options.tags,
      namespace: options.namespace,
      entry_type: options.entry_type,
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      limit: MUNIN_QUERY_MAX,
    });
    addResults(unique, page.results);

    if (page.results.length < MUNIN_QUERY_MAX) break;

    const timestamps = page.results
      .map((result) => normalizeIsoTimestamp(result.updated_at))
      .filter((value): value is string => value !== undefined && !Number.isNaN(Date.parse(value)));
    if (timestamps.length !== page.results.length) {
      truncated = true;
      break;
    }

    const boundary = timestamps.reduce((oldest, value) => value < oldest ? value : oldest);
    const boundaryPage = await munin.query({
      tags: options.tags,
      namespace: options.namespace,
      entry_type: options.entry_type,
      since: boundary,
      until: boundary,
      limit: MUNIN_QUERY_MAX,
    });
    addResults(unique, boundaryPage.results);
    if (boundaryPage.results.length >= MUNIN_QUERY_MAX) truncated = true;

    const previousMillisecond = Date.parse(boundary) - 1;
    if (!Number.isFinite(previousMillisecond)) {
      truncated = true;
      break;
    }
    if (since && previousMillisecond < Date.parse(since)) break;

    const nextUntil = new Date(previousMillisecond).toISOString();
    if (until && nextUntil >= until) {
      truncated = true;
      break;
    }
    until = nextUntil;
  }

  return { results: [...unique.values()], truncated };
}
