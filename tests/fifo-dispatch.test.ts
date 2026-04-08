import { describe, it, expect } from "vitest";
import { pickEarliestTask } from "../src/task-helpers.js";
import type { MuninQueryResult } from "../src/munin-client.js";

function makeResult(
  namespace: string,
  created_at: string,
  key: string = "status"
): MuninQueryResult {
  return {
    id: `id-${namespace}`,
    namespace,
    key,
    entry_type: "state",
    content_preview: "",
    tags: ["pending"],
    created_at,
    updated_at: created_at,
  };
}

describe("pickEarliestTask", () => {
  it("returns undefined for an empty result set", () => {
    expect(pickEarliestTask([])).toBeUndefined();
  });

  it("returns undefined when no result has key === 'status'", () => {
    const results = [
      makeResult("tasks/abc/", "2026-01-01T00:00:00Z", "meta"),
      makeResult("tasks/def/", "2026-01-01T00:01:00Z", "context"),
    ];
    expect(pickEarliestTask(results)).toBeUndefined();
  });

  it("returns the only status entry when there is exactly one", () => {
    const entry = makeResult("tasks/only/", "2026-01-01T12:00:00Z");
    expect(pickEarliestTask([entry])).toBe(entry);
  });

  it("returns the entry with the earliest created_at (FIFO)", () => {
    const old = makeResult("tasks/old/", "2026-01-01T08:00:00Z");
    const mid = makeResult("tasks/mid/", "2026-01-01T09:00:00Z");
    const newest = makeResult("tasks/new/", "2026-01-01T10:00:00Z");

    // Results returned in any order — newest first (as search ranking might do)
    expect(pickEarliestTask([newest, mid, old])).toBe(old);
    // Results in chronological order
    expect(pickEarliestTask([old, mid, newest])).toBe(old);
    // Two-element case
    expect(pickEarliestTask([newest, old])).toBe(old);
  });

  it("ignores non-status entries when selecting the earliest", () => {
    const metaEntry = makeResult("tasks/meta/", "2026-01-01T07:00:00Z", "meta");
    const oldTask = makeResult("tasks/old/", "2026-01-01T08:00:00Z");
    const newTask = makeResult("tasks/new/", "2026-01-01T10:00:00Z");

    // metaEntry has an earlier timestamp but is not key=status
    expect(pickEarliestTask([metaEntry, newTask, oldTask])).toBe(oldTask);
  });

  it("is stable: returns the first-encountered entry when timestamps are equal", () => {
    const sameTime = "2026-01-01T09:00:00Z";
    const first = makeResult("tasks/first/", sameTime);
    const second = makeResult("tasks/second/", sameTime);

    // When timestamps are equal the reduce keeps the first-seen entry
    // (the `<` comparison is strict, so ties stay with the accumulator)
    expect(pickEarliestTask([first, second])).toBe(first);
    expect(pickEarliestTask([second, first])).toBe(second);
  });

  it("handles millisecond-precision ISO timestamps correctly", () => {
    const earlier = makeResult("tasks/a/", "2026-04-08T10:00:00.123Z");
    const later = makeResult("tasks/b/", "2026-04-08T10:00:00.456Z");

    expect(pickEarliestTask([later, earlier])).toBe(earlier);
  });
});
