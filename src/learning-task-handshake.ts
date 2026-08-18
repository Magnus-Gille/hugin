import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { composeAbortSignals } from "./munin-client.js";

import {
  buildHuginTaskIdentity,
  fingerprintRenderedPrompt,
  huginTaskIdentitySchema,
  type HuginTaskIdentity,
} from "./task-identity.js";
import {
  BROKER_TASK_TYPE_TAXONOMY_ID,
  BROKER_TASK_TYPE_TAXONOMY_VERSION,
  taskTypeSchema as brokerTaskTypeIdSchema,
} from "./broker/task-type-metadata.js";

export const LEARNING_TASK_CONTRACT_VERSION = "grimnir.learning-task/v1" as const;
export const LEARNING_TASK_SCHEMA_REVISION = 1 as const;
export const LEARNING_TASK_PREFLIGHT_ENDPOINT = "/v1/capabilities/learning-task" as const;
export const LEARNING_TASK_PREFLIGHT_PROTOCOL = "learning-task-preflight/v1" as const;
export const LEARNING_TASK_GATEWAY_PRINCIPAL = "service:gille-inference" as const;
export const LEARNING_TASK_PREFLIGHT_TTL_MS = 15 * 60 * 1_000;
/**
 * Bounded allowance for clock disagreement between Hugin's host and the M5 gateway host when
 * ordering timestamps that were stamped on DIFFERENT hosts (issue #253). Without it, the
 * preflight freshness check requires the gateway's `advertised_at` to land inside the
 * milliseconds-wide request/observe bracket measured on Hugin's clock — tighter agreement than
 * NTP delivers between two hosts, so the joint handshake fails on ordinary tens-of-ms offsets.
 * The tolerance is applied ONLY to cross-host orderings; same-host orderings stay exact, and the
 * advertisement expiry edge is TIGHTENED by the same amount (the acceptance window never grows).
 */
export const LEARNING_TASK_CLOCK_SKEW_TOLERANCE_MS = 2_000;
export const LEARNING_TASK_FEATURES = [
  "hugin-request-stamp-v1",
  "gateway-echo-v1",
  "three-stage-prompt-provenance-v1",
  "reproducible-serving-digests-v1",
] as const;

export const LEARNING_TASK_CAPABILITIES = {
  contract_version: LEARNING_TASK_CONTRACT_VERSION,
  schema_revision: LEARNING_TASK_SCHEMA_REVISION,
  features: [...LEARNING_TASK_FEATURES],
} as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const opaqueIdSchema = z.string().regex(
  /^opaque:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const utcTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

function isExactUtcTimestamp(value: string): boolean {
  const match = utcTimestampPattern.exec(value);
  if (!match) return false;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return false;
  return instant.getUTCFullYear() === Number(match[1])
    && instant.getUTCMonth() + 1 === Number(match[2])
    && instant.getUTCDate() === Number(match[3])
    && instant.getUTCHours() === Number(match[4])
    && instant.getUTCMinutes() === Number(match[5])
    && instant.getUTCSeconds() === Number(match[6]);
}

const timestampSchema = z.string().refine(isExactUtcTimestamp, {
  message: "invalid RFC 3339 UTC timestamp",
});
const capabilitySchema = z.object({
  contract_version: z.literal(LEARNING_TASK_CONTRACT_VERSION),
  schema_revision: z.literal(LEARNING_TASK_SCHEMA_REVISION),
  features: z.array(z.enum(LEARNING_TASK_FEATURES)).length(LEARNING_TASK_FEATURES.length)
    .refine((features) => new Set(features).size === LEARNING_TASK_FEATURES.length
      && LEARNING_TASK_FEATURES.every((feature) => features.includes(feature)), {
      message: "learning-task features must be unique and complete",
    }),
}).strict();

const preflightRequestSchema = z.object({
  request_id: opaqueIdSchema,
  endpoint: z.literal(LEARNING_TASK_PREFLIGHT_ENDPOINT),
  protocol_version: z.literal(LEARNING_TASK_PREFLIGHT_PROTOCOL),
  requested_at: timestampSchema,
  requested_capabilities: capabilitySchema,
}).strict();

const preflightResponseSchema = z.object({
  advertisement_id: opaqueIdSchema,
  endpoint: z.literal(LEARNING_TASK_PREFLIGHT_ENDPOINT),
  protocol_version: z.literal(LEARNING_TASK_PREFLIGHT_PROTOCOL),
  advertised_at: timestampSchema,
  expires_at: timestampSchema,
  authenticated_principal_id: z.literal(LEARNING_TASK_GATEWAY_PRINCIPAL),
  authentication: z.literal("service-auth"),
  capabilities: capabilitySchema,
}).strict();

const sourceDocumentTypeSchema = z.enum([
  "raw-input",
  "prompt-stage",
  "origin-prompt-config",
  "origin-harness-config",
  "origin-tool-policy-config",
]);
const sourceDocumentDigestSchema = z.object({
  algorithm: z.literal("sha256"),
  canonicalization: z.literal("jcs-rfc8785-utf8-v1"),
  source_ref: z.string().regex(/^source-doc:[a-z0-9][a-z0-9._/-]*$/),
  source_type: sourceDocumentTypeSchema,
  source_version: z.string().min(1),
  digest: sha256Schema,
}).strict();

const sourceSchema = z.object({
  component: z.literal("hugin"),
  system: z.string().min(1),
  id: z.string().min(1),
  created_at: timestampSchema,
  accepted_at: timestampSchema,
  principal: z.object({
    id: z.string().min(1),
    authentication: z.enum(["verified-signature", "gateway-owner-auth", "service-auth"]),
    scope: z.enum(["owner", "service"]),
  }).strict(),
  content_owner: z.object({
    id: z.string().min(1),
    authority: z.enum(["authenticated-owner", "delegated-owner"]),
  }).strict(),
}).strict();

const taskTypeSchema = z.object({
  // #235 owns the runtime task-type registry. Learning stamps consume that
  // schema instead of maintaining a third local list.
  id: brokerTaskTypeIdSchema,
  taxonomy_id: z.literal(BROKER_TASK_TYPE_TAXONOMY_ID),
  taxonomy_version: z.literal(BROKER_TASK_TYPE_TAXONOMY_VERSION),
}).strict();

const versionedConfigSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  config_digest: sourceDocumentDigestSchema,
}).strict();

export const huginRequestStampSchema = z.object({
  task_instance_id: z.string().min(1),
  attempt_id: z.string().min(1),
  client_id: z.literal("hugin"),
  expected_transport_principal_id: z.string().min(1),
  idempotency_key: opaqueIdSchema,
  request_id: opaqueIdSchema,
  stamped_at: timestampSchema,
  contract_request: capabilitySchema,
  preflight: z.object({
    request: preflightRequestSchema,
    response: preflightResponseSchema,
  }).strict(),
  source: sourceSchema,
  task_type: taskTypeSchema,
  raw_input: sourceDocumentDigestSchema.refine((value) => value.source_type === "raw-input"),
  raw_fingerprint: z.object({
    algorithm: z.literal("sha256"),
    version: z.literal("trim-utf8-sha256-v1"),
    digest: sha256Schema,
  }).strict(),
  hugin_envelope: sourceDocumentDigestSchema.refine((value) => value.source_type === "prompt-stage"),
  origin_config: z.object({
    prompt: versionedConfigSchema,
    harness: versionedConfigSchema,
    tool_policy: versionedConfigSchema,
  }).strict(),
  macro_decision: z.object({
    policy_id: z.string().min(1),
    version: z.string().min(1),
    decision_id: z.string().min(1),
    target: z.literal("m5"),
    service: z.literal("gille-inference"),
  }).strict(),
}).strict();

export const learningTaskGatewayEchoSchema = z.object({
  echoed_request: huginRequestStampSchema,
  gateway_request_id: opaqueIdSchema,
  admission_id: opaqueIdSchema,
  admitted_at: timestampSchema,
  authenticated_principal_id: z.string().min(1),
  authentication: z.enum(["gateway-owner-auth", "service-auth"]),
  principal_binding_digest: z.object({
    algorithm: z.literal("sha256"),
    version: z.literal("gateway-principal-request-binding-jcs-v1"),
    digest: sha256Schema,
  }).strict(),
  capabilities: capabilitySchema,
}).strict();

export type LearningTaskSource = z.infer<typeof sourceSchema>;
export type LearningTaskPreflightRequest = z.infer<typeof preflightRequestSchema>;
export type LearningTaskPreflightResponse = z.infer<typeof preflightResponseSchema>;
export type HuginRequestStamp = z.infer<typeof huginRequestStampSchema>;
export type LearningTaskGatewayEcho = z.infer<typeof learningTaskGatewayEchoSchema>;

const evidenceRefSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
}).strict();
const requestStampDigestSchema = z.object({
  algorithm: z.literal("sha256"),
  version: z.literal("hugin-request-stamp-jcs-v1"),
  digest: sha256Schema,
}).strict();
const gatewayEchoDigestSchema = z.object({
  algorithm: z.literal("sha256"),
  version: z.literal("gateway-echo-jcs-v1"),
  digest: sha256Schema,
}).strict();
const replayPayloadDigestSchema = z.object({
  algorithm: z.literal("sha256"),
  version: z.literal("hugin-replay-payload-jcs-v1"),
  digest: sha256Schema,
}).strict();

export const learningTaskReplayPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(LEARNING_TASK_CONTRACT_VERSION),
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  requestBody: z.record(z.string(), z.unknown()),
}).strict();

const learningTaskDelegateRequestBodySchema = z.object({
  prompt: z.string().min(1),
  huginTaskIdentity: huginTaskIdentitySchema,
  learningTaskStamp: huginRequestStampSchema,
}).passthrough();

export type LearningTaskReplayPayload = z.infer<typeof learningTaskReplayPayloadSchema>;

export const preparedLearningTaskDispatchSchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(LEARNING_TASK_CONTRACT_VERSION),
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  attemptStartedAt: timestampSchema,
  preparedAt: timestampSchema,
  attemptStartRef: evidenceRefSchema,
  preparedDispatchRef: evidenceRefSchema,
  replayPayloadRef: evidenceRefSchema,
  replayPayloadDigest: replayPayloadDigestSchema,
  attemptOutcomeRef: evidenceRefSchema,
  taskOutcomeRef: evidenceRefSchema,
  requestStamp: huginRequestStampSchema,
  requestStampDigest: requestStampDigestSchema,
}).strict().superRefine((value, ctx) => {
  if (value.taskId !== value.requestStamp.task_instance_id
    || value.attemptId !== value.requestStamp.attempt_id) {
    ctx.addIssue({ code: "custom", message: "prepared dispatch identity does not match its request stamp" });
  }
  if (!canonicalEqual(value.requestStampDigest, requestStampDigest(value.requestStamp))) {
    ctx.addIssue({ code: "custom", path: ["requestStampDigest"], message: "prepared request stamp digest mismatch" });
  }
  let attemptKey: string | undefined;
  try {
    attemptKey = learningTaskAttemptKey(value.attemptId);
  } catch {
    ctx.addIssue({ code: "custom", path: ["attemptId"], message: "invalid Hugin learning attempt id" });
  }
  const namespace = `tasks/${value.taskId}`;
  const expectedRefs: Array<[
    "attemptStartRef" | "preparedDispatchRef" | "replayPayloadRef" | "attemptOutcomeRef" | "taskOutcomeRef",
    string | undefined,
  ]> = [
    ["attemptStartRef", attemptKey],
    ["preparedDispatchRef", attemptKey ? `${attemptKey}-prepared` : undefined],
    ["replayPayloadRef", attemptKey ? `${attemptKey}-replay` : undefined],
    ["attemptOutcomeRef", attemptKey ? `${attemptKey}-outcome` : undefined],
    ["taskOutcomeRef", "result-structured"],
  ];
  for (const [field, key] of expectedRefs) {
    const ref = value[field] as LearningTaskEvidenceRef;
    if (ref.namespace !== namespace || ref.key !== key) {
      ctx.addIssue({ code: "custom", path: [field], message: "prepared dispatch reference binding mismatch" });
    }
  }
});

export type PreparedLearningTaskDispatch = z.infer<typeof preparedLearningTaskDispatchSchema>;

export const learningTaskExecutionEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(LEARNING_TASK_CONTRACT_VERSION),
  state: z.enum(["preflight-failed", "m5-not-admitted", "join-failed", "m5-admitted"]),
  evidenceAccepted: z.boolean(),
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  attemptStartedAt: timestampSchema,
  attemptStartRef: evidenceRefSchema.optional(),
  preparedDispatchRef: evidenceRefSchema.optional(),
  replayPayloadRef: evidenceRefSchema.optional(),
  replayPayloadDigest: replayPayloadDigestSchema.optional(),
  taskOutcomeRef: evidenceRefSchema,
  rawFingerprint: z.object({
    algorithm: z.literal("sha256"),
    version: z.literal("trim-utf8-sha256-v1"),
    digest: sha256Schema,
  }).strict(),
  requestStamp: huginRequestStampSchema.optional(),
  requestStampDigest: requestStampDigestSchema.optional(),
  gatewayEcho: learningTaskGatewayEchoSchema.optional(),
  gatewayEchoDigest: gatewayEchoDigestSchema.optional(),
  attemptOutcomeRef: evidenceRefSchema.optional(),
  failureCode: z.enum([
    "preflight-failed",
    "transport-not-admitted",
    "gateway-echo-invalid",
    "attempt-outcome-persistence-failed",
    "prepared-dispatch-persistence-failed",
    "recovery-unavailable",
  ]).optional(),
  failureReason: z.string().min(1).max(512).optional(),
}).strict().superRefine((value, ctx) => {
  const hasStamp = value.requestStamp !== undefined && value.requestStampDigest !== undefined;
  const hasEcho = value.gatewayEcho !== undefined && value.gatewayEchoDigest !== undefined;
  if ((value.requestStamp === undefined) !== (value.requestStampDigest === undefined)) {
    ctx.addIssue({ code: "custom", message: "request stamp and digest must be known together" });
  }
  if ((value.gatewayEcho === undefined) !== (value.gatewayEchoDigest === undefined)) {
    ctx.addIssue({ code: "custom", message: "gateway echo and digest must be known together" });
  }
  if (value.state === "preflight-failed" && (hasStamp || hasEcho)) {
    ctx.addIssue({ code: "custom", message: "preflight failure cannot carry a request stamp or echo" });
  }
  if (value.state !== "preflight-failed" && !hasStamp) {
    ctx.addIssue({ code: "custom", message: "post-preflight evidence requires the exact request stamp" });
  }
  if (value.state !== "preflight-failed" && value.attemptStartRef === undefined) {
    ctx.addIssue({ code: "custom", message: "a stamped attempt requires its durable start reference" });
  }
  if (value.state !== "preflight-failed"
    && value.failureCode !== "prepared-dispatch-persistence-failed"
    && value.preparedDispatchRef === undefined) {
    ctx.addIssue({ code: "custom", message: "a dispatched attempt requires its immutable prepared-dispatch reference" });
  }
  if ((value.replayPayloadRef === undefined) !== (value.replayPayloadDigest === undefined)) {
    ctx.addIssue({ code: "custom", message: "replay payload reference and digest must be known together" });
  }
  if (value.state !== "preflight-failed"
    && value.failureCode !== "prepared-dispatch-persistence-failed"
    && value.replayPayloadRef === undefined) {
    ctx.addIssue({ code: "custom", message: "a dispatched attempt requires its classified replay payload reference" });
  }
  const expectedNamespace = `tasks/${value.taskId}`;
  if (value.taskOutcomeRef.namespace !== expectedNamespace || value.taskOutcomeRef.key !== "result-structured") {
    ctx.addIssue({ code: "custom", path: ["taskOutcomeRef"], message: "task outcome reference does not bind the evidence task" });
  }
  let expectedAttemptKey: string | undefined;
  try {
    expectedAttemptKey = learningTaskAttemptKey(value.attemptId);
  } catch {
    ctx.addIssue({ code: "custom", path: ["attemptId"], message: "invalid Hugin learning attempt id" });
  }
  if (value.attemptStartRef && (value.attemptStartRef.namespace !== expectedNamespace
    || value.attemptStartRef.key !== expectedAttemptKey)) {
    ctx.addIssue({ code: "custom", path: ["attemptStartRef"], message: "attempt start reference does not bind this attempt" });
  }
  if (value.preparedDispatchRef && (value.preparedDispatchRef.namespace !== expectedNamespace
    || value.preparedDispatchRef.key !== `${expectedAttemptKey}-prepared`)) {
    ctx.addIssue({ code: "custom", path: ["preparedDispatchRef"], message: "prepared dispatch reference does not bind this task" });
  }
  if (value.replayPayloadRef && (value.replayPayloadRef.namespace !== expectedNamespace
    || value.replayPayloadRef.key !== `${expectedAttemptKey}-replay`)) {
    ctx.addIssue({ code: "custom", path: ["replayPayloadRef"], message: "replay payload reference does not bind this attempt" });
  }
  if (value.attemptOutcomeRef && (value.attemptOutcomeRef.namespace !== expectedNamespace
    || value.attemptOutcomeRef.key !== `${expectedAttemptKey}-outcome`)) {
    ctx.addIssue({ code: "custom", path: ["attemptOutcomeRef"], message: "attempt outcome reference does not bind this attempt" });
  }
  if (value.requestStamp) {
    if (value.requestStamp.task_instance_id !== value.taskId
      || value.requestStamp.attempt_id !== value.attemptId
      || !canonicalEqual(value.requestStamp.raw_fingerprint, value.rawFingerprint)) {
      ctx.addIssue({ code: "custom", path: ["requestStamp"], message: "request stamp does not bind the evidence task/attempt/raw fingerprint" });
    }
    if (!value.requestStampDigest
      || !canonicalEqual(value.requestStampDigest, requestStampDigest(value.requestStamp))) {
      ctx.addIssue({ code: "custom", path: ["requestStampDigest"], message: "request stamp digest mismatch" });
    }
  }
  if (value.gatewayEcho && value.requestStamp) {
    try {
      validateLearningTaskGatewayEcho(
        value.gatewayEcho,
        value.requestStamp,
        new Date(value.gatewayEcho.admitted_at),
      );
    } catch (error) {
      ctx.addIssue({ code: "custom", path: ["gatewayEcho"], message: error instanceof Error ? error.message : "gateway echo binding mismatch" });
    }
    if (!value.gatewayEchoDigest
      || !canonicalEqual(value.gatewayEchoDigest, gatewayEchoDigest(value.gatewayEcho))) {
      ctx.addIssue({ code: "custom", path: ["gatewayEchoDigest"], message: "gateway echo digest mismatch" });
    }
  }
  if (value.state === "m5-admitted" && (!hasEcho || !value.evidenceAccepted)) {
    ctx.addIssue({ code: "custom", message: "admitted evidence requires an accepted exact echo" });
  }
  if (value.state !== "m5-admitted" && value.evidenceAccepted) {
    ctx.addIssue({ code: "custom", message: "non-admitted evidence cannot be accepted" });
  }
});
export type LearningTaskExecutionEvidence = z.infer<typeof learningTaskExecutionEvidenceSchema>;

export class LearningTaskHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningTaskHandshakeError";
  }
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new LearningTaskHandshakeError("JCS rejects a lone high surrogate");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new LearningTaskHandshakeError("JCS rejects a lone low surrogate");
    }
  }
}

/** RFC 8785 / ECMAScript JSON canonicalization for the accepted v1 digests. */
export function jcsCanonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jcsCanonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => {
      assertUnicodeScalarString(key);
      const child = object[key];
      if (child === undefined) throw new LearningTaskHandshakeError("JCS rejects undefined");
      return `${JSON.stringify(key)}:${jcsCanonicalize(child)}`;
    }).join(",")}}`;
  }
  if (typeof value === "string") assertUnicodeScalarString(value);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new LearningTaskHandshakeError("JCS rejects non-finite numbers");
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  throw new LearningTaskHandshakeError(`JCS rejects non-JSON value ${typeof value}`);
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jcsDigest(value: unknown): string {
  return sha256Utf8(jcsCanonicalize(value));
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return jcsCanonicalize(left) === jcsCanonicalize(right);
}

function opaqueId(uuid: string): string {
  return opaqueIdSchema.parse(`opaque:${uuid}`);
}

export interface LearningTaskEvidenceRef {
  namespace: string;
  key: string;
}

export interface LearningTaskAttemptStart {
  schemaVersion: 1;
  contractVersion: typeof LEARNING_TASK_CONTRACT_VERSION;
  taskId: string;
  attemptId: string;
  startedAt: string;
  huginTaskIdentity: HuginTaskIdentity;
  /** In-memory only; the durable start projection deliberately omits prompt bytes. */
  renderedPrompt: string;
}

export const durableLearningTaskAttemptStartSchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(LEARNING_TASK_CONTRACT_VERSION),
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  startedAt: timestampSchema,
  huginTaskIdentity: huginTaskIdentitySchema,
  taskOutcomeRef: evidenceRefSchema,
}).strict().superRefine((value, ctx) => {
  if (value.huginTaskIdentity.taskId !== value.taskId) {
    ctx.addIssue({
      code: "custom",
      path: ["huginTaskIdentity", "taskId"],
      message: "attempt-start producer identity does not bind its task",
    });
  }
  if (value.taskOutcomeRef.namespace !== `tasks/${value.taskId}`
    || value.taskOutcomeRef.key !== "result-structured") {
    ctx.addIssue({
      code: "custom",
      path: ["taskOutcomeRef"],
      message: "attempt-start task outcome reference does not bind its task",
    });
  }
});
export type DurableLearningTaskAttemptStart = z.infer<
  typeof durableLearningTaskAttemptStartSchema
>;

export function createLearningTaskAttemptStart(input: {
  taskId: string;
  attemptId?: string;
  startedAt?: string;
  rawTaskText: string;
  renderedPrompt: string;
}): LearningTaskAttemptStart {
  const startedAt = timestampSchema.parse(input.startedAt ?? new Date().toISOString());
  const attemptId = input.attemptId ?? `hugin-attempt:${randomUUID()}`;
  return {
    schemaVersion: 1,
    contractVersion: LEARNING_TASK_CONTRACT_VERSION,
    taskId: input.taskId,
    attemptId,
    startedAt,
    huginTaskIdentity: buildHuginTaskIdentity({
      taskId: input.taskId,
      rawTaskText: input.rawTaskText,
      renderedPrompt: input.renderedPrompt,
    }),
    renderedPrompt: input.renderedPrompt,
  };
}

export function durableLearningTaskAttemptStart(
  attempt: LearningTaskAttemptStart,
): DurableLearningTaskAttemptStart {
  return durableLearningTaskAttemptStartSchema.parse({
    schemaVersion: 1,
    contractVersion: LEARNING_TASK_CONTRACT_VERSION,
    taskId: attempt.taskId,
    attemptId: attempt.attemptId,
    startedAt: attempt.startedAt,
    huginTaskIdentity: structuredClone(attempt.huginTaskIdentity),
    taskOutcomeRef: { namespace: `tasks/${attempt.taskId}`, key: "result-structured" },
  });
}

export function learningTaskAttemptKey(attemptId: string): string {
  const suffix = attemptId.replace(/^hugin-attempt:/, "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(suffix)) {
    throw new LearningTaskHandshakeError("learning-task attempt id is not a Hugin UUID attempt");
  }
  return `learning-attempt-${suffix}`;
}

export function learningTaskPreparedDispatchKey(attemptId: string): string {
  return `${learningTaskAttemptKey(attemptId)}-prepared`;
}

export function learningTaskReplayPayloadKey(attemptId: string): string {
  return `${learningTaskAttemptKey(attemptId)}-replay`;
}

export function validatePreparedLearningTaskAttemptStart(
  preparedInput: PreparedLearningTaskDispatch,
  raw: unknown,
): DurableLearningTaskAttemptStart {
  const prepared = preparedLearningTaskDispatchSchema.parse(preparedInput);
  const start = durableLearningTaskAttemptStartSchema.parse(raw);
  const bindings: Array<[unknown, unknown]> = [
    [start.taskId, prepared.taskId],
    [start.attemptId, prepared.attemptId],
    [start.startedAt, prepared.attemptStartedAt],
    [start.taskOutcomeRef, prepared.taskOutcomeRef],
    [start.huginTaskIdentity.taskId, prepared.taskId],
    [start.huginTaskIdentity.rawTaskFingerprint, prepared.requestStamp.raw_fingerprint],
  ];
  if (bindings.some(([actual, expected]) => !canonicalEqual(actual, expected))) {
    throw new LearningTaskHandshakeError(
      "durable attempt start does not bind the selected prepared dispatch",
    );
  }
  return start;
}

export function validateStoredLearningTaskAttemptStart(input: {
  taskNamespace: string;
  key: string;
  raw: unknown;
}): DurableLearningTaskAttemptStart {
  const start = durableLearningTaskAttemptStartSchema.parse(input.raw);
  if (input.taskNamespace !== `tasks/${start.taskId}`
    || input.key !== learningTaskAttemptKey(start.attemptId)) {
    throw new LearningTaskHandshakeError(
      "durable attempt start does not bind its storage location",
    );
  }
  return start;
}

export function learningTaskPreDispatchRecoveryFailure(input: {
  start: DurableLearningTaskAttemptStart;
  attemptStartRef: LearningTaskEvidenceRef;
  reason: string;
}): LearningTaskExecutionEvidence {
  return learningTaskExecutionEvidenceSchema.parse({
    schemaVersion: 1,
    contractVersion: LEARNING_TASK_CONTRACT_VERSION,
    state: "preflight-failed",
    evidenceAccepted: false,
    taskId: input.start.taskId,
    attemptId: input.start.attemptId,
    attemptStartedAt: input.start.startedAt,
    attemptStartRef: input.attemptStartRef,
    taskOutcomeRef: input.start.taskOutcomeRef,
    rawFingerprint: input.start.huginTaskIdentity.rawTaskFingerprint,
    failureCode: "recovery-unavailable",
    failureReason: input.reason.slice(0, 512),
  });
}

interface ReadPreflightOptions {
  gatewayBaseUrl: string;
  apiKey: string;
  attemptStartedAt: string;
  now?: () => Date;
  randomUuid?: () => string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

async function readBoundedJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
    throw new LearningTaskHandshakeError("learning-task preflight response exceeds 64 KiB");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LearningTaskHandshakeError("learning-task preflight returned invalid JSON");
  }
}

export async function fetchLearningTaskPreflight(
  options: ReadPreflightOptions,
): Promise<{
  expectedTransportPrincipalId: string;
  preflight: { request: LearningTaskPreflightRequest; response: LearningTaskPreflightResponse };
}> {
  if (options.apiKey.trim() === "") {
    throw new LearningTaskHandshakeError("LearningTaskContract requires an authenticated M5 key");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const uuid = options.randomUuid ?? randomUUID;
  const headers = { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" };
  const principalRequest = options.signal
    ? composeAbortSignals([options.signal, AbortSignal.timeout(10_000)])
    : { signal: AbortSignal.timeout(10_000), cleanup: () => {} };
  let principalResponse: Response;
  let principalRaw: unknown;
  try {
    principalResponse = await fetchImpl(`${options.gatewayBaseUrl}/portal/me`, {
      method: "GET",
      headers,
      signal: principalRequest.signal,
    });
    if (!principalResponse.ok) {
      throw new LearningTaskHandshakeError(`authenticated M5 principal lookup failed with HTTP ${principalResponse.status}`);
    }
    principalRaw = await readBoundedJson(principalResponse);
  } finally {
    principalRequest.cleanup();
  }
  const principal = z.object({ alias: z.string().min(1), tier: z.literal("owner") }).passthrough()
    .safeParse(principalRaw);
  if (!principal.success) {
    throw new LearningTaskHandshakeError("M5 principal lookup did not return an owner alias");
  }

  const requestedAt = timestampSchema.parse(now().toISOString());
  if (Date.parse(requestedAt) < Date.parse(timestampSchema.parse(options.attemptStartedAt))) {
    throw new LearningTaskHandshakeError("learning-task preflight precedes durable attempt start");
  }
  const request = preflightRequestSchema.parse({
    request_id: opaqueId(uuid()),
    endpoint: LEARNING_TASK_PREFLIGHT_ENDPOINT,
    protocol_version: LEARNING_TASK_PREFLIGHT_PROTOCOL,
    requested_at: requestedAt,
    requested_capabilities: structuredClone(LEARNING_TASK_CAPABILITIES),
  });
  const capabilityRequest = options.signal
    ? composeAbortSignals([options.signal, AbortSignal.timeout(10_000)])
    : { signal: AbortSignal.timeout(10_000), cleanup: () => {} };
  let capabilityResponse: Response;
  let capabilityRaw: unknown;
  try {
    capabilityResponse = await fetchImpl(
      `${options.gatewayBaseUrl}${LEARNING_TASK_PREFLIGHT_ENDPOINT}`,
      { method: "GET", headers, signal: capabilityRequest.signal },
    );
    if (!capabilityResponse.ok) {
      throw new LearningTaskHandshakeError(`authenticated learning-task preflight failed with HTTP ${capabilityResponse.status}`);
    }
    capabilityRaw = await readBoundedJson(capabilityResponse);
  } finally {
    capabilityRequest.cleanup();
  }
  const parsed = preflightResponseSchema.safeParse(capabilityRaw);
  if (!parsed.success) {
    throw new LearningTaskHandshakeError("learning-task preflight advertised an unsupported or partial contract");
  }
  const response = parsed.data;
  const observedAt = now().getTime();
  const requestedMs = Date.parse(request.requested_at);
  const advertisedMs = Date.parse(response.advertised_at);
  const expiresMs = Date.parse(response.expires_at);
  // `requested_at`/`observedAt` are Hugin-host clocks; `advertised_at`/`expires_at` are
  // gateway-host clocks. Cross-host orderings carry the bounded skew tolerance (#253); the
  // expiry edge is tightened by the same amount so tolerance can never extend the window.
  if (!(
    requestedMs - LEARNING_TASK_CLOCK_SKEW_TOLERANCE_MS <= advertisedMs
    && advertisedMs <= observedAt + LEARNING_TASK_CLOCK_SKEW_TOLERANCE_MS
    && observedAt < expiresMs - LEARNING_TASK_CLOCK_SKEW_TOLERANCE_MS
  )) {
    throw new LearningTaskHandshakeError("learning-task preflight freshness does not cover observation time");
  }
  if (expiresMs - advertisedMs > LEARNING_TASK_PREFLIGHT_TTL_MS) {
    throw new LearningTaskHandshakeError("learning-task preflight cache TTL exceeds fifteen minutes");
  }
  if (!canonicalEqual(request.requested_capabilities, response.capabilities)
    || !canonicalEqual(response.capabilities, LEARNING_TASK_CAPABILITIES)) {
    throw new LearningTaskHandshakeError("learning-task preflight capability downgrade");
  }
  return {
    expectedTransportPrincipalId: principal.data.alias,
    preflight: { request, response },
  };
}

export interface LearningTaskRequestContext {
  attempt: LearningTaskAttemptStart;
  attemptStartRef: LearningTaskEvidenceRef;
  expectedTransportPrincipalId: string;
  idempotencyKey: string;
  requestId: string;
  source: LearningTaskSource;
  preflight: {
    request: LearningTaskPreflightRequest;
    response: LearningTaskPreflightResponse;
  };
  /** Frozen once after accepted preflight and reused for every serialization. */
  stampedAt: string;
}

export type LearningTaskPreparation =
  | {
      kind: "ready";
      context: LearningTaskRequestContext;
      preparedDispatch: PreparedLearningTaskDispatch;
      replayPayload: LearningTaskReplayPayload;
    }
  | {
      kind: "preflight-failed";
      attempt: LearningTaskAttemptStart;
      attemptStartRef?: LearningTaskEvidenceRef;
      failureReason: string;
    }
  | {
      kind: "dispatch-failed";
      attempt: LearningTaskAttemptStart;
      attemptStartRef: LearningTaskEvidenceRef;
      requestStamp: HuginRequestStamp;
      requestStampDigest: ReturnType<typeof requestStampDigest>;
      failureReason: string;
    };

function sourceDigest(
  sourceRef: string,
  sourceType: z.infer<typeof sourceDocumentTypeSchema>,
  sourceVersion: string,
  document: unknown,
): z.infer<typeof sourceDocumentDigestSchema> {
  return sourceDocumentDigestSchema.parse({
    algorithm: "sha256",
    canonicalization: "jcs-rfc8785-utf8-v1",
    source_ref: sourceRef,
    source_type: sourceType,
    source_version: sourceVersion,
    digest: jcsDigest(document),
  });
}

const PROMPT_CONFIG_DOCUMENT = {
  schema_version: "config-source/v1",
  component: "hugin",
  config_kind: "prompt",
  id: "hugin-direct-delegate-prompt",
  version: "v1",
  settings: {
    renderer: "renderHomeserverUserMessage",
    context_heading: "## Context",
    task_heading: "## Task",
    separator: "horizontal-rule-v1",
  },
};
const HARNESS_CONFIG_DOCUMENT = {
  schema_version: "config-source/v1",
  component: "hugin",
  config_kind: "harness",
  id: "homeserver-executor",
  version: "learning-task-v1",
  settings: {
    adapter: "m5-gateway-delegate",
    serializer: "grimnir-learning-task-v1",
    response_join: "exact-principal-bound-echo",
    timeout_policy: "bounded-abort-no-automatic-replay",
  },
};
const TOOL_POLICY_DOCUMENT = {
  schema_version: "config-source/v1",
  component: "hugin",
  config_kind: "tool-policy",
  id: "bounded-delegate",
  version: "learning-task-v1",
  settings: {
    allow: ["delegate", "configured-verifier"],
    deny: ["caller-stamp-override", "unbounded-shell"],
  },
};

function originConfig(): HuginRequestStamp["origin_config"] {
  return {
    prompt: {
      id: PROMPT_CONFIG_DOCUMENT.id,
      version: PROMPT_CONFIG_DOCUMENT.version,
      config_digest: sourceDigest(
        "source-doc:hugin/config/direct-delegate-prompt-v1",
        "origin-prompt-config",
        "config-source-v1",
        PROMPT_CONFIG_DOCUMENT,
      ),
    },
    harness: {
      id: HARNESS_CONFIG_DOCUMENT.id,
      version: HARNESS_CONFIG_DOCUMENT.version,
      config_digest: sourceDigest(
        "source-doc:hugin/config/homeserver-learning-task-v1",
        "origin-harness-config",
        "config-source-v1",
        HARNESS_CONFIG_DOCUMENT,
      ),
    },
    tool_policy: {
      id: TOOL_POLICY_DOCUMENT.id,
      version: TOOL_POLICY_DOCUMENT.version,
      config_digest: sourceDigest(
        "source-doc:hugin/config/bounded-delegate-learning-task-v1",
        "origin-tool-policy-config",
        "config-source-v1",
        TOOL_POLICY_DOCUMENT,
      ),
    },
  };
}

export function buildLearningTaskRequestStamp(input: {
  context: LearningTaskRequestContext;
  taskType: string;
  rawTaskText: string;
  renderedPrompt: string;
}): HuginRequestStamp {
  const { context } = input;
  const taskIdentity = buildHuginTaskIdentity({
    taskId: context.attempt.taskId,
    rawTaskText: input.rawTaskText,
    renderedPrompt: input.renderedPrompt,
  });
  if (!canonicalEqual(taskIdentity, context.attempt.huginTaskIdentity)
    || input.renderedPrompt !== context.attempt.renderedPrompt) {
    throw new LearningTaskHandshakeError("task bytes changed after durable attempt start");
  }
  const taskType = taskTypeSchema.parse({
    id: input.taskType,
    taxonomy_id: BROKER_TASK_TYPE_TAXONOMY_ID,
    taxonomy_version: BROKER_TASK_TYPE_TAXONOMY_VERSION,
  });
  const config = originConfig();
  const rawDocument = {
    schema_version: "raw-input/v1",
    fixture_only: false,
    origin_component: "hugin",
    input_role: "hugin-logical-prompt",
    encoding: "utf-8",
    text: input.rawTaskText,
  };
  const rawInput = sourceDigest(
    `source-doc:hugin/raw/${jcsDigest(rawDocument)}`,
    "raw-input",
    "raw-input-v1",
    rawDocument,
  );
  const envelopeRef = `source-doc:hugin/prompt/${context.attempt.attemptId.replace(/^hugin-attempt:/, "")}`;
  const envelopeDocument = {
    schema_version: "prompt-stage/v2",
    stage: "hugin-envelope",
    fixture_only: false,
    encoding: "utf-8",
    input_source_refs: [
      rawInput.source_ref,
      config.prompt.config_digest.source_ref,
      config.harness.config_digest.source_ref,
      config.tool_policy.config_digest.source_ref,
    ],
    text: input.renderedPrompt,
    byte_length: Buffer.byteLength(input.renderedPrompt, "utf8"),
    sha256: sha256Utf8(input.renderedPrompt),
    task_binding: context.attempt.taskId,
  };
  const stampedAt = timestampSchema.parse(context.stampedAt);
  const started = Date.parse(context.attempt.startedAt);
  const accepted = Date.parse(context.source.accepted_at);
  const requested = Date.parse(context.preflight.request.requested_at);
  const advertised = Date.parse(context.preflight.response.advertised_at);
  const stamped = Date.parse(stampedAt);
  const expires = Date.parse(context.preflight.response.expires_at);
  if (!(Date.parse(context.source.created_at) <= accepted
    && accepted <= started
    && started <= stamped
    // A previously authenticated request/advertisement pair may be cached
    // before this attempt. Its own request must still precede advertisement,
    // and the advertisement must remain fresh at this attempt's stamp time.
    // `requested`/`stamped` are Hugin-host clocks; `advertised`/`expires` are
    // gateway-host clocks, so those orderings carry the bounded cross-host
    // skew tolerance (#253, same as fetchLearningTaskPreflight and the
    // gateway-echo check) — with the expiry edge tightened, never extended.
    // The same-host chain above stays exact.
    && requested - LEARNING_TASK_CLOCK_SKEW_TOLERANCE_MS <= advertised
    && advertised <= stamped + LEARNING_TASK_CLOCK_SKEW_TOLERANCE_MS
    && stamped < expires - LEARNING_TASK_CLOCK_SKEW_TOLERANCE_MS)) {
    throw new LearningTaskHandshakeError("LearningTaskContract attempt/preflight/stamp clocks are out of order");
  }
  if (expires - advertised > LEARNING_TASK_PREFLIGHT_TTL_MS
    || !canonicalEqual(context.preflight.request.requested_capabilities, LEARNING_TASK_CAPABILITIES)
    || !canonicalEqual(context.preflight.response.capabilities, LEARNING_TASK_CAPABILITIES)) {
    throw new LearningTaskHandshakeError("LearningTaskContract preflight is stale or downgraded");
  }
  return huginRequestStampSchema.parse({
    task_instance_id: context.attempt.taskId,
    attempt_id: context.attempt.attemptId,
    client_id: "hugin",
    expected_transport_principal_id: context.expectedTransportPrincipalId,
    idempotency_key: context.idempotencyKey,
    request_id: context.requestId,
    stamped_at: stampedAt,
    contract_request: structuredClone(LEARNING_TASK_CAPABILITIES),
    preflight: structuredClone(context.preflight),
    source: structuredClone(context.source),
    task_type: taskType,
    raw_input: rawInput,
    raw_fingerprint: taskIdentity.rawTaskFingerprint,
    hugin_envelope: sourceDigest(
      envelopeRef,
      "prompt-stage",
      "prompt-stage-v2",
      envelopeDocument,
    ),
    origin_config: config,
    macro_decision: {
      policy_id: "hugin-runtime-selection",
      version: "homeserver-delegate-learning-task-v1",
      decision_id: `learning-task:${context.attempt.attemptId.replace(/^hugin-attempt:/, "")}`,
      target: "m5",
      service: "gille-inference",
    },
  });
}

export function requestStampDigest(stamp: HuginRequestStamp): {
  algorithm: "sha256";
  version: "hugin-request-stamp-jcs-v1";
  digest: string;
} {
  return {
    algorithm: "sha256",
    version: "hugin-request-stamp-jcs-v1",
    digest: jcsDigest(stamp),
  };
}

export function gatewayEchoDigest(echo: LearningTaskGatewayEcho): {
  algorithm: "sha256";
  version: "gateway-echo-jcs-v1";
  digest: string;
} {
  return {
    algorithm: "sha256",
    version: "gateway-echo-jcs-v1",
    digest: jcsDigest(echo),
  };
}

export function createPreparedLearningTaskDispatch(input: {
  context: LearningTaskRequestContext;
  requestStamp: HuginRequestStamp;
  requestBody: Record<string, unknown>;
}): {
  preparedDispatch: PreparedLearningTaskDispatch;
  replayPayload: LearningTaskReplayPayload;
} {
  const { context, requestStamp } = input;
  const attemptKey = learningTaskAttemptKey(context.attempt.attemptId);
  const replayPayload = learningTaskReplayPayloadSchema.parse({
    schemaVersion: 1,
    contractVersion: LEARNING_TASK_CONTRACT_VERSION,
    taskId: context.attempt.taskId,
    attemptId: context.attempt.attemptId,
    requestBody: structuredClone(input.requestBody),
  });
  if (!canonicalEqual(replayPayload.requestBody.learningTaskStamp, requestStamp)) {
    throw new LearningTaskHandshakeError("prepared replay body must carry the exact request stamp");
  }
  const preparedDispatch = preparedLearningTaskDispatchSchema.parse({
    schemaVersion: 1,
    contractVersion: LEARNING_TASK_CONTRACT_VERSION,
    taskId: context.attempt.taskId,
    attemptId: context.attempt.attemptId,
    attemptStartedAt: context.attempt.startedAt,
    preparedAt: requestStamp.stamped_at,
    attemptStartRef: context.attemptStartRef,
    preparedDispatchRef: {
      namespace: `tasks/${context.attempt.taskId}`,
      key: `${attemptKey}-prepared`,
    },
    replayPayloadRef: {
      namespace: `tasks/${context.attempt.taskId}`,
      key: `${attemptKey}-replay`,
    },
    replayPayloadDigest: {
      algorithm: "sha256",
      version: "hugin-replay-payload-jcs-v1",
      digest: jcsDigest(replayPayload),
    },
    attemptOutcomeRef: {
      namespace: `tasks/${context.attempt.taskId}`,
      key: `${attemptKey}-outcome`,
    },
    taskOutcomeRef: {
      namespace: `tasks/${context.attempt.taskId}`,
      key: "result-structured",
    },
    requestStamp,
    requestStampDigest: requestStampDigest(requestStamp),
  });
  validatePreparedLearningTaskReplayPayload(
    preparedDispatch,
    replayPayload,
    durableLearningTaskAttemptStart(context.attempt),
  );
  return { preparedDispatch, replayPayload };
}

export function validateLearningTaskReplayPayload(
  prepared: PreparedLearningTaskDispatch,
  raw: unknown,
): LearningTaskReplayPayload {
  const payload = learningTaskReplayPayloadSchema.parse(raw);
  if (payload.taskId !== prepared.taskId
    || payload.attemptId !== prepared.attemptId
    || !canonicalEqual(payload.requestBody.learningTaskStamp, prepared.requestStamp)) {
    throw new LearningTaskHandshakeError("classified replay payload does not bind the prepared dispatch");
  }
  const actualDigest = jcsDigest(payload);
  if (actualDigest !== prepared.replayPayloadDigest.digest) {
    throw new LearningTaskHandshakeError("classified replay payload digest mismatch");
  }
  return payload;
}

export function validatePreparedLearningTaskReplayPayload(
  prepared: PreparedLearningTaskDispatch,
  raw: unknown,
  attemptStart: DurableLearningTaskAttemptStart,
): LearningTaskReplayPayload {
  const payload = validateLearningTaskReplayPayload(prepared, raw);
  const delegateBody = learningTaskDelegateRequestBodySchema.safeParse(payload.requestBody);
  if (!delegateBody.success) {
    throw new LearningTaskHandshakeError(
      "classified replay payload does not contain a valid Hugin delegate body",
    );
  }
  if (!canonicalEqual(delegateBody.data.huginTaskIdentity, attemptStart.huginTaskIdentity)) {
    throw new LearningTaskHandshakeError(
      "classified replay payload Hugin identity does not exactly bind the immutable attempt start",
    );
  }
  const renderedPromptFingerprint = fingerprintRenderedPrompt(delegateBody.data.prompt);
  if (!canonicalEqual(
    renderedPromptFingerprint,
    attemptStart.huginTaskIdentity.renderedPromptFingerprint,
  )) {
    throw new LearningTaskHandshakeError(
      "classified replay prompt does not bind the immutable Hugin rendered-prompt fingerprint",
    );
  }
  return payload;
}

/**
 * Canonical prepared-dispatch ↔ attempt-outcome join.
 *
 * Keep every durable binding in one validator so normal completion, startup
 * recovery, and existing-outcome reuse cannot gradually accept different
 * subsets of the contract.
 */
export function validatePreparedLearningTaskOutcome(
  preparedInput: PreparedLearningTaskDispatch,
  raw: unknown,
): LearningTaskExecutionEvidence {
  const prepared = preparedLearningTaskDispatchSchema.parse(preparedInput);
  const outcome = learningTaskExecutionEvidenceSchema.parse(raw);
  const bindings: Array<[unknown, unknown]> = [
    [outcome.taskId, prepared.taskId],
    [outcome.attemptId, prepared.attemptId],
    [outcome.attemptStartedAt, prepared.attemptStartedAt],
    [outcome.attemptStartRef, prepared.attemptStartRef],
    [outcome.preparedDispatchRef, prepared.preparedDispatchRef],
    [outcome.replayPayloadRef, prepared.replayPayloadRef],
    [outcome.replayPayloadDigest, prepared.replayPayloadDigest],
    [outcome.attemptOutcomeRef, prepared.attemptOutcomeRef],
    [outcome.taskOutcomeRef, prepared.taskOutcomeRef],
    [outcome.rawFingerprint, prepared.requestStamp.raw_fingerprint],
    [outcome.requestStamp, prepared.requestStamp],
    [outcome.requestStampDigest, prepared.requestStampDigest],
  ];
  if (bindings.some(([actual, expected]) => !canonicalEqual(actual, expected))) {
    throw new LearningTaskHandshakeError(
      "durable learning-task outcome does not bind the selected prepared dispatch",
    );
  }
  // The evidence schema already verifies the exact echo, digest, principal,
  // capabilities, and admission clock against outcome.requestStamp. Re-run the
  // public validator here to make that dependency explicit at the canonical
  // prepared/outcome join.
  if (outcome.gatewayEcho) {
    validateLearningTaskGatewayEcho(
      outcome.gatewayEcho,
      prepared.requestStamp,
      new Date(outcome.gatewayEcho.admitted_at),
    );
    if (!outcome.gatewayEchoDigest
      || !canonicalEqual(outcome.gatewayEchoDigest, gatewayEchoDigest(outcome.gatewayEcho))) {
      throw new LearningTaskHandshakeError(
        "durable learning-task outcome gateway echo digest mismatch",
      );
    }
  }
  return outcome;
}

export function learningTaskRecoveryFailure(
  prepared: PreparedLearningTaskDispatch,
  reason: string,
): LearningTaskExecutionEvidence {
  return learningTaskExecutionEvidenceSchema.parse({
    schemaVersion: 1,
    contractVersion: LEARNING_TASK_CONTRACT_VERSION,
    state: "join-failed",
    evidenceAccepted: false,
    taskId: prepared.taskId,
    attemptId: prepared.attemptId,
    attemptStartedAt: prepared.attemptStartedAt,
    attemptStartRef: prepared.attemptStartRef,
    preparedDispatchRef: prepared.preparedDispatchRef,
    replayPayloadRef: prepared.replayPayloadRef,
    replayPayloadDigest: prepared.replayPayloadDigest,
    taskOutcomeRef: prepared.taskOutcomeRef,
    rawFingerprint: prepared.requestStamp.raw_fingerprint,
    requestStamp: prepared.requestStamp,
    requestStampDigest: prepared.requestStampDigest,
    attemptOutcomeRef: prepared.attemptOutcomeRef,
    failureCode: "recovery-unavailable",
    failureReason: reason.slice(0, 512),
  });
}

export async function recoverPreparedLearningTaskDispatch(input: {
  prepared: PreparedLearningTaskDispatch;
  replayPayload: unknown;
  gatewayBaseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<LearningTaskExecutionEvidence> {
  const prepared = preparedLearningTaskDispatchSchema.parse(input.prepared);
  const replay = validateLearningTaskReplayPayload(prepared, input.replayPayload);
  const baseEvidence = learningTaskRecoveryFailure(
    prepared,
    "exact prepared-dispatch recovery has not completed",
  );
  try {
    const response = await (input.fetchImpl ?? fetch)(`${input.gatewayBaseUrl}/delegate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
      body: JSON.stringify(replay.requestBody),
      signal: input.signal
        ?? AbortSignal.timeout(Math.min(30_000, Math.max(1, input.timeoutMs ?? 30_000))),
    });
    if (!response.ok) {
      return learningTaskRecoveryFailure(
        prepared,
        `exact prepared-dispatch recovery returned HTTP ${response.status}`,
      );
    }
    const raw = await readBoundedJson(response) as {
      learningTaskAdmission?: { recovered?: unknown; outcomeAvailable?: unknown };
      learningTaskGatewayEcho?: unknown;
    };
    if (raw.learningTaskAdmission?.recovered !== true
      || raw.learningTaskAdmission?.outcomeAvailable !== false) {
      return learningTaskRecoveryFailure(
        prepared,
        "gateway did not prove exact stored-admission recovery without inference replay",
      );
    }
    const echo = validateLearningTaskGatewayEcho(
      raw.learningTaskGatewayEcho,
      prepared.requestStamp,
    );
    return learningTaskExecutionEvidenceSchema.parse({
      ...baseEvidence,
      state: "m5-admitted",
      evidenceAccepted: true,
      gatewayEcho: echo,
      gatewayEchoDigest: gatewayEchoDigest(echo),
      failureCode: undefined,
      failureReason: undefined,
    });
  } catch (error) {
    return learningTaskRecoveryFailure(
      prepared,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Preserve known evidence shape when the immutable outcome receipt cannot be created. */
export function learningTaskOutcomePersistenceFailure(
  evidence: LearningTaskExecutionEvidence,
  reason = "durable learning-task attempt outcome write failed",
): LearningTaskExecutionEvidence {
  return learningTaskExecutionEvidenceSchema.parse({
    ...evidence,
    state: evidence.state === "preflight-failed" ? "preflight-failed" : "join-failed",
    evidenceAccepted: false,
    attemptOutcomeRef: undefined,
    failureCode: "attempt-outcome-persistence-failed",
    failureReason: reason.slice(0, 512),
  });
}

export function validateLearningTaskGatewayEcho(
  raw: unknown,
  stamp: HuginRequestStamp,
  observedAt: Date = new Date(),
): LearningTaskGatewayEcho {
  const parsed = learningTaskGatewayEchoSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LearningTaskHandshakeError("gateway returned a missing or malformed LearningTaskContract echo");
  }
  const echo = parsed.data;
  if (!canonicalEqual(echo.echoed_request, stamp)) {
    throw new LearningTaskHandshakeError("gateway echo does not exactly reproduce the Hugin request stamp");
  }
  if (!canonicalEqual(echo.capabilities, stamp.contract_request)) {
    throw new LearningTaskHandshakeError("gateway echo downgraded LearningTaskContract capabilities");
  }
  if (echo.authenticated_principal_id !== stamp.expected_transport_principal_id
    || echo.authentication !== "gateway-owner-auth") {
    throw new LearningTaskHandshakeError("gateway echo authenticated principal substitution");
  }
  const admitted = Date.parse(echo.admitted_at);
  // `stamped_at`/`observedAt` are Hugin-host clocks; `admitted_at` is a gateway-host clock.
  // Same bounded cross-host skew tolerance as the preflight freshness check (#253).
  if (!(
    Date.parse(stamp.stamped_at) - LEARNING_TASK_CLOCK_SKEW_TOLERANCE_MS <= admitted
    && admitted <= observedAt.getTime() + LEARNING_TASK_CLOCK_SKEW_TOLERANCE_MS
  )) {
    throw new LearningTaskHandshakeError("gateway admission clock is outside the request/observation interval");
  }
  const expectedBinding = jcsDigest({
    authenticated_principal_id: echo.authenticated_principal_id,
    request_stamp: stamp,
  });
  if (echo.principal_binding_digest.digest !== expectedBinding) {
    throw new LearningTaskHandshakeError("gateway principal/request binding digest mismatch");
  }
  return echo;
}

export function createLearningTaskRequestContext(input: {
  attempt: LearningTaskAttemptStart;
  attemptStartRef: LearningTaskEvidenceRef;
  source: LearningTaskSource;
  preflight: Awaited<ReturnType<typeof fetchLearningTaskPreflight>>;
  stampedAt: string;
  randomUuid?: () => string;
}): LearningTaskRequestContext {
  const uuid = input.randomUuid ?? randomUUID;
  return {
    attempt: input.attempt,
    attemptStartRef: input.attemptStartRef,
    expectedTransportPrincipalId: input.preflight.expectedTransportPrincipalId,
    idempotencyKey: opaqueId(uuid()),
    requestId: opaqueId(uuid()),
    source: sourceSchema.parse(input.source),
    preflight: input.preflight.preflight,
    stampedAt: timestampSchema.parse(input.stampedAt),
  };
}

/**
 * Linearized producer preparation used by the dispatcher. The injected start
 * writer must complete before this function performs either authenticated M5
 * read, so a gateway can never observe a stamp for an attempt Hugin did not
 * first make durable.
 */
export async function prepareDurableLearningTaskAttempt(input: {
  taskId: string;
  startedAt: string;
  rawTaskText: string;
  renderedPrompt: string;
  gatewayBaseUrl: string;
  apiKey: string;
  buildSource: () => LearningTaskSource;
  persistStart: (
    ref: LearningTaskEvidenceRef,
    record: DurableLearningTaskAttemptStart,
    signal?: AbortSignal,
  ) => Promise<void>;
  buildPreparedDispatch: (
    context: LearningTaskRequestContext,
  ) => {
    preparedDispatch: PreparedLearningTaskDispatch;
    replayPayload: LearningTaskReplayPayload;
  };
  persistReplayPayload: (
    ref: LearningTaskEvidenceRef,
    record: LearningTaskReplayPayload,
    signal?: AbortSignal,
  ) => Promise<void>;
  persistPrepared: (
    ref: LearningTaskEvidenceRef,
    record: PreparedLearningTaskDispatch,
    signal?: AbortSignal,
  ) => Promise<void>;
  now?: () => Date;
  randomUuid?: () => string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{
  attempt: LearningTaskAttemptStart;
  attemptStartRef: LearningTaskEvidenceRef;
  startPersisted: boolean;
  preparation: LearningTaskPreparation;
}> {
  const uuid = input.randomUuid ?? randomUUID;
  const now = input.now ?? (() => new Date());
  const attempt = createLearningTaskAttemptStart({
    taskId: input.taskId,
    attemptId: `hugin-attempt:${uuid()}`,
    startedAt: input.startedAt,
    rawTaskText: input.rawTaskText,
    renderedPrompt: input.renderedPrompt,
  });
  const attemptStartRef = {
    namespace: `tasks/${input.taskId}`,
    key: learningTaskAttemptKey(attempt.attemptId),
  };
  let startPersisted = false;
  let preparedDispatch: PreparedLearningTaskDispatch | undefined;
  let replayPayload: LearningTaskReplayPayload | undefined;
  try {
    if (input.signal?.aborted) throw new Error("learning-task preparation deadline exceeded");
    await input.persistStart(attemptStartRef, durableLearningTaskAttemptStart(attempt), input.signal);
    startPersisted = true;
    if (input.signal?.aborted) throw new Error("learning-task preparation deadline exceeded");
    const source = input.buildSource();
    const preflight = await fetchLearningTaskPreflight({
      gatewayBaseUrl: input.gatewayBaseUrl,
      apiKey: input.apiKey,
      attemptStartedAt: attempt.startedAt,
      now,
      randomUuid: uuid,
      fetchImpl: input.fetchImpl,
      signal: input.signal,
    });
    if (input.signal?.aborted) throw new Error("learning-task preparation deadline exceeded");
    // The accepted preflight establishes the earliest safe point to freeze the
    // request stamp. Every later defensive serialization must reuse this exact
    // timestamp rather than sample wall-clock time again.
    const stampedAt = timestampSchema.parse(now().toISOString());
    const context = createLearningTaskRequestContext({
      attempt,
      attemptStartRef,
      source,
      preflight,
      stampedAt,
      randomUuid: uuid,
    });
    const prepared = input.buildPreparedDispatch(context);
    preparedDispatch = prepared.preparedDispatch;
    replayPayload = prepared.replayPayload;
    await input.persistReplayPayload(preparedDispatch.replayPayloadRef, replayPayload, input.signal);
    if (input.signal?.aborted) throw new Error("learning-task preparation deadline exceeded");
    await input.persistPrepared(preparedDispatch.preparedDispatchRef, preparedDispatch, input.signal);
    return {
      attempt,
      attemptStartRef,
      startPersisted,
      preparation: {
        kind: "ready",
        context,
        preparedDispatch,
        replayPayload,
      },
    };
  } catch (err) {
    if (preparedDispatch) {
      return {
        attempt,
        attemptStartRef,
        startPersisted,
        preparation: {
          kind: "dispatch-failed",
          attempt,
          attemptStartRef,
          requestStamp: preparedDispatch.requestStamp,
          requestStampDigest: preparedDispatch.requestStampDigest,
          failureReason: (err instanceof Error ? err.message : String(err)).slice(0, 512),
        },
      };
    }
    return {
      attempt,
      attemptStartRef,
      startPersisted,
      preparation: {
        kind: "preflight-failed",
        attempt,
        attemptStartRef: startPersisted ? attemptStartRef : undefined,
        failureReason: (err instanceof Error ? err.message : String(err)).slice(0, 512),
      },
    };
  }
}
