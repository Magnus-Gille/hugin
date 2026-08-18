import { describe, expect, it, vi } from "vitest";
import {
  OrganicShadowQueue,
  MICRO_EXPERIMENT_SHADOW_PREP_HEADROOM_MS,
  buildOrganicResult,
  classifyOrganicLearningTaskAdmission,
  classifyOrganicShadowAdmission,
  decideOrganicEligibility,
  decideOrganicRecovery,
  organicOracleDigestForVerifier,
  organicBaselineModelMatchesResult,
  organicBaselineModelMatchesTask,
  organicVerifierDigestMatches,
  reconcileOrganicOrphanPlan,
  shadowWallBudgetForBaselineTimeout,
  enqueueOrganicShadowAfterBaseline,
  microExperimentDigest,
  persistOrganicOrphanInvalidAfterBaseline,
  persistOrganicPlanBeforeDispatch,
  type OrganicMicroExperimentPlan,
} from "../src/organic-micro-experiment.js";

const digest = (char: string) => `sha256:${char.repeat(64)}`;

function plan(): OrganicMicroExperimentPlan {
  const decision = decideOrganicEligibility({
    enabled: true,
    taskId: "task-123",
    taskRef: "ref:hugin-task-123",
    createdAt: "2026-08-18T10:00:00.000Z",
    inputDigest: digest("1"),
    authenticatedSource: true,
    deterministicVerifier: true,
    baselineBindingRef: "ref:baseline-binding",
    baselineBindingDigest: digest("2"),
    challengerBindingRef: "ref:challenger-binding",
    challengerBindingDigest: digest("3"),
    oracleId: "oracle-v1",
    oracleDigest: digest("4"),
  });
  if (!decision.eligible) throw new Error(decision.reason);
  return decision.plan;
}

describe("organic micro-experiment seam", () => {
  it("maps the authenticated gateway echo's bare digest to eligible evidence", () => {
    const bareDigest = "a".repeat(64);
    const admission = classifyOrganicLearningTaskAdmission({
      state: "m5-admitted",
      evidenceAccepted: true,
      gatewayEchoDigest: {
        algorithm: "sha256",
        version: "gateway-echo-jcs-v1",
        digest: bareDigest,
      },
    });
    expect(admission).toEqual({
      learning_task_status: "admitted",
      transport_identity: "authenticated-echo",
      bundle_digest: `sha256:${bareDigest}`,
    });

    const result = buildOrganicResult({
      plan: plan(),
      startedAt: "2026-08-18T10:00:01.000Z",
      finishedAt: "2026-08-18T10:00:02.000Z",
      baseline: { executionStatus: "completed", outputDigest: digest("5"), oracleStatus: "pass", latencyMs: 2 },
      shadow: { executionStatus: "completed", outputDigest: digest("6"), oracleStatus: "pass", latencyMs: 20, admission },
    });
    expect(result.terminal.status).toBe("PASS");
    expect(result.terminal.aggregation_eligibility).toBe("eligible");
  });

  it("is default-off, deterministic, one-shadow, and abstains without a verifier", () => {
    expect(decideOrganicEligibility({
      enabled: false,
      taskId: "task-123",
      taskRef: "ref:hugin-task-123",
      createdAt: "2026-08-18T10:00:00.000Z",
      inputDigest: digest("1"),
      authenticatedSource: true,
      deterministicVerifier: true,
      baselineBindingRef: "ref:baseline-binding",
      baselineBindingDigest: digest("2"),
      challengerBindingRef: "ref:challenger-binding",
      challengerBindingDigest: digest("3"),
      oracleId: "oracle-v1",
      oracleDigest: digest("4"),
    })).toEqual({ eligible: false, reason: "disabled" });
    expect(decideOrganicEligibility({
      enabled: true,
      taskId: "task-123",
      taskRef: "ref:hugin-task-123",
      createdAt: "2026-08-18T10:00:00.000Z",
      inputDigest: digest("1"),
      authenticatedSource: true,
      deterministicVerifier: false,
      baselineBindingRef: "ref:baseline-binding",
      baselineBindingDigest: digest("2"),
      challengerBindingRef: "ref:challenger-binding",
      challengerBindingDigest: digest("3"),
      oracleId: "oracle-v1",
      oracleDigest: digest("4"),
    })).toEqual({ eligible: false, reason: "missing-deterministic-verifier" });
    const first = plan();
    const second = plan();
    expect(first).toEqual(second);
    expect(first.execution.shadow_count).toBe(1);
    expect(first.execution.primary_path).toBe("baseline");
    expect(first.evidence_policy.contains_task_content).toBe(false);
    expect(decideOrganicEligibility({
      enabled: true,
      taskId: "task-123",
      taskRef: "ref:hugin-task-123",
      createdAt: "2026-08-18T10:00:00.000Z",
      inputDigest: digest("1"),
      authenticatedSource: true,
      deterministicVerifier: true,
      recursiveShadow: true,
      baselineBindingRef: "ref:baseline-binding",
      baselineBindingDigest: digest("2"),
      challengerBindingRef: "ref:challenger-binding",
      challengerBindingDigest: digest("3"),
      oracleId: "oracle-v1",
      oracleDigest: digest("4"),
    })).toEqual({ eligible: false, reason: "recursive-shadow" });
  });

  it("freezes a digest-bound plan before baseline and fails open on a stuck persistence write", async () => {
    const p = plan();
    let aborted = false;
    const store = {
      createOnly: vi.fn((_key: string, _content: string, signal?: AbortSignal) =>
        new Promise<"created">((_, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        })),
    };
    const started = Date.now();
    const outcome = await persistOrganicPlanBeforeDispatch(store, p, 10);
    expect(outcome).toEqual({ persisted: false, reason: "timeout" });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(250);
    const { plan_digest, ...planBody } = p;
    expect(plan_digest).toBe(microExperimentDigest(planBody));
  });

  it("rejects a plan that changes more than one field", () => {
    expect(decideOrganicEligibility({
      enabled: true,
      taskId: "task-123",
      taskRef: "ref:hugin-task-123",
      createdAt: "2026-08-18T10:00:00.000Z",
      inputDigest: digest("1"),
      authenticatedSource: true,
      deterministicVerifier: true,
      baselineBindingRef: "ref:baseline-binding",
      baselineBindingDigest: digest("2"),
      challengerBindingRef: "ref:challenger-binding",
      challengerBindingDigest: digest("3"),
      oracleId: "oracle-v1",
      oracleDigest: digest("4"),
      changedFields: ["route.model", "route.reasoning"],
    })).toEqual({ eligible: false, reason: "invalid-binding" });
  });

  it("requires the ten-observation aggregation floor", () => {
    const input = {
      enabled: true,
      taskId: "task-123",
      taskRef: "ref:hugin-task-123",
      createdAt: "2026-08-18T10:00:00.000Z",
      inputDigest: digest("1"),
      authenticatedSource: true,
      deterministicVerifier: true,
      baselineBindingRef: "ref:baseline-binding",
      baselineBindingDigest: digest("2"),
      challengerBindingRef: "ref:challenger-binding",
      challengerBindingDigest: digest("3"),
      oracleId: "oracle-v1",
      oracleDigest: digest("4"),
      minimumObservations: 9,
    };
    expect(decideOrganicEligibility(input)).toEqual({ eligible: false, reason: "invalid-binding" });
  });

  it("preserves the baseline timeout and abstains when headroom would exceed the wall cap", () => {
    expect(MICRO_EXPERIMENT_SHADOW_PREP_HEADROOM_MS).toBe(5_000);
    expect(shadowWallBudgetForBaselineTimeout(115_000)).toBe(120_000);
    expect(shadowWallBudgetForBaselineTimeout(115_001)).toBeNull();
    expect(shadowWallBudgetForBaselineTimeout(120_000)).toBeNull();
  });

  it("binds the configured oracle digest to the actual verifier bytes", () => {
    const first = { type: "numeric", expected: 1 };
    const second = { type: "numeric", expected: 2 };
    const firstDigest = organicOracleDigestForVerifier(first);
    expect(firstDigest).not.toBe(organicOracleDigestForVerifier(second));
    expect(organicVerifierDigestMatches(first, firstDigest)).toBe(true);
    expect(organicVerifierDigestMatches(second, firstDigest)).toBe(false);
    expect(organicVerifierDigestMatches(first, digest("f"))).toBe(false);
  });

  it("requires the owner baseline model to match both the task and effective gateway result", () => {
    expect(organicBaselineModelMatchesTask("baseline-v1", "baseline-v1")).toBe(true);
    expect(organicBaselineModelMatchesTask("baseline-v1", "other-model")).toBe(false);
    expect(organicBaselineModelMatchesTask("baseline-v1", undefined)).toBe(false);
    expect(organicBaselineModelMatchesResult("baseline-v1", "baseline-v1")).toBe(true);
    expect(organicBaselineModelMatchesResult("baseline-v1", "other-model")).toBe(false);
    expect(organicBaselineModelMatchesResult("baseline-v1", null)).toBe(false);
  });

  it("fails closed on malformed or divergent create-only plan results", async () => {
    const p = plan();
    await expect(persistOrganicPlanBeforeDispatch({
      createOnly: async () => "created",
    }, p, 20)).resolves.toEqual({ persisted: true, status: "created" });
    await expect(persistOrganicPlanBeforeDispatch({
      createOnly: async () => "exact-existing",
      read: async () => JSON.stringify(p),
    }, p, 20)).resolves.toEqual({ persisted: true, status: "exact-existing" });
    await expect(persistOrganicPlanBeforeDispatch({
      createOnly: async () => "malformed" as never,
    }, p, 20)).resolves.toEqual({ persisted: false, reason: "write-failed" });
    await expect(persistOrganicPlanBeforeDispatch({
      createOnly: async () => "exact-existing",
      read: async () => "different bytes",
    }, p, 20)).resolves.toEqual({ persisted: false, reason: "write-failed" });
  });

  it("does not await a never-resolving shadow", async () => {
    const queue = new OrganicShadowQueue(1);
    let baselineFinished = false;
    const result = queue.enqueue({
      id: "organic-job-123",
      run: () => new Promise<void>(() => {}),
    });
    baselineFinished = true;
    expect(result).toBe("enqueued");
    expect(baselineFinished).toBe(true);
    expect(queue.enqueue({ id: "organic-job-123", run: async () => undefined })).toBe("duplicate");
    expect(queue.enqueue({ id: "organic-job-456", run: async () => undefined })).toBe("full");
  });

  it("marks unauthenticated loopback evidence diagnostic-only and keeps baseline delivery", () => {
    const p = plan();
    const result = buildOrganicResult({
      plan: p,
      startedAt: "2026-08-18T10:00:01.000Z",
      finishedAt: "2026-08-18T10:00:02.000Z",
      baseline: {
        executionStatus: "completed",
        outputDigest: digest("5"),
        oracleStatus: "pass",
        latencyMs: 2,
      },
      shadow: {
        executionStatus: "completed",
        outputDigest: digest("6"),
        oracleStatus: "pass",
        latencyMs: 20,
        admission: classifyOrganicShadowAdmission({
          learningTaskStatus: "not-evaluated",
          authenticatedEcho: false,
          localLoopback: true,
        }),
      },
    });
    expect(result.terminal.status).toBe("PASS");
    expect(result.terminal.aggregation_eligibility).toBe("diagnostic-only");
    expect(result.terminal.policy_candidate).toBe("not-created");
    expect(result.terminal.primary_delivery).toBe("baseline");
    expect(result.terminal.production_mutation).toBe("none");
    expect(result.evidence_policy.contains_output_content).toBe(false);
  });

  it("rejects incomplete authenticated identity as INVALID", () => {
    const p = plan();
    const result = buildOrganicResult({
      plan: p,
      startedAt: "2026-08-18T10:00:01.000Z",
      finishedAt: "2026-08-18T10:00:02.000Z",
      baseline: {
        executionStatus: "completed",
        outputDigest: digest("5"),
        oracleStatus: "pass",
        latencyMs: 2,
      },
      shadow: {
        executionStatus: "completed",
        outputDigest: digest("6"),
        oracleStatus: "pass",
        latencyMs: 20,
        admission: {
          learning_task_status: "admitted",
          transport_identity: "authenticated-echo",
          bundle_digest: null,
        },
      },
    });
    expect(result.terminal.status).toBe("INVALID");
    expect(result.terminal.aggregation_eligibility).toBe("ineligible");
    expect(classifyOrganicShadowAdmission({
      learningTaskStatus: "admitted",
      authenticatedEcho: true,
      bundleDigest: "not-a-digest",
    })).toEqual({
      learning_task_status: "admitted",
      transport_identity: "authenticated-echo",
      bundle_digest: null,
    });
  });

  it("uses the exact PASS/HOLD/INVALID reason contracts", () => {
    const p = plan();
    const admitted = classifyOrganicShadowAdmission({ learningTaskStatus: "admitted", authenticatedEcho: true, bundleDigest: digest("7") });
    const pass = buildOrganicResult({
      plan: p,
      startedAt: "2026-08-18T10:00:01.000Z",
      finishedAt: "2026-08-18T10:00:02.000Z",
      baseline: { executionStatus: "completed", outputDigest: digest("5"), oracleStatus: "pass", latencyMs: 2 },
      shadow: { executionStatus: "completed", outputDigest: digest("6"), oracleStatus: "pass", latencyMs: 20, admission: admitted },
    });
    expect(pass.terminal.reasons).toEqual(["challenger-oracle-pass", "single-observation-only"]);

    const hold = buildOrganicResult({
      plan: p,
      startedAt: "2026-08-18T10:00:01.000Z",
      finishedAt: "2026-08-18T10:00:02.000Z",
      baseline: { executionStatus: "completed", outputDigest: digest("5"), oracleStatus: "pass", latencyMs: 2 },
      shadow: { executionStatus: "completed", outputDigest: digest("6"), oracleStatus: "fail", latencyMs: 20, admission: admitted },
    });
    expect(hold.terminal.status).toBe("HOLD");
    expect(hold.terminal.reasons).toEqual(["challenger-oracle-fail", "single-observation-only"]);

    const shadowFailure = buildOrganicResult({
      plan: p,
      startedAt: "2026-08-18T10:00:01.000Z",
      finishedAt: "2026-08-18T10:00:02.000Z",
      baseline: { executionStatus: "completed", outputDigest: digest("5"), oracleStatus: "pass", latencyMs: 2 },
      shadow: { executionStatus: "timed-out", outputDigest: digest("6"), oracleStatus: "not-run", latencyMs: 20, admission: admitted },
    });
    expect(shadowFailure.terminal.status).toBe("HOLD");
    expect(shadowFailure.terminal.reasons).toEqual(["shadow-execution-failed", "single-observation-only"]);
    expect(shadowFailure.evidence_policy.evidence_complete).toBe(true);

    const primaryFailure = buildOrganicResult({
      plan: p,
      startedAt: "2026-08-18T10:00:01.000Z",
      finishedAt: "2026-08-18T10:00:02.000Z",
      baseline: { executionStatus: "completed", outputDigest: digest("5"), oracleStatus: "fail", latencyMs: 2 },
      shadow: { executionStatus: "completed", outputDigest: digest("6"), oracleStatus: "pass", latencyMs: 20, admission: admitted },
    });
    expect(primaryFailure.terminal.status).toBe("INVALID");
    expect(primaryFailure.terminal.reasons).toEqual(["primary-oracle-fail"]);
    expect(primaryFailure.terminal.reasons).not.toContain("challenger-oracle-pass");
    expect(primaryFailure.evidence_policy.evidence_complete).toBe(false);

    const incompletePrimary = buildOrganicResult({
      plan: p,
      startedAt: "2026-08-18T10:00:01.000Z",
      finishedAt: "2026-08-18T10:00:02.000Z",
      baseline: { executionStatus: "failed", outputDigest: digest("5"), oracleStatus: "pass", latencyMs: 2 },
      shadow: { executionStatus: "completed", outputDigest: digest("6"), oracleStatus: "pass", latencyMs: 20, admission: admitted },
    });
    expect(incompletePrimary.terminal.status).toBe("INVALID");
    expect(incompletePrimary.terminal.aggregation_eligibility).toBe("ineligible");
    expect(incompletePrimary.terminal.reasons).toEqual(["evidence-incomplete"]);
    expect(incompletePrimary.evidence_policy.evidence_complete).toBe(false);

    const genericIdentity = buildOrganicResult({
      plan: p,
      startedAt: "2026-08-18T10:00:01.000Z",
      finishedAt: "2026-08-18T10:00:02.000Z",
      baseline: { executionStatus: "completed", outputDigest: digest("5"), oracleStatus: "pass", latencyMs: 2 },
      shadow: {
        executionStatus: "completed",
        outputDigest: digest("6"),
        oracleStatus: "pass",
        latencyMs: 20,
        admission: { learning_task_status: "not-evaluated", transport_identity: "not-applicable", bundle_digest: null },
      },
    });
    expect(genericIdentity.terminal.status).toBe("INVALID");
    expect(genericIdentity.terminal.reasons).toEqual(["identity-mismatch"]);
    expect(genericIdentity.terminal.reasons).not.toContain("challenger-oracle-pass");
  });

  it("keeps an oracle failure as HOLD evidence, never a promotion candidate", () => {
    const p = plan();
    const result = buildOrganicResult({
      plan: p,
      startedAt: "2026-08-18T10:00:01.000Z",
      finishedAt: "2026-08-18T10:00:02.000Z",
      baseline: {
        executionStatus: "completed",
        outputDigest: digest("5"),
        oracleStatus: "pass",
        latencyMs: 2,
      },
      shadow: {
        executionStatus: "completed",
        outputDigest: digest("6"),
        oracleStatus: "fail",
        latencyMs: 20,
        admission: classifyOrganicShadowAdmission({
          learningTaskStatus: "admitted",
          authenticatedEcho: true,
          bundleDigest: digest("7"),
        }),
      },
    });
    expect(result.terminal.status).toBe("HOLD");
    expect(result.terminal.aggregation_eligibility).toBe("eligible");
    expect(result.terminal.reasons).toContain("challenger-oracle-fail");
  });

  it("turns a plan digest mismatch into INVALID evidence", () => {
    const p = plan();
    const tampered = { ...p, axis: { ...p.axis, changed_fields: ["route.model", "tool-policy"] } };
    const result = buildOrganicResult({
      plan: tampered,
      startedAt: "2026-08-18T10:00:01.000Z",
      finishedAt: "2026-08-18T10:00:02.000Z",
      baseline: { executionStatus: "completed", outputDigest: digest("5"), oracleStatus: "pass", latencyMs: 2 },
      shadow: {
        executionStatus: "completed",
        outputDigest: digest("6"),
        oracleStatus: "pass",
        latencyMs: 20,
        admission: classifyOrganicShadowAdmission({
          learningTaskStatus: "not-evaluated",
          authenticatedEcho: false,
          localLoopback: true,
        }),
      },
    });
    expect(result.terminal.status).toBe("INVALID");
    expect(result.terminal.aggregation_eligibility).toBe("ineligible");
  });

  it("marks clock, budget, and invalid evidence failures explicitly", () => {
    const p = plan();
    const result = buildOrganicResult({
      plan: p,
      startedAt: "2026-08-18T09:59:59.000Z",
      finishedAt: "2026-08-18T10:00:02.000Z",
      baseline: { executionStatus: "completed", outputDigest: digest("5"), oracleStatus: "pass", latencyMs: 2 },
      shadow: {
        executionStatus: "completed",
        outputDigest: digest("6"),
        oracleStatus: "pass",
        latencyMs: p.execution.max_wall_ms + 1,
        completionTokens: p.execution.max_completion_tokens + 1,
        admission: classifyOrganicShadowAdmission({
          learningTaskStatus: "admitted",
          authenticatedEcho: true,
          bundleDigest: digest("7"),
        }),
      },
    });
    expect(result.terminal.status).toBe("INVALID");
    expect(result.terminal.reasons).toContain("evidence-incomplete");
    expect(result.evidence_policy.evidence_complete).toBe(false);
  });

  it("coordinates plan/baseline/result ordering without awaiting a hanging shadow", async () => {
    const p = plan();
    const events: string[] = [];
    let resolveBaseline!: () => void;
    const baselineCommitted = new Promise<void>((resolve) => { resolveBaseline = resolve; });
    const persistResult = vi.fn(async () => { events.push("result"); });
    let shadowStarted = false;
    const caller = enqueueOrganicShadowAfterBaseline({
      baselineCommitted,
      queue: new OrganicShadowQueue(1),
      plan: p,
      baseline: { executionStatus: "completed", outputDigest: digest("5"), oracleStatus: "pass", latencyMs: 2 },
      startedAt: "2026-08-18T10:00:01.000Z",
      runShadow: async () => {
        shadowStarted = true;
        return await new Promise<never>(() => {});
      },
      persistResult,
    });
    await Promise.resolve();
    expect(shadowStarted).toBe(false);
    resolveBaseline();
    await expect(caller).resolves.toBe("enqueued");
    expect(shadowStarted).toBe(true);
    expect(persistResult).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("writes one orphan INVALID result only after the rerun baseline barrier", async () => {
    const p = plan();
    let releaseBaseline!: () => void;
    const baselineCommitted = new Promise<void>((resolve) => { releaseBaseline = resolve; });
    const persisted: ReturnType<typeof buildOrganicResult>[] = [];
    const orphan = persistOrganicOrphanInvalidAfterBaseline({
      baselineCommitted,
      plan: p,
      startedAt: "2026-08-18T10:00:01.000Z",
      finishedAt: "2026-08-18T10:00:02.000Z",
      baseline: { executionStatus: "completed", outputDigest: digest("5"), oracleStatus: "pass", latencyMs: 2 },
      persistResult: async (result) => { persisted.push(result); },
    });
    await Promise.resolve();
    expect(persisted).toHaveLength(0);
    releaseBaseline();
    await expect(orphan).resolves.toBe("persisted");
    expect(persisted).toHaveLength(1);
    expect(persisted[0].terminal.status).toBe("INVALID");
    expect(persisted[0].plan_digest).toBe(p.plan_digest);
  });

  it("turns a queue error into a terminal invalid result callback", async () => {
    const p = plan();
    const queue = new OrganicShadowQueue(1);
    const errors: unknown[] = [];
    queue.enqueue({
      id: "blocking-job",
      run: async () => { throw new Error("queue runner failed"); },
      onError: (error) => { errors.push(error); },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(p.experiment_id).toMatch(/^organic-/);
  });

  it("persists INVALID evidence for coordinator queue errors and queue-full", async () => {
    const p = plan();
    const baseline = { executionStatus: "completed" as const, outputDigest: digest("5"), oracleStatus: "pass" as const, latencyMs: 2 };
    const queueErrorResults: ReturnType<typeof buildOrganicResult>[] = [];
    const errorOutcome = await enqueueOrganicShadowAfterBaseline({
      baselineCommitted: Promise.resolve(),
      queue: new OrganicShadowQueue(1),
      plan: p,
      baseline,
      startedAt: "2026-08-18T10:00:01.000Z",
      runShadow: async () => { throw new Error("shadow transport failed"); },
      persistResult: async (result) => { queueErrorResults.push(result); },
    });
    expect(errorOutcome).toBe("enqueued");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queueErrorResults[0]?.terminal.status).toBe("INVALID");
    expect(queueErrorResults[0]?.evidence_policy.evidence_complete).toBe(false);

    const fullQueue = new OrganicShadowQueue(1);
    fullQueue.enqueue({ id: "already-running", run: () => new Promise<void>(() => {}) });
    const fullResults: ReturnType<typeof buildOrganicResult>[] = [];
    const fullOutcome = await enqueueOrganicShadowAfterBaseline({
      baselineCommitted: Promise.resolve(),
      queue: fullQueue,
      plan: { ...p, experiment_id: "organic-full-123" },
      baseline,
      startedAt: "2026-08-18T10:00:01.000Z",
      runShadow: async () => ({
        executionStatus: "completed",
        outputDigest: digest("6"),
        oracleStatus: "pass",
        latencyMs: 1,
        admission: classifyOrganicShadowAdmission({ learningTaskStatus: "admitted", authenticatedEcho: true, bundleDigest: digest("7") }),
      }),
      persistResult: async (result) => { fullResults.push(result); },
    });
    expect(fullOutcome).toBe("full");
    expect(fullResults[0]?.terminal.status).toBe("INVALID");
  });

  it("fails closed on restart/orphan and duplicate replay", () => {
    const p = plan();
    expect(decideOrganicRecovery({
      planDigest: p.plan_digest,
      persistedPlanDigest: p.plan_digest,
      resultPresent: false,
      shadowAlreadyStarted: false,
    })).toEqual({ action: "invalidate", reason: "orphaned-plan" });
    expect(decideOrganicRecovery({
      planDigest: p.plan_digest,
      persistedPlanDigest: digest("f"),
      resultPresent: false,
      shadowAlreadyStarted: false,
    })).toEqual({ action: "invalidate", reason: "plan-digest-mismatch" });
    expect(decideOrganicRecovery({
      planDigest: p.plan_digest,
      persistedPlanDigest: p.plan_digest,
      resultPresent: true,
      shadowAlreadyStarted: true,
    })).toEqual({ action: "ignore", reason: "terminal-result-present" });
  });

  it("reconciles only terminal orphan plans into one create-only INVALID result", async () => {
    const p = plan();
    const structured = JSON.stringify({
      schemaVersion: 1,
      taskId: "task-123",
      taskNamespace: "tasks/task-123",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "homeserver",
      executor: "homeserver",
      resultSource: "homeserver",
      exitCode: 0,
      startedAt: "2026-08-18T10:00:01.000Z",
      completedAt: "2026-08-18T10:00:02.000Z",
      bodyKind: "response",
      bodyText: "private response must never be copied",
      runtimeMetadata: { delegation: { outcome: "pass" } },
    });
    const persisted: ReturnType<typeof buildOrganicResult>[] = [];
    const outcome = await reconcileOrganicOrphanPlan({
      taskNamespace: "tasks/task-123",
      baselineTerminal: true,
      store: {
        read: async (key) => key === "micro-experiment-plan"
          ? JSON.stringify(p)
          : key === "result-structured" ? structured : null,
        persistResult: async (result) => { persisted.push(result); return "created"; },
      },
    });
    expect(outcome).toEqual({ status: "invalidated", reason: "orphaned-plan" });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].terminal.status).toBe("INVALID");
    expect(persisted[0].primary.output_digest).toBe(microExperimentDigest("private response must never be copied"));
    expect(JSON.stringify(persisted[0])).not.toContain("private response");

    const running = await reconcileOrganicOrphanPlan({
      taskNamespace: "tasks/task-123",
      baselineTerminal: false,
      store: {
        read: async (key) => key === "micro-experiment-plan" ? JSON.stringify(p) : null,
        persistResult: async () => "created",
      },
    });
    expect(running).toEqual({ status: "abstained-running", reason: "baseline-not-terminal" });

    const activeQueue = new OrganicShadowQueue(1);
    activeQueue.enqueue({ id: p.experiment_id, run: () => new Promise<void>(() => {}) });
    await expect(reconcileOrganicOrphanPlan({
      taskNamespace: "tasks/task-123",
      baselineTerminal: true,
      shadowActive: (candidate) => activeQueue.has(candidate.experiment_id),
      store: {
        read: async (key) => key === "micro-experiment-plan" ? JSON.stringify(p) : null,
        persistResult: async () => "created",
      },
    })).resolves.toEqual({ status: "abstained-running", reason: "shadow-active" });
  });

  it("does not replay or overwrite exact existing, malformed, or incomplete recovery artifacts", async () => {
    const p = plan();
    const structured = JSON.stringify({
      schemaVersion: 1,
      taskId: "task-123",
      taskNamespace: "tasks/task-123",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "homeserver",
      executor: "homeserver",
      resultSource: "homeserver",
      exitCode: 0,
      startedAt: "2026-08-18T10:00:01.000Z",
      completedAt: "2026-08-18T10:00:02.000Z",
      bodyKind: "response",
      bodyText: "response",
      runtimeMetadata: { delegation: { outcome: "pass" } },
    });
    const existing = buildOrganicResult({
      plan: p,
      startedAt: "2026-08-18T10:00:01.000Z",
      finishedAt: "2026-08-18T10:00:02.000Z",
      baseline: { executionStatus: "completed", outputDigest: digest("5"), oracleStatus: "pass", latencyMs: 1 },
      shadow: {
        executionStatus: "failed", outputDigest: digest("6"), oracleStatus: "not-run", latencyMs: 1,
        admission: { learning_task_status: "rejected", transport_identity: "not-applicable", bundle_digest: null },
      },
    });
    const noWrite = vi.fn(async () => "created" as const);
    await expect(reconcileOrganicOrphanPlan({
      taskNamespace: "tasks/task-123",
      baselineTerminal: true,
      store: {
        read: async (key) => key === "micro-experiment-plan" ? JSON.stringify(p)
          : key === "micro-experiment-result" ? JSON.stringify(existing)
          : structured,
        persistResult: noWrite,
      },
    })).resolves.toEqual({ status: "already-has-result", reason: "terminal-result-present" });
    expect(noWrite).not.toHaveBeenCalled();

    await expect(reconcileOrganicOrphanPlan({
      taskNamespace: "tasks/task-123",
      baselineTerminal: true,
      store: { read: async (key) => key === "micro-experiment-plan" ? "{}" : null, persistResult: noWrite },
    })).resolves.toEqual({ status: "failed", reason: "malformed-plan" });
    await expect(reconcileOrganicOrphanPlan({
      taskNamespace: "tasks/task-123",
      baselineTerminal: true,
      store: {
        read: async (key) => key === "micro-experiment-plan" ? JSON.stringify(p)
          : key === "micro-experiment-result" ? "not-json" : structured,
        persistResult: noWrite,
      },
    })).resolves.toEqual({ status: "failed", reason: "malformed-result" });
    await expect(reconcileOrganicOrphanPlan({
      taskNamespace: "tasks/other-task",
      baselineTerminal: true,
      store: { read: async (key) => key === "micro-experiment-plan" ? JSON.stringify(p) : null, persistResult: noWrite },
    })).resolves.toEqual({ status: "failed", reason: "missing-durable-baseline" });
  });
});
