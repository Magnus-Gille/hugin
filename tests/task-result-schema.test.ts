import { describe, expect, it } from "vitest";
import { buildStructuredTaskResult } from "../src/task-result-schema.js";

describe("structured task result schema", () => {
  it("preserves exact content-blind repository change evidence", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1, taskId: "daily-1", taskNamespace: "tasks/daily-1",
      lifecycle: "completed", outcome: "completed", runtime: "claude",
      executor: "claude-sdk", resultSource: "sdk-result", exitCode: 0,
      completedAt: "2026-07-14T12:00:00Z", bodyKind: "response", bodyText: "ok",
      repositoryChange: {
        baseBranch: "master",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        changedFiles: ["src/parser.ts", "tests/parser.test.ts"],
        diffSha256: "c".repeat(64),
      },
      repositoryOutcome: {
        state: "changes-present",
        baseBranch: "master",
        baseCommit: "a".repeat(40),
      },
    });
    expect(result.repositoryChange?.changedFiles).toEqual([
      "src/parser.ts",
      "tests/parser.test.ts",
    ]);
    expect(result.repositoryChange?.baseBranch).toBe("master");
    expect(result.repositoryOutcome?.state).toBe("changes-present");
  });

  it("makes a managed-repository no-op explicit without inventing change evidence", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "noop",
      taskNamespace: "tasks/noop",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "codex",
      executor: "codex-spawn",
      resultSource: "stdout",
      exitCode: 0,
      completedAt: "2026-07-15T12:00:00Z",
      bodyKind: "response",
      bodyText: "No changes needed.",
      repositoryOutcome: {
        state: "no-changes",
        baseBranch: "master",
        baseCommit: "a".repeat(40),
      },
    });

    expect(result.repositoryOutcome).toEqual({
      state: "no-changes",
      baseBranch: "master",
      baseCommit: "a".repeat(40),
    });
    expect(result.repositoryChange).toBeUndefined();
  });

  it("preserves M5 delegation provenance on canonical homeserver results", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1, taskId: "mcp-m5-abc", taskNamespace: "tasks/mcp-m5-abc",
      lifecycle: "completed", outcome: "completed", runtime: "homeserver",
      executor: "homeserver-delegate", resultSource: "homeserver-delegate", exitCode: 0,
      completedAt: "2026-07-11T12:00:00Z", bodyKind: "response", bodyText: "ok",
      runtimeMetadata: {
        effectiveHost: "m5", effectiveModel: "mellum",
        delegation: {
          taskType: "extract", modelId: "mellum", nodeId: "m5", outcome: "pass", score: 1,
          decisionReason: "ledger route", ledgerId: "ledger-1", verifierNotes: "exact",
          delegated: true, escalated: false,
        },
      },
    });
    expect(result.runtimeMetadata?.delegation?.ledgerId).toBe("ledger-1");
  });

  // Issue #163: the orchestrator fan-out path delegated to M5 too, but dropped
  // every M5 provenance field before the durable result — so an operator could
  // not tell which node/model/verifier produced a fanout leaf, nor join it back
  // to the authoritative M5 ledger row.
  it("preserves M5 delegation provenance on orchestrator fanout outcomes", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1, taskId: "orch-1", taskNamespace: "tasks/orch-1",
      lifecycle: "completed", outcome: "completed", runtime: "orchestrator",
      executor: "orchestrator", resultSource: "orchestrator", exitCode: 0,
      completedAt: "2026-07-11T12:00:00Z", bodyKind: "response", bodyText: "ok",
      orchestratorOutcomes: [
        {
          subtaskId: "s1", taskType: "extract", provider: "homeserver",
          model: "qwen3-30b-instruct", ok: true, verdictOk: null,
          costUsd: 0, latencyMs: 1200,
          delegation: {
            ledgerId: "487bae49-e751-4fc8-a10c-8f12f6aa59a4",
            nodeId: "orin", modelId: "qwen2.5-coder:3b", taskType: "extract",
            outcome: "unverified", decisionReason: "viable (10/10 pass)",
            verifier: "answerIs", delegated: true, escalated: false,
            policyMode: "shadow", policyAction: "shadow",
            priceCatalogVersion: "2026-07-08",
            costTraceId: "fc5e98f9-2d7c-4792-b2c3-c936d29d44fb",
          },
        },
      ],
    });
    const d = result.orchestratorOutcomes?.[0]?.delegation;
    expect(d?.ledgerId).toBe("487bae49-e751-4fc8-a10c-8f12f6aa59a4");
    expect(d?.nodeId).toBe("orin");
    expect(d?.modelId).toBe("qwen2.5-coder:3b");
    expect(d?.verifier).toBe("answerIs");
    expect(d?.policyMode).toBe("shadow");
    expect(d?.priceCatalogVersion).toBe("2026-07-08");
  });

  it("keeps the delegation block optional so non-M5 workers still validate", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1, taskId: "orch-2", taskNamespace: "tasks/orch-2",
      lifecycle: "completed", outcome: "completed", runtime: "orchestrator",
      executor: "orchestrator", resultSource: "orchestrator", exitCode: 0,
      completedAt: "2026-07-11T12:00:00Z", bodyKind: "response", bodyText: "ok",
      orchestratorOutcomes: [
        {
          subtaskId: "s1", taskType: "summarize", provider: "openrouter",
          model: "deepseek-v4-flash", ok: true, verdictOk: true,
          costUsd: 0.0001, latencyMs: 900,
        },
      ],
    });
    expect(result.orchestratorOutcomes?.[0]?.delegation).toBeUndefined();
  });

  it("accepts the widened M5 provenance fields on runtimeMetadata.delegation", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1, taskId: "mcp-m5-def", taskNamespace: "tasks/mcp-m5-def",
      lifecycle: "completed", outcome: "completed", runtime: "homeserver",
      executor: "homeserver-delegate", resultSource: "homeserver-delegate", exitCode: 0,
      completedAt: "2026-07-11T12:00:00Z", bodyKind: "response", bodyText: "ok",
      runtimeMetadata: {
        delegation: {
          ledgerId: "ledger-2", verifier: "answerIs", policyMode: "shadow",
          policyAction: "shadow", policyReason: "no verifier-backed lane",
          priceCatalogVersion: "2026-07-08", costTraceId: "ct-1", formatRetried: false,
        },
      },
    });
    expect(result.runtimeMetadata?.delegation?.policyMode).toBe("shadow");
    expect(result.runtimeMetadata?.delegation?.priceCatalogVersion).toBe("2026-07-08");
    expect(result.runtimeMetadata?.delegation?.costTraceId).toBe("ct-1");
  });
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

  it("orchestratorOutcomes rows accept an optional per-worker error (issue #157)", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "20260709-orch-busy",
      taskNamespace: "tasks/20260709-orch-busy",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "orchestrator",
      executor: "orchestrator",
      resultSource: "orchestrator",
      exitCode: 0,
      completedAt: "2026-07-09T10:00:02Z",
      bodyKind: "response",
      bodyText: "answer",
      orchestratorOutcomes: [
        {
          subtaskId: "1",
          taskType: "summarize",
          provider: "homeserver",
          model: "qwen3-coder-next-80b",
          ok: false,
          verdictOk: null,
          costUsd: null,
          latencyMs: 40,
          error: "HTTP 503 server_busy retryAfterS=5 — gave up after 6 attempts",
        },
        {
          subtaskId: "2",
          taskType: "summarize",
          provider: "homeserver",
          model: "qwen3-coder-next-80b",
          ok: true,
          verdictOk: null,
          costUsd: 0,
          latencyMs: 86_705,
        },
      ],
    });

    expect(result.orchestratorOutcomes?.[0].error).toContain("HTTP 503 server_busy");
    expect(result.orchestratorOutcomes?.[1].error).toBeUndefined();
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

describe("structured task result schema — submission provenance (#146)", () => {
  it("accepts honest unverifiable provenance on pipeline parents", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "20260710-pipeline",
      taskNamespace: "tasks/20260710-pipeline",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "pipeline",
      executor: "dispatcher",
      resultSource: "pipeline-decomposition",
      exitCode: 0,
      completedAt: "2026-07-10T10:00:00Z",
      bodyKind: "response",
      bodyText: "compiled",
      provenance: {
        claimedSubmitter: "codex-cli",
        verifiedSubmitter: null,
        policy: "warn",
        signatureStatus: "unverifiable",
        keyId: "codex-cli",
      },
    });

    expect(result.runtime).toBe("pipeline");
    expect(result.provenance?.verifiedSubmitter).toBeNull();
  });

  it("keeps provenance optional so historical schemaVersion=1 results still parse", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "historical",
      taskNamespace: "tasks/historical",
      lifecycle: "failed",
      outcome: "failed",
      runtime: "claude",
      executor: "dispatcher",
      resultSource: "dispatcher",
      exitCode: 1,
      completedAt: "2026-07-10T10:00:00Z",
      bodyKind: "error",
      bodyText: "old result",
    });
    expect(result.provenance).toBeUndefined();
  });
});
