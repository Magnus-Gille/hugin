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

  it("accepts opencode harness task results", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "20260708-opencode",
      taskNamespace: "tasks/20260708-opencode",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "opencode",
      executor: "opencode",
      resultSource: "opencode-json",
      exitCode: 0,
      completedAt: "2026-07-08T12:00:00Z",
      bodyKind: "response",
      bodyText: "Fixed math.js and tests pass.",
      runtimeMetadata: {
        requestedModel: "qwen3-coder-next-80b",
        effectiveModel: "m5/qwen3-coder-next-80b",
      },
    });

    expect(result.runtime).toBe("opencode");
    expect(result.runtimeMetadata?.effectiveModel).toBe("m5/qwen3-coder-next-80b");
  });

  it("accepts orchestratorOutcomes (verdict layer V8) with a mix of ok/verdict states", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "20260703-orch",
      taskNamespace: "tasks/20260703-orch",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "orchestrator",
      executor: "orchestrator",
      resultSource: "orchestrator",
      exitCode: 0,
      completedAt: "2026-07-03T10:00:02Z",
      bodyKind: "response",
      bodyText: "Final synthesized answer",
      orchestratorOutcomes: [
        {
          subtaskId: "1",
          taskType: "summarize",
          provider: "openrouter",
          model: "deepseek/deepseek-v4-flash",
          ok: true,
          verdictOk: true,
          costUsd: 0.002,
          latencyMs: 800,
        },
        {
          subtaskId: "2",
          taskType: "other",
          provider: "openrouter",
          model: "deepseek/deepseek-v4-flash",
          ok: false,
          verdictOk: null,
          costUsd: null,
          latencyMs: 50,
        },
      ],
    });

    expect(result.orchestratorOutcomes).toHaveLength(2);
    expect(result.orchestratorOutcomes?.[0].verdictOk).toBe(true);
    expect(result.orchestratorOutcomes?.[1].verdictOk).toBeNull();
    expect(result.orchestratorOutcomes?.[1].costUsd).toBeNull();
  });

  it("omits orchestratorOutcomes for non-orchestrator runtimes (additive/optional)", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "20260703-claude",
      taskNamespace: "tasks/20260703-claude",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "claude",
      executor: "agent-sdk",
      resultSource: "agent-sdk",
      exitCode: 0,
      completedAt: "2026-07-03T10:00:02Z",
      bodyKind: "response",
      bodyText: "answer",
    });

    expect(result.orchestratorOutcomes).toBeUndefined();
  });

  it("orchestratorOutcomes rows accept optional inputTokens/outputTokens (savings tracker S4)", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "20260704-orch-tokens",
      taskNamespace: "tasks/20260704-orch-tokens",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "orchestrator",
      executor: "orchestrator",
      resultSource: "orchestrator",
      exitCode: 0,
      completedAt: "2026-07-04T10:00:02Z",
      bodyKind: "response",
      bodyText: "Final synthesized answer",
      orchestratorOutcomes: [
        {
          subtaskId: "1",
          taskType: "summarize",
          provider: "openrouter",
          model: "deepseek/deepseek-v4-flash",
          ok: true,
          verdictOk: true,
          costUsd: 0.002,
          latencyMs: 800,
          inputTokens: 1000,
          outputTokens: 500,
        },
        {
          subtaskId: "2",
          taskType: "other",
          provider: "openrouter",
          model: "deepseek/deepseek-v4-flash",
          ok: false,
          verdictOk: null,
          costUsd: null,
          latencyMs: 50,
          inputTokens: null,
          outputTokens: null,
        },
      ],
    });

    expect(result.orchestratorOutcomes?.[0].inputTokens).toBe(1000);
    expect(result.orchestratorOutcomes?.[0].outputTokens).toBe(500);
    expect(result.orchestratorOutcomes?.[1].inputTokens).toBeNull();
  });

  it("orchestratorOutcomes rows still accept omitted inputTokens/outputTokens (backward compatible)", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "20260704-orch-no-tokens",
      taskNamespace: "tasks/20260704-orch-no-tokens",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "orchestrator",
      executor: "orchestrator",
      resultSource: "orchestrator",
      exitCode: 0,
      completedAt: "2026-07-04T10:00:02Z",
      bodyKind: "response",
      bodyText: "answer",
      orchestratorOutcomes: [
        {
          subtaskId: "1",
          taskType: "summarize",
          provider: "openrouter",
          model: "deepseek/deepseek-v4-flash",
          ok: true,
          verdictOk: true,
          costUsd: 0.002,
          latencyMs: 800,
        },
      ],
    });

    expect(result.orchestratorOutcomes?.[0].inputTokens).toBeUndefined();
  });
});

describe("structured task result schema — savings (PR3, S4)", () => {
  it("accepts an optional savings object", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "20260704-savings",
      taskNamespace: "tasks/20260704-savings",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "orchestrator",
      executor: "orchestrator",
      resultSource: "orchestrator",
      exitCode: 0,
      completedAt: "2026-07-04T10:00:02Z",
      bodyKind: "response",
      bodyText: "answer",
      savings: {
        baselineModelId: "claude-sonnet-4-6",
        coveredCalls: 3,
        uncoveredCalls: 1,
        actualCostUsd: 0.05,
        baselineCostUsd: 2.5,
        savedUsd: 2.45,
      },
    });

    expect(result.savings?.baselineModelId).toBe("claude-sonnet-4-6");
    expect(result.savings?.savedUsd).toBeCloseTo(2.45, 6);
  });

  it("omits savings when not computed (additive/optional)", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "20260704-no-savings",
      taskNamespace: "tasks/20260704-no-savings",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "claude",
      executor: "agent-sdk",
      resultSource: "agent-sdk",
      exitCode: 0,
      completedAt: "2026-07-04T10:00:02Z",
      bodyKind: "response",
      bodyText: "answer",
    });

    expect(result.savings).toBeUndefined();
  });
});
