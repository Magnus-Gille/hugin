import { describe, expect, it } from "vitest";
import {
  m5CodeLoopTelemetrySchema,
  observationFromM5CodeLoop,
} from "../src/learning/m5-code-loop-adapter.js";

const context = {
  experimentId: "gate-d-edit-deadline",
  runId: "01-champion",
  sampleId: "01",
  arm: "champion" as const,
  holdout: false,
  configurationFingerprint: "a".repeat(64),
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    status: "completed",
    diff: "diff --git a/a.ts b/a.ts",
    diff_truncated: false,
    changed_files: ["a.ts"],
    protected_violations: [],
    summary: "done",
    check: { ran: true, exit_code: 0, output_tail: "ok" },
    usage: {
      turns: 4,
      wall_ms: 10_000,
      prompt_tokens: 100,
      completion_tokens: 50,
    },
    work_id: "cl-20260713-abcdef12",
    detail: "",
    ...overrides,
  };
}

describe("M5 code-loop experiment adapter", () => {
  it("maps protected-check success and phase telemetry without copying content", () => {
    const observation = observationFromM5CodeLoop(result({
      telemetry: {
        schema_version: 1,
        first_edit_turn: 2,
        edit_start_ms: 3_000,
        phase_ms: { inspect: 3_000, edit: 7_000, check: 500 },
        mutation_evidence: "tool-call",
        observability_coverage: 1,
      },
    }), context);

    expect(observation).toMatchObject({
      quality_outcome: "pass",
      product_outcome: "unrated",
      verifier: { kind: "mechanical", independent: true },
      latency_ms: 10_500,
      edit_start_ms: 3_000,
      edited: true,
      tests_run: true,
      tests_passed: true,
      work_id: "cl-20260713-abcdef12",
      phase_ms: { inspect: 3_000, edit: 7_000, check: 500 },
    });
    expect(JSON.stringify(observation)).not.toContain("diff --git");
    expect(JSON.stringify(observation)).not.toContain("done");
  });

  it("keeps old gateway results honest by leaving edit timing unmeasured", () => {
    const observation = observationFromM5CodeLoop(result(), context);
    expect(observation.edited).toBe(true);
    expect(observation.edit_start_ms).toBeUndefined();
    expect(observation.phase_ms).toBeUndefined();
    expect(observation.observability_coverage).toBe(0);
  });

  it("does not fabricate edit time for diff-only mutation evidence", () => {
    const parsed = m5CodeLoopTelemetrySchema.safeParse({
      schema_version: 1,
      first_edit_turn: 2,
      edit_start_ms: 3_000,
      phase_ms: { inspect: 3_000 },
      mutation_evidence: "diff-only",
      observability_coverage: 0.5,
    });
    expect(parsed.success).toBe(false);
  });

  it("classifies serving failures as infra and deadline caps as quality failures", () => {
    expect(observationFromM5CodeLoop(result({
      status: "arm-error",
      changed_files: [],
      check: { ran: false, exit_code: null, output_tail: "" },
    }), context)).toMatchObject({
      quality_outcome: "infra-error",
      failure_kind: "arm-error",
      edited: false,
    });
    expect(observationFromM5CodeLoop(result({
      status: "cap-exceeded",
      changed_files: [],
      check: { ran: false, exit_code: null, output_tail: "" },
      telemetry: {
        schema_version: 1,
        phase_ms: { inspect: 8_000 },
        mutation_evidence: "none",
        observability_coverage: 1,
        failure_kind: "edit-deadline",
      },
    }), context)).toMatchObject({
      quality_outcome: "fail",
      failure_kind: "edit-deadline",
    });
  });

  it("disqualifies a protected-file violation even when check reports success", () => {
    const observation = observationFromM5CodeLoop(result({
      protected_violations: ["test/oracle.ts"],
    }), context);
    expect(observation.quality_outcome).toBe("fail");
    expect(observation.verifier).toEqual({ kind: "none", independent: false });
    expect(observation.failure_kind).toBe("protected-file-modified");
  });

  it("binds the recorded fingerprint to M5's effective model and caps", () => {
    const execution = {
      schema_version: 1 as const,
      model: "qwen3-coder-next-80b",
      engine: "pi",
      harness_version: "1",
      effective_caps: { wall_s: 600, turns: 13, completion_tokens: 60_000 },
    };
    expect(() => observationFromM5CodeLoop(result({ execution }), {
      ...context,
      expectedExecution: {
        model: "another-model",
        harnessVersion: execution.harness_version,
        caps: execution.effective_caps,
      },
    })).toThrow(/effective model/);
    expect(observationFromM5CodeLoop(result({ execution }), {
      ...context,
      expectedExecution: {
        model: execution.model,
        harnessVersion: execution.harness_version,
        caps: execution.effective_caps,
      },
    }).configuration_fingerprint).toBe("a".repeat(64));
  });

  it("binds v4 capability evidence and refuses a prose-only result", () => {
    const caps = { wall_s: 600, turns: 13, completion_tokens: 60_000 };
    const execution = {
      schema_version: 1 as const,
      model: "qwen3-coder-next-80b",
      engine: "pi",
      harness_version: "code-loop-pi-2026-07-14-v4",
      effective_caps: caps,
      capabilities: {
        start_idempotency: "client-run-id-v1",
        agent_checks: "pi-bash-events-v1",
      },
    };
    const expectedExecution = {
      model: execution.model,
      harnessVersion: execution.harness_version,
      caps,
      capabilities: {
        startIdempotency: "client-run-id-v1" as const,
        agentChecks: "pi-bash-events-v1" as const,
      },
    };
    expect(() => observationFromM5CodeLoop(result({ execution }), {
      ...context,
      expectedExecution,
    })).toThrow(/agent-side check evidence/);
    expect(observationFromM5CodeLoop(result({
      execution,
      agent_checks: {
        schema_version: 1,
        source: "pi-bash-events",
        state: "none",
        work_id: "cl-20260713-abcdef12",
        attempts: [],
      },
    }), {
      ...context,
      expectedExecution,
    }).configuration_fingerprint).toBe("a".repeat(64));
  });

  it("uses an external protected verifier without trusting an M5 self-check", () => {
    const observation = observationFromM5CodeLoop(result({
      status: "cap-exceeded",
      check: { ran: false, exit_code: null, output_tail: "" },
    }), {
      ...context,
      externalVerification: {
        ran: true,
        passed: true,
        testsRan: true,
        id: "gate-d-check",
        version: "sha256:abc",
        durationMs: 800,
      },
    });
    expect(observation).toMatchObject({
      quality_outcome: "pass",
      verifier: { id: "gate-d-check", version: "sha256:abc" },
      latency_ms: 10_800,
      tests_run: true,
      tests_passed: true,
      phase_ms: { check: 800 },
    });
  });
});
