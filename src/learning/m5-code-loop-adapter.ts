/**
 * Translate the owner-only M5 code_loop result into Hugin's content-blind
 * experiment observation. The M5 response is untrusted input: validate it,
 * preserve missing telemetry as missing, and never infer edit timing from a
 * final git diff.
 */

import { z } from "zod";
import {
  learningObservationSchema,
  sha256Schema,
  type LearningObservationInput,
} from "./experiment-schema.js";

const codeLoopStatusSchema = z.enum([
  "completed",
  "cap-exceeded",
  "degenerate",
  "arm-error",
  "orphaned",
]);

const phaseMsSchema = z.object({
  inspect: z.number().int().nonnegative().optional(),
  edit: z.number().int().nonnegative().optional(),
  check: z.number().int().nonnegative().optional(),
}).strict();

/** Proposed gille-inference #247 telemetry. Optional for old deployed gateways. */
export const m5CodeLoopTelemetrySchema = z.object({
  schema_version: z.literal(1),
  first_edit_turn: z.number().int().positive().optional(),
  edit_start_ms: z.number().int().nonnegative().optional(),
  phase_ms: phaseMsSchema,
  mutation_evidence: z.enum(["tool-call", "diff-only", "none"]),
  observability_coverage: z.number().min(0).max(1),
  failure_kind: z.string().min(1).max(120).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.mutation_evidence !== "tool-call" && value.edit_start_ms !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["edit_start_ms"],
      message: "edit_start_ms requires tool-call mutation evidence",
    });
  }
  if (value.mutation_evidence !== "tool-call" && value.first_edit_turn !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["first_edit_turn"],
      message: "first_edit_turn requires tool-call mutation evidence",
    });
  }
});

export const m5CodeLoopResultSchema = z.object({
  status: codeLoopStatusSchema,
  diff: z.string(),
  diff_truncated: z.boolean().default(false),
  changed_files: z.array(z.string()),
  protected_violations: z.array(z.string()),
  summary: z.string(),
  check: z.object({
    ran: z.boolean(),
    exit_code: z.number().int().nullable(),
    output_tail: z.string(),
    duration_ms: z.number().int().nonnegative().optional(),
  }).strict(),
  usage: z.object({
    turns: z.number().int().nonnegative(),
    wall_ms: z.number().int().nonnegative(),
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }).strict(),
  work_id: z.string().min(1).max(200),
  detail: z.string(),
  execution: z.object({
    schema_version: z.literal(1),
    model: z.string().min(1),
    engine: z.string().min(1),
    harness_version: z.string().min(1),
    effective_caps: z.object({
      wall_s: z.number().int().positive(),
      turns: z.number().int().positive(),
      completion_tokens: z.number().int().positive(),
      edit_deadline_turn: z.number().int().positive().optional(),
    }).strict(),
  }).strict().optional(),
  telemetry: m5CodeLoopTelemetrySchema.optional(),
}).strict();
export type M5CodeLoopResult = z.infer<typeof m5CodeLoopResultSchema>;

export interface M5CodeLoopObservationContext {
  experimentId: string;
  runId: string;
  sampleId: string;
  arm: "champion" | "challenger";
  holdout: boolean;
  configurationFingerprint: string;
  taskId?: string;
  ledgerId?: string;
  expectedExecution?: {
    model: string;
    harnessVersion: string;
    caps: {
      wall_s: number;
      turns: number;
      completion_tokens: number;
      edit_deadline_turn?: number;
    };
  };
  externalVerification?: {
    ran: boolean;
    passed: boolean;
    testsRan: boolean;
    id: string;
    version: string;
    durationMs: number;
  };
}

function qualityOf(
  result: M5CodeLoopResult,
  external: M5CodeLoopObservationContext["externalVerification"],
): LearningObservationInput["quality_outcome"] {
  if (
    result.status === "degenerate" ||
    result.status === "arm-error" ||
    result.status === "orphaned"
  ) {
    return "infra-error";
  }
  if (result.status === "cap-exceeded" || result.protected_violations.length > 0) {
    if (result.protected_violations.length > 0) return "fail";
  }
  if (external?.ran) return external.passed ? "pass" : "fail";
  if (result.status === "cap-exceeded") return "fail";
  if (!result.check.ran) return "unverified";
  return result.check.exit_code === 0 ? "pass" : "fail";
}

function failureKindOf(
  result: M5CodeLoopResult,
  external: M5CodeLoopObservationContext["externalVerification"],
): string | undefined {
  if (result.telemetry?.failure_kind) return result.telemetry.failure_kind;
  if (result.protected_violations.length > 0) return "protected-file-modified";
  if (external?.ran && !external.passed) return "protected-check-failed";
  if (result.status === "completed" && result.check.ran && result.check.exit_code !== 0) {
    return "protected-check-failed";
  }
  return result.status === "completed" ? undefined : result.status;
}

function assertExecutionBinding(
  result: M5CodeLoopResult,
  expected: M5CodeLoopObservationContext["expectedExecution"],
): void {
  if (!expected) return;
  if (!result.execution) {
    throw new Error("M5 result omitted effective execution metadata required by the experiment");
  }
  if (result.execution.model !== expected.model) {
    throw new Error(
      `M5 effective model ${result.execution.model} does not match declared ${expected.model}`,
    );
  }
  if (result.execution.harness_version !== expected.harnessVersion) {
    throw new Error(
      `M5 harness version ${result.execution.harness_version} does not match declared ${expected.harnessVersion}`,
    );
  }
  const actual = result.execution.effective_caps;
  const fields = ["wall_s", "turns", "completion_tokens", "edit_deadline_turn"] as const;
  for (const field of fields) {
    if (actual[field] !== expected.caps[field]) {
      throw new Error(`M5 effective cap ${field} does not match the declared experiment arm`);
    }
  }
}

export function observationFromM5CodeLoop(
  rawResult: unknown,
  context: M5CodeLoopObservationContext,
): LearningObservationInput {
  const result = m5CodeLoopResultSchema.parse(rawResult);
  assertExecutionBinding(result, context.expectedExecution);
  const fingerprint = sha256Schema.parse(context.configurationFingerprint);
  const external = context.externalVerification;
  const authoritativeCheck =
    result.protected_violations.length === 0 &&
    (external?.ran === true || result.check.ran);
  const m5CheckMs = result.telemetry?.phase_ms.check ?? result.check.duration_ms ?? 0;
  const checkMs = m5CheckMs + (external?.durationMs ?? 0);
  const latencyMs = result.usage.wall_ms + (checkMs ?? 0);
  const rawPhase = result.telemetry?.phase_ms;
  const phase = rawPhase || checkMs > 0
    ? { ...rawPhase, ...(checkMs > 0 ? { check: checkMs } : {}) }
    : undefined;

  return learningObservationSchema.parse({
    experiment_id: context.experimentId,
    run_id: context.runId,
    sample_id: context.sampleId,
    arm: context.arm,
    holdout: context.holdout,
    configuration_fingerprint: fingerprint,
    quality_outcome: qualityOf(result, external),
    product_outcome: "unrated",
    verifier: authoritativeCheck
      ? {
          kind: "mechanical",
          independent: true,
          id: external?.ran ? external.id : "m5-check-cmd",
          version: external?.ran ? external.version : "1",
        }
      : { kind: "none", independent: false },
    latency_ms: latencyMs,
    cost_usd: 0,
    edit_start_ms: result.telemetry?.edit_start_ms,
    observability_coverage: result.telemetry?.observability_coverage ?? 0,
    edited: result.changed_files.length > 0,
    tests_run: external?.ran ? external.testsRan : result.check.ran,
    tests_passed: external?.ran && external.testsRan
      ? external.passed
      : external?.ran
        ? undefined
        : result.check.ran
        ? result.check.exit_code === 0
        : undefined,
    phase_ms: phase && Object.values(phase).some((value) => value !== undefined)
      ? phase
      : undefined,
    failure_kind: failureKindOf(result, external),
    task_id: context.taskId,
    ledger_id: context.ledgerId,
    work_id: result.work_id,
  });
}
