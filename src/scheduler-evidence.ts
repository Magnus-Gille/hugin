import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalizeJcs } from "./jcs.js";
import { dispatcherRuntimeSchema } from "./task-result-schema.js";

export const SCHEDULER_ESTIMATOR_VERSION = "scheduler-duration-v1" as const;
export const SCHEDULER_SERVICE_CLOCK = "claim-to-release-v1" as const;

const isoTimestampSchema = z.string().datetime({ offset: true });
const taskNamespaceSchema = z.string().regex(/^tasks\/[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const schedulerTaskRefSchema = z.object({
  namespace: taskNamespaceSchema,
  key: z.literal("status"),
}).strict();

export const schedulerServiceEstimateSchema = z.object({
  seconds: z.number().finite().nonnegative(),
  estimatorVersion: z.literal(SCHEDULER_ESTIMATOR_VERSION),
  serviceClock: z.literal(SCHEDULER_SERVICE_CLOCK),
  source: z.literal("verified-terminal-history"),
  sampleCount: z.number().int().positive(),
  historyThrough: isoTimestampSchema,
  historyThroughDecisionId: z.string().uuid(),
}).strict();

const completeServiceClockSchema = z.object({
  serviceClock: z.literal(SCHEDULER_SERVICE_CLOCK),
  clockComplete: z.literal(true),
  claimedAt: isoTimestampSchema,
  releasedAt: isoTimestampSchema,
  schedulerServiceSeconds: z.number().finite().nonnegative(),
}).strict().superRefine((value, ctx) => {
  const elapsedSeconds = (Date.parse(value.releasedAt) - Date.parse(value.claimedAt)) / 1000;
  if (elapsedSeconds < 0) {
    ctx.addIssue({
      code: "custom",
      path: ["releasedAt"],
      message: "release boundary precedes claim boundary",
    });
  } else if (Math.abs(elapsedSeconds - value.schedulerServiceSeconds) > 0.001) {
    ctx.addIssue({
      code: "custom",
      path: ["schedulerServiceSeconds"],
      message: "service seconds must equal the claim-to-release interval",
    });
  }
});

const incompleteServiceClockSchema = z.object({
  serviceClock: z.literal(SCHEDULER_SERVICE_CLOCK),
  clockComplete: z.literal(false),
  claimedAt: isoTimestampSchema.optional(),
  releasedAt: isoTimestampSchema.optional(),
  incompleteReason: z.enum([
    "claim-boundary-unavailable",
    "release-boundary-unavailable",
    "terminal-result-unavailable",
  ]),
}).strict();

export const schedulerServiceClockEvidenceSchema = z.union([
  completeServiceClockSchema,
  incompleteServiceClockSchema,
]);
export type SchedulerServiceClockEvidence = z.infer<typeof schedulerServiceClockEvidenceSchema>;

export function buildCompleteSchedulerServiceClock(
  claimedAt: string,
  releasedAt: string,
): z.infer<typeof completeServiceClockSchema> {
  const claimedMs = Date.parse(claimedAt);
  const releasedMs = Date.parse(releasedAt);
  return completeServiceClockSchema.parse({
    serviceClock: SCHEDULER_SERVICE_CLOCK,
    clockComplete: true,
    claimedAt,
    releasedAt,
    schedulerServiceSeconds: (releasedMs - claimedMs) / 1000,
  });
}

const challengerEvidenceReasonSchema = z.enum([
  "window-truncated",
  "estimate-missing",
  "estimator-version-mismatch",
]);

export const schedulerDecisionPredictionSchema = z.object({
  schemaVersion: z.literal(1),
  decisionId: z.string().uuid(),
  observedAt: isoTimestampSchema,
  champion: z.object({
    policy: z.enum(["complete-fifo-v1", "visible-window-fifo-v1"]),
    taskRef: schedulerTaskRefSchema,
    serviceEstimate: schedulerServiceEstimateSchema.nullable(),
  }).strict(),
  challenger: z.object({
    policy: z.literal("bounded-sejf-v1"),
    overdueThresholdSeconds: z.literal(1800),
    taskRef: schedulerTaskRefSchema.nullable(),
    reason: z.enum(["shortest-estimate", "oldest-overdue", "insufficient-evidence"]),
    evidenceReasons: z.array(challengerEvidenceReasonSchema).max(3).default([]),
    serviceEstimate: schedulerServiceEstimateSchema.nullable(),
  }).strict(),
  window: z.object({
    eligibleTasks: z.number().int().nonnegative(),
    pendingEnumerationComplete: z.boolean(),
    runningEnumerationComplete: z.boolean(),
    eligibilityAuthority: z.literal("legacy-unbound-group-sequence"),
    estimatedWorkMinutes: z.number().finite().nonnegative().nullable(),
    missingEstimates: z.number().int().nonnegative(),
  }).strict(),
  estimatorVersion: z.literal(SCHEDULER_ESTIMATOR_VERSION),
}).strict().superRefine((value, ctx) => {
  const windowComplete = value.window.pendingEnumerationComplete
    && value.window.runningEnumerationComplete;
  const abstained = value.challenger.reason === "insufficient-evidence";
  if (value.window.eligibleTasks < 1) {
    ctx.addIssue({ code: "custom", path: ["window", "eligibleTasks"], message: "a champion claim requires an eligible task" });
  }
  if (value.window.missingEstimates > value.window.eligibleTasks) {
    ctx.addIssue({ code: "custom", path: ["window", "missingEstimates"], message: "missing estimates cannot exceed eligible tasks" });
  }
  if ((value.champion.policy === "complete-fifo-v1") !== windowComplete) {
    ctx.addIssue({
      code: "custom",
      path: ["champion", "policy"],
      message: "champion policy must reflect enumeration completeness",
    });
  }
  if (abstained && value.challenger.taskRef !== null) {
    ctx.addIssue({ code: "custom", path: ["challenger", "taskRef"], message: "abstention cannot choose a task" });
  }
  if (abstained && value.challenger.evidenceReasons.length === 0) {
    ctx.addIssue({ code: "custom", path: ["challenger", "evidenceReasons"], message: "abstention requires bounded evidence" });
  }
  if (!abstained && value.challenger.taskRef === null) {
    ctx.addIssue({ code: "custom", path: ["challenger", "taskRef"], message: "a challenger choice requires a task" });
  }
  if (abstained && value.challenger.serviceEstimate !== null) {
    ctx.addIssue({ code: "custom", path: ["challenger", "serviceEstimate"], message: "abstention cannot carry a chosen estimate" });
  }
  if (!abstained && value.challenger.serviceEstimate === null) {
    ctx.addIssue({ code: "custom", path: ["challenger", "serviceEstimate"], message: "a challenger choice requires an estimate" });
  }
  if (!abstained && value.champion.serviceEstimate === null) {
    ctx.addIssue({ code: "custom", path: ["champion", "serviceEstimate"], message: "a comparison requires the persisted champion estimate" });
  }
  if (value.window.missingEstimates > 0 && !abstained) {
    ctx.addIssue({ code: "custom", path: ["challenger", "reason"], message: "missing estimates require abstention" });
  }
  if (value.window.missingEstimates > 0
    && !value.challenger.evidenceReasons.includes("estimate-missing")) {
    ctx.addIssue({ code: "custom", path: ["challenger", "evidenceReasons"], message: "missing estimates must be explicit" });
  }
  if (value.window.missingEstimates === 0 && value.champion.serviceEstimate === null) {
    ctx.addIssue({ code: "custom", path: ["champion", "serviceEstimate"], message: "zero missing estimates requires a champion estimate" });
  }
  if (value.window.missingEstimates === 0
    && value.challenger.evidenceReasons.includes("estimate-missing")) {
    ctx.addIssue({ code: "custom", path: ["challenger", "evidenceReasons"], message: "estimate-missing contradicts a complete estimate set" });
  }
  if (value.window.missingEstimates > 0 && value.window.estimatedWorkMinutes !== null) {
    ctx.addIssue({ code: "custom", path: ["window", "estimatedWorkMinutes"], message: "partial estimates cannot be represented as total work" });
  }
  if (value.window.missingEstimates === 0 && value.window.estimatedWorkMinutes === null) {
    ctx.addIssue({ code: "custom", path: ["window", "estimatedWorkMinutes"], message: "complete estimates require total work minutes" });
  }
  if (!abstained && value.challenger.evidenceReasons.length > 0) {
    ctx.addIssue({ code: "custom", path: ["challenger", "evidenceReasons"], message: "a completed comparison cannot carry abstention evidence" });
  }
  for (const [path, estimate] of [
    [["champion", "serviceEstimate"], value.champion.serviceEstimate],
    [["challenger", "serviceEstimate"], value.challenger.serviceEstimate],
  ] as const) {
    if (estimate && Date.parse(estimate.historyThrough) > Date.parse(value.observedAt)) {
      ctx.addIssue({ code: "custom", path: [...path, "historyThrough"], message: "estimate history cannot look ahead past observation" });
    }
  }
  if (!windowComplete && !value.challenger.evidenceReasons.includes("window-truncated")) {
    ctx.addIssue({ code: "custom", path: ["challenger", "evidenceReasons"], message: "truncated enumeration must be explicit" });
  }
  if (value.champion.policy === "visible-window-fifo-v1" && !abstained) {
    ctx.addIssue({ code: "custom", path: ["challenger", "reason"], message: "truncated FIFO window requires abstention" });
  }
});
export type SchedulerDecisionPrediction = z.infer<typeof schedulerDecisionPredictionSchema>;

export const schedulerTerminalClassSchema = z.enum([
  "completed",
  "failed",
  "timed-out",
  "cancelled",
]);

const schedulerTerminalResultBindingSchema = z.object({
  namespace: taskNamespaceSchema,
  key: z.literal("result-structured"),
  updatedAt: isoTimestampSchema,
  sha256: sha256Schema,
}).strict();

export const schedulerDecisionOutcomeSchema = z.object({
  schemaVersion: z.literal(1),
  decisionId: z.string().uuid(),
  taskRef: schedulerTaskRefSchema,
  terminalClass: schedulerTerminalClassSchema,
  clock: schedulerServiceClockEvidenceSchema,
  requestedRuntime: dispatcherRuntimeSchema,
  effectiveRuntime: dispatcherRuntimeSchema,
  taskType: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(),
  harness: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/).optional(),
  championEstimateSeconds: z.number().finite().nonnegative().nullable(),
  absolutePredictionErrorSeconds: z.number().finite().nonnegative().nullable(),
  longJob: z.boolean(),
  terminalResult: schedulerTerminalResultBindingSchema,
}).strict().superRefine((value, ctx) => {
  if (value.terminalResult.namespace !== value.taskRef.namespace) {
    ctx.addIssue({
      code: "custom",
      path: ["terminalResult", "namespace"],
      message: "terminal result must bind the champion task namespace",
    });
  }
  if (value.championEstimateSeconds === null && value.absolutePredictionErrorSeconds !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["absolutePredictionErrorSeconds"],
      message: "prediction error requires the persisted champion estimate",
    });
  }
  if (!value.clock.clockComplete && value.absolutePredictionErrorSeconds !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["absolutePredictionErrorSeconds"],
      message: "incomplete service clocks cannot produce prediction error",
    });
  }
  if (value.clock.clockComplete && value.championEstimateSeconds !== null) {
    const expected = Math.abs(
      value.clock.schedulerServiceSeconds - value.championEstimateSeconds,
    );
    if (value.absolutePredictionErrorSeconds !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["absolutePredictionErrorSeconds"],
        message: "prediction error must use the persisted champion estimate",
      });
    }
  }
});
export type SchedulerDecisionOutcome = z.infer<typeof schedulerDecisionOutcomeSchema>;

function hashSchedulerEvidence(value: unknown): string {
  return createHash("sha256").update(canonicalizeJcs(value), "utf8").digest("hex");
}

export function hashSchedulerPrediction(value: unknown): string {
  return hashSchedulerEvidence(schedulerDecisionPredictionSchema.parse(value));
}

export function hashSchedulerOutcome(value: unknown): string {
  return hashSchedulerEvidence(schedulerDecisionOutcomeSchema.parse(value));
}

export interface SchedulerEstimatorOptions {
  minimumSamples: number;
  windowSize: number;
}

/**
 * Build a rolling numeric median from already grouped terminal history.
 * Every complete terminal class participates; only explicitly incomplete
 * claim-to-release clocks are censored.
 */
export function buildRollingMedianDurationEstimate(
  input: unknown[],
  options: SchedulerEstimatorOptions,
): z.infer<typeof schedulerServiceEstimateSchema> | null {
  if (!Number.isInteger(options.minimumSamples) || options.minimumSamples < 1) {
    throw new Error("minimumSamples must be a positive integer");
  }
  if (!Number.isInteger(options.windowSize) || options.windowSize < options.minimumSamples) {
    throw new Error("windowSize must be an integer greater than or equal to minimumSamples");
  }
  const parsed = z.array(schedulerDecisionOutcomeSchema).parse(input);
  const uniqueByDecision = new Map<string, SchedulerDecisionOutcome>();
  for (const sample of parsed) {
    const existing = uniqueByDecision.get(sample.decisionId);
    if (existing && hashSchedulerOutcome(existing) !== hashSchedulerOutcome(sample)) {
      throw new Error(`conflicting scheduler outcomes for decision ${sample.decisionId}`);
    }
    uniqueByDecision.set(sample.decisionId, sample);
  }
  const samples = [...uniqueByDecision.values()]
    .filter((sample): sample is SchedulerDecisionOutcome & {
      clock: z.infer<typeof completeServiceClockSchema>;
    } => sample.clock.clockComplete)
    .sort((left, right) => {
      const timestampOrder = Date.parse(left.clock.releasedAt) - Date.parse(right.clock.releasedAt);
      if (timestampOrder !== 0) return timestampOrder;
      return left.decisionId < right.decisionId
        ? -1
        : left.decisionId > right.decisionId
          ? 1
          : 0;
    })
    .slice(-options.windowSize);
  if (samples.length < options.minimumSamples) return null;

  const ordered = samples
    .map((sample) => sample.clock.schedulerServiceSeconds)
    .sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const seconds = ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;

  return schedulerServiceEstimateSchema.parse({
    seconds,
    estimatorVersion: SCHEDULER_ESTIMATOR_VERSION,
    serviceClock: SCHEDULER_SERVICE_CLOCK,
    source: "verified-terminal-history",
    sampleCount: samples.length,
    historyThrough: samples.at(-1)!.clock.releasedAt,
    historyThroughDecisionId: samples.at(-1)!.decisionId,
  });
}
