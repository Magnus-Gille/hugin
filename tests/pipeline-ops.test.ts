import { describe, expect, it } from "vitest";
import { compilePipelineTask } from "../src/pipeline-compiler.js";
import { buildPipelineResumePlan } from "../src/pipeline-ops.js";

function makePipeline() {
  return compilePipelineTask(
    "20260402-step3-resume-pipeline",
    "tasks/20260402-step3-resume-pipeline",
    `## Task: Step3 Resume Pipeline

- **Runtime:** pipeline
- **Submitted by:** hugin
- **Submitted at:** 2026-04-02T11:00:00Z

### Pipeline

Phase: gather
  Runtime: claude-sdk
  Prompt: |
    Gather.

Phase: report
  Depends-on: gather
  Runtime: ollama-pi
  Prompt: |
    Report.

Phase: publish
  Depends-on: report
  Runtime: codex-spawn
  Prompt: |
    Publish.
`
  );
}

describe("pipeline resume planner", () => {
  it("keeps completed phases and requeues cancelled descendants", () => {
    const pipeline = makePipeline();
    const plan = buildPipelineResumePlan(pipeline, {
      [pipeline.phases[0]!.taskNamespace]: "completed",
      [pipeline.phases[1]!.taskNamespace]: "cancelled",
      [pipeline.phases[2]!.taskNamespace]: "cancelled",
    });

    expect(plan.resumable).toBe(true);
    expect(plan.hasActivePhases).toBe(false);
    expect(plan.phases.map((phase) => phase.nextLifecycle)).toEqual([
      "completed",
      "pending",
      "blocked",
    ]);
  });

  it("restarts failed roots and blocks their dependents", () => {
    const pipeline = makePipeline();
    const plan = buildPipelineResumePlan(pipeline, {
      [pipeline.phases[0]!.taskNamespace]: "failed",
      [pipeline.phases[1]!.taskNamespace]: "failed",
      [pipeline.phases[2]!.taskNamespace]: "failed",
    });

    expect(plan.resumable).toBe(true);
    expect(plan.hasActivePhases).toBe(false);
    expect(plan.phases.map((phase) => phase.nextLifecycle)).toEqual([
      "pending",
      "blocked",
      "blocked",
    ]);
  });

  it("refuses to resume an already active pipeline", () => {
    const pipeline = makePipeline();
    const plan = buildPipelineResumePlan(pipeline, {
      [pipeline.phases[0]!.taskNamespace]: "running",
      [pipeline.phases[1]!.taskNamespace]: "blocked",
      [pipeline.phases[2]!.taskNamespace]: "blocked",
    });

    expect(plan.resumable).toBe(false);
    expect(plan.reason).toMatch(/already active/);
  });

  it("continues a partial resume when some phases are already active", () => {
    const pipeline = makePipeline();
    const plan = buildPipelineResumePlan(pipeline, {
      [pipeline.phases[0]!.taskNamespace]: "running",
      [pipeline.phases[1]!.taskNamespace]: "cancelled",
      [pipeline.phases[2]!.taskNamespace]: "cancelled",
    });

    expect(plan.resumable).toBe(true);
    expect(plan.hasActivePhases).toBe(true);
    expect(plan.phases.map((phase) => phase.nextLifecycle)).toEqual([
      "running",
      "blocked",
      "blocked",
    ]);
  });

  it("refuses to resume a fully completed pipeline", () => {
    const pipeline = makePipeline();
    const plan = buildPipelineResumePlan(pipeline, {
      [pipeline.phases[0]!.taskNamespace]: "completed",
      [pipeline.phases[1]!.taskNamespace]: "completed",
      [pipeline.phases[2]!.taskNamespace]: "completed",
    });

    expect(plan.resumable).toBe(false);
    expect(plan.reason).toMatch(/already completed/);
  });
});
