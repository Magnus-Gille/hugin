import { createHash, randomUUID } from "node:crypto";

import {
  LEARNING_TASK_CAPABILITIES,
  createPreparedLearningTaskDispatch,
  createLearningTaskAttemptStart,
  jcsCanonicalize,
  type LearningTaskRequestContext,
} from "../../src/learning-task-handshake.js";
import {
  buildHomeserverRequestBody,
  buildFreshHomeserverDelegateRequestBody,
  renderHomeserverUserMessage,
  type HomeserverTaskConfig,
} from "../../src/homeserver-executor.js";

/** Build trusted producer context for executor unit tests; never used by runtime code. */
export function withLearningTaskContext(
  task: HomeserverTaskConfig,
  taskId: string,
): HomeserverTaskConfig {
  if (task.path !== "delegate") return task;
  const base = Date.now() - 5_000;
  const renderedPrompt = renderHomeserverUserMessage(task);
  const attempt = createLearningTaskAttemptStart({
    taskId,
    attemptId: `hugin-attempt:${randomUUID()}`,
    startedAt: new Date(base + 1_000).toISOString(),
    rawTaskText: task.prompt,
    renderedPrompt,
  });
  const context: LearningTaskRequestContext = {
    attempt,
    attemptStartRef: {
      namespace: `tasks/${taskId}`,
      key: `learning-attempt-${attempt.attemptId.replace(/^hugin-attempt:/, "")}`,
    },
    expectedTransportPrincipalId: "service:hugin",
    idempotencyKey: `opaque:${randomUUID()}`,
    requestId: `opaque:${randomUUID()}`,
    source: {
      component: "hugin",
      system: "test",
      id: `tasks/${taskId}`,
      created_at: new Date(base - 1_000).toISOString(),
      accepted_at: new Date(base).toISOString(),
      principal: {
        id: "principal:test-owner",
        authentication: "verified-signature",
        scope: "owner",
      },
      content_owner: {
        id: "principal:test-owner",
        authority: "authenticated-owner",
      },
    },
    preflight: {
      request: {
        request_id: `opaque:${randomUUID()}`,
        endpoint: "/v1/capabilities/learning-task",
        protocol_version: "learning-task-preflight/v1",
        requested_at: new Date(base + 2_000).toISOString(),
        requested_capabilities: structuredClone(LEARNING_TASK_CAPABILITIES),
      },
      response: {
        advertisement_id: `opaque:${randomUUID()}`,
        endpoint: "/v1/capabilities/learning-task",
        protocol_version: "learning-task-preflight/v1",
        advertised_at: new Date(base + 3_000).toISOString(),
        expires_at: new Date(base + 3_000 + 15 * 60_000).toISOString(),
        authenticated_principal_id: "service:gille-inference",
        authentication: "service-auth",
        capabilities: structuredClone(LEARNING_TASK_CAPABILITIES),
      },
    },
    stampedAt: new Date(base + 4_000).toISOString(),
  };
  const requestBody = buildFreshHomeserverDelegateRequestBody(task, taskId, context);
  const prepared = createPreparedLearningTaskDispatch({
    context,
    requestStamp: requestBody.learningTaskStamp!,
    requestBody,
  });
  return {
    ...task,
    learningTask: {
      kind: "ready",
      context,
      ...prepared,
    },
  };
}

export function withLearningTaskGatewayEcho(
  task: HomeserverTaskConfig,
  taskId: string,
  outcome: Record<string, unknown>,
): Record<string, unknown> {
  const stamp = buildHomeserverRequestBody(task, taskId).learningTaskStamp!;
  const authenticatedPrincipalId = stamp.expected_transport_principal_id;
  return {
    ...outcome,
    learningTaskGatewayEcho: {
      echoed_request: structuredClone(stamp),
      gateway_request_id: `opaque:${randomUUID()}`,
      admission_id: `opaque:${randomUUID()}`,
      admitted_at: new Date(Date.parse(stamp.stamped_at) + 1).toISOString(),
      authenticated_principal_id: authenticatedPrincipalId,
      authentication: "gateway-owner-auth",
      principal_binding_digest: {
        algorithm: "sha256",
        version: "gateway-principal-request-binding-jcs-v1",
        digest: createHash("sha256").update(jcsCanonicalize({
          authenticated_principal_id: authenticatedPrincipalId,
          request_stamp: stamp,
        }), "utf8").digest("hex"),
      },
      capabilities: structuredClone(stamp.contract_request),
    },
  };
}
