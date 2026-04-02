import { describe, expect, it } from "vitest";
import {
  MAX_DEPENDENCIES,
  buildPromotedTags,
  evaluateBlockedTask,
  getDependencyFailurePolicy,
  getDependencyIds,
} from "../src/task-graph.js";

describe("task graph tags", () => {
  it("extracts dependency ids from blocked task tags", () => {
    expect(
      getDependencyIds([
        "blocked",
        "runtime:claude",
        "depends-on:task-a",
        "depends-on:task-b",
      ])
    ).toEqual(["task-a", "task-b"]);
  });

  it("defaults dependency failure policy to fail", () => {
    expect(getDependencyFailurePolicy(["blocked", "runtime:claude"])).toBe("fail");
  });

  it("parses continue dependency failure policy", () => {
    expect(
      getDependencyFailurePolicy([
        "blocked",
        "runtime:claude",
        "on-dep-failure:continue",
      ])
    ).toBe("continue");
  });

  it("builds promoted tags by stripping blocked state and dependency edges", () => {
    expect(
      buildPromotedTags([
        "blocked",
        "runtime:claude",
        "type:review",
        "depends-on:task-a",
        "on-dep-failure:continue",
      ])
    ).toEqual(["runtime:claude", "type:review", "on-dep-failure:continue", "pending"]);
  });
});

describe("blocked task evaluation", () => {
  it("promotes when all dependencies completed", () => {
    const evaluation = evaluateBlockedTask(
      ["blocked", "depends-on:task-a", "depends-on:task-b"],
      {
        "task-a": "completed",
        "task-b": "completed",
      }
    );

    expect(evaluation.shouldPromote).toBe(true);
    expect(evaluation.shouldFail).toBe(false);
    expect(evaluation.allCompleted).toBe(true);
  });

  it("fails immediately when a dependency failed and policy is fail", () => {
    const evaluation = evaluateBlockedTask(
      ["blocked", "depends-on:task-a", "depends-on:task-b"],
      {
        "task-a": "failed",
        "task-b": "pending",
      }
    );

    expect(evaluation.shouldFail).toBe(true);
    expect(evaluation.shouldPromote).toBe(false);
    expect(evaluation.failureReason).toContain("task-a");
  });

  it("waits for all dependencies to become terminal when policy is continue", () => {
    const evaluation = evaluateBlockedTask(
      [
        "blocked",
        "depends-on:task-a",
        "depends-on:task-b",
        "on-dep-failure:continue",
      ],
      {
        "task-a": "failed",
        "task-b": "pending",
      }
    );

    expect(evaluation.shouldFail).toBe(false);
    expect(evaluation.shouldPromote).toBe(false);
    expect(evaluation.allTerminal).toBe(false);
  });

  it("promotes after all dependencies are terminal when policy is continue", () => {
    const evaluation = evaluateBlockedTask(
      [
        "blocked",
        "depends-on:task-a",
        "depends-on:task-b",
        "on-dep-failure:continue",
      ],
      {
        "task-a": "failed",
        "task-b": "completed",
      }
    );

    expect(evaluation.shouldFail).toBe(false);
    expect(evaluation.shouldPromote).toBe(true);
    expect(evaluation.allTerminal).toBe(true);
  });

  it("fails tasks that exceed the fan-out limit", () => {
    const tags = ["blocked", ...Array.from({ length: MAX_DEPENDENCIES + 1 }, (_, i) => `depends-on:task-${i}`)];
    const evaluation = evaluateBlockedTask(tags, {});

    expect(evaluation.shouldFail).toBe(true);
    expect(evaluation.failureReason).toContain(String(MAX_DEPENDENCIES));
  });

  it("does not promote when a dependency is missing", () => {
    const evaluation = evaluateBlockedTask(
      ["blocked", "depends-on:task-a"],
      {}
    );

    expect(evaluation.shouldPromote).toBe(false);
    expect(evaluation.shouldFail).toBe(false);
    expect(evaluation.missingIds).toEqual(["task-a"]);
  });
});
