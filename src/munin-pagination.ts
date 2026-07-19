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
   * True whenever the walk cannot prove the returned result set is complete,
   * including exact-timestamp ambiguity, caller budget exhaustion, or a
   * malformed page cursor. Use `budgetExhausted` for the caller-limit case.
   */
  truncated: boolean;
  /** True when caller limits, rather than the corpus end, stopped the walk. */
  budgetExhausted: boolean;
  /** Cursor immediately before the oldest returned row, for a later sweep. */
  continuationUntil?: string;
}

export interface MuninPaginationBudget {
  /** Maximum ordinary pages to request. Exact-boundary probes are additional. */
  maxPages?: number;
  /** Maximum unique rows returned to the caller. */
  maxResults?: number;
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
  budget: MuninPaginationBudget = {},
): Promise<MuninPaginatedQueryResult> {
  const since = normalizeIsoTimestamp(options.since);
  let until = normalizeIsoTimestamp(options.until);
  const unique = new Map<string, MuninQueryResult>();
  let truncated = false;
  let budgetExhausted = false;
  let pages = 0;

  while (true) {
    pages += 1;
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

    if (
      (budget.maxPages !== undefined && pages >= budget.maxPages) ||
      (budget.maxResults !== undefined && unique.size >= budget.maxResults)
    ) {
      // A full page means another older page may exist. Stop honestly at the
      // caller's work budget instead of allowing history/recovery surfaces to
      // grow without bound.
      truncated = true;
      budgetExhausted = true;
      break;
    }

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

  const results = [...unique.values()].sort((a, b) => {
    const byTime = (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
    return byTime || resultIdentity(a).localeCompare(resultIdentity(b));
  });
  if (budget.maxResults !== undefined && results.length > budget.maxResults) {
    results.length = budget.maxResults;
    truncated = true;
    budgetExhausted = true;
  }
  let continuationUntil: string | undefined;
  if (budgetExhausted) {
    const oldestTimestamp = results
      .map((entry) => Date.parse(entry.updated_at))
      .filter(Number.isFinite)
      .reduce<number | null>(
        (oldest, value) => oldest === null || value < oldest ? value : oldest,
        null,
      );
    if (oldestTimestamp !== null) {
      continuationUntil = new Date(oldestTimestamp - 1).toISOString();
    }
  }
  return {
    results,
    truncated,
    budgetExhausted,
    ...(continuationUntil ? { continuationUntil } : {}),
  };
}
