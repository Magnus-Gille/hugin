import { describe, expect, it } from "vitest";
import {
  buildPhaseTaskDrafts,
  compilePipelineTask,
} from "../src/pipeline-compiler.js";

function makePipeline(content: string) {
  return compilePipelineTask(
    "20260402-improve-munin-ux",
    "tasks/20260402-improve-munin-ux",
    content
  );
}

describe("pipeline compiler", () => {
  it("compiles a valid pipeline into IR", () => {
    const pipeline = makePipeline(`## Task: Improve Munin UX

- **Runtime:** pipeline
- **Sensitivity:** internal
- **Submitted by:** claude-code
- **Submitted at:** 2026-04-02T22:00:00Z
- **Reply-to:** telegram:12345678

### Pipeline

Phase: explore
  Runtime: ollama-pi
  Prompt: |
    Use the tools and document friction.

Phase: debate
  Depends-on: explore
  Runtime: claude-sdk
  Context: repo:hugin
  Timeout: 60000
  Prompt: |
    Read the findings and rank improvements.
`);

    expect(pipeline.id).toBe("20260402-improve-munin-ux");
    expect(pipeline.replyTo).toBe("telegram:12345678");
    expect(pipeline.sensitivity).toBe("internal");
    expect(pipeline.phases).toHaveLength(2);
    expect(pipeline.phases[0]?.taskId).toBe("20260402-improve-munin-ux-explore");
    expect(pipeline.phases[1]?.dependencyTaskIds).toEqual([
      "20260402-improve-munin-ux-explore",
    ]);
    expect(pipeline.phases[1]?.context).toBe("repo:hugin");
    expect(pipeline.phases[1]?.timeout).toBe(60000);
  });

  it("builds child task drafts with dependency tags and provenance in content", () => {
    const pipeline = makePipeline(`## Task: Improve Munin UX

- **Runtime:** pipeline
- **Submitted by:** claude-code

### Pipeline

Phase: explore
  Runtime: ollama-pi
  Prompt: |
    Explore.

Phase: synthesize
  Depends-on: explore
  Runtime: claude-sdk
  On-dep-failure: continue
  Prompt: |
    Synthesize.
`);

    const drafts = buildPhaseTaskDrafts(pipeline);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.namespace).toBe("tasks/20260402-improve-munin-ux-explore");
    expect(drafts[0]?.tags).toEqual([
      "pending",
      "runtime:ollama",
      "type:pipeline",
      "type:pipeline-phase",
    ]);
    expect(drafts[1]?.tags).toEqual([
      "blocked",
      "runtime:claude",
      "type:pipeline",
      "type:pipeline-phase",
      "on-dep-failure:continue",
      "depends-on:20260402-improve-munin-ux-explore",
    ]);
    expect(drafts[1]?.content).toContain("**Pipeline:** 20260402-improve-munin-ux");
    expect(drafts[1]?.content).toContain("**Depends on task ids:** 20260402-improve-munin-ux-explore");
    expect(drafts[1]?.content).toContain("**Depends on phases:** explore");
  });

  it("rejects Runtime: auto until routing exists", () => {
    expect(() =>
      makePipeline(`## Task: Invalid

- **Runtime:** pipeline

### Pipeline

Phase: explore
  Runtime: auto
  Prompt: |
    Explore.
`)
    ).toThrow(/Runtime: auto/);
  });

  it("rejects unknown dependency references", () => {
    expect(() =>
      makePipeline(`## Task: Invalid deps

- **Runtime:** pipeline

### Pipeline

Phase: synthesize
  Depends-on: missing
  Runtime: claude-sdk
  Prompt: |
    Synthesize.
`)
    ).toThrow(/unknown phase "missing"/);
  });

  it("rejects dependency cycles", () => {
    expect(() =>
      makePipeline(`## Task: Cyclic

- **Runtime:** pipeline

### Pipeline

Phase: first
  Depends-on: second
  Runtime: claude-sdk
  Prompt: |
    First.

Phase: second
  Depends-on: first
  Runtime: codex-spawn
  Prompt: |
    Second.
`)
    ).toThrow(/cycle/);
  });

  it("rejects gated authority before Step 4", () => {
    expect(() =>
      makePipeline(`## Task: Gated

- **Runtime:** pipeline

### Pipeline

Phase: deploy
  Runtime: codex-spawn
  Authority: gated
  Prompt: |
    Deploy.
`)
    ).toThrow(/deferred until Step 4/);
  });
});
