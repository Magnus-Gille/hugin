/**
 * Hand-built (not executor-driven) fixtures for an admitted LearningTaskContract
 * evidence row, used by tests/candidate-pool-assembler.test.ts and
 * tests/gille-outcome-evidence-resolver.test.ts (hugin#272). Simpler than
 * tests/helpers/learning-task.ts's executor-path fixtures: `.strict()` Zod
 * schemas here carry no cross-field superRefine of their own except
 * `learningTaskExecutionEvidenceSchema`, so a hand-built object that
 * satisfies that schema's bindings/digests is sufficient -- no need to run
 * the real preflight/dispatch pipeline.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  LEARNING_TASK_CAPABILITIES,
  LEARNING_TASK_CONTRACT_VERSION,
  LEARNING_TASK_GATEWAY_PRINCIPAL,
  LEARNING_TASK_PREFLIGHT_ENDPOINT,
  LEARNING_TASK_PREFLIGHT_PROTOCOL,
  gatewayEchoDigest,
  jcsCanonicalize,
  learningTaskAttemptKey,
  learningTaskExecutionEvidenceSchema,
  requestStampDigest,
  type HuginRequestStamp,
  type LearningTaskExecutionEvidence,
} from "../../src/learning-task-handshake.js";
import {
  BROKER_TASK_TYPE_TAXONOMY_ID,
  BROKER_TASK_TYPE_TAXONOMY_VERSION,
} from "../../src/broker/task-type-metadata.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface FixtureAdmittedAttemptInput {
  taskId: string;
  taskType: string;
  promptId?: string;
  promptVersion?: string;
  harnessId?: string;
  harnessVersion?: string;
  toolPolicyId?: string;
  toolPolicyVersion?: string;
  /** Base wall-clock instant (ms); every stamp/echo timestamp derives from it. */
  baseMs?: number;
}

export interface FixtureAdmittedAttempt {
  attemptId: string;
  attemptOutcomeRef: { namespace: string; key: string };
  evidence: LearningTaskExecutionEvidence;
}

/** Build a schema-valid, `m5-admitted` `LearningTaskExecutionEvidence` row for one fresh attempt. */
export function buildFixtureAdmittedAttempt(input: FixtureAdmittedAttemptInput): FixtureAdmittedAttempt {
  const attemptId = `hugin-attempt:${randomUUID()}`;
  const attemptKey = learningTaskAttemptKey(attemptId);
  const namespace = `tasks/${input.taskId}`;
  const base = input.baseMs ?? Date.parse("2026-07-01T00:00:00.000Z");

  const promptId = input.promptId ?? "hugin-direct-delegate-prompt";
  const promptVersion = input.promptVersion ?? "v1";
  const harnessId = input.harnessId ?? "homeserver-executor";
  const harnessVersion = input.harnessVersion ?? "learning-task-v1";
  const toolPolicyId = input.toolPolicyId ?? "bounded-delegate";
  const toolPolicyVersion = input.toolPolicyVersion ?? "learning-task-v1";

  const rawTaskText = `fixture raw task text for ${input.taskId}`;
  const renderedPrompt = `fixture rendered prompt for ${input.taskId}`;
  const rawFingerprint = {
    algorithm: "sha256" as const,
    version: "trim-utf8-sha256-v1" as const,
    digest: sha256(rawTaskText),
  };

  const stamp: HuginRequestStamp = {
    task_instance_id: input.taskId,
    attempt_id: attemptId,
    client_id: "hugin",
    expected_transport_principal_id: "principal:test-owner",
    idempotency_key: `opaque:${randomUUID()}`,
    request_id: `opaque:${randomUUID()}`,
    stamped_at: new Date(base).toISOString(),
    contract_request: structuredClone(LEARNING_TASK_CAPABILITIES),
    preflight: {
      request: {
        request_id: `opaque:${randomUUID()}`,
        endpoint: LEARNING_TASK_PREFLIGHT_ENDPOINT,
        protocol_version: LEARNING_TASK_PREFLIGHT_PROTOCOL,
        requested_at: new Date(base - 3_000).toISOString(),
        requested_capabilities: structuredClone(LEARNING_TASK_CAPABILITIES),
      },
      response: {
        advertisement_id: `opaque:${randomUUID()}`,
        endpoint: LEARNING_TASK_PREFLIGHT_ENDPOINT,
        protocol_version: LEARNING_TASK_PREFLIGHT_PROTOCOL,
        advertised_at: new Date(base - 2_000).toISOString(),
        expires_at: new Date(base + 10 * 60_000).toISOString(),
        authenticated_principal_id: LEARNING_TASK_GATEWAY_PRINCIPAL,
        authentication: "service-auth",
        capabilities: structuredClone(LEARNING_TASK_CAPABILITIES),
      },
    },
    source: {
      component: "hugin",
      system: "test",
      id: namespace,
      created_at: new Date(base - 5_000).toISOString(),
      accepted_at: new Date(base - 4_000).toISOString(),
      principal: { id: "principal:test-owner", authentication: "verified-signature", scope: "owner" },
      content_owner: { id: "principal:test-owner", authority: "authenticated-owner" },
    },
    task_type: {
      id: input.taskType,
      taxonomy_id: BROKER_TASK_TYPE_TAXONOMY_ID,
      taxonomy_version: BROKER_TASK_TYPE_TAXONOMY_VERSION,
    },
    raw_input: {
      algorithm: "sha256",
      canonicalization: "jcs-rfc8785-utf8-v1",
      source_ref: `source-doc:hugin/raw/${sha256(rawTaskText)}`,
      source_type: "raw-input",
      source_version: "raw-input-v1",
      digest: sha256(rawTaskText),
    },
    raw_fingerprint: rawFingerprint,
    hugin_envelope: {
      algorithm: "sha256",
      canonicalization: "jcs-rfc8785-utf8-v1",
      source_ref: `source-doc:hugin/prompt/${attemptId.replace(/^hugin-attempt:/, "")}`,
      source_type: "prompt-stage",
      source_version: "prompt-stage-v2",
      digest: sha256(renderedPrompt),
    },
    origin_config: {
      prompt: {
        id: promptId,
        version: promptVersion,
        config_digest: {
          algorithm: "sha256",
          canonicalization: "jcs-rfc8785-utf8-v1",
          source_ref: "source-doc:hugin/config/direct-delegate-prompt-v1",
          source_type: "origin-prompt-config",
          source_version: "config-source-v1",
          digest: sha256(`${promptId}@${promptVersion}`),
        },
      },
      harness: {
        id: harnessId,
        version: harnessVersion,
        config_digest: {
          algorithm: "sha256",
          canonicalization: "jcs-rfc8785-utf8-v1",
          source_ref: "source-doc:hugin/config/homeserver-learning-task-v1",
          source_type: "origin-harness-config",
          source_version: "config-source-v1",
          digest: sha256(`${harnessId}@${harnessVersion}`),
        },
      },
      tool_policy: {
        id: toolPolicyId,
        version: toolPolicyVersion,
        config_digest: {
          algorithm: "sha256",
          canonicalization: "jcs-rfc8785-utf8-v1",
          source_ref: "source-doc:hugin/config/bounded-delegate-learning-task-v1",
          source_type: "origin-tool-policy-config",
          source_version: "config-source-v1",
          digest: sha256(`${toolPolicyId}@${toolPolicyVersion}`),
        },
      },
    },
    macro_decision: {
      policy_id: "hugin-runtime-selection",
      version: "homeserver-delegate-learning-task-v1",
      decision_id: `learning-task:${attemptId.replace(/^hugin-attempt:/, "")}`,
      target: "m5",
      service: "gille-inference",
    },
  };

  const stampDigest = requestStampDigest(stamp);
  const admittedAt = new Date(base + 1_000).toISOString();
  const authenticatedPrincipalId = stamp.expected_transport_principal_id;
  const bindingDigest = sha256(
    jcsCanonicalize({ authenticated_principal_id: authenticatedPrincipalId, request_stamp: stamp }),
  );
  const gatewayEcho = {
    echoed_request: structuredClone(stamp),
    gateway_request_id: `opaque:${randomUUID()}`,
    admission_id: `opaque:${randomUUID()}`,
    admitted_at: admittedAt,
    authenticated_principal_id: authenticatedPrincipalId,
    authentication: "gateway-owner-auth" as const,
    principal_binding_digest: {
      algorithm: "sha256" as const,
      version: "gateway-principal-request-binding-jcs-v1" as const,
      digest: bindingDigest,
    },
    capabilities: structuredClone(stamp.contract_request),
  };
  const echoDigest = gatewayEchoDigest(gatewayEcho);
  const attemptOutcomeRef = { namespace, key: `${attemptKey}-outcome` };

  const evidence: LearningTaskExecutionEvidence = {
    schemaVersion: 1,
    contractVersion: LEARNING_TASK_CONTRACT_VERSION,
    state: "m5-admitted",
    evidenceAccepted: true,
    taskId: input.taskId,
    attemptId,
    attemptStartedAt: new Date(base - 4_500).toISOString(),
    attemptStartRef: { namespace, key: attemptKey },
    preparedDispatchRef: { namespace, key: `${attemptKey}-prepared` },
    replayPayloadRef: { namespace, key: `${attemptKey}-replay` },
    replayPayloadDigest: {
      algorithm: "sha256",
      version: "hugin-replay-payload-jcs-v1",
      digest: sha256(`${attemptId}-replay`),
    },
    attemptOutcomeRef,
    taskOutcomeRef: { namespace, key: "result-structured" },
    rawFingerprint,
    requestStamp: stamp,
    requestStampDigest: stampDigest,
    gatewayEcho,
    gatewayEchoDigest: echoDigest,
  };

  const parsed = learningTaskExecutionEvidenceSchema.parse(evidence);
  return { attemptId, attemptOutcomeRef, evidence: parsed };
}

/** Minimal "status" document content: hashable as-is by `buildQualityBinding`,
 * and parseable by `broker/task-store.ts`'s `parseStoredEnvelope` (which does
 * a bare `JSON.parse` + type cast, not schema validation) to recover a
 * `prompt` field. */
export function buildFixtureStatusDocument(taskId: string, prompt: string): string {
  const envelope = { task_id: taskId, prompt };
  return [
    `## Task: fixture-${taskId}`,
    "",
    "### Broker envelope",
    "```json",
    JSON.stringify(envelope),
    "```",
  ].join("\n");
}

/** Minimal "result-structured" content: `buildQualityBinding` only requires
 * `task_id` + `result_schema_version: 1` when the full structured-result
 * schema does not match (its own documented fallback path). */
export function buildFixtureResultStructuredDocument(taskId: string): string {
  return JSON.stringify({ task_id: taskId, result_schema_version: 1 });
}
