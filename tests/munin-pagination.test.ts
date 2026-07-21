import { describe, expect, it } from "vitest";
import type { MuninClient, MuninQueryResult } from "../src/munin-client.js";
import { queryAllMuninEntries } from "../src/munin-pagination.js";
import { selectNextTask } from "../src/task-helpers.js";

function makeTask(index: number, timestamp: string): MuninQueryResult {
  return {
    id: `entry-${index}`,
    namespace: index === 0 ? "tasks/oldest" : `tasks/new-${index}`,
    key: "status",
    entry_type: "state",
    content_preview: "**Runtime:** claude",
    tags: ["pending"],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

class FilterOnlyMunin {
  calls: Parameters<MuninClient["query"]>[0][] = [];

  constructor(readonly rows: MuninQueryResult[]) {}

  async query(opts: Parameters<MuninClient["query"]>[0]) {
    this.calls.push(opts);
    const results = this.rows
      .filter((row) => (opts.tags ?? []).every((tag) => row.tags.includes(tag)))
      .filter((row) => !opts.since || row.updated_at >= opts.since)
      .filter((row) => !opts.until || row.updated_at <= opts.until)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, opts.limit ?? 10);
    return { results, total: results.length };
  }
}

describe("queryAllMuninEntries", () => {
  it("walks every capped page and recovers a corpus larger than 100 rows", async () => {
    const base = Date.UTC(2026, 6, 12, 12, 0, 0);
    const rows = Array.from({ length: 125 }, (_, index) =>
      makeTask(index, new Date(base + index).toISOString()),
    );
    const munin = new FilterOnlyMunin(rows);

    const result = await queryAllMuninEntries(munin as unknown as MuninClient, {
      tags: ["pending"],
      namespace: "tasks/",
      entry_type: "state",
    });

    expect(result.results).toHaveLength(125);
    expect(result.truncated).toBe(false);
    expect(result.budgetExhausted).toBe(false);
    expect(munin.calls.length).toBeGreaterThan(3);
    expect(munin.calls.every((call) => call.query === undefined)).toBe(true);
  });

  it("recovers every row when a page boundary splits a sub-cap timestamp bucket", async () => {
    const base = Date.UTC(2026, 6, 12, 12, 0, 0);
    const boundary = new Date(base).toISOString();
    const newer = Array.from({ length: 30 }, (_, index) =>
      makeTask(index, new Date(base + index + 1).toISOString()),
    );
    const boundaryRows = Array.from({ length: 30 }, (_, index) =>
      makeTask(30 + index, boundary),
    );
    const older = Array.from({ length: 10 }, (_, index) =>
      makeTask(60 + index, new Date(base - index - 1).toISOString()),
    );
    const munin = new FilterOnlyMunin([...newer, ...boundaryRows, ...older]);

    const result = await queryAllMuninEntries(munin as unknown as MuninClient, {
      tags: ["pending"],
      namespace: "tasks/",
      entry_type: "state",
    });

    expect(result.results).toHaveLength(70);
    expect(result.truncated).toBe(false);
    expect(munin.calls).toContainEqual(expect.objectContaining({
      since: boundary,
      until: boundary,
    }));
  });

  it("keeps the oldest task claimable while newer tasks continuously refill the first page", async () => {
    const base = Date.UTC(2026, 6, 12, 12, 0, 0);
    const rows = Array.from({ length: 75 }, (_, index) =>
      makeTask(index, new Date(base + index).toISOString()),
    );
    const munin = new FilterOnlyMunin(rows);

    // A fresh batch arrives immediately before every poll. With the old
    // relevance-ranked limit:10 query, this can keep the oldest task outside
    // the candidate window forever. The paged filter query claims it in poll 1.
    let claimed: MuninQueryResult | undefined;
    let claimedOnPoll = 0;
    for (let poll = 1; poll <= 3 && !claimed; poll += 1) {
      for (let arrival = 0; arrival < 20; arrival += 1) {
        const index = rows.length;
        rows.push(makeTask(index, new Date(base + index).toISOString()));
      }
      const pending = await queryAllMuninEntries(munin as unknown as MuninClient, {
        tags: ["pending"],
        namespace: "tasks/",
        entry_type: "state",
      });
      const candidate = selectNextTask(pending.results, []);
      if (candidate?.namespace === "tasks/oldest") {
        claimed = candidate;
        claimedOnPoll = poll;
      } else if (candidate) {
        const index = rows.findIndex((row) => row.id === candidate.id);
        if (index >= 0) rows.splice(index, 1);
      }
    }

    expect(claimed?.namespace).toBe("tasks/oldest");
    expect(claimedOnPoll).toBe(1);
  });

  it("reports an overflowing timestamp bucket without skipping older visible tasks", async () => {
    const timestamp = "2026-07-12T12:00:00.000Z";
    const older = makeTask(100, "2026-07-12T11:59:59.999Z");
    const rows = [
      ...Array.from({ length: 60 }, (_, index) => makeTask(index, timestamp)),
      older,
    ];
    const munin = new FilterOnlyMunin(rows);

    const result = await queryAllMuninEntries(munin as unknown as MuninClient, {
      tags: ["pending"],
      namespace: "tasks/",
      entry_type: "state",
    });

    expect(result.truncated).toBe(true);
    expect(result.results).toHaveLength(51);
    expect(result.results).toContain(older);
    expect(selectNextTask(result.results, [])).toBe(older);
    expect(munin.calls).toContainEqual(expect.objectContaining({
      since: timestamp,
      until: timestamp,
    }));
  });

  it("stops at a caller-owned work budget and reports the partial history honestly", async () => {
    const base = Date.UTC(2026, 6, 12, 12, 0, 0);
    const rows = Array.from({ length: 300 }, (_, index) =>
      makeTask(index, new Date(base + index).toISOString()),
    );
    const munin = new FilterOnlyMunin(rows);

    const result = await queryAllMuninEntries(
      munin as unknown as MuninClient,
      {
        tags: ["pending"],
        namespace: "tasks/",
        entry_type: "state",
      },
      { maxPages: 2, maxResults: 100 },
    );

    expect(result.results).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.budgetExhausted).toBe(true);
    expect(result.continuationUntil).toBeDefined();
    // Two ordinary pages plus their exact-timestamp boundary probes.
    expect(munin.calls).toHaveLength(4);

    const older = await queryAllMuninEntries(
      munin as unknown as MuninClient,
      {
        tags: ["pending"],
        namespace: "tasks/",
        entry_type: "state",
        until: result.continuationUntil,
      },
      { maxPages: 2, maxResults: 100 },
    );
    expect(older.results.every((row) =>
      row.updated_at <= result.continuationUntil!,
    )).toBe(true);
    expect(
      older.results.some((row) => result.results.some((current) => current.id === row.id)),
    ).toBe(false);
  });
});
