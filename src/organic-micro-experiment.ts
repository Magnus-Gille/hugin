/**
 * Organic micro-experiment seam (hugin#384).
 *
 * This module is deliberately smaller than the standing harness sampler.  The
 * sampler compares existing execution lanes; this seam records one optional,
 * content-blind M5 shadow beside ordinary work.  It has no routing or
 * promotion authority.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  structuredTaskResultSchema,
  type StructuredTaskResult,
} from "./task-result-schema.js";

export const MICRO_EXPERIMENT_SCHEMA_VERSION = "grimnir.micro-experiment/v1" as const;
export const MICRO_EXPERIMENT_CANONICALIZATION = "micro-experiment-canonical-json-v1" as const;
export const MICRO_EXPERIMENT_DEFAULT_MAX_WALL_MS = 30_000;
export const MICRO_EXPERIMENT_DEFAULT_MAX_COMPLETION_TOKENS = 256;
export const MICRO_EXPERIMENT_DEFAULT_MINIMUM_OBSERVATIONS = 10;
export const MICRO_EXPERIMENT_MAX_WALL_MS = 120_000;
export const MICRO_EXPERIMENT_MAX_COMPLETION_TOKENS = 32_768;
/** Bounded LearningTask/preflight and evidence headroom around the unchanged
 * baseline executor timeout. The shadow wall budget is never clamped after
 * eligibility: tasks whose timeout + headroom exceeds the v1 cap abstain. */
export const MICRO_EXPERIMENT_SHADOW_PREP_HEADROOM_MS = 5_000;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const refSchema = z.string().regex(/^ref:[a-z][a-z0-9-]{2,95}$/);
const idSchema = z.string().regex(/^[a-z][a-z0-9-]{2,95}$/);
const timestampSchema = z.string().datetime({ offset: true });

const axisKindSchema = z.enum([
  "model-route",
  "prompt",
  "harness",
  "tool-policy",
  "runtime-parameter",
]);

const runSchema = z.object({
  role: z.enum(["baseline", "challenger"]),
  binding_digest: digestSchema,
  execution_status: z.enum(["completed", "failed", "timed-out"]),
  output_digest: digestSchema,
  oracle_status: z.enum(["pass", "fail", "not-run"]),
  latency_ms: z.number().int().min(0),
  prompt_tokens: z.number().int().min(0).optional(),
  completion_tokens: z.number().int().min(0).optional(),
}).strict();

const admissionSchema = z.object({
  learning_task_status: z.enum(["admitted", "not-evaluated", "rejected"]),
  transport_identity: z.enum(["authenticated-echo", "local-loopback", "not-applicable"]),
  bundle_digest: digestSchema.nullable(),
}).strict();

const terminalSchema = z.object({
  status: z.enum(["PASS", "HOLD", "INVALID"]),
  reasons: z.array(z.enum([
    "challenger-oracle-pass",
    "challenger-oracle-fail",
    "primary-oracle-fail",
    "shadow-execution-failed",
    "budget-exceeded",
    "identity-mismatch",
    "evidence-incomplete",
    "insufficient-benefit",
    "single-observation-only",
  ])).min(1),
  aggregation_eligibility: z.enum(["eligible", "diagnostic-only", "ineligible"]),
  policy_candidate: z.literal("not-created"),
  primary_delivery: z.literal("baseline"),
  production_mutation: z.literal("none"),
}).strict();

const planSchema = z.object({
  kind: z.literal("micro-experiment-plan"),
  schema_version: z.literal(MICRO_EXPERIMENT_SCHEMA_VERSION),
  experiment_id: idSchema,
  created_at: timestampSchema,
  source: z.object({
    mode: z.enum(["organic", "synthetic"]),
    task_ref: refSchema,
    input_digest: digestSchema,
    allowed_use: z.literal("evaluation"),
  }).strict(),
  axis: z.object({
    kind: axisKindSchema,
    changed_fields: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{1,79}$/)).length(1),
    baseline_binding_ref: refSchema,
    baseline_binding_digest: digestSchema,
    challenger_binding_ref: refSchema,
    challenger_binding_digest: digestSchema,
  }).strict(),
  execution: z.object({
    primary_path: z.literal("baseline"),
    normal_work_independent: z.literal(true),
    shadow_count: z.literal(1),
    shadow_non_blocking: z.literal(true),
    shadow_side_effects: z.literal("none"),
    max_wall_ms: z.number().int().positive(),
    max_completion_tokens: z.number().int().positive(),
  }).strict(),
  oracle: z.object({
    kind: z.literal("deterministic"),
    oracle_id: idSchema,
    oracle_digest: digestSchema,
  }).strict(),
  aggregation_policy: z.object({
    minimum_observations: z.number().int().min(10),
    single_observation_policy_candidate: z.literal(false),
    mutation_authorized: z.literal(false),
  }).strict(),
  evidence_policy: z.object({
    contains_task_content: z.literal(false),
    contains_output_content: z.literal(false),
    retention_class: z.literal("content-blind-metrics"),
  }).strict(),
  plan_digest: digestSchema,
}).strict();

const resultSchema = z.object({
  kind: z.literal("micro-experiment-result"),
  schema_version: z.literal(MICRO_EXPERIMENT_SCHEMA_VERSION),
  result_id: idSchema,
  experiment_id: idSchema,
  plan_digest: digestSchema,
  started_at: timestampSchema,
  finished_at: timestampSchema,
  primary: runSchema,
  shadow: runSchema,
  terminal: terminalSchema,
  admission: admissionSchema,
  evidence_policy: z.object({
    contains_task_content: z.literal(false),
    contains_output_content: z.literal(false),
    evidence_complete: z.boolean(),
  }).strict(),
  result_digest: digestSchema,
}).strict();

export type OrganicMicroExperimentPlan = z.infer<typeof planSchema>;
export type OrganicMicroExperimentResult = z.infer<typeof resultSchema>;
export type OrganicMicroExperimentRun = z.infer<typeof runSchema>;
export type OrganicMicroExperimentAdmission = z.infer<typeof admissionSchema>;
export type OrganicMicroExperimentTerminal = z.infer<typeof terminalSchema>;

export type OrganicEligibilityReason =
  | "disabled"
  | "not-organic"
  | "missing-deterministic-verifier"
  | "recursive-shadow"
  | "invalid-identity"
  | "invalid-binding";

export interface OrganicEligibilityInput {
  enabled: boolean;
  taskId: string;
  taskRef: string;
  createdAt: string;
  inputDigest: string;
  authenticatedSource: boolean;
  deterministicVerifier: boolean;
  recursiveShadow?: boolean;
  baselineBindingRef: string;
  baselineBindingDigest: string;
  challengerBindingRef: string;
  challengerBindingDigest: string;
  oracleId: string;
  oracleDigest: string;
  axisKind?: z.infer<typeof axisKindSchema>;
  changedFields?: string[];
  maxWallMs?: number;
  maxCompletionTokens?: number;
  minimumObservations?: number;
}

export type OrganicEligibility =
  | { eligible: true; plan: OrganicMicroExperimentPlan }
  | { eligible: false; reason: OrganicEligibilityReason };

/**
 * Canonical JSON for the Grimnir v1 micro-experiment digest. JSON object keys
 * are sorted recursively and arrays retain their order. This intentionally
 * avoids storing or returning the input/output bytes themselves.
 */
export function canonicalMicroExperimentJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number is not canonical JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalMicroExperimentJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalMicroExperimentJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`unsupported value in canonical JSON: ${typeof value}`);
}

export function microExperimentDigest(value: unknown, omitField?: string): string {
  const copy = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : value;
  if (omitField && copy && typeof copy === "object" && !Array.isArray(copy)) {
    delete (copy as Record<string, unknown>)[omitField];
  }
  return `sha256:${createHash("sha256")
    .update(canonicalMicroExperimentJson(copy), "utf8")
    .digest("hex")}`;
}

export function organicOracleDigestForVerifier(verifier: unknown): string {
  return microExperimentDigest(verifier);
}

export function organicVerifierDigestMatches(verifier: unknown, configuredDigest: string): boolean {
  try {
    return isDigest(configuredDigest) && organicOracleDigestForVerifier(verifier) === configuredDigest;
  } catch {
    return false;
  }
}

/** The owner binding must name the exact task model before a plan is frozen. */
export function organicBaselineModelMatchesTask(
  configuredModel: string,
  taskModel: string | undefined,
): boolean {
  return configuredModel.length > 0 && taskModel !== undefined && taskModel === configuredModel;
}

/** A shadow is admitted only after the gateway proves the effective baseline model. */
export function organicBaselineModelMatchesResult(
  configuredModel: string,
  effectiveModel: string | null,
): boolean {
  return configuredModel.length > 0 && effectiveModel !== null && effectiveModel === configuredModel;
}

export function shadowWallBudgetForBaselineTimeout(timeoutMs: number): number | null {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return null;
  const total = timeoutMs + MICRO_EXPERIMENT_SHADOW_PREP_HEADROOM_MS;
  return total <= MICRO_EXPERIMENT_MAX_WALL_MS ? total : null;
}

function idFromTask(taskId: string): string {
  return `organic-${createHash("sha256").update(taskId, "utf8").digest("hex").slice(0, 24)}`;
}

function isDigest(value: string): boolean {
  return digestSchema.safeParse(value).success;
}

function isRef(value: string): boolean {
  return refSchema.safeParse(value).success;
}

/** Build the plan before baseline dispatch. No verifier or identity means no plan. */
export function decideOrganicEligibility(input: OrganicEligibilityInput): OrganicEligibility {
  if (!input.enabled) return { eligible: false, reason: "disabled" };
  if (!input.authenticatedSource) return { eligible: false, reason: "not-organic" };
  if (input.recursiveShadow) return { eligible: false, reason: "recursive-shadow" };
  if (!input.deterministicVerifier) return { eligible: false, reason: "missing-deterministic-verifier" };
  if (!timestampSchema.safeParse(input.createdAt).success) return { eligible: false, reason: "invalid-identity" };
  if (!isDigest(input.inputDigest)
    || !isDigest(input.baselineBindingDigest)
    || !isDigest(input.challengerBindingDigest)
    || !isDigest(input.oracleDigest)
    || !isRef(input.taskRef)
    || !isRef(input.baselineBindingRef)
    || !isRef(input.challengerBindingRef)
    || !idSchema.safeParse(input.oracleId).success) {
    return { eligible: false, reason: "invalid-identity" };
  }
  if (input.baselineBindingDigest === input.challengerBindingDigest
    || input.baselineBindingRef === input.challengerBindingRef) {
    return { eligible: false, reason: "invalid-binding" };
  }
  const fields = input.changedFields ?? ["route.model"];
  if (fields.length !== 1 || new Set(fields).size !== fields.length
    || fields.some((field) => !/^[a-z][a-z0-9_.-]{1,79}$/.test(field))) {
    return { eligible: false, reason: "invalid-binding" };
  }
  const maxWallMs = input.maxWallMs ?? MICRO_EXPERIMENT_DEFAULT_MAX_WALL_MS;
  const maxCompletionTokens = input.maxCompletionTokens ?? MICRO_EXPERIMENT_DEFAULT_MAX_COMPLETION_TOKENS;
  const minimumObservations = input.minimumObservations ?? MICRO_EXPERIMENT_DEFAULT_MINIMUM_OBSERVATIONS;
  if (!Number.isSafeInteger(maxWallMs) || maxWallMs <= 0 || maxWallMs > MICRO_EXPERIMENT_MAX_WALL_MS
    || !Number.isSafeInteger(maxCompletionTokens) || maxCompletionTokens <= 0
    || maxCompletionTokens > MICRO_EXPERIMENT_MAX_COMPLETION_TOKENS
    || !Number.isSafeInteger(minimumObservations) || minimumObservations < 10) {
    return { eligible: false, reason: "invalid-binding" };
  }
  if (!axisKindSchema.safeParse(input.axisKind ?? "model-route").success) {
    return { eligible: false, reason: "invalid-binding" };
  }
  const plan: Omit<OrganicMicroExperimentPlan, "plan_digest"> = {
    kind: "micro-experiment-plan",
    schema_version: MICRO_EXPERIMENT_SCHEMA_VERSION,
    experiment_id: idFromTask(input.taskId),
    created_at: input.createdAt,
    source: {
      mode: "organic",
      task_ref: input.taskRef,
      input_digest: input.inputDigest,
      allowed_use: "evaluation",
    },
    axis: {
      kind: input.axisKind ?? "model-route",
      changed_fields: fields,
      baseline_binding_ref: input.baselineBindingRef,
      baseline_binding_digest: input.baselineBindingDigest,
      challenger_binding_ref: input.challengerBindingRef,
      challenger_binding_digest: input.challengerBindingDigest,
    },
    execution: {
      primary_path: "baseline",
      normal_work_independent: true,
      shadow_count: 1,
      shadow_non_blocking: true,
      shadow_side_effects: "none",
      max_wall_ms: maxWallMs,
      max_completion_tokens: maxCompletionTokens,
    },
    oracle: {
      kind: "deterministic",
      oracle_id: input.oracleId,
      oracle_digest: input.oracleDigest,
    },
    aggregation_policy: {
      minimum_observations: minimumObservations,
      single_observation_policy_candidate: false,
      mutation_authorized: false,
    },
    evidence_policy: {
      contains_task_content: false,
      contains_output_content: false,
      retention_class: "content-blind-metrics",
    },
  };
  const parsed = planSchema.parse({ ...plan, plan_digest: microExperimentDigest(plan) });
  return { eligible: true, plan: parsed };
}

export interface OrganicArtifactStore {
  createOnly: (key: string, content: string, signal?: AbortSignal) => Promise<"created" | "exact-existing">;
  read?: (key: string, signal?: AbortSignal) => Promise<string | null>;
}

type OrganicCreateOnlyPersistence =
  | { persisted: true; status: "created" | "exact-existing" }
  | { persisted: false; reason: "timeout" | "write-failed" };

function validatePlan(plan: OrganicMicroExperimentPlan): boolean {
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) return false;
  const { plan_digest: declaredDigest, ...body } = parsed.data;
  return declaredDigest === microExperimentDigest(body);
}

function validateCreateOnlyContent(
  status: unknown,
  expectedContent: string,
  existingContent: string | null | undefined,
): boolean {
  if (status === "created") return true;
  if (status !== "exact-existing") return false;
  // A store with a read path must prove the exact existing bytes. Stores
  // without a read path may still return an exact-existing typed conflict, but
  // they cannot be treated as stronger than that contract says.
  return existingContent === undefined || existingContent === expectedContent;
}

/**
 * Persisting the plan is a bounded pre-dispatch gate. A timeout means "no
 * experiment" and the caller proceeds with baseline work; the late write is
 * aborted by the caller's signal where the backing store supports it.
 */
export async function persistOrganicPlanBeforeDispatch(
  store: OrganicArtifactStore,
  plan: OrganicMicroExperimentPlan,
  timeoutMs: number,
  key = plan.experiment_id,
): Promise<OrganicCreateOnlyPersistence> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !validatePlan(plan)) {
    return { persisted: false, reason: "write-failed" };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let persistenceStatus: "created" | "exact-existing" = "created";
  try {
    const expectedContent = JSON.stringify(plan);
    const write = (async () => {
      const status = await store.createOnly(key, expectedContent, controller.signal);
      persistenceStatus = status;
      const existingContent = status === "exact-existing" && store.read
        ? await store.read(key, controller.signal)
        : undefined;
      if (!validateCreateOnlyContent(status, expectedContent, existingContent)) {
        throw new Error("organic plan persistence returned an invalid create-only result");
      }
    })();
    const timed = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("organic plan persistence timeout"));
      }, timeoutMs);
    });
    await Promise.race([write, timed]);
    // A caller can refuse to replay an orphaned exact-existing plan after
    // restart while still validating the typed conflict and bytes.
    return { persisted: true, status: persistenceStatus };
  } catch (error) {
    return {
      persisted: false,
      reason: timedOut || error instanceof Error && error.message.includes("timeout")
        ? "timeout"
        : "write-failed",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function persistOrganicResultCreateOnly(
  store: OrganicArtifactStore,
  result: OrganicMicroExperimentResult,
  timeoutMs: number,
  key = "micro-experiment-result",
): Promise<OrganicCreateOnlyPersistence> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !resultSchema.safeParse(result).success) {
    return { persisted: false, reason: "write-failed" };
  }
  const { result_digest: declaredDigest, ...body } = result;
  if (declaredDigest !== microExperimentDigest(body)) {
    return { persisted: false, reason: "write-failed" };
  }
  return persistCreateOnlyArtifact(store, key, JSON.stringify(result), timeoutMs);
}

async function persistCreateOnlyArtifact(
  store: OrganicArtifactStore,
  key: string,
  content: string,
  timeoutMs: number,
): Promise<OrganicCreateOnlyPersistence> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let persistenceStatus: "created" | "exact-existing" = "created";
  try {
    const write = (async () => {
      const status = await store.createOnly(key, content, controller.signal);
      persistenceStatus = status;
      const existingContent = status === "exact-existing" && store.read
        ? await store.read(key, controller.signal)
        : undefined;
      if (!validateCreateOnlyContent(status, content, existingContent)) {
        throw new Error("organic result persistence returned an invalid create-only result");
      }
    })();
    const timed = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("organic result persistence timeout"));
      }, timeoutMs);
    });
    await Promise.race([write, timed]);
    return { persisted: true, status: persistenceStatus };
  } catch (error) {
    return {
      persisted: false,
      reason: timedOut || error instanceof Error && error.message.includes("timeout")
        ? "timeout"
        : "write-failed",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface OrganicShadowExecution {
  executionStatus: "completed" | "failed" | "timed-out";
  outputDigest: string;
  oracleStatus: "pass" | "fail" | "not-run";
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  admission: OrganicMicroExperimentAdmission;
  invalidReason?: "budget-exceeded" | "evidence-incomplete" | "identity-mismatch" | "primary-oracle-fail";
}

export interface OrganicBaselineExecution {
  executionStatus: "completed" | "failed" | "timed-out";
  outputDigest: string;
  oracleStatus: "pass" | "fail" | "not-run";
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export function makeOrganicRun(
  role: "baseline" | "challenger",
  bindingDigest: string,
  execution: OrganicBaselineExecution | OrganicShadowExecution,
): OrganicMicroExperimentRun {
  return runSchema.parse({
    role,
    binding_digest: bindingDigest,
    execution_status: execution.executionStatus,
    output_digest: execution.outputDigest,
    oracle_status: execution.oracleStatus,
    latency_ms: execution.latencyMs,
    ...(execution.promptTokens === undefined ? {} : { prompt_tokens: execution.promptTokens }),
    ...(execution.completionTokens === undefined ? {} : { completion_tokens: execution.completionTokens }),
  });
}

function terminalFor(
  baseline: OrganicMicroExperimentRun,
  shadow: OrganicMicroExperimentRun,
  admission: OrganicMicroExperimentAdmission,
  invalidReason?: "budget-exceeded" | "evidence-incomplete" | "identity-mismatch" | "primary-oracle-fail",
): OrganicMicroExperimentTerminal {
  const reasons: OrganicMicroExperimentTerminal["reasons"] = [];
  const executionComplete = baseline.execution_status === "completed"
    && shadow.execution_status === "completed";
  const oraclePass = baseline.oracle_status === "pass" && shadow.oracle_status === "pass";
  if (shadow.execution_status !== "completed") reasons.push("shadow-execution-failed");
  if (baseline.oracle_status !== "pass") reasons.push("primary-oracle-fail");
  if (shadow.oracle_status === "pass") reasons.push("challenger-oracle-pass");
  else if (shadow.oracle_status === "fail") reasons.push("challenger-oracle-fail");
  if (shadow.oracle_status === "not-run" && shadow.execution_status === "completed") reasons.push("evidence-incomplete");
  if (invalidReason && !reasons.includes(invalidReason)) reasons.push(invalidReason);

  const identityInvalid = !isDigest(baseline.binding_digest)
    || !isDigest(shadow.binding_digest)
    || baseline.role !== "baseline"
    || shadow.role !== "challenger"
    || admission.bundle_digest === null && admission.transport_identity === "authenticated-echo"
    || admission.transport_identity === "authenticated-echo" && admission.learning_task_status !== "admitted"
    || admission.learning_task_status === "rejected"
    || admission.transport_identity === "not-applicable"
    || admission.transport_identity === "local-loopback"
      && (admission.learning_task_status !== "not-evaluated" || admission.bundle_digest !== null);
  const invalid = Boolean(invalidReason) || identityInvalid;
  if (invalid) {
    const invalidatingReasons = reasons.filter((reason) => [
      "primary-oracle-fail",
      "budget-exceeded",
      "identity-mismatch",
      "evidence-incomplete",
    ].includes(reason));
    if (identityInvalid && !invalidatingReasons.includes("identity-mismatch")) invalidatingReasons.push("identity-mismatch");
    if (invalidatingReasons.length === 0) invalidatingReasons.push("evidence-incomplete");
    return terminalSchema.parse({
      status: "INVALID",
      reasons: [...new Set(invalidatingReasons)],
      aggregation_eligibility: "ineligible",
      policy_candidate: "not-created",
      primary_delivery: "baseline",
      production_mutation: "none",
    });
  }
  if (baseline.oracle_status !== "pass") {
    return terminalSchema.parse({
      status: "INVALID",
      reasons: ["primary-oracle-fail"],
      aggregation_eligibility: "ineligible",
      policy_candidate: "not-created",
      primary_delivery: "baseline",
      production_mutation: "none",
    });
  }
  const negativeReason = shadow.execution_status !== "completed"
    ? "shadow-execution-failed"
    : shadow.oracle_status === "fail"
      ? "challenger-oracle-fail"
      : shadow.oracle_status === "not-run"
        ? "evidence-incomplete"
        : null;
  if (negativeReason) reasons.splice(0, reasons.length, negativeReason);
  const status = executionComplete && oraclePass ? "PASS" : "HOLD";
  const finalReasons = status === "PASS"
    ? ["challenger-oracle-pass", "single-observation-only"]
    : [...(negativeReason ? [negativeReason] : ["insufficient-benefit"]), "single-observation-only"];
  const diagnosticOnly = admission.transport_identity === "local-loopback"
    && admission.learning_task_status === "not-evaluated"
    && admission.bundle_digest === null;
  const aggregationEligibility = admission.transport_identity === "authenticated-echo"
    && admission.learning_task_status === "admitted"
    && admission.bundle_digest !== null
    ? "eligible"
    : diagnosticOnly ? "diagnostic-only" : "ineligible";
  if (aggregationEligibility === "ineligible") {
    return terminalSchema.parse({
      status: "INVALID",
      reasons: ["identity-mismatch"],
      aggregation_eligibility: "ineligible",
      policy_candidate: "not-created",
      primary_delivery: "baseline",
      production_mutation: "none",
    });
  }
  return terminalSchema.parse({
    status,
    reasons: finalReasons,
    aggregation_eligibility: aggregationEligibility,
    policy_candidate: "not-created",
    primary_delivery: "baseline",
    production_mutation: "none",
  });
}

export function buildOrganicResult(input: {
  plan: OrganicMicroExperimentPlan;
  startedAt: string;
  finishedAt: string;
  baseline: OrganicBaselineExecution;
  shadow: OrganicShadowExecution;
}): OrganicMicroExperimentResult {
  const { plan_digest: declaredPlanDigest, ...planWithoutDigest } = input.plan;
  const planDigestValid = declaredPlanDigest === microExperimentDigest(planWithoutDigest);
  const planInputValid = validatePlan(input.plan);
  const startedMs = Date.parse(input.startedAt);
  const finishedMs = Date.parse(input.finishedAt);
  const planCreatedMs = Date.parse(input.plan.created_at);
  const clockValid = Number.isFinite(startedMs)
    && Number.isFinite(finishedMs)
    && Number.isFinite(planCreatedMs)
    && planCreatedMs <= startedMs
    && startedMs <= finishedMs;
  const baseline = makeOrganicRun("baseline", input.plan.axis.baseline_binding_digest, input.baseline);
  const shadow = makeOrganicRun("challenger", input.plan.axis.challenger_binding_digest, input.shadow);
  const admission = admissionSchema.parse(input.shadow.admission);
  const budgetExceeded = input.shadow.latencyMs > input.plan.execution.max_wall_ms
    || input.shadow.completionTokens !== undefined
      && input.shadow.completionTokens > input.plan.execution.max_completion_tokens;
  const invalidReason = !planInputValid || !clockValid
    ? "evidence-incomplete"
    : budgetExceeded
      ? "budget-exceeded"
      : input.baseline.executionStatus !== "completed"
        ? "evidence-incomplete"
      : input.baseline.oracleStatus !== "pass"
        ? "primary-oracle-fail"
      : input.shadow.executionStatus === "completed" && input.shadow.oracleStatus === "not-run"
        ? "evidence-incomplete"
      : input.shadow.invalidReason;
  const terminal = planDigestValid && planInputValid && clockValid
    ? terminalFor(baseline, shadow, admission, invalidReason)
    : terminalSchema.parse({
        status: "INVALID",
        reasons: [planDigestValid ? invalidReason ?? "evidence-incomplete" : "identity-mismatch"],
        aggregation_eligibility: "ineligible",
        policy_candidate: "not-created",
        primary_delivery: "baseline",
        production_mutation: "none",
      });
  const resultWithoutDigest = {
    kind: "micro-experiment-result" as const,
    schema_version: MICRO_EXPERIMENT_SCHEMA_VERSION,
    result_id: `${input.plan.experiment_id}-result`,
    experiment_id: input.plan.experiment_id,
    plan_digest: input.plan.plan_digest,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    primary: baseline,
    shadow,
    terminal,
    admission,
    evidence_policy: {
      contains_task_content: false as const,
      contains_output_content: false as const,
      evidence_complete: terminal.status !== "INVALID"
        && !terminal.reasons.includes("evidence-incomplete"),
    },
  };
  return resultSchema.parse({
    ...resultWithoutDigest,
    result_digest: microExperimentDigest(resultWithoutDigest),
  });
}

export interface OrganicShadowJob {
  id: string;
  run: () => Promise<void>;
  onError?: (error: unknown) => Promise<void> | void;
}

/** A tiny bounded worker queue. Enqueue never waits for execution. */
export class OrganicShadowQueue {
  private readonly pending: OrganicShadowJob[] = [];
  private running = false;
  private runningId: string | null = null;

  constructor(private readonly capacity = 1) {}

  get size(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  has(id: string): boolean {
    return this.runningId === id || this.pending.some((candidate) => candidate.id === id);
  }

  enqueue(job: OrganicShadowJob): "enqueued" | "duplicate" | "full" {
    if (this.runningId === job.id || this.pending.some((candidate) => candidate.id === job.id)) return "duplicate";
    if (this.size >= this.capacity) return "full";
    this.pending.push(job);
    this.pump();
    return "enqueued";
  }

  private pump(): void {
    if (this.running) return;
    const job = this.pending.shift();
    if (!job) return;
    this.running = true;
    this.runningId = job.id;
    void Promise.resolve()
      .then(() => job.run())
      .catch(async (error) => {
        try {
          await job.onError?.(error);
        } catch (handlerError) {
          console.error(
            `[organic-micro-experiment] shadow error handler failed: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`,
          );
        }
      })
      .finally(() => {
        this.running = false;
        this.runningId = null;
        this.pump();
      });
  }
}

export function buildOrganicInvalidResult(input: {
  plan: OrganicMicroExperimentPlan;
  startedAt: string;
  finishedAt: string;
  baseline: OrganicBaselineExecution;
  reason: "evidence-incomplete" | "identity-mismatch" | "budget-exceeded";
}): OrganicMicroExperimentResult {
  return buildOrganicResult({
    plan: input.plan,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    baseline: input.baseline,
    shadow: {
      executionStatus: "failed",
      outputDigest: microExperimentDigest("organic-shadow-no-evidence"),
      oracleStatus: "not-run",
      latencyMs: 0,
      admission: {
        learning_task_status: "rejected",
        transport_identity: "not-applicable",
        bundle_digest: null,
      },
      invalidReason: input.reason,
    },
  });
}

export interface OrganicOrphanRecoveryStore {
  read: (key: "micro-experiment-plan" | "micro-experiment-result" | "result-structured") => Promise<string | null>;
  persistResult: (result: OrganicMicroExperimentResult) => Promise<"created" | "exact-existing">;
}

export type OrganicOrphanRecoveryOutcome =
  | { status: "invalidated"; reason: "orphaned-plan" }
  | { status: "already-has-result"; reason: "terminal-result-present" }
  | { status: "abstained-running"; reason: "baseline-not-terminal" | "shadow-active" }
  | {
      status: "failed";
      reason: "malformed-plan" | "malformed-result" | "missing-durable-baseline"
        | "baseline-digest-mismatch" | "result-persistence-failed";
    };

function parsePersistedPlan(content: string | null): OrganicMicroExperimentPlan | null {
  if (!content) return null;
  try {
    const parsed = planSchema.safeParse(JSON.parse(content));
    if (!parsed.success || !validatePlan(parsed.data)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function parsePersistedResult(content: string | null): OrganicMicroExperimentResult | null {
  if (!content) return null;
  try {
    const parsed = resultSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return null;
    const { result_digest: declaredDigest, ...body } = parsed.data;
    return declaredDigest === microExperimentDigest(body) ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Derive only bounded, content-blind baseline fields from the durable result. */
export function organicBaselineFromStructuredResult(
  content: string | null,
  expectedTaskNamespace?: string,
): OrganicBaselineExecution | null {
  if (!content) return null;
  let parsed: StructuredTaskResult;
  try {
    const candidate = structuredTaskResultSchema.safeParse(JSON.parse(content));
    if (!candidate.success) return null;
    parsed = candidate.data;
  } catch {
    return null;
  }
  if (expectedTaskNamespace !== undefined && parsed.taskNamespace !== expectedTaskNamespace) return null;
  const delegatedOutcome = parsed.runtimeMetadata?.delegation?.outcome;
  const oracleStatus: OrganicBaselineExecution["oracleStatus"] = delegatedOutcome === "pass"
    ? "pass"
    : delegatedOutcome === "fail" || delegatedOutcome === "error"
      ? "fail"
      : "not-run";
  return {
    executionStatus: parsed.outcome === "timed_out" || parsed.exitCode === "TIMEOUT"
      ? "timed-out"
      : parsed.outcome === "completed" ? "completed" : "failed",
    outputDigest: microExperimentDigest(parsed.bodyText),
    oracleStatus,
    latencyMs: Math.max(0, Math.round((parsed.durationSeconds ?? 0) * 1_000)),
  };
}

/**
 * Reconcile one plan row after restart. This function never calls M5: it only
 * validates existing plan/result/baseline artifacts and creates one bound
 * INVALID result for a terminal baseline whose detached shadow disappeared.
 */
export async function reconcileOrganicOrphanPlan(input: {
  taskNamespace?: string;
  baselineTerminal: boolean;
  shadowActive?: (plan: OrganicMicroExperimentPlan) => boolean;
  store: OrganicOrphanRecoveryStore;
}): Promise<OrganicOrphanRecoveryOutcome> {
  const planContent = await input.store.read("micro-experiment-plan");
  const plan = parsePersistedPlan(planContent);
  if (!plan) return { status: "failed", reason: "malformed-plan" };
  if (input.shadowActive?.(plan)) {
    return { status: "abstained-running", reason: "shadow-active" };
  }

  const resultContent = await input.store.read("micro-experiment-result");
  if (resultContent !== null) {
    const result = parsePersistedResult(resultContent);
    if (!result
      || result.plan_digest !== plan.plan_digest
      || result.experiment_id !== plan.experiment_id
      || result.result_id !== `${plan.experiment_id}-result`) {
      return { status: "failed", reason: "malformed-result" };
    }
    return { status: "already-has-result", reason: "terminal-result-present" };
  }
  if (!input.baselineTerminal) {
    return { status: "abstained-running", reason: "baseline-not-terminal" };
  }

  const structuredContent = await input.store.read("result-structured");
  const baseline = organicBaselineFromStructuredResult(structuredContent, input.taskNamespace);
  if (!baseline) return { status: "failed", reason: "missing-durable-baseline" };
  const recovery = decideOrganicRecovery({
    planDigest: plan.plan_digest,
    persistedPlanDigest: plan.plan_digest,
    resultPresent: false,
    shadowAlreadyStarted: false,
  });
  if (recovery.action !== "invalidate" || recovery.reason !== "orphaned-plan") {
    return { status: "failed", reason: "baseline-digest-mismatch" };
  }
  const startedAt = structuredContent
    ? (() => {
        try {
          const parsed = structuredTaskResultSchema.safeParse(JSON.parse(structuredContent));
          return parsed.success && parsed.data.startedAt ? parsed.data.startedAt : plan.created_at;
        } catch {
          return plan.created_at;
        }
      })()
    : plan.created_at;
  const finishedAt = structuredContent
    ? (() => {
        try {
          const parsed = structuredTaskResultSchema.safeParse(JSON.parse(structuredContent));
          return parsed.success ? parsed.data.completedAt : plan.created_at;
        } catch {
          return plan.created_at;
        }
      })()
    : plan.created_at;
  try {
    const persisted = await input.store.persistResult(buildOrganicInvalidResult({
      plan,
      startedAt,
      finishedAt,
      baseline,
      reason: "evidence-incomplete",
    }));
    return persisted === "created" || persisted === "exact-existing"
      ? { status: "invalidated", reason: "orphaned-plan" }
      : { status: "failed", reason: "result-persistence-failed" };
  } catch {
    return { status: "failed", reason: "result-persistence-failed" };
  }
}

export type OrganicShadowEnqueueOutcome = "enqueued" | "duplicate" | "full" | "baseline-not-committed";

export async function persistOrganicOrphanInvalidAfterBaseline(input: {
  baselineCommitted: Promise<void>;
  plan: OrganicMicroExperimentPlan;
  baseline: OrganicBaselineExecution;
  startedAt: string;
  finishedAt: string;
  reason?: "evidence-incomplete" | "identity-mismatch" | "budget-exceeded";
  persistResult: (result: OrganicMicroExperimentResult) => Promise<void>;
}): Promise<"persisted" | "baseline-not-committed"> {
  try {
    await input.baselineCommitted;
  } catch {
    return "baseline-not-committed";
  }
  await input.persistResult(buildOrganicInvalidResult({
    plan: input.plan,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    baseline: input.baseline,
    reason: input.reason ?? "evidence-incomplete",
  }));
  return "persisted";
}

/**
 * Coordinator seam used by Hugin after its normal result-structured write.
 * Awaiting this function only waits for the durable-baseline barrier and the
 * bounded enqueue operation; it never awaits the shadow itself.
 */
export async function enqueueOrganicShadowAfterBaseline(input: {
  baselineCommitted: Promise<void>;
  queue: OrganicShadowQueue;
  plan: OrganicMicroExperimentPlan;
  baseline: OrganicBaselineExecution;
  startedAt: string;
  runShadow: () => Promise<OrganicShadowExecution>;
  persistResult: (result: OrganicMicroExperimentResult) => Promise<void>;
  now?: () => string;
}): Promise<OrganicShadowEnqueueOutcome> {
  try {
    await input.baselineCommitted;
  } catch {
    return "baseline-not-committed";
  }
  const finishedAt = input.now ?? (() => new Date().toISOString());
  const persistInvalid = async (reason: "evidence-incomplete" | "identity-mismatch" | "budget-exceeded") => {
    await input.persistResult(buildOrganicInvalidResult({
      plan: input.plan,
      startedAt: input.startedAt,
      finishedAt: finishedAt(),
      baseline: input.baseline,
      reason,
    }));
  };
  const outcome = input.queue.enqueue({
    id: input.plan.experiment_id,
    run: async () => {
      const shadow = await input.runShadow();
      await input.persistResult(buildOrganicResult({
        plan: input.plan,
        startedAt: input.startedAt,
        finishedAt: finishedAt(),
        baseline: input.baseline,
        shadow,
      }));
    },
    onError: async () => {
      await persistInvalid("evidence-incomplete");
    },
  });
  if (outcome === "full") await persistInvalid("evidence-incomplete");
  return outcome;
}

export type OrganicRecoveryDecision =
  | { action: "ignore"; reason: "terminal-result-present" }
  | { action: "invalidate"; reason: "orphaned-plan" | "plan-digest-mismatch" | "shadow-already-started" };

/**
 * Restart/replay guard for a future durable queue adapter. An in-memory queue
 * cannot safely resurrect a paid shadow after a process crash; until a
 * durable runner can prove idempotent M5 admission, recovery invalidates the
 * orphan rather than replaying it. A terminal result is always a duplicate
 * and is ignored.
 */
export function decideOrganicRecovery(input: {
  planDigest: string;
  persistedPlanDigest: string;
  resultPresent: boolean;
  shadowAlreadyStarted: boolean;
}): OrganicRecoveryDecision {
  if (input.resultPresent) return { action: "ignore", reason: "terminal-result-present" };
  if (input.planDigest !== input.persistedPlanDigest) {
    return { action: "invalidate", reason: "plan-digest-mismatch" };
  }
  if (input.shadowAlreadyStarted) return { action: "invalidate", reason: "shadow-already-started" };
  return { action: "invalidate", reason: "orphaned-plan" };
}

export function classifyOrganicShadowAdmission(input: {
  learningTaskStatus: "admitted" | "not-evaluated" | "rejected";
  authenticatedEcho: boolean;
  bundleDigest?: string | null;
  localLoopback?: boolean;
}): OrganicMicroExperimentAdmission {
  if (input.authenticatedEcho) {
    return {
      learning_task_status: input.learningTaskStatus,
      transport_identity: "authenticated-echo",
      bundle_digest: input.bundleDigest && isDigest(input.bundleDigest) ? input.bundleDigest : null,
    };
  }
  if (input.localLoopback) {
    return {
      learning_task_status: input.learningTaskStatus,
      transport_identity: "local-loopback",
      bundle_digest: null,
    };
  }
  return {
    learning_task_status: input.learningTaskStatus,
    transport_identity: "not-applicable",
    bundle_digest: null,
  };
}

/** Map the authenticated LearningTask echo digest (bare SHA-256) to the
 * micro-experiment contract's prefixed digest without treating a missing or
 * malformed echo as authenticated evidence. */
export function classifyOrganicLearningTaskAdmission(input: {
  state: "preflight-failed" | "m5-not-admitted" | "join-failed" | "m5-admitted";
  evidenceAccepted: boolean;
  gatewayEchoDigest?: {
    algorithm: "sha256";
    version: "gateway-echo-jcs-v1";
    digest: string;
  };
}): OrganicMicroExperimentAdmission {
  const authenticatedEcho = input.state === "m5-admitted" && input.evidenceAccepted;
  const bareDigest = input.gatewayEchoDigest?.digest;
  const bundleDigest = bareDigest && /^[a-f0-9]{64}$/.test(bareDigest)
    ? `sha256:${bareDigest}`
    : null;
  return classifyOrganicShadowAdmission({
    learningTaskStatus: authenticatedEcho ? "admitted" : "not-evaluated",
    authenticatedEcho,
    bundleDigest,
  });
}
