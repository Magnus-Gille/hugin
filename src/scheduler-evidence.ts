import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalizeJcs } from "./jcs.js";
import {
  dispatcherRuntimeSchema,
  structuredTaskResultSchema,
  type DispatcherRuntime,
} from "./task-result-schema.js";

export const SCHEDULER_ESTIMATOR_VERSION = "scheduler-duration-v1" as const;
export const SCHEDULER_SERVICE_CLOCK = "claim-to-release-v1" as const;
export const SCHEDULER_LONG_JOB_SECONDS = 1800 as const;

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
  "candidate-timestamp-invalid",
  "shadow-disabled",
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
    evidenceReasons: z.array(challengerEvidenceReasonSchema).max(5).default([]),
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
  if (windowComplete && value.challenger.evidenceReasons.includes("window-truncated")) {
    ctx.addIssue({ code: "custom", path: ["challenger", "evidenceReasons"], message: "window-truncated contradicts complete enumeration" });
  }
  if (value.champion.policy === "visible-window-fifo-v1" && !abstained) {
    ctx.addIssue({ code: "custom", path: ["challenger", "reason"], message: "truncated FIFO window requires abstention" });
  }
});
export type SchedulerDecisionPrediction = z.infer<typeof schedulerDecisionPredictionSchema>;

export interface SchedulerShadowCandidate {
  taskRef: z.input<typeof schedulerTaskRefSchema>;
  createdAt: string;
  serviceEstimate: unknown | null;
}

export interface BuildSchedulerDecisionPredictionInput {
  decisionId: string;
  observedAt: string;
  championTaskRef: z.input<typeof schedulerTaskRefSchema>;
  candidates: SchedulerShadowCandidate[];
  eligibleTaskCount?: number;
  pendingEnumerationComplete: boolean;
  runningEnumerationComplete: boolean;
  shadowEnabled: boolean;
}

/**
 * Build one behavior-neutral FIFO/challenger observation. Candidate order is
 * the champion's already-filtered FIFO order; this function can observe that
 * order but cannot replace its first element as the enforced claim.
 */
export function buildSchedulerDecisionPrediction(
  input: BuildSchedulerDecisionPredictionInput,
): SchedulerDecisionPrediction {
  const championTaskRef = schedulerTaskRefSchema.parse(input.championTaskRef);
  const observedAtMs = Date.parse(input.observedAt);
  if (!Number.isFinite(observedAtMs)) throw new Error("scheduler observation time is invalid");
  if (input.candidates.length === 0) throw new Error("scheduler prediction requires candidates");
  const windowComplete = input.pendingEnumerationComplete && input.runningEnumerationComplete;
  const evaluateCandidates = input.shadowEnabled && windowComplete;
  const eligibleTaskCount = input.eligibleTaskCount ?? input.candidates.length;
  if (!Number.isInteger(eligibleTaskCount) || eligibleTaskCount < input.candidates.length) {
    throw new Error("eligible task count cannot be smaller than supplied candidates");
  }
  if (evaluateCandidates && eligibleTaskCount !== input.candidates.length) {
    throw new Error("enabled complete-window comparison requires every eligible candidate");
  }

  const candidates = input.candidates.map((candidate) => {
    const taskRef = schedulerTaskRefSchema.parse(candidate.taskRef);
    const estimateResult = !evaluateCandidates || candidate.serviceEstimate === null
      ? null
      : schedulerServiceEstimateSchema.safeParse(candidate.serviceEstimate);
    const estimateValid = estimateResult?.success === true
      && Date.parse(estimateResult.data.historyThrough) <= observedAtMs;
    return {
      taskRef,
      createdAt: candidate.createdAt,
      createdAtMs: Date.parse(candidate.createdAt),
      estimate: estimateValid ? estimateResult.data : null,
      estimateInvalid: evaluateCandidates && estimateResult !== null && !estimateValid,
    };
  });
  if (candidates[0]!.taskRef.namespace !== championTaskRef.namespace) {
    throw new Error("scheduler champion must remain the first eligible FIFO task");
  }

  const missingEstimates = evaluateCandidates
    ? candidates.filter((candidate) => candidate.estimate === null).length
    : eligibleTaskCount;
  const invalidEstimate = candidates.some((candidate) => candidate.estimateInvalid);
  const invalidTimestamp = evaluateCandidates && candidates.some(
    (candidate) => !Number.isFinite(candidate.createdAtMs) || candidate.createdAtMs > observedAtMs,
  );
  const evidenceReasons: z.infer<typeof challengerEvidenceReasonSchema>[] = [];
  if (!windowComplete) evidenceReasons.push("window-truncated");
  if (missingEstimates > 0) evidenceReasons.push("estimate-missing");
  if (invalidEstimate) evidenceReasons.push("estimator-version-mismatch");
  if (invalidTimestamp) evidenceReasons.push("candidate-timestamp-invalid");
  if (!input.shadowEnabled) evidenceReasons.push("shadow-disabled");

  let chosen: (typeof candidates)[number] | null = null;
  let reason: "shortest-estimate" | "oldest-overdue" | "insufficient-evidence" =
    "insufficient-evidence";
  if (evidenceReasons.length === 0) {
    const oldestOverdue = candidates.find(
      (candidate) => observedAtMs - candidate.createdAtMs >= 1_800_000,
    );
    if (oldestOverdue) {
      chosen = oldestOverdue;
      reason = "oldest-overdue";
    } else {
      chosen = candidates.reduce((shortest, candidate) =>
        candidate.estimate!.seconds < shortest.estimate!.seconds ? candidate : shortest,
      );
      reason = "shortest-estimate";
    }
  }

  const champion = candidates[0]!;
  const estimatedWorkMinutes = missingEstimates === 0
    ? candidates.reduce((total, candidate) => total + candidate.estimate!.seconds, 0) / 60
    : null;

  return schedulerDecisionPredictionSchema.parse({
    schemaVersion: 1,
    decisionId: input.decisionId,
    observedAt: input.observedAt,
    champion: {
      policy: windowComplete ? "complete-fifo-v1" : "visible-window-fifo-v1",
      taskRef: championTaskRef,
      serviceEstimate: champion.estimate,
    },
    challenger: {
      policy: "bounded-sejf-v1",
      overdueThresholdSeconds: 1800,
      taskRef: chosen?.taskRef ?? null,
      reason,
      evidenceReasons,
      serviceEstimate: chosen?.estimate ?? null,
    },
    window: {
      eligibleTasks: eligibleTaskCount,
      pendingEnumerationComplete: input.pendingEnumerationComplete,
      runningEnumerationComplete: input.runningEnumerationComplete,
      eligibilityAuthority: "legacy-unbound-group-sequence",
      estimatedWorkMinutes,
      missingEstimates,
    },
    estimatorVersion: SCHEDULER_ESTIMATOR_VERSION,
  });
}

/** Resolve at most one bounded estimate per finite requested runtime per poll. */
export function resolveSchedulerRuntimeEstimates<T extends DispatcherRuntime>(
  runtimes: readonly (T | null)[],
  enabled: boolean,
  lookup: (runtime: T) => z.infer<typeof schedulerServiceEstimateSchema> | null,
): Array<z.infer<typeof schedulerServiceEstimateSchema> | null> {
  if (!enabled) return runtimes.map(() => null);
  const memoized = new Map<T, z.infer<typeof schedulerServiceEstimateSchema> | null>();
  return runtimes.map((runtime) => {
    if (runtime === null) return null;
    if (!memoized.has(runtime)) memoized.set(runtime, lookup(runtime));
    return memoized.get(runtime) ?? null;
  });
}

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

export interface SchedulerTerminalResultRevision {
  namespace: string;
  key: "result-structured";
  updatedAt: string;
  sha256: string;
  result: unknown;
}

export interface BuildSchedulerDecisionOutcomeInput {
  prediction: unknown;
  claimedAt: string | null;
  releasedAt: string;
  requestedRuntime: DispatcherRuntime;
  effectiveRuntime: DispatcherRuntime;
  terminalResult: SchedulerTerminalResultRevision;
  taskType?: string;
  harness?: string;
  model?: string;
}

function boundedIdentity(value: string | undefined, pattern: RegExp): string | undefined {
  const trimmed = value?.trim();
  return trimmed && pattern.test(trimmed) ? trimmed : undefined;
}

/** Build one content-blind outcome from the exact durable terminal result revision. */
export function buildSchedulerDecisionOutcomeFromTerminalResult(
  input: BuildSchedulerDecisionOutcomeInput,
): SchedulerDecisionOutcome {
  const prediction = schedulerDecisionPredictionSchema.parse(input.prediction);
  const terminal = structuredTaskResultSchema.parse(input.terminalResult.result);
  if (input.terminalResult.namespace !== prediction.champion.taskRef.namespace
    || terminal.taskNamespace !== prediction.champion.taskRef.namespace) {
    throw new Error("terminal result does not bind the champion task");
  }
  if (input.terminalResult.key !== "result-structured") {
    throw new Error("scheduler outcome requires result-structured evidence");
  }

  const claimedAt = input.claimedAt && isoTimestampSchema.safeParse(input.claimedAt).success
    ? input.claimedAt
    : null;
  const releaseBoundaryValid = isoTimestampSchema.safeParse(input.releasedAt).success
    && (!claimedAt || Date.parse(input.releasedAt) >= Date.parse(claimedAt));
  const clock: SchedulerServiceClockEvidence = claimedAt && releaseBoundaryValid
    ? buildCompleteSchedulerServiceClock(claimedAt, input.releasedAt)
    : schedulerServiceClockEvidenceSchema.parse({
        serviceClock: SCHEDULER_SERVICE_CLOCK,
        clockComplete: false,
        ...(claimedAt ? { claimedAt } : {}),
        releasedAt: input.releasedAt,
        incompleteReason: claimedAt
          ? "release-boundary-unavailable"
          : "claim-boundary-unavailable",
      });
  const championEstimateSeconds = prediction.champion.serviceEstimate?.seconds ?? null;
  const absolutePredictionErrorSeconds = clock.clockComplete
    && championEstimateSeconds !== null
    ? Math.abs(clock.schedulerServiceSeconds - championEstimateSeconds)
    : null;
  const terminalClass = terminal.outcome === "timed_out" ? "timed-out" : terminal.outcome;

  return schedulerDecisionOutcomeSchema.parse({
    schemaVersion: 1,
    decisionId: prediction.decisionId,
    taskRef: prediction.champion.taskRef,
    terminalClass,
    clock,
    requestedRuntime: input.requestedRuntime,
    effectiveRuntime: input.effectiveRuntime,
    taskType: boundedIdentity(input.taskType, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    harness: boundedIdentity(input.harness, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    model: boundedIdentity(input.model, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/),
    championEstimateSeconds,
    absolutePredictionErrorSeconds,
    longJob: clock.clockComplete
      ? clock.schedulerServiceSeconds >= SCHEDULER_LONG_JOB_SECONDS
      : false,
    terminalResult: {
      namespace: input.terminalResult.namespace,
      key: input.terminalResult.key,
      updatedAt: input.terminalResult.updatedAt,
      sha256: sha256Schema.parse(input.terminalResult.sha256),
    },
  });
}

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

/**
 * Bounded estimator state for outcomes whose complete authenticated evidence
 * chain has been verified. Callers may admit a freshly persisted chain or a
 * post-restart chain loaded from exact immutable rows.
 */
export class SchedulerRuntimeEstimatorCache {
  private readonly samplesByRuntime = new Map<DispatcherRuntime, Map<string, SchedulerDecisionOutcome>>();

  constructor(private readonly options: SchedulerEstimatorOptions) {
    if (!Number.isInteger(options.minimumSamples) || options.minimumSamples < 1) {
      throw new Error("minimumSamples must be a positive integer");
    }
    if (!Number.isInteger(options.windowSize) || options.windowSize < options.minimumSamples) {
      throw new Error("windowSize must be an integer greater than or equal to minimumSamples");
    }
  }

  recordVerified(input: unknown): void {
    const outcome = schedulerDecisionOutcomeSchema.parse(input);
    for (const samples of this.samplesByRuntime.values()) {
      const existing = samples.get(outcome.decisionId);
      if (existing && hashSchedulerOutcome(existing) !== hashSchedulerOutcome(outcome)) {
        throw new Error(`conflicting scheduler outcomes for decision ${outcome.decisionId}`);
      }
      if (existing) return;
    }
    if (!outcome.clock.clockComplete) return;

    const samples = this.samplesByRuntime.get(outcome.requestedRuntime) ?? new Map();
    samples.set(outcome.decisionId, outcome);
    const ordered = [...samples.values()].sort((left, right) => {
      const leftTime = left.clock.clockComplete
        ? left.clock.releasedAt
        : left.terminalResult.updatedAt;
      const rightTime = right.clock.clockComplete
        ? right.clock.releasedAt
        : right.terminalResult.updatedAt;
      const timeOrder = Date.parse(leftTime) - Date.parse(rightTime);
      return timeOrder || left.decisionId.localeCompare(right.decisionId);
    });
    for (const stale of ordered.slice(0, Math.max(0, ordered.length - this.options.windowSize))) {
      samples.delete(stale.decisionId);
    }
    this.samplesByRuntime.set(outcome.requestedRuntime, samples);
  }

  get(runtime: DispatcherRuntime): z.infer<typeof schedulerServiceEstimateSchema> | null {
    dispatcherRuntimeSchema.parse(runtime);
    return buildRollingMedianDurationEstimate(
      [...(this.samplesByRuntime.get(runtime)?.values() ?? [])],
      this.options,
    );
  }
}
