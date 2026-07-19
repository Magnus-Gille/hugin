import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  LEARNING_TASK_CAPABILITIES,
  buildLearningTaskRequestStamp,
  createPreparedLearningTaskDispatch,
  createLearningTaskAttemptStart,
  durableLearningTaskAttemptStart,
  fetchLearningTaskPreflight,
  jcsCanonicalize,
  prepareDurableLearningTaskAttempt,
  recoverPreparedLearningTaskDispatch,
  learningTaskOutcomePersistenceFailure,
  learningTaskExecutionEvidenceSchema,
  validateLearningTaskGatewayEcho,
  validatePreparedLearningTaskAttemptStart,
  validatePreparedLearningTaskOutcome,
  type LearningTaskRequestContext,
} from "../src/learning-task-handshake.js";
import {
  buildHomeserverRequestBody,
  buildFreshHomeserverDelegateRequestBody,
  executeHomeserverTask,
  renderHomeserverUserMessage,
  type HomeserverTaskConfig,
} from "../src/homeserver-executor.js";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const acceptedAt = "2026-07-19T10:00:00.000Z";
const startedAt = "2026-07-19T10:00:01.000Z";
const advertisedAt = "2026-07-19T10:00:02.000Z";
const serializerFixture = JSON.parse(readFileSync(
  new URL("./fixtures/hugin-learning-task-serializer-v1.json", import.meta.url),
  "utf8",
)) as {
  fixture_status: string;
  contract_source: string;
  producer_source: string;
  consumer_target: string;
  raw_logical_task: string;
  observed_hugin_instruction: string;
  task_id: string;
  task_type: string;
  expected_raw_fingerprint: string;
  expected_contract: typeof LEARNING_TASK_CAPABILITIES;
  origin_config: Record<string, [string, string]>;
  stamp: unknown;
};

function context(): LearningTaskRequestContext {
  const task = {
    prompt: "  Summarize the fixture incident report.\n",
    gatewayBaseUrl: "https://m5.test",
    apiKey: "private-owner-key",
    path: "delegate",
    taskType: "summarize",
    timeoutMs: 30_000,
    maxOutputChars: 4_096,
  } satisfies HomeserverTaskConfig;
  const renderedPrompt = renderHomeserverUserMessage(task);
  const attempt = createLearningTaskAttemptStart({
    taskId: "task-001",
    attemptId: "hugin-attempt:11111111-1111-4111-8111-111111111111",
    startedAt,
    rawTaskText: task.prompt,
    renderedPrompt,
  });
  return {
    attempt,
    attemptStartRef: {
      namespace: "tasks/task-001",
      key: "learning-attempt-11111111-1111-4111-8111-111111111111",
    },
    expectedTransportPrincipalId: "service:hugin",
    idempotencyKey: "opaque:e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
    requestId: "opaque:e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2",
    source: {
      component: "hugin",
      system: "broker",
      id: "broker-001",
      created_at: "2026-07-19T09:59:00.000Z",
      accepted_at: acceptedAt,
      principal: {
        id: "principal:owner",
        authentication: "gateway-owner-auth",
        scope: "owner",
      },
      content_owner: {
        id: "principal:owner",
        authority: "authenticated-owner",
      },
    },
    preflight: {
      request: {
        request_id: "opaque:f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1",
        endpoint: "/v1/capabilities/learning-task",
        protocol_version: "learning-task-preflight/v1",
        requested_at: "2026-07-19T10:00:01.500Z",
        requested_capabilities: structuredClone(LEARNING_TASK_CAPABILITIES),
      },
      response: {
        advertisement_id: "opaque:f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2",
        endpoint: "/v1/capabilities/learning-task",
        protocol_version: "learning-task-preflight/v1",
        advertised_at: advertisedAt,
        expires_at: "2026-07-19T10:15:02.000Z",
        authenticated_principal_id: "service:gille-inference",
        authentication: "service-auth",
        capabilities: structuredClone(LEARNING_TASK_CAPABILITIES),
      },
    },
    stampedAt: "2026-07-19T10:00:02.250Z",
  };
}

function readyLearningTask(task: HomeserverTaskConfig, ctx: LearningTaskRequestContext) {
  const requestBody = buildFreshHomeserverDelegateRequestBody(task, ctx.attempt.taskId, ctx);
  return {
    kind: "ready" as const,
    context: ctx,
    ...createPreparedLearningTaskDispatch({
      context: ctx,
      requestStamp: requestBody.learningTaskStamp!,
      requestBody,
    }),
  };
}

function taskConfigForFixture(): HomeserverTaskConfig {
  return {
    prompt: "  Summarize the fixture incident report.\n",
    gatewayBaseUrl: "https://m5.test",
    apiKey: "private-owner-key",
    path: "delegate",
    taskType: "summarize",
    timeoutMs: 30_000,
    maxOutputChars: 4_096,
  };
}

function gatewayEchoFor(stamp: ReturnType<typeof buildLearningTaskRequestStamp>) {
  const authenticatedPrincipalId = stamp.expected_transport_principal_id;
  return {
    echoed_request: structuredClone(stamp),
    gateway_request_id: "opaque:e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3",
    admission_id: "opaque:e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4",
    admitted_at: new Date(Date.parse(stamp.stamped_at) + 1).toISOString(),
    authenticated_principal_id: authenticatedPrincipalId,
    authentication: "gateway-owner-auth" as const,
    principal_binding_digest: {
      algorithm: "sha256" as const,
      version: "gateway-principal-request-binding-jcs-v1" as const,
      digest: createHash("sha256").update(jcsCanonicalize({
        authenticated_principal_id: authenticatedPrincipalId,
        request_stamp: stamp,
      }), "utf8").digest("hex"),
    },
    capabilities: structuredClone(stamp.contract_request),
  };
}

describe("LearningTaskContract v1 producer handshake", () => {
  it("makes the attempt durable before either authenticated M5 read", async () => {
    const events: string[] = [];
    const uuids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ];
    const clock = [
      new Date("2026-07-19T10:00:01.500Z"),
      new Date("2026-07-19T10:00:02.250Z"),
      new Date("2026-07-19T10:00:02.250Z"),
    ];
    const fetchImpl = vi.fn(async (url: string) => {
      events.push(url.endsWith("/portal/me") ? "principal" : "preflight");
      if (url.endsWith("/portal/me")) {
        return response({ alias: "service:hugin", tier: "owner" });
      }
      return response({
        advertisement_id: "opaque:55555555-5555-4555-8555-555555555555",
        endpoint: "/v1/capabilities/learning-task",
        protocol_version: "learning-task-preflight/v1",
        advertised_at: advertisedAt,
        expires_at: "2026-07-19T10:15:02.000Z",
        authenticated_principal_id: "service:gille-inference",
        authentication: "service-auth",
        capabilities: structuredClone(LEARNING_TASK_CAPABILITIES),
      });
    });

    const result = await prepareDurableLearningTaskAttempt({
      taskId: "task-001",
      startedAt,
      rawTaskText: "raw task bytes",
      renderedPrompt: "## Task\nraw task bytes",
      gatewayBaseUrl: "https://m5.test",
      apiKey: "private-owner-key",
      buildSource: () => structuredClone(context().source),
      persistStart: async (ref, record) => {
        events.push("persist");
        expect(ref.key).toBe("learning-attempt-11111111-1111-4111-8111-111111111111");
        expect(JSON.stringify(record)).not.toContain("raw task bytes");
      },
      buildPreparedDispatch: (ctx) => {
        const task = {
          prompt: "raw task bytes",
          gatewayBaseUrl: "https://m5.test",
          apiKey: "private-owner-key",
          path: "delegate" as const,
          taskType: "summarize",
          timeoutMs: 30_000,
          maxOutputChars: 4_096,
        };
        const requestBody = buildFreshHomeserverDelegateRequestBody(task, "task-001", ctx);
        return createPreparedLearningTaskDispatch({
          context: ctx,
          requestStamp: requestBody.learningTaskStamp!,
          requestBody,
        });
      },
      persistReplayPayload: async () => { events.push("replay"); },
      persistPrepared: async (_ref, record) => {
        events.push("prepared");
        expect(JSON.stringify(record)).not.toContain("raw task bytes");
      },
      now: () => clock.shift()!,
      randomUuid: () => uuids.shift()!,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(events).toEqual(["persist", "principal", "preflight", "replay", "prepared"]);
    expect(result.startPersisted).toBe(true);
    expect(result.preparation.kind).toBe("ready");
    expect(result.preparation.kind === "ready" && result.preparation.context.stampedAt)
      .toBe("2026-07-19T10:00:02.250Z");
  });

  it("keeps the prepared request byte-identical when execution starts later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-19T10:00:02.500Z"));
    const logDir = mkdtempSync(join(tmpdir(), "hugin-learning-stamp-"));
    try {
      const task = {
        prompt: "raw task bytes",
        gatewayBaseUrl: "https://m5.test",
        apiKey: "private-owner-key",
        path: "delegate" as const,
        taskType: "summarize",
        timeoutMs: 30_000,
        maxOutputChars: 4_096,
      };
      const uuids = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
      ];
      const clock = [
        new Date("2026-07-19T10:00:01.500Z"),
        new Date("2026-07-19T10:00:02.250Z"),
        new Date("2026-07-19T10:00:02.500Z"),
      ];
      const preflightFetch = vi.fn(async (url: string) => {
        if (url.endsWith("/portal/me")) {
          return response({ alias: "service:hugin", tier: "owner" });
        }
        return response({
          advertisement_id: "opaque:55555555-5555-4555-8555-555555555555",
          endpoint: "/v1/capabilities/learning-task",
          protocol_version: "learning-task-preflight/v1",
          advertised_at: advertisedAt,
          expires_at: "2026-07-19T10:15:02.000Z",
          authenticated_principal_id: "service:gille-inference",
          authentication: "service-auth",
          capabilities: structuredClone(LEARNING_TASK_CAPABILITIES),
        });
      });

      const prepared = await prepareDurableLearningTaskAttempt({
        taskId: "task-001",
        startedAt,
        rawTaskText: task.prompt,
        renderedPrompt: renderHomeserverUserMessage(task),
        gatewayBaseUrl: task.gatewayBaseUrl,
        apiKey: task.apiKey,
        buildSource: () => structuredClone(context().source),
        persistStart: async () => {},
        buildPreparedDispatch: (requestContext) => {
          const requestBody = buildFreshHomeserverDelegateRequestBody(
            task,
            "task-001",
            requestContext,
          );
          return createPreparedLearningTaskDispatch({
            context: requestContext,
            requestStamp: requestBody.learningTaskStamp!,
            requestBody,
          });
        },
        persistReplayPayload: async () => {},
        persistPrepared: async () => {},
        now: () => clock.shift()!,
        randomUuid: () => uuids.shift()!,
        fetchImpl: preflightFetch as typeof fetch,
      });
      expect(prepared.preparation.kind).toBe("ready");
      if (prepared.preparation.kind !== "ready") throw new Error("preparation failed");

      const expectedBody = prepared.preparation.replayPayload.requestBody;
      const echo = gatewayEchoFor(prepared.preparation.preparedDispatch.requestStamp);
      vi.setSystemTime(new Date("2026-07-19T10:00:05.000Z"));
      const delegateFetch = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
        async (_url, init) => {
          expect((init as RequestInit).body).toBe(JSON.stringify(expectedBody));
          return response({
            outcome: "pass",
            output: "ok",
            learningTaskGatewayEcho: echo,
          });
        },
      );

      const result = await executeHomeserverTask({
        ...task,
        learningTask: prepared.preparation,
      }, "task-001", logDir);

      expect(delegateFetch).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        exitCode: 0,
        resultText: "ok",
        learningTask: { state: "m5-admitted", evidenceAccepted: true },
      });
    } finally {
      rmSync(logDir, { recursive: true, force: true });
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("fails closed without touching M5 when durable start persistence fails", async () => {
    const fetchImpl = vi.fn();
    const result = await prepareDurableLearningTaskAttempt({
      taskId: "task-001",
      startedAt,
      rawTaskText: "raw task bytes",
      renderedPrompt: "## Task\nraw task bytes",
      gatewayBaseUrl: "https://m5.test",
      apiKey: "private-owner-key",
      buildSource: () => structuredClone(context().source),
      persistStart: async () => { throw new Error("Munin unavailable"); },
      buildPreparedDispatch: () => { throw new Error("must not build"); },
      persistReplayPayload: async () => { throw new Error("must not persist"); },
      persistPrepared: async () => { throw new Error("must not persist"); },
      randomUuid: () => "11111111-1111-4111-8111-111111111111",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.startPersisted).toBe(false);
    expect(result.preparation).toMatchObject({
      kind: "preflight-failed",
      attemptStartRef: undefined,
      failureReason: "Munin unavailable",
    });
  });

  it("runs the shared cross-repository fixture through the real /delegate serializer", () => {
    expect(serializerFixture.fixture_status).toBe("real-hugin-serializer");
    expect(serializerFixture.contract_source).toContain("grimnir@032acc9");
    expect(serializerFixture.producer_source).toContain("hugin#240");
    expect(serializerFixture.consumer_target).toContain("gille-inference#2");
    const ctx = context();
    const task: HomeserverTaskConfig = {
      prompt: serializerFixture.raw_logical_task,
      gatewayBaseUrl: "https://m5.test",
      apiKey: "private-owner-key",
      path: "delegate",
      taskType: serializerFixture.task_type,
      timeoutMs: 30_000,
      maxOutputChars: 4_096,
      learningTask: readyLearningTask({
        prompt: serializerFixture.raw_logical_task,
        gatewayBaseUrl: "https://m5.test",
        apiKey: "private-owner-key",
        path: "delegate",
        taskType: serializerFixture.task_type,
        timeoutMs: 30_000,
        maxOutputChars: 4_096,
      }, ctx),
    };
    const body = buildHomeserverRequestBody(task, serializerFixture.task_id);
    expect(body.prompt).toBe(serializerFixture.observed_hugin_instruction);
    expect(body.learningTaskStamp).toEqual(serializerFixture.stamp);
    expect(body.learningTaskStamp?.contract_request).toEqual(serializerFixture.expected_contract);
    expect(body.learningTaskStamp?.raw_fingerprint.digest)
      .toBe(serializerFixture.expected_raw_fingerprint);
    expect([
      body.learningTaskStamp?.origin_config.prompt.id,
      body.learningTaskStamp?.origin_config.prompt.version,
    ]).toEqual(serializerFixture.origin_config.prompt);
    expect([
      body.learningTaskStamp?.origin_config.harness.id,
      body.learningTaskStamp?.origin_config.harness.version,
    ]).toEqual(serializerFixture.origin_config.harness);
    expect([
      body.learningTaskStamp?.origin_config.tool_policy.id,
      body.learningTaskStamp?.origin_config.tool_policy.version,
    ]).toEqual(serializerFixture.origin_config.tool_policy);
  });

  it("persists a distinct raw identity before rendering and stamps only after attempt start", () => {
    const ctx = context();
    const task: HomeserverTaskConfig = {
      prompt: "  Summarize the fixture incident report.\n",
      gatewayBaseUrl: "https://m5.test",
      apiKey: "private-owner-key",
      path: "delegate",
      taskType: "summarize",
      timeoutMs: 30_000,
      maxOutputChars: 4_096,
      learningTask: readyLearningTask({
        prompt: "  Summarize the fixture incident report.\n",
        gatewayBaseUrl: "https://m5.test",
        apiKey: "private-owner-key",
        path: "delegate",
        taskType: "summarize",
        timeoutMs: 30_000,
        maxOutputChars: 4_096,
      }, ctx),
    };
    const body = buildHomeserverRequestBody(task, "task-001");

    expect(body.learningTaskStamp).toEqual(
      buildLearningTaskRequestStamp({
        context: ctx,
        taskType: "summarize",
        rawTaskText: task.prompt,
        renderedPrompt: renderHomeserverUserMessage(task),
      }),
    );
    expect(body.learningTaskStamp?.raw_fingerprint)
      .toEqual(body.huginTaskIdentity?.rawTaskFingerprint);
    expect(body.learningTaskStamp?.hugin_envelope.digest)
      .not.toBe(body.huginTaskIdentity?.renderedPromptFingerprint.digest);
    expect(Date.parse(body.learningTaskStamp!.stamped_at))
      .toBeGreaterThanOrEqual(Date.parse(ctx.attempt.startedAt));
    expect(JSON.stringify(body.learningTaskStamp)).not.toContain(task.prompt.trim());
  });

  it("keeps prepared evidence content-blind and attempt-keyed while separating classified replay bytes", () => {
    const task = taskConfigForFixture();
    const first = readyLearningTask(task, context());
    const secondContext = context();
    secondContext.attempt = createLearningTaskAttemptStart({
      taskId: "task-001",
      attemptId: "hugin-attempt:99999999-9999-4999-8999-999999999999",
      startedAt,
      rawTaskText: task.prompt,
      renderedPrompt: renderHomeserverUserMessage(task),
    });
    secondContext.attemptStartRef = {
      namespace: "tasks/task-001",
      key: "learning-attempt-99999999-9999-4999-8999-999999999999",
    };
    const second = readyLearningTask(task, secondContext);

    expect(JSON.stringify(first.preparedDispatch)).not.toContain(task.prompt.trim());
    expect(JSON.stringify(first.replayPayload)).toContain(task.prompt.trim());
    expect(first.preparedDispatch.preparedDispatchRef.key)
      .not.toBe(second.preparedDispatch.preparedDispatchRef.key);
    expect(first.preparedDispatch.replayPayloadRef.key)
      .not.toBe(second.preparedDispatch.replayPayloadRef.key);
  });

  it("recovers only an exact stored admission and never accepts a fresh/replayed outcome", async () => {
    const task = taskConfigForFixture();
    const prepared = readyLearningTask(task, context());
    const stamp = prepared.preparedDispatch.requestStamp;
    const echo = gatewayEchoFor(stamp);
    const fetchImpl = vi.fn(async () => response({
      outcome: "error",
      learningTaskAdmission: { recovered: true, outcomeAvailable: false },
      learningTaskGatewayEcho: echo,
    }));
    const recovered = await recoverPreparedLearningTaskDispatch({
      prepared: prepared.preparedDispatch,
      replayPayload: prepared.replayPayload,
      gatewayBaseUrl: "https://m5.test",
      apiKey: "owner-key",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(recovered).toMatchObject({ state: "m5-admitted", evidenceAccepted: true });
    expect(validatePreparedLearningTaskOutcome(prepared.preparedDispatch, recovered))
      .toEqual(recovered);
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string))
      .toEqual(prepared.replayPayload.requestBody);
    const crossAttempt = structuredClone(recovered);
    crossAttempt.requestStamp!.attempt_id = "hugin-attempt:99999999-9999-4999-8999-999999999999";
    expect(() => learningTaskExecutionEvidenceSchema.parse(crossAttempt)).toThrow();
    const fakeDigest = structuredClone(recovered);
    fakeDigest.requestStampDigest!.digest = "0".repeat(64);
    expect(() => learningTaskExecutionEvidenceSchema.parse(fakeDigest)).toThrow();

    const changedReplayDigest = structuredClone(recovered);
    changedReplayDigest.replayPayloadDigest!.digest = "0".repeat(64);
    expect(() => validatePreparedLearningTaskOutcome(
      prepared.preparedDispatch,
      changedReplayDigest,
    )).toThrow(/prepared dispatch/i);

    const changedStartTime = structuredClone(recovered);
    changedStartTime.attemptStartedAt = "2026-07-19T10:00:01.001Z";
    expect(() => validatePreparedLearningTaskOutcome(
      prepared.preparedDispatch,
      changedStartTime,
    )).toThrow(/prepared dispatch/i);

    const refMutations: Array<(value: typeof recovered) => void> = [
      (value) => { value.attemptStartRef!.key += "-different"; },
      (value) => { value.preparedDispatchRef!.key += "-different"; },
      (value) => { value.replayPayloadRef!.key += "-different"; },
      (value) => { value.attemptOutcomeRef!.key += "-different"; },
      (value) => { value.taskOutcomeRef.key += "-different"; },
    ];
    for (const mutate of refMutations) {
      const changedRef = structuredClone(recovered);
      mutate(changedRef);
      expect(() => validatePreparedLearningTaskOutcome(
        prepared.preparedDispatch,
        changedRef,
      )).toThrow(/reference|prepared dispatch/i);
    }

    const fresh = await recoverPreparedLearningTaskDispatch({
      prepared: prepared.preparedDispatch,
      replayPayload: prepared.replayPayload,
      gatewayBaseUrl: "https://m5.test",
      apiKey: "owner-key",
      fetchImpl: (async () => response({ output: "must not be trusted", learningTaskGatewayEcho: echo })) as typeof fetch,
    });
    expect(fresh).toMatchObject({
      state: "join-failed",
      evidenceAccepted: false,
      failureCode: "recovery-unavailable",
    });
  });

  it("cross-binds a prepared dispatch to its immutable full attempt-start identity", () => {
    const task = taskConfigForFixture();
    const ready = readyLearningTask(task, context());
    const start = durableLearningTaskAttemptStart(ready.context.attempt);

    expect(validatePreparedLearningTaskAttemptStart(ready.preparedDispatch, start))
      .toEqual(start);

    const crossTask = structuredClone(start);
    crossTask.huginTaskIdentity.taskId = "another-task";
    expect(() => validatePreparedLearningTaskAttemptStart(
      ready.preparedDispatch,
      crossTask,
    )).toThrow(/attempt[- ]start/i);

    const crossRaw = structuredClone(start);
    crossRaw.huginTaskIdentity.rawTaskFingerprint.digest = "0".repeat(64);
    expect(() => validatePreparedLearningTaskAttemptStart(
      ready.preparedDispatch,
      crossRaw,
    )).toThrow(/attempt[- ]start/i);
  });

  it("keeps preflight evidence schema-valid when outcome persistence fails", () => {
    const ctx = context();
    const failed = learningTaskOutcomePersistenceFailure({
      schemaVersion: 1,
      contractVersion: "grimnir.learning-task/v1",
      state: "preflight-failed",
      evidenceAccepted: false,
      taskId: ctx.attempt.taskId,
      attemptId: ctx.attempt.attemptId,
      attemptStartedAt: ctx.attempt.startedAt,
      attemptStartRef: ctx.attemptStartRef,
      taskOutcomeRef: { namespace: "tasks/task-001", key: "result-structured" },
      rawFingerprint: ctx.attempt.huginTaskIdentity.rawTaskFingerprint,
      failureCode: "preflight-failed",
      failureReason: "preflight failed",
    });
    expect(failed).toMatchObject({
      state: "preflight-failed",
      failureCode: "attempt-outcome-persistence-failed",
      attemptOutcomeRef: undefined,
    });
  });

  it("accepts a still-fresh authenticated preflight cached before attempt start", () => {
    const ctx = context();
    ctx.preflight.request.requested_at = "2026-07-19T09:59:58.000Z";
    ctx.preflight.response.advertised_at = "2026-07-19T09:59:59.000Z";
    ctx.preflight.response.expires_at = "2026-07-19T10:14:59.000Z";

    expect(() => buildLearningTaskRequestStamp({
      context: ctx,
      taskType: "summarize",
      rawTaskText: "  Summarize the fixture incident report.\n",
      renderedPrompt: ctx.attempt.renderedPrompt,
    })).not.toThrow();
  });

  it("uses authenticated preflight and caller identity without sending the bearer token in evidence", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer private-owner-key");
      if (url.endsWith("/portal/me")) {
        return response({ alias: "service:hugin", tier: "owner" });
      }
      return response({
        advertisement_id: `opaque:${randomUUID()}`,
        endpoint: "/v1/capabilities/learning-task",
        protocol_version: "learning-task-preflight/v1",
        advertised_at: advertisedAt,
        expires_at: "2026-07-19T10:15:02.000Z",
        authenticated_principal_id: "service:gille-inference",
        authentication: "service-auth",
        capabilities: structuredClone(LEARNING_TASK_CAPABILITIES),
      });
    });

    const clock = [
      new Date("2026-07-19T10:00:01.500Z"),
      new Date("2026-07-19T10:00:02.250Z"),
    ];
    const result = await fetchLearningTaskPreflight({
      gatewayBaseUrl: "https://m5.test",
      apiKey: "private-owner-key",
      attemptStartedAt: startedAt,
      now: () => clock.shift()!,
      randomUuid: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(calls).toEqual([
      "https://m5.test/portal/me",
      "https://m5.test/v1/capabilities/learning-task",
    ]);
    expect(result.expectedTransportPrincipalId).toBe("service:hugin");
    expect(JSON.stringify(result)).not.toContain("private-owner-key");
    expect(result.preflight.request.requested_at).toBe("2026-07-19T10:00:01.500Z");
  });

  it.each([
    ["feature downgrade", (value: any) => value.capabilities.features.pop()],
    ["stale response", (value: any) => { value.expires_at = advertisedAt; }],
    ["wrong service", (value: any) => { value.authenticated_principal_id = "service:other"; }],
  ])("fails closed on %s", async (_name, mutate) => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/portal/me")) return response({ alias: "service:hugin", tier: "owner" });
      const value: any = {
        advertisement_id: `opaque:${randomUUID()}`,
        endpoint: "/v1/capabilities/learning-task",
        protocol_version: "learning-task-preflight/v1",
        advertised_at: advertisedAt,
        expires_at: "2026-07-19T10:15:02.000Z",
        authenticated_principal_id: "service:gille-inference",
        authentication: "service-auth",
        capabilities: structuredClone(LEARNING_TASK_CAPABILITIES),
      };
      mutate(value);
      return response(value);
    });
    await expect(fetchLearningTaskPreflight({
      gatewayBaseUrl: "https://m5.test",
      apiKey: "key",
      attemptStartedAt: startedAt,
      now: () => new Date("2026-07-19T10:00:02.250Z"),
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow();
  });

  it("validates exact echo, authenticated principal, capability set, and JCS binding", () => {
    const ctx = context();
    const stamp = buildLearningTaskRequestStamp({
      context: ctx,
      taskType: "summarize",
      rawTaskText: ctx.attempt.huginTaskIdentity.rawTaskFingerprint.digest === "never" ? "" : "  Summarize the fixture incident report.\n",
      renderedPrompt: ctx.attempt.renderedPrompt,
    });
    const binding = {
      authenticated_principal_id: "service:hugin",
      request_stamp: stamp,
    };
    const echo = {
      echoed_request: structuredClone(stamp),
      gateway_request_id: "opaque:e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3",
      admission_id: "opaque:e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4",
      admitted_at: "2026-07-19T10:00:03.000Z",
      authenticated_principal_id: "service:hugin",
      authentication: "gateway-owner-auth",
      principal_binding_digest: {
        algorithm: "sha256",
        version: "gateway-principal-request-binding-jcs-v1",
        digest: createHash("sha256").update(jcsCanonicalize(binding), "utf8").digest("hex"),
      },
      capabilities: structuredClone(LEARNING_TASK_CAPABILITIES),
    };

    expect(validateLearningTaskGatewayEcho(echo, stamp, new Date("2026-07-19T10:00:04Z")))
      .toEqual(echo);

    const changed = structuredClone(echo);
    changed.echoed_request.attempt_id = "hugin-attempt:other";
    expect(() => validateLearningTaskGatewayEcho(changed, stamp)).toThrow(/echo/i);

    const substituted = structuredClone(echo);
    substituted.authenticated_principal_id = "service:other";
    expect(() => validateLearningTaskGatewayEcho(substituted, stamp)).toThrow(/principal/i);
  });
});
