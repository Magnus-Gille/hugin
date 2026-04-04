import { describe, expect, it } from "vitest";
import { buildStructuredTaskResult } from "../src/task-result-schema.js";

describe("structured task result schema", () => {
  it("accepts completed pipeline phase results", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "20260402-phase-a",
      taskNamespace: "tasks/20260402-phase-a",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "ollama",
      executor: "ollama",
      resultSource: "ollama",
      exitCode: 0,
      startedAt: "2026-04-02T11:00:00Z",
      completedAt: "2026-04-02T11:00:03Z",
      durationSeconds: 3,
      logFile: "~/.hugin/logs/20260402-phase-a.log",
      group: "pipeline:demo",
      sequence: 2,
      bodyKind: "response",
      bodyText: "STEP3_OK",
      pipeline: {
        pipelineId: "20260402-pipeline",
        phase: "summarize",
        dependencyTaskIds: ["20260402-phase-root"],
        dependencyPhases: ["gather"],
        submittedBy: "claude-code",
        sensitivity: "internal",
        authority: "autonomous",
        sideEffects: [],
      },
    });

    expect(result.pipeline?.pipelineId).toBe("20260402-pipeline");
    expect(result.bodyKind).toBe("response");
  });

  it("accepts dispatcher-generated failure results without timings", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "20260402-phase-b",
      taskNamespace: "tasks/20260402-phase-b",
      lifecycle: "failed",
      outcome: "failed",
      runtime: "ollama",
      executor: "dispatcher",
      resultSource: "dependency",
      exitCode: -1,
      completedAt: "2026-04-02T11:00:03Z",
      bodyKind: "error",
      bodyText: "Dependency 20260402-phase-a failed",
      errorMessage: "Dependency 20260402-phase-a failed",
    });

    expect(result.errorMessage).toBe("Dependency 20260402-phase-a failed");
    expect(result.startedAt).toBeUndefined();
  });

  it("trims machine-readable error messages without changing body text", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "20260402-phase-c",
      taskNamespace: "tasks/20260402-phase-c",
      lifecycle: "failed",
      outcome: "timed_out",
      runtime: "ollama",
      executor: "ollama",
      resultSource: "ollama",
      exitCode: "TIMEOUT",
      completedAt: "2026-04-02T11:00:03Z",
      bodyKind: "error",
      bodyText: "\n[Ollama streaming timed out]\n",
      errorMessage: "\n[Ollama streaming timed out]\n",
    });

    expect(result.bodyText).toBe("\n[Ollama streaming timed out]\n");
    expect(result.errorMessage).toBe("[Ollama streaming timed out]");
  });

  it("accepts cancelled task results with cancellation exit codes", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "20260402-phase-d",
      taskNamespace: "tasks/20260402-phase-d",
      lifecycle: "cancelled",
      outcome: "cancelled",
      runtime: "claude",
      executor: "agent-sdk",
      resultSource: "agent-sdk",
      exitCode: "CANCELLED",
      startedAt: "2026-04-02T11:00:00Z",
      completedAt: "2026-04-02T11:00:02Z",
      durationSeconds: 2,
      bodyKind: "response",
      bodyText: "Partial answer",
      errorMessage: "Cancelled by operator",
    });

    expect(result.lifecycle).toBe("cancelled");
    expect(result.outcome).toBe("cancelled");
    expect(result.exitCode).toBe("CANCELLED");
  });

  it("accepts approval metadata for gated phases", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "20260404-deploy",
      taskNamespace: "tasks/20260404-deploy",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "codex",
      executor: "spawn",
      resultSource: "hook",
      exitCode: 0,
      completedAt: "2026-04-04T10:00:02Z",
      bodyKind: "response",
      bodyText: "DEPLOYED",
      pipeline: {
        pipelineId: "20260404-pipeline",
        phase: "deploy",
        dependencyTaskIds: ["20260404-review"],
        dependencyPhases: ["review"],
        authority: "gated",
        sideEffects: ["deploy.service"],
      },
      approval: {
        status: "approved",
        requestedAt: "2026-04-04T09:55:00Z",
        decidedAt: "2026-04-04T09:56:00Z",
        decisionSource: "ratatoskr",
        operationKey: "20260404-pipeline:20260404-deploy",
      },
    });

    expect(result.pipeline?.authority).toBe("gated");
    expect(result.pipeline?.sideEffects).toEqual(["deploy.service"]);
    expect(result.approval?.status).toBe("approved");
  });
});
