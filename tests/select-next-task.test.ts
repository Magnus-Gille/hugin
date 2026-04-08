import { describe, it, expect } from "vitest";
import { selectNextTask, parseGroupField, parseSequenceField } from "../src/task-helpers.js";
import type { MuninQueryResult } from "../src/munin-client.js";

function makeTask(
  namespace: string,
  created_at: string,
  contentPreview: string = "",
  key: string = "status",
): MuninQueryResult {
  return {
    id: `id-${namespace}`,
    namespace,
    key,
    entry_type: "state",
    content_preview: contentPreview,
    tags: ["pending"],
    created_at,
    updated_at: created_at,
  };
}

function makeRunning(
  namespace: string,
  contentPreview: string = "",
): MuninQueryResult {
  return {
    id: `id-${namespace}`,
    namespace,
    key: "status",
    entry_type: "state",
    content_preview: contentPreview,
    tags: ["running"],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const NO_RUNNING: MuninQueryResult[] = [];

describe("parseGroupField", () => {
  it("returns undefined when no Group field", () => {
    expect(parseGroupField("**Runtime:** claude\n**Prompt:** do stuff")).toBeUndefined();
  });

  it("parses Group field", () => {
    expect(parseGroupField("**Group:** my-group\n**Sequence:** 1")).toBe("my-group");
  });

  it("is case-insensitive", () => {
    expect(parseGroupField("**group:** test-group")).toBe("test-group");
  });
});

describe("parseSequenceField", () => {
  it("returns undefined when no Sequence field", () => {
    expect(parseSequenceField("**Runtime:** claude")).toBeUndefined();
  });

  it("parses Sequence field as a number", () => {
    expect(parseSequenceField("**Sequence:** 3")).toBe(3);
  });

  it("is case-insensitive", () => {
    expect(parseSequenceField("**sequence:** 7")).toBe(7);
  });
});

describe("selectNextTask", () => {
  it("returns undefined for an empty result set", () => {
    expect(selectNextTask([], NO_RUNNING)).toBeUndefined();
  });

  it("returns undefined when no result has key === 'status'", () => {
    const results = [
      makeTask("tasks/abc/", "2026-01-01T00:00:00Z", "", "meta"),
    ];
    expect(selectNextTask(results, NO_RUNNING)).toBeUndefined();
  });

  it("dispatches a task without a Group field normally (earliest FIFO)", () => {
    const old = makeTask("tasks/old/", "2026-01-01T08:00:00Z", "**Runtime:** claude");
    const newer = makeTask("tasks/new/", "2026-01-01T09:00:00Z", "**Runtime:** claude");
    expect(selectNextTask([newer, old], NO_RUNNING)).toBe(old);
  });

  it("dispatches a grouped task with Sequence 1 when no other group members exist", () => {
    const content = "**Group:** batch-a\n**Sequence:** 1\n**Runtime:** claude";
    const task = makeTask("tasks/seq1/", "2026-01-01T08:00:00Z", content);
    expect(selectNextTask([task], NO_RUNNING)).toBe(task);
  });

  it("skips Sequence 2 when Sequence 1 is still pending in batch", () => {
    const seq1 = makeTask(
      "tasks/seq1/",
      "2026-01-01T08:00:00Z",
      "**Group:** batch-a\n**Sequence:** 1\n**Runtime:** claude",
    );
    const seq2 = makeTask(
      "tasks/seq2/",
      "2026-01-01T09:00:00Z",
      "**Group:** batch-a\n**Sequence:** 2\n**Runtime:** claude",
    );
    // Both pending — seq1 should be selected, and if only seq2 is passed it should be blocked
    expect(selectNextTask([seq1, seq2], NO_RUNNING)).toBe(seq1);
    // If only seq2 is in the pending batch but seq1 is also there, seq2 is blocked
    expect(selectNextTask([seq2, seq1], NO_RUNNING)).toBe(seq1);
  });

  it("skips Sequence 2 when Sequence 1 is running (in runningTasks)", () => {
    const seq2 = makeTask(
      "tasks/seq2/",
      "2026-01-01T09:00:00Z",
      "**Group:** batch-a\n**Sequence:** 2\n**Runtime:** claude",
    );
    const runningSeq1 = makeRunning(
      "tasks/seq1/",
      "**Group:** batch-a\n**Sequence:** 1\n**Runtime:** claude",
    );
    expect(selectNextTask([seq2], [runningSeq1])).toBeUndefined();
  });

  it("dispatches Sequence 2 when Sequence 1 is not pending and not running", () => {
    const seq2 = makeTask(
      "tasks/seq2/",
      "2026-01-01T09:00:00Z",
      "**Group:** batch-a\n**Sequence:** 2\n**Runtime:** claude",
    );
    // seq1 has completed (not in either list)
    expect(selectNextTask([seq2], NO_RUNNING)).toBe(seq2);
  });

  it("non-group tasks are unaffected by group sequencing", () => {
    const groupTask = makeTask(
      "tasks/grouped/",
      "2026-01-01T08:00:00Z",
      "**Group:** batch-a\n**Sequence:** 2\n**Runtime:** claude",
    );
    const noGroupTask = makeTask(
      "tasks/plain/",
      "2026-01-01T09:00:00Z",
      "**Runtime:** claude",
    );
    const runningSeq1 = makeRunning(
      "tasks/seq1/",
      "**Group:** batch-a\n**Sequence:** 1\n**Runtime:** claude",
    );
    // groupTask is blocked, noGroupTask should be selected despite being newer
    expect(selectNextTask([groupTask, noGroupTask], [runningSeq1])).toBe(noGroupTask);
  });

  it("prefers non-group task over blocked group task even if group task is older", () => {
    const olderGroupTask = makeTask(
      "tasks/older-grouped/",
      "2026-01-01T07:00:00Z",
      "**Group:** batch-x\n**Sequence:** 3\n**Runtime:** claude",
    );
    const newerPlainTask = makeTask(
      "tasks/newer-plain/",
      "2026-01-01T08:00:00Z",
      "**Runtime:** claude",
    );
    const runningSeq2 = makeRunning(
      "tasks/seq2/",
      "**Group:** batch-x\n**Sequence:** 2\n**Runtime:** claude",
    );
    // olderGroupTask is blocked by runningSeq2 (seq 2 < 3)
    // newerPlainTask has no group so it is eligible
    expect(selectNextTask([olderGroupTask, newerPlainTask], [runningSeq2])).toBe(newerPlainTask);
  });

  it("tasks from different groups do not block each other", () => {
    const groupA_seq2 = makeTask(
      "tasks/a-seq2/",
      "2026-01-01T08:00:00Z",
      "**Group:** group-a\n**Sequence:** 2\n**Runtime:** claude",
    );
    const groupB_seq1 = makeTask(
      "tasks/b-seq1/",
      "2026-01-01T09:00:00Z",
      "**Group:** group-b\n**Sequence:** 1\n**Runtime:** claude",
    );
    const runningA_seq1 = makeRunning(
      "tasks/a-seq1/",
      "**Group:** group-a\n**Sequence:** 1\n**Runtime:** claude",
    );
    // groupA_seq2 is blocked, groupB_seq1 is not blocked (different group)
    expect(selectNextTask([groupA_seq2, groupB_seq1], [runningA_seq1])).toBe(groupB_seq1);
  });

  it("dispatches a grouped task with no Sequence field regardless of other group members", () => {
    const noSeqGroupTask = makeTask(
      "tasks/no-seq/",
      "2026-01-01T08:00:00Z",
      "**Group:** batch-a\n**Runtime:** claude",
    );
    expect(selectNextTask([noSeqGroupTask], NO_RUNNING)).toBe(noSeqGroupTask);
  });
});
