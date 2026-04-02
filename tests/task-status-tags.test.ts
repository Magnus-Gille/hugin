import { describe, expect, it } from "vitest";
import {
  buildPipelineParentCancelledTags,
  buildPipelineParentSuccessTags,
  buildTerminalStatusTags,
} from "../src/task-status-tags.js";

describe("task status tag helpers", () => {
  it("preserves policy tags on terminal child tasks", () => {
    expect(
      buildTerminalStatusTags("completed", [
        "running",
        "runtime:ollama",
        "type:pipeline",
        "type:pipeline-phase",
        "on-dep-failure:continue",
        "claimed_by:hugin-x",
        "lease_expires:2026-04-02T10:00:00Z",
      ])
    ).toEqual([
      "completed",
      "runtime:ollama",
      "type:pipeline",
      "type:pipeline-phase",
      "on-dep-failure:continue",
    ]);
  });

  it("preserves incoming type tags on successful pipeline parents", () => {
    expect(
      buildPipelineParentSuccessTags([
        "running",
        "runtime:pipeline",
        "type:research",
        "type:evaluation",
      ])
    ).toEqual([
      "completed",
      "runtime:pipeline",
      "type:research",
      "type:evaluation",
      "type:pipeline",
    ]);
  });

  it("preserves policy tags on cancelled child tasks", () => {
    expect(
      buildTerminalStatusTags("cancelled", [
        "running",
        "runtime:ollama",
        "type:pipeline",
        "type:pipeline-phase",
        "on-dep-failure:continue",
        "claimed_by:hugin-x",
        "lease_expires:2026-04-02T10:00:00Z",
      ])
    ).toEqual([
      "cancelled",
      "runtime:ollama",
      "type:pipeline",
      "type:pipeline-phase",
      "on-dep-failure:continue",
    ]);
  });

  it("preserves incoming type tags on cancelled pipeline parents", () => {
    expect(
      buildPipelineParentCancelledTags([
        "completed",
        "runtime:pipeline",
        "type:research",
        "type:evaluation",
        "cancel-requested",
      ])
    ).toEqual([
      "cancelled",
      "runtime:pipeline",
      "type:research",
      "type:evaluation",
      "type:pipeline",
    ]);
  });
});
