import { randomUUID } from "node:crypto";
import { z } from "zod";
import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { CodeHealthIdentityBinding } from "./code-health-identity.js";

export type CodeHealthClassification =
  | "public"
  | "internal"
  | "client-confidential"
  | "client-restricted";

export interface CodeHealthAppendRequest {
  action: "append";
  namespace: string;
  idempotency_key: string;
  record: Record<string, unknown>;
  classification?: CodeHealthClassification;
  expected_updated_at?: string;
}

export type CodeHealthDeliveryResult = {
  status: "acknowledged" | "queued" | "unsaved";
  recordId: string;
  receipt?: {
    record_id: string;
    collected_at: string;
    expires_at: string;
    updated_at: string;
    classification: string;
  };
  reason?: string;
};

export interface CodeHealthCaptureSnapshot {
  observationRefs: string[];
  assessmentRefs: string[];
  assessmentState: "missing" | "partial" | "complete";
  observedModel: string | null;
  captureDelivery: Array<{
    recordId: string;
    recordKind: "observation" | "assessment";
    status: "acknowledged" | "queued" | "unsaved";
    updatedAt?: string;
  }>;
}

export interface CodeHealthCaptureConfig {
  binding: CodeHealthIdentityBinding;
  namespace: string;
  classification?: CodeHealthClassification;
  requestedModel: string | null;
  observedModel: () => string | null;
  beforeSha: string | null;
  afterSha: string | null;
  parentAttemptId?: string | null;
  childAttemptIds?: readonly string[];
  validateCodeHealthRecord: (record: unknown) => Promise<{ valid: boolean; errors: string[] }>;
  deliverCodeHealth: (request: CodeHealthAppendRequest) => Promise<CodeHealthDeliveryResult>;
  createIdempotencyKey?: () => string;
}

interface CodeHealthTransportModule {
  validateCodeHealthRecord(record: unknown): Promise<{ valid: boolean; errors: string[] }>;
  deliverCodeHealth(
    request: CodeHealthAppendRequest,
    options: { outbox: unknown; writer: { codeHealthAppend(request: CodeHealthAppendRequest): Promise<unknown> } },
  ): Promise<CodeHealthDeliveryResult>;
}

/** Lazy binding to the sibling outbox leaf so pure SDK tests can inject transport behavior. */
export function createCodeHealthTransportDependencies(input: {
  outbox: unknown;
  writer: { codeHealthAppend(request: CodeHealthAppendRequest): Promise<unknown> };
}): Pick<CodeHealthCaptureConfig, "validateCodeHealthRecord" | "deliverCodeHealth"> {
  const loadTransport = async (): Promise<CodeHealthTransportModule> => {
    const moduleSpecifier = "./code-health-transport.js";
    return await import(moduleSpecifier) as unknown as CodeHealthTransportModule;
  };
  return {
    validateCodeHealthRecord: async (record) => (await loadTransport()).validateCodeHealthRecord(record),
    deliverCodeHealth: async (request) => (await loadTransport()).deliverCodeHealth(request, {
      outbox: input.outbox,
      writer: input.writer,
    }),
  };
}

const MAX_CAPTURE_RECORD_BYTES = 16 * 1024;
const MAX_CAPTURE_RECORDS = 32;
const MAX_OBSERVATIONS_PER_ATTEMPT = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REF_PATTERN = /^ref:[a-z0-9][a-z0-9-]{0,95}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const UPDATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const reportCodeHealthInput = {
  record: z.record(z.string(), z.unknown()),
  expected_updated_at: z.string().datetime().optional(),
};
const codeHealthContextInput = {} as const;

export type CodeHealthCaptureTool = SdkMcpToolDefinition<typeof reportCodeHealthInput> & {
  contextTool: SdkMcpToolDefinition<typeof codeHealthContextInput>;
  snapshot: () => CodeHealthCaptureSnapshot | undefined;
  settle: () => Promise<void>;
};

function errorResult(reason: string) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ accepted: false, reason }) }] };
}

function successResult(recordId: string, delivery: CodeHealthDeliveryResult) {
  const payload = {
    accepted: true,
    record_id: recordId,
    status: delivery.status,
    ...(delivery.status === "acknowledged" && delivery.receipt
      ? { updated_at: delivery.receipt.updated_at }
      : {}),
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("unsupported-json-value");
  return encoded;
}

function isSafeNamespace(namespace: string): boolean {
  return namespace.length > 0
    && namespace.length <= 200
    && namespace === namespace.trim()
    && !/[\u0000-\u001f\u007f]/.test(namespace);
}

export function isCodeHealthCaptureConfigValid(
  config: CodeHealthCaptureConfig,
  expectedTaskId?: string,
): boolean {
  const repo = config.binding.repo;
  return isSafeNamespace(config.namespace)
    && UUID_PATTERN.test(config.binding.attemptId)
    && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(config.binding.taskId)
    && (!expectedTaskId || config.binding.taskId === expectedTaskId)
    && config.binding.taskNamespace === `tasks/${config.binding.taskId}`
    && repo.owner === "Magnus-Gille"
    && (repo.name === "sagascript" || repo.name === "gille-inference")
    && (config.requestedModel === null || MODEL_PATTERN.test(config.requestedModel))
    && (config.beforeSha === null || SHA_PATTERN.test(config.beforeSha))
    && (config.afterSha === null || SHA_PATTERN.test(config.afterSha))
    && (config.parentAttemptId === undefined || config.parentAttemptId === null
      || /^[a-z0-9][a-z0-9._-]{0,95}$/.test(config.parentAttemptId))
    && (config.childAttemptIds === undefined || (config.childAttemptIds.length <= 128
      && config.childAttemptIds.every((id) => /^[a-z0-9][a-z0-9._-]{0,95}$/.test(id))))
    && (config.classification === undefined
      || ["public", "internal", "client-confidential", "client-restricted"].includes(config.classification));
}

function isModelOrUnknown(value: unknown, expected: string | null): boolean {
  return value === expected
    && (value === null || (typeof value === "string" && MODEL_PATTERN.test(value)));
}

function isBoundRecord(record: Record<string, unknown>, config: CodeHealthCaptureConfig): boolean {
  const { binding } = config;
  if (record.record_kind !== "observation" && record.record_kind !== "assessment") return false;
  if (record.repo_owner !== binding.repo.owner || record.repo_name !== binding.repo.name) return false;
  if (record.task_id !== binding.taskId || record.attempt_id !== binding.attemptId) return false;
  if (record.parent_attempt_id !== (config.parentAttemptId ?? null)) return false;
  if (record.before_sha !== config.beforeSha || record.after_sha !== config.afterSha) return false;
  if (typeof record.record_id !== "string" || !REF_PATTERN.test(record.record_id)) return false;

  const reporter = record.reporter;
  const worker = record.actual_worker;
  if (!isPlainRecord(reporter) || !isPlainRecord(worker)) return false;
  if (reporter.kind !== "worker" || worker.kind !== "worker") return false;
  if (!REF_PATTERN.test(String(reporter.id)) || !REF_PATTERN.test(String(worker.id))) return false;
  const observedModel = config.observedModel();
  if (observedModel !== null && !MODEL_PATTERN.test(observedModel)) return false;
  if (!isModelOrUnknown(reporter.requested_model, config.requestedModel)
    || !isModelOrUnknown(worker.requested_model, config.requestedModel)
    || !isModelOrUnknown(reporter.observed_model, observedModel)
    || !isModelOrUnknown(worker.observed_model, observedModel)
    || reporter.observed_effort !== null
    || worker.observed_effort !== null) return false;

  if (record.record_kind === "assessment") {
    const childAttemptIds = record.child_attempt_ids;
    const expectedChildAttemptIds = config.childAttemptIds ?? [];
    if (!Array.isArray(childAttemptIds)
      || childAttemptIds.length !== expectedChildAttemptIds.length
      || childAttemptIds.some((id, index) => id !== expectedChildAttemptIds[index])) return false;
  }
  return true;
}

function isCorrection(record: Record<string, unknown>): boolean {
  return record.supersedes_record_id !== null || record.correction_ref !== null;
}

function safeDeliveryResult(
  result: CodeHealthDeliveryResult,
  recordId: string,
): CodeHealthDeliveryResult {
  if (!result || result.recordId !== recordId) return { status: "unsaved", recordId };
  if (result.status === "queued" || result.status === "unsaved") return { status: result.status, recordId };
  if (result.status !== "acknowledged"
    || !result.receipt
    || result.receipt.record_id !== recordId
    || !UPDATED_AT_PATTERN.test(result.receipt.updated_at)
    || !Number.isFinite(Date.parse(result.receipt.updated_at))) {
    return { status: "unsaved", recordId };
  }
  return {
    status: "acknowledged",
    recordId,
    receipt: { ...result.receipt },
  };
}

/** Build the one fixed in-process SDK tool for an already authorized task binding. */
export function createCodeHealthCaptureTool(config: CodeHealthCaptureConfig): CodeHealthCaptureTool {
  if (!isCodeHealthCaptureConfigValid(config)) throw new Error("code-health capture config is invalid");

  const createIdempotencyKey = config.createIdempotencyKey ?? randomUUID;
  const observationRefs: string[] = [];
  const assessmentRefs: string[] = [];
  const captureDelivery: CodeHealthCaptureSnapshot["captureDelivery"] = [];
  const seen = new Map<string, { canonicalRecord: string; response: ReturnType<typeof successResult> }>();
  const pendingHandlers = new Set<Promise<unknown>>();
  let handlerQueue: Promise<void> = Promise.resolve();
  let assessmentState: CodeHealthCaptureSnapshot["assessmentState"] = "missing";
  let observationCount = 0;

  const handleInput = async ({ record: inputRecord, expected_updated_at }: {
    record: Record<string, unknown>;
    expected_updated_at?: string;
  }) => {
      let encoded: string;
      let canonical: string;
      let record: Record<string, unknown>;
      try {
        encoded = JSON.stringify(inputRecord);
        canonical = canonicalJson(inputRecord);
        record = JSON.parse(encoded) as Record<string, unknown>;
      } catch {
        return errorResult("invalid_record");
      }
      if (!isPlainRecord(record)
        || Buffer.byteLength(encoded, "utf8") > MAX_CAPTURE_RECORD_BYTES
        || !REF_PATTERN.test(String(record.record_id ?? ""))) return errorResult("invalid_record");

      const recordId = record.record_id as string;
      const prior = seen.get(recordId);
      const requestCanonical = `${canonical}\0${expected_updated_at ?? ""}`;
      if (prior) {
        return prior.canonicalRecord === requestCanonical
          ? prior.response
          : errorResult("record_id_conflict");
      }
      if (captureDelivery.length >= MAX_CAPTURE_RECORDS) return errorResult("capture_limit");
      if (record.record_kind === "observation" && observationCount >= MAX_OBSERVATIONS_PER_ATTEMPT) {
        return errorResult("observation_limit");
      }

      try {
        const validation = await config.validateCodeHealthRecord(record);
        if (!validation.valid) return errorResult("invalid_record");
      } catch {
        return errorResult("invalid_record");
      }
      if (!isBoundRecord(record, config)) return errorResult("identity_mismatch");

      const correction = isCorrection(record);
      if (correction !== (expected_updated_at !== undefined)) return errorResult("correction_cas_required");
      if (expected_updated_at !== undefined
        && (!UPDATED_AT_PATTERN.test(expected_updated_at) || !Number.isFinite(Date.parse(expected_updated_at)))) {
        return errorResult("invalid_correction_cas");
      }

      const recordKind = record.record_kind as "observation" | "assessment";
      const idempotencyKey = createIdempotencyKey();
      if (!UUID_PATTERN.test(idempotencyKey)) return errorResult("delivery_unavailable");
      const request: CodeHealthAppendRequest = {
        action: "append",
        namespace: config.namespace,
        idempotency_key: idempotencyKey,
        record,
        ...(config.classification ? { classification: config.classification } : {}),
        ...(expected_updated_at ? { expected_updated_at } : {}),
      };
      let delivery: CodeHealthDeliveryResult;
      try {
        delivery = safeDeliveryResult(await config.deliverCodeHealth(request), recordId);
      } catch {
        delivery = { status: "unsaved", recordId };
      }

      if (recordKind === "observation") {
        observationCount++;
        observationRefs.push(recordId);
      } else {
        assessmentRefs.push(recordId);
        assessmentState = record.completeness === "complete" ? "complete" : "partial";
      }
      captureDelivery.push({
        recordId,
        recordKind,
        status: delivery.status,
        ...(delivery.status === "acknowledged" && delivery.receipt
          ? { updatedAt: delivery.receipt.updated_at }
          : {}),
      });
      const response = successResult(recordId, delivery);
      seen.set(recordId, { canonicalRecord: requestCanonical, response });
      return response;
  };

  const definition = tool(
    "report_code_health",
    "Submit one canonical code-health observation or assessment. Hugin binds task identity and reports delivery state.",
    reportCodeHealthInput,
    async (input) => {
      // Serialize admission so duplicate IDs and per-attempt bounds cannot be
      // raced by parallel SDK tool callbacks.
      const operation = handlerQueue.then(() => handleInput(input));
      handlerQueue = operation.then(() => undefined, () => undefined);
      pendingHandlers.add(operation);
      try {
        return await operation;
      } finally {
        pendingHandlers.delete(operation);
      }
    },
  );

  const contextTool = tool(
    "get_code_health_context",
    "Read the fixed code-health capture identity and canonical schema guide. Call before submitting records; it returns task metadata and contract fields only, never task prompts or source code.",
    codeHealthContextInput,
    async () => ({
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          binding: {
            repo_owner: config.binding.repo.owner,
            repo_name: config.binding.repo.name,
            task_id: config.binding.taskId,
            attempt_id: config.binding.attemptId,
            parent_attempt_id: config.parentAttemptId ?? null,
            child_attempt_ids: config.childAttemptIds ?? [],
            before_sha: config.beforeSha,
            after_sha: config.afterSha,
            requested_model: config.requestedModel,
            observed_model: config.observedModel(),
          },
          fixed: {
            version: "1.0",
            rubric_version: "changeability-1.0",
            namespace: config.namespace,
            classification: config.classification ?? null,
            task_class: "not supplied by Hugin; do not guess, and omit capture if it cannot be selected from the actual task",
            record_id_format: "ref:<lowercase-id>",
            refs_format: "ref:<lowercase-id>",
            reporter_and_actual_worker: {
              required: ["id", "kind", "requested_model", "observed_model", "observed_effort"],
              kind: "worker",
              id: "opaque ref from the owning repository's evidence registry",
              model_or_unknown: "token-or-null",
              observed_effort: null,
              requested_and_observed_model: "Use the exact binding above; null means unknown.",
            },
            timestamps: "whole-second UTC in YYYY-MM-DDTHH:mm:ssZ form",
            sha: "null or exact 40-character lowercase commit SHA from the binding",
            object_policy: "Closed objects: do not add fields outside the listed contract.",
          },
          observation: {
            required: [
              "record_kind", "version", "repo_owner", "repo_name", "task_id", "task_class",
              "attempt_id", "parent_attempt_id", "record_id", "observed_at", "before_sha", "after_sha",
              "module_refs", "reporter", "actual_worker", "occurrence_id", "dimension", "polarity",
              "cause", "supporting_refs", "counter_refs", "source_observation_ref", "rubric_version",
              "supersedes_record_id", "correction_ref",
            ],
            enums: {
              task_class: ["implementation", "refactor", "test", "docs", "investigation", "qa"],
              dimension: ["locate", "understand", "verify"],
              polarity: ["positive", "negative"],
              cause: ["code", "environment", "mixed"],
            },
            supporting_refs_min: 1,
            supporting_refs_max: 3,
            counter_refs_max: 3,
            module_refs_max: 16,
          },
          assessment: {
            required: [
              "record_kind", "version", "repo_owner", "repo_name", "task_id", "task_class",
              "attempt_id", "parent_attempt_id", "child_attempt_ids", "record_id", "observed_at",
              "before_sha", "after_sha", "module_refs", "reporter", "actual_worker", "rubric_version",
              "applicability", "outcome", "completeness", "environment", "observation_refs", "ratings",
              "supersedes_record_id", "correction_ref",
            ],
            enums: {
              task_class: ["implementation", "refactor", "test", "docs", "investigation", "qa"],
              applicability: ["applicable", "not_applicable"],
              outcome: ["completed", "partial", "failed", "aborted"],
              completeness: ["complete", "partial"],
              environment: ["available", "unavailable", "unknown"],
              rating_dimension: ["locate", "understand", "verify"],
              rating_value: ["easy", "manageable", "difficult", "not-assessable"],
              rating_reason: ["grounded", "environment_unavailable", "insufficient_evidence", "not_applicable"],
            },
            rating_count: 3,
            observation_refs_max: 3,
          },
          rubric: {
            locate: {
              easy: "One obvious owning file or symbol.",
              manageable: "Two or three related files, or one indirection.",
              difficult: "Distributed or ambiguous ownership, or a hidden consumer.",
            },
            understand: {
              easy: "Local behavior and explicit contract.",
              manageable: "A few known callers, data paths, or compatibility details.",
              difficult: "Hidden consumers, cross-layer contracts, or materially uncertain state.",
            },
            verify: {
              easy: "An available deterministic direct check.",
              manageable: "Small setup, several checks, or contract inspection.",
              difficult: "Validation spans layers or remains materially uncertain despite available checks.",
            },
            not_assessable: "Separate from easy; use when evidence is insufficient or the environment is unavailable.",
            do_not_aggregate: true,
          },
          privacy: "Use only opaque refs from the owning repository's evidence registry for module, supporting, counter, and rating references. If required evidence cannot be referenced safely, skip capture or mark the dimension not-assessable. Do not include prompts, copied code, diffs, transcripts, user text, URLs, filesystem paths, credentials, raw errors, or private locators. Summaries, if used, must be sanitized paraphrases. Supply ratings only when grounded in actual work; never infer ratings from lifecycle status.",
        }),
      }],
    }),
  );
  return Object.assign(definition, {
    contextTool,
    snapshot: () => captureDelivery.length === 0
      ? undefined
      : {
          observationRefs: [...observationRefs],
          assessmentRefs: [...assessmentRefs],
          assessmentState,
          observedModel: config.observedModel(),
          captureDelivery: captureDelivery.map((entry) => ({ ...entry })),
        },
    settle: async () => {
      while (pendingHandlers.size > 0) {
        await Promise.allSettled([...pendingHandlers]);
      }
    },
  }) as CodeHealthCaptureTool & { contextTool: typeof contextTool };
}
