/**
 * Worker liveness assessment (issue #389).
 *
 * A single deterministic definition of "is the Hugin dispatcher worker
 * alive" from its `tasks/_heartbeat` Munin entry, so submitters (Claude
 * skills) and Heimdall agree on the same states instead of each guessing at
 * a staleness threshold. Pure and content-blind: it only ever inspects ids,
 * timestamps, and counts — never task prompt/response text.
 */
import { z } from "zod";

/** A stale heartbeat is `>= STALE_MULTIPLIER` poll intervals old, floored at MIN_THRESHOLD_MS. */
export const WORKER_LIVENESS_STALE_MULTIPLIER = 3;
/** Absolute floor for the staleness threshold, regardless of a very small poll interval. */
export const WORKER_LIVENESS_MIN_THRESHOLD_MS = 180_000;
/** A `polled_at` this far in the future (clock skew) is tolerated as healthy, not "malformed". */
export const WORKER_LIVENESS_CLOCK_SKEW_TOLERANCE_MS = 60_000;
/** Same maximum accepted by the dispatcher's HUGIN_POLL_INTERVAL_MS parser. */
export const WORKER_LIVENESS_MAX_POLL_INTERVAL_MS = 3_600_000;
export const WORKER_LIVENESS_ID_MAX_LENGTH = 200;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

/**
 * Id formats the dispatcher actually writes: a plain worker id (e.g. `hugin-<host>`) and a
 * Munin task namespace (`tasks/<id>`). Anything else (free text, other namespaces) is
 * refused so the content-blind output can never echo stored prose.
 */
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TASK_ID_PATTERN = /^tasks\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,193}$/;

export function isSafeWorkerLivenessId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= WORKER_LIVENESS_ID_MAX_LENGTH
    && !CONTROL_CHARACTER_PATTERN.test(value)
    && (WORKER_ID_PATTERN.test(value) || TASK_ID_PATTERN.test(value));
}

function assertValidPollIntervalMs(pollIntervalMs: number): void {
  if (
    !Number.isSafeInteger(pollIntervalMs)
    || pollIntervalMs <= 0
    || pollIntervalMs > WORKER_LIVENESS_MAX_POLL_INTERVAL_MS
  ) {
    throw new Error(
      `pollIntervalMs must be a positive integer no greater than ${WORKER_LIVENESS_MAX_POLL_INTERVAL_MS}`,
    );
  }
}

/** threshold = max(3 * pollIntervalMs, 180_000) */
export function computeWorkerLivenessThresholdMs(pollIntervalMs: number): number {
  assertValidPollIntervalMs(pollIntervalMs);
  return Math.max(WORKER_LIVENESS_STALE_MULTIPLIER * pollIntervalMs, WORKER_LIVENESS_MIN_THRESHOLD_MS);
}

export type WorkerLivenessState =
  | "healthy-idle"
  | "healthy-busy"
  | "stale"
  | "absent"
  | "malformed";

export interface WorkerLivenessAssessment {
  state: WorkerLivenessState;
  ageMs: number | null;
  thresholdMs: number;
  workerId: string | null;
  currentTask: string | null;
  attention: boolean;
  reason: string;
}

export interface AssessWorkerLivenessInput {
  /** The raw `tasks/_heartbeat` entry content: a JSON string, an already-parsed
   *  object, or `null`/`undefined` when the entry itself was never found. */
  heartbeat: unknown;
  now: Date;
  pollIntervalMs: number;
  /** Number of pending tasks, when cheaply known. `undefined` means unknown. */
  pendingCount?: number;
}

// Only the fields liveness assessment needs are validated. Unknown extra
// fields (queue observability, ollama_loaded, etc.) are accepted but never
// read here, so a heartbeat schema addition elsewhere cannot make this
// module falsely report "malformed".
const heartbeatShapeSchema = z
  .object({
    worker_id: z.string().max(WORKER_LIVENESS_ID_MAX_LENGTH).regex(WORKER_ID_PATTERN).nullish(),
    current_task: z.string().max(WORKER_LIVENESS_ID_MAX_LENGTH).regex(TASK_ID_PATTERN).nullish(),
    polled_at: z.string().min(1),
  })
  .passthrough();

function attentionFor(state: WorkerLivenessState, pendingCount: number | undefined): boolean {
  if (state === "healthy-idle" || state === "healthy-busy") return false;
  if (pendingCount === undefined) return true;
  return pendingCount > 0;
}

function malformedResult(
  reason: string,
  pendingCount: number | undefined,
  thresholdMs: number,
  workerId: string | null = null,
  currentTask: string | null = null,
): WorkerLivenessAssessment {
  return {
    state: "malformed",
    ageMs: null,
    thresholdMs,
    workerId,
    currentTask,
    attention: attentionFor("malformed", pendingCount),
    reason,
  };
}

export function assessWorkerLiveness(input: AssessWorkerLivenessInput): WorkerLivenessAssessment {
  const thresholdMs = computeWorkerLivenessThresholdMs(input.pollIntervalMs);
  const { heartbeat, pendingCount } = input;

  if (heartbeat === null || heartbeat === undefined) {
    return {
      state: "absent",
      ageMs: null,
      thresholdMs,
      workerId: null,
      currentTask: null,
      attention: attentionFor("absent", pendingCount),
      reason: "no tasks/_heartbeat entry found",
    };
  }

  let candidate: unknown = heartbeat;
  if (typeof heartbeat === "string") {
    try {
      candidate = JSON.parse(heartbeat);
    } catch {
      return malformedResult("heartbeat content is not valid JSON", pendingCount, thresholdMs);
    }
  }

  const parsed = heartbeatShapeSchema.safeParse(candidate);
  if (!parsed.success) {
    return malformedResult(
      `heartbeat failed schema validation: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      pendingCount,
      thresholdMs,
    );
  }

  const workerId = parsed.data.worker_id ?? null;
  const currentTask = parsed.data.current_task ?? null;

  const polledAtMs = Date.parse(parsed.data.polled_at);
  if (Number.isNaN(polledAtMs)) {
    return malformedResult(
      "polled_at is not a parseable timestamp",
      pendingCount,
      thresholdMs,
      workerId,
      currentTask,
    );
  }

  const ageMs = input.now.getTime() - polledAtMs;

  if (ageMs < -WORKER_LIVENESS_CLOCK_SKEW_TOLERANCE_MS) {
    return {
      state: "malformed",
      ageMs,
      thresholdMs,
      workerId,
      currentTask,
      attention: attentionFor("malformed", pendingCount),
      reason:
        `polled_at is ${Math.abs(ageMs)}ms in the future, beyond the ` +
        `${WORKER_LIVENESS_CLOCK_SKEW_TOLERANCE_MS}ms clock-skew tolerance`,
    };
  }

  if (ageMs > thresholdMs) {
    return {
      state: "stale",
      ageMs,
      thresholdMs,
      workerId,
      currentTask,
      attention: attentionFor("stale", pendingCount),
      reason: `heartbeat age ${ageMs}ms exceeds the ${thresholdMs}ms staleness threshold`,
    };
  }

  const state: WorkerLivenessState = currentTask ? "healthy-busy" : "healthy-idle";
  return {
    state,
    ageMs,
    thresholdMs,
    workerId,
    currentTask,
    attention: attentionFor(state, pendingCount),
    reason: currentTask
      ? `heartbeat age ${ageMs}ms is within the ${thresholdMs}ms threshold; worker executing ${currentTask}`
      : `heartbeat age ${ageMs}ms is within the ${thresholdMs}ms threshold; worker idle`,
  };
}
