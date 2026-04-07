import { describe, expect, it } from "vitest";
import {
  buildPhaseTaskDrafts,
  buildPipelineDecompositionResult,
  compilePipelineTask,
} from "../src/pipeline-compiler.js";
import type { OllamaHost } from "../src/ollama-hosts.js";

const defaultOllamaHosts: OllamaHost[] = [
  {
    name: "pi",
    baseUrl: "http://127.0.0.1:11434",
    available: true,
    models: ["qwen2.5:3b"],
    lastChecked: Date.now(),
  },
  {
    name: "laptop",
    baseUrl: "http://100.1.2.3:11434",
    available: false,
    models: [],
    lastChecked: Date.now(),
  },
];

function makePipeline(content: string, ollamaHosts?: OllamaHost[]) {
  return compilePipelineTask(
    "20260402-improve-munin-ux",
    "tasks/20260402-improve-munin-ux",
    content,
    ollamaHosts ?? defaultOllamaHosts,
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
- **Reply-format:** summary
- **Group:** demo-batch
- **Sequence:** 4

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
    expect(pipeline.replyFormat).toBe("summary");
    expect(pipeline.group).toBe("demo-batch");
    expect(pipeline.sequence).toBe(4);
    expect(pipeline.sensitivity).toBe("internal");
    expect(pipeline.phases).toHaveLength(2);
    expect(pipeline.phases[0]?.taskId).toBe("20260402-improve-munin-ux-explore");
    expect(pipeline.phases[1]?.dependencyTaskIds).toEqual([
      "20260402-improve-munin-ux-explore",
    ]);
    expect(pipeline.phases[0]?.model).toBe("qwen2.5:3b");
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
      "authority:autonomous",
      "sensitivity:internal",
    ]);
    expect(drafts[1]?.tags).toEqual([
      "blocked",
      "runtime:claude",
      "type:pipeline",
      "type:pipeline-phase",
      "authority:autonomous",
      "sensitivity:internal",
      "on-dep-failure:continue",
      "depends-on:20260402-improve-munin-ux-explore",
    ]);
    expect(drafts[0]?.content).toContain("**Model:** qwen2.5:3b");
    expect(drafts[1]?.content).toContain("**Pipeline:** 20260402-improve-munin-ux");
    expect(drafts[1]?.content).toContain("**Depends on task ids:** 20260402-improve-munin-ux-explore");
    expect(drafts[1]?.content).toContain("**Depends on phases:** explore");
  });

  it("routes Runtime: auto to a concrete runtime at compile time", () => {
    const pipeline = makePipeline(`## Task: Auto-routed

- **Runtime:** pipeline
- **Sensitivity:** internal

### Pipeline

Phase: explore
  Runtime: auto
  Prompt: |
    Explore.
`);
    // auto should resolve to a concrete runtime
    expect(pipeline.phases[0]?.runtime).toBeTruthy();
    expect(pipeline.phases[0]?.runtime).not.toBe("auto");
    expect(pipeline.phases[0]?.autoRouted).toBe(true);
    expect(pipeline.phases[0]?.routingReason).toBeTruthy();
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

  it("accepts gated authority when explicit side effects are declared", () => {
    const pipeline = makePipeline(`## Task: Gated

- **Runtime:** pipeline

### Pipeline

Phase: deploy
  Runtime: codex-spawn
  Authority: gated
  Side-effects: deploy.service
  Prompt: |
    Deploy.
`);

    expect(pipeline.phases[0]?.authority).toBe("gated");
    expect(pipeline.phases[0]?.sideEffects).toEqual(["deploy.service"]);
  });

  it("rejects gated phases without explicit side effects", () => {
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
    ).toThrow(/declares no Side-effects/);
  });

  it("rejects autonomous phases that declare side effects", () => {
    expect(() =>
      makePipeline(`## Task: Invalid autonomous side effects

- **Runtime:** pipeline

### Pipeline

Phase: notify
  Runtime: claude-sdk
  Side-effects: message.telegram.send
  Prompt: |
    Notify.
`)
    ).toThrow(/declares side effects but uses Authority: autonomous/);
  });

  it("rejects unknown side effect ids", () => {
    expect(() =>
      makePipeline(`## Task: Unknown side effect

- **Runtime:** pipeline

### Pipeline

Phase: notify
  Runtime: claude-sdk
  Authority: gated
  Side-effects: message.slack.send
  Prompt: |
    Notify.
`)
    ).toThrow(/unknown side effect/);
  });

  it("rejects private-sensitive cloud phases", () => {
    expect(() =>
      makePipeline(`## Task: Private review

- **Runtime:** pipeline
- **Sensitivity:** private

### Pipeline

Phase: review
  Runtime: claude-sdk
  Prompt: |
    Review the private notes.
`)
    ).toThrow(/max allowed: internal/);
  });

  it("allows private-sensitive local ollama phases", () => {
    const pipeline = makePipeline(`## Task: Private review

- **Runtime:** pipeline
- **Sensitivity:** private

### Pipeline

Phase: review
  Runtime: ollama-pi
  Prompt: |
    Review the private notes.
`);

    expect(pipeline.phases[0]?.effectiveSensitivity).toBe("private");
    expect(pipeline.phases[0]?.runtime).toBe("ollama-pi");
  });

  it("renders parent routing metadata in the decomposition result", () => {
    const pipeline = makePipeline(`## Task: Improve Munin UX

- **Runtime:** pipeline
- **Submitted by:** claude-code
- **Reply-to:** telegram:12345678
- **Reply-format:** summary
- **Group:** demo-batch
- **Sequence:** 4

### Pipeline

Phase: explore
  Runtime: ollama-pi
  Prompt: |
    Explore.
`);

    const result = buildPipelineDecompositionResult(pipeline);

    expect(result).toContain("- **Reply-to:** telegram:12345678");
    expect(result).toContain("- **Reply-format:** summary");
    expect(result).toContain("- **Group:** demo-batch");
    expect(result).toContain("- **Sequence:** 4");
  });

  it("propagates private sensitivity through dependency edges", () => {
    const pipeline = makePipeline(`## Task: Dependency sensitivity propagation

- **Runtime:** pipeline
- **Sensitivity:** internal

### Pipeline

Phase: gather
  Runtime: ollama-pi
  Sensitivity: private
  Prompt: |
    Gather private data.

Phase: analyze
  Runtime: ollama-pi
  Depends-on: gather
  Prompt: |
    Analyze the gathered data.

Phase: summarize
  Runtime: ollama-pi
  Depends-on: analyze
  Prompt: |
    Summarize everything.
`);

    // gather: declared private → effective private
    expect(pipeline.phases.find(p => p.name === "gather")?.effectiveSensitivity).toBe("private");
    // analyze: no declared sensitivity, depends on gather (private) → inherits private
    expect(pipeline.phases.find(p => p.name === "analyze")?.effectiveSensitivity).toBe("private");
    // summarize: no declared sensitivity, depends on analyze (private via inheritance) → inherits private
    expect(pipeline.phases.find(p => p.name === "summarize")?.effectiveSensitivity).toBe("private");
    // pipeline-level declared sensitivity stays as declared (internal)
    expect(pipeline.sensitivity).toBe("internal");
  });

  it("rejects missing phase runtimes with a direct error", () => {
    expect(() =>
      makePipeline(`## Task: Missing runtime

- **Runtime:** pipeline

### Pipeline

Phase: explore
  Prompt: |
    Explore.
`)
    ).toThrow(/missing a Runtime field/);
  });

  it("auto-routes private pipeline phase to trusted runtime only", () => {
    const pipeline = makePipeline(`## Task: Private auto

- **Runtime:** pipeline
- **Sensitivity:** private

### Pipeline

Phase: review
  Runtime: auto
  Prompt: |
    Review private notes.
`);
    // Private must route to trusted (ollama)
    expect(pipeline.phases[0]?.dispatcherRuntime).toBe("ollama");
    expect(pipeline.phases[0]?.autoRouted).toBe(true);
  });

  it("compiles pipeline with mixed auto and explicit phases", () => {
    const pipeline = makePipeline(`## Task: Mixed routing

- **Runtime:** pipeline
- **Sensitivity:** internal

### Pipeline

Phase: gather
  Runtime: ollama-pi
  Prompt: |
    Gather data.

Phase: analyze
  Depends-on: gather
  Runtime: auto
  Prompt: |
    Analyze.

Phase: report
  Depends-on: analyze
  Runtime: claude-sdk
  Prompt: |
    Report.
`);
    expect(pipeline.phases).toHaveLength(3);
    // First phase: explicit
    expect(pipeline.phases[0]?.runtime).toBe("ollama-pi");
    expect(pipeline.phases[0]?.autoRouted).toBeUndefined();
    // Second phase: auto-routed
    expect(pipeline.phases[1]?.autoRouted).toBe(true);
    expect(pipeline.phases[1]?.runtime).not.toBe("auto");
    // Third phase: explicit
    expect(pipeline.phases[2]?.runtime).toBe("claude-sdk");
    expect(pipeline.phases[2]?.autoRouted).toBeUndefined();
  });

  it("auto-routes with Capabilities: filtering", () => {
    const pipeline = makePipeline(`## Task: Capable auto

- **Runtime:** pipeline
- **Sensitivity:** internal

### Pipeline

Phase: code-task
  Runtime: auto
  Capabilities: tools, code
  Prompt: |
    Write code.
`);
    // tools+code should route to claude-sdk or codex (not ollama which has no capabilities)
    expect(["claude", "codex"]).toContain(pipeline.phases[0]?.dispatcherRuntime);
    expect(pipeline.phases[0]?.autoRouted).toBe(true);
  });
});
