import { describe, expect, it } from "vitest";
import { compilePipelineTask } from "../src/pipeline-compiler.js";
import {
  buildPipelineExecutionSummary,
  getPipelineExecutionSummaryFingerprint,
  parsePipelineExecutionSummary,
  pipelineSummaryNeedsReconciliation,
} from "../src/pipeline-summary.js";
import { buildStructuredTaskResult } from "../src/task-result-schema.js";

function makePipeline() {
  return compilePipelineTask(
    "20260402-step3-pipeline",
    "tasks/20260402-step3-pipeline",
    `## Task: Step3 Pipeline

- **Runtime:** pipeline
- **Submitted by:** claude-code
- **Submitted at:** 2026-04-02T11:00:00Z
- **Reply-to:** telegram:step3
- **Reply-format:** summary
- **Group:** step3-batch
- **Sequence:** 9

### Pipeline

Phase: gather
  Runtime: ollama-pi
  Prompt: |
    Gather.

Phase: summarize
  Depends-on: gather
  Runtime: ollama-pi
  On-dep-failure: continue
  Prompt: |
    Summarize.
`
  );
}

function makeThreePhasePipeline() {
  return compilePipelineTask(
    "20260402-step3-pipeline-mixed-terminal",
    "tasks/20260402-step3-pipeline-mixed-terminal",
    `## Task: Step3 Mixed Terminal Pipeline

- **Runtime:** pipeline
- **Submitted by:** claude-code
- **Submitted at:** 2026-04-02T11:00:00Z

### Pipeline

Phase: gather
  Runtime: ollama-pi
  Prompt: |
    Gather.

Phase: summarize
  Depends-on: gather
  Runtime: ollama-pi
  Prompt: |
    Summarize.

Phase: review
  Depends-on: summarize
  Runtime: ollama-pi
  Prompt: |
    Review.
`
  );
}

describe("pipeline execution summary", () => {
  it("builds a decomposed summary before any phase runs", () => {
    const pipeline = makePipeline();
    const summary = buildPipelineExecutionSummary(
      pipeline,
      pipeline.phases.map((phase, index) => ({
        phase,
        lifecycle: index === 0 ? "pending" : "blocked",
      })),
      "2026-04-02T11:00:00Z"
    );

    expect(summary.executionState).toBe("decomposed");
    expect(summary.phaseCounts.pending).toBe(1);
    expect(summary.phaseCounts.blocked).toBe(1);
    expect(summary.replyTo).toBe("telegram:step3");
    expect(summary.group).toBe("step3-batch");
  });

  it("reports running once a phase has been claimed", () => {
    const pipeline = makePipeline();
    const summary = buildPipelineExecutionSummary(pipeline, [
      {
        phase: pipeline.phases[0]!,
        lifecycle: "running",
      },
      {
        phase: pipeline.phases[1]!,
        lifecycle: "blocked",
      },
    ]);

    expect(summary.executionState).toBe("running");
    expect(summary.phaseCounts.running).toBe(1);
  });

  it("builds a completed summary with timings from structured results", () => {
    const pipeline = makePipeline();
    const summary = buildPipelineExecutionSummary(
      pipeline,
      [
        {
          phase: pipeline.phases[0]!,
          lifecycle: "completed",
          structuredResult: buildStructuredTaskResult({
            schemaVersion: 1,
            taskId: pipeline.phases[0]!.taskId,
            taskNamespace: pipeline.phases[0]!.taskNamespace,
            lifecycle: "completed",
            outcome: "completed",
            runtime: "ollama",
            executor: "ollama",
            resultSource: "ollama",
            exitCode: 0,
            startedAt: "2026-04-02T11:00:01Z",
            completedAt: "2026-04-02T11:00:03Z",
            durationSeconds: 2,
            logFile: "~/.hugin/logs/gather.log",
            bodyKind: "response",
            bodyText: "GATHER",
          }),
        },
        {
          phase: pipeline.phases[1]!,
          lifecycle: "completed",
          structuredResult: buildStructuredTaskResult({
            schemaVersion: 1,
            taskId: pipeline.phases[1]!.taskId,
            taskNamespace: pipeline.phases[1]!.taskNamespace,
            lifecycle: "completed",
            outcome: "completed",
            runtime: "ollama",
            executor: "ollama",
            resultSource: "ollama",
            exitCode: 0,
            startedAt: "2026-04-02T11:00:04Z",
            completedAt: "2026-04-02T11:00:08Z",
            durationSeconds: 4,
            logFile: "~/.hugin/logs/summarize.log",
            bodyKind: "response",
            bodyText: "SUMMARIZE",
          }),
        },
      ],
      "2026-04-02T11:00:08Z"
    );

    expect(summary.executionState).toBe("completed");
    expect(summary.terminal).toBe(true);
    expect(summary.startedAt).toBe("2026-04-02T11:00:01Z");
    expect(summary.completedAt).toBe("2026-04-02T11:00:08Z");
    expect(summary.durationSeconds).toBe(7);
  });

  it("distinguishes completed_with_failures once all phases are terminal", () => {
    const pipeline = makePipeline();
    const summary = buildPipelineExecutionSummary(
      pipeline,
      [
        {
          phase: pipeline.phases[0]!,
          lifecycle: "failed",
          structuredResult: buildStructuredTaskResult({
            schemaVersion: 1,
            taskId: pipeline.phases[0]!.taskId,
            taskNamespace: pipeline.phases[0]!.taskNamespace,
            lifecycle: "failed",
            outcome: "failed",
            runtime: "ollama",
            executor: "dispatcher",
            resultSource: "dependency",
            exitCode: -1,
            completedAt: "2026-04-02T11:00:03Z",
            bodyKind: "error",
            bodyText: "boom",
            errorMessage: "boom",
          }),
        },
        {
          phase: pipeline.phases[1]!,
          lifecycle: "completed",
          structuredResult: buildStructuredTaskResult({
            schemaVersion: 1,
            taskId: pipeline.phases[1]!.taskId,
            taskNamespace: pipeline.phases[1]!.taskNamespace,
            lifecycle: "completed",
            outcome: "completed",
            runtime: "ollama",
            executor: "ollama",
            resultSource: "ollama",
            exitCode: 0,
            startedAt: "2026-04-02T11:00:04Z",
            completedAt: "2026-04-02T11:00:08Z",
            durationSeconds: 4,
            logFile: "~/.hugin/logs/summarize.log",
            bodyKind: "response",
            bodyText: "SUMMARIZE",
          }),
        },
      ]
    );

    expect(summary.executionState).toBe("completed_with_failures");
    expect(summary.phaseCounts.failed).toBe(1);
    expect(summary.phases[0]?.errorMessage).toBe("boom");
  });

  it("reports cancelled once all remaining phases are cancelled", () => {
    const pipeline = makePipeline();
    const summary = buildPipelineExecutionSummary(
      pipeline,
      [
        {
          phase: pipeline.phases[0]!,
          lifecycle: "completed",
          structuredResult: buildStructuredTaskResult({
            schemaVersion: 1,
            taskId: pipeline.phases[0]!.taskId,
            taskNamespace: pipeline.phases[0]!.taskNamespace,
            lifecycle: "completed",
            outcome: "completed",
            runtime: "ollama",
            executor: "ollama",
            resultSource: "ollama",
            exitCode: 0,
            startedAt: "2026-04-02T11:00:01Z",
            completedAt: "2026-04-02T11:00:03Z",
            durationSeconds: 2,
            logFile: "~/.hugin/logs/gather.log",
            bodyKind: "response",
            bodyText: "GATHER",
          }),
        },
        {
          phase: pipeline.phases[1]!,
          lifecycle: "cancelled",
          structuredResult: buildStructuredTaskResult({
            schemaVersion: 1,
            taskId: pipeline.phases[1]!.taskId,
            taskNamespace: pipeline.phases[1]!.taskNamespace,
            lifecycle: "cancelled",
            outcome: "cancelled",
            runtime: "ollama",
            executor: "dispatcher",
            resultSource: "cancellation",
            exitCode: "CANCELLED",
            completedAt: "2026-04-02T11:00:04Z",
            bodyKind: "error",
            bodyText: "Pipeline cancelled by operator",
            errorMessage: "Pipeline cancelled by operator",
          }),
        },
      ]
    );

    expect(summary.executionState).toBe("cancelled");
    expect(summary.terminal).toBe(true);
    expect(summary.phaseCounts.cancelled).toBe(1);
    expect(summary.phases[1]?.outcome).toBe("cancelled");
  });

  it("reports cancelled when every phase is cancelled", () => {
    const pipeline = makePipeline();
    const summary = buildPipelineExecutionSummary(
      pipeline,
      pipeline.phases.map((phase) => ({
        phase,
        lifecycle: "cancelled" as const,
        structuredResult: buildStructuredTaskResult({
          schemaVersion: 1,
          taskId: phase.taskId,
          taskNamespace: phase.taskNamespace,
          lifecycle: "cancelled",
          outcome: "cancelled",
          runtime: "claude",
          executor: "dispatcher",
          resultSource: "cancellation",
          exitCode: "CANCELLED",
          completedAt: "2026-04-02T11:00:04Z",
          bodyKind: "error",
          bodyText: "Pipeline cancelled by operator",
          errorMessage: "Pipeline cancelled by operator",
        }),
      }))
    );

    expect(summary.executionState).toBe("cancelled");
    expect(summary.terminal).toBe(true);
    expect(summary.phaseCounts.cancelled).toBe(2);
  });

  it("does not let cancelled phases hide terminal failures", () => {
    const pipeline = makeThreePhasePipeline();
    const summary = buildPipelineExecutionSummary(
      pipeline,
      [
        {
          phase: pipeline.phases[0]!,
          lifecycle: "completed",
          structuredResult: buildStructuredTaskResult({
            schemaVersion: 1,
            taskId: pipeline.phases[0]!.taskId,
            taskNamespace: pipeline.phases[0]!.taskNamespace,
            lifecycle: "completed",
            outcome: "completed",
            runtime: "ollama",
            executor: "ollama",
            resultSource: "ollama",
            exitCode: 0,
            startedAt: "2026-04-02T11:00:01Z",
            completedAt: "2026-04-02T11:00:03Z",
            durationSeconds: 2,
            bodyKind: "response",
            bodyText: "GATHER",
          }),
        },
        {
          phase: pipeline.phases[1]!,
          lifecycle: "failed",
          structuredResult: buildStructuredTaskResult({
            schemaVersion: 1,
            taskId: pipeline.phases[1]!.taskId,
            taskNamespace: pipeline.phases[1]!.taskNamespace,
            lifecycle: "failed",
            outcome: "failed",
            runtime: "ollama",
            executor: "dispatcher",
            resultSource: "dependency",
            exitCode: -1,
            completedAt: "2026-04-02T11:00:04Z",
            bodyKind: "error",
            bodyText: "summarize failed",
            errorMessage: "summarize failed",
          }),
        },
        {
          phase: pipeline.phases[2]!,
          lifecycle: "cancelled",
          structuredResult: buildStructuredTaskResult({
            schemaVersion: 1,
            taskId: pipeline.phases[2]!.taskId,
            taskNamespace: pipeline.phases[2]!.taskNamespace,
            lifecycle: "cancelled",
            outcome: "cancelled",
            runtime: "ollama",
            executor: "dispatcher",
            resultSource: "cancellation",
            exitCode: "CANCELLED",
            completedAt: "2026-04-02T11:00:05Z",
            bodyKind: "error",
            bodyText: "review cancelled",
            errorMessage: "review cancelled",
          }),
        },
      ]
    );

    expect(summary.executionState).toBe("completed_with_failures");
    expect(summary.phaseCounts.completed).toBe(1);
    expect(summary.phaseCounts.failed).toBe(1);
    expect(summary.phaseCounts.cancelled).toBe(1);
  });

  it("flags missing and non-terminal summaries for reconciliation", () => {
    expect(pipelineSummaryNeedsReconciliation(null)).toBe(true);

    const pipeline = makePipeline();
    const runningSummary = buildPipelineExecutionSummary(
      pipeline,
      [
        {
          phase: pipeline.phases[0]!,
          lifecycle: "running",
        },
        {
          phase: pipeline.phases[1]!,
          lifecycle: "blocked",
        },
      ],
      "2026-04-02T11:00:02Z"
    );

    expect(pipelineSummaryNeedsReconciliation(runningSummary)).toBe(true);
    expect(
      pipelineSummaryNeedsReconciliation(
        parsePipelineExecutionSummary(JSON.stringify(runningSummary))
      )
    ).toBe(true);

    const completedSummary = buildPipelineExecutionSummary(
      pipeline,
      pipeline.phases.map((phase, index) => ({
        phase,
        lifecycle: "completed" as const,
        structuredResult: buildStructuredTaskResult({
          schemaVersion: 1,
          taskId: phase.taskId,
          taskNamespace: phase.taskNamespace,
          lifecycle: "completed",
          outcome: "completed",
          runtime: "ollama",
          executor: "ollama",
          resultSource: "ollama",
          exitCode: 0,
          startedAt: `2026-04-02T11:00:0${index + 1}Z`,
          completedAt: `2026-04-02T11:00:0${index + 2}Z`,
          durationSeconds: 1,
          bodyKind: "response",
          bodyText: phase.name.toUpperCase(),
        }),
      })),
      "2026-04-02T11:00:03Z"
    );

    expect(
      pipelineSummaryNeedsReconciliation(
        parsePipelineExecutionSummary(JSON.stringify(completedSummary))
      )
    ).toBe(false);
    expect(parsePipelineExecutionSummary("{not-json")).toBeNull();
  });

  it("ignores generatedAt when fingerprinting summaries", () => {
    const pipeline = makePipeline();
    const first = buildPipelineExecutionSummary(
      pipeline,
      [
        {
          phase: pipeline.phases[0]!,
          lifecycle: "running",
        },
        {
          phase: pipeline.phases[1]!,
          lifecycle: "blocked",
        },
      ],
      "2026-04-02T11:00:02Z"
    );
    const second = buildPipelineExecutionSummary(
      pipeline,
      [
        {
          phase: pipeline.phases[0]!,
          lifecycle: "running",
        },
        {
          phase: pipeline.phases[1]!,
          lifecycle: "blocked",
        },
      ],
      "2026-04-02T11:00:22Z"
    );

    expect(getPipelineExecutionSummaryFingerprint(first)).toBe(
      getPipelineExecutionSummaryFingerprint(second)
    );
  });
});
