import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalizeJcs } from "./jcs.js";
import type { MuninQueryResult } from "./munin-client.js";
import {
  SCHEDULER_ESTIMATOR_VERSION,
  schedulerServiceEstimateSchema,
  schedulerTaskRefSchema,
} from "./scheduler-evidence.js";

export const SCHEDULER_WORKLOAD_SNAPSHOT_VERSION = 1 as const;

const isoTimestampSchema = z.string().datetime({ offset: true });
const nonnegativeFiniteSchema = z.number().finite().nonnegative();

export const schedulerWorkloadBucketKeySchema = z.enum([
  "dispatchable",
  "groupBlocked",
  "pipelineBlocked",
  "approvalGated",
  "otherNonterminal",
  "runningRemaining",
]);
export type SchedulerWorkloadBucketKey = z.infer<
  typeof schedulerWorkloadBucketKeySchema
>;

const bucketCompletenessSchema = z.object({
  dispatchable: z.boolean(),
  groupBlocked: z.boolean(),
  pipelineBlocked: z.boolean(),
  approvalGated: z.boolean(),
  otherNonterminal: z.boolean(),
  runningRemaining: z.boolean(),
}).strict();

const schedulerWorkloadSummarySchema = z.object({
  taskCount: z.number().int().nonnegative(),
  knownWorkMinutes: nonnegativeFiniteSchema,
  estimatedWorkMinutes: nonnegativeFiniteSchema.nullable(),
  missingEstimates: z.number().int().nonnegative(),
  enumerationComplete: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.missingEstimates > value.taskCount) {
    ctx.addIssue({
      code: "custom",
      path: ["missingEstimates"],
      message: "missing estimates cannot exceed task count",
    });
  }
  const totalAvailable = value.enumerationComplete && value.missingEstimates === 0;
  if (totalAvailable !== (value.estimatedWorkMinutes !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["estimatedWorkMinutes"],
      message: "estimated total requires complete enumeration and estimates",
    });
  }
  if (value.estimatedWorkMinutes !== null
    && Math.abs(value.estimatedWorkMinutes - value.knownWorkMinutes) > 1e-9) {
    ctx.addIssue({
      code: "custom",
      path: ["estimatedWorkMinutes"],
      message: "complete estimated work must equal known work",
    });
  }
});

export const schedulerWorkloadSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEDULER_WORKLOAD_SNAPSHOT_VERSION),
  observedAt: isoTimestampSchema,
  estimatorVersion: z.literal(SCHEDULER_ESTIMATOR_VERSION),
  buckets: z.object({
    dispatchable: schedulerWorkloadSummarySchema,
    groupBlocked: schedulerWorkloadSummarySchema,
    pipelineBlocked: schedulerWorkloadSummarySchema,
    approvalGated: schedulerWorkloadSummarySchema,
    otherNonterminal: schedulerWorkloadSummarySchema,
    runningRemaining: schedulerWorkloadSummarySchema,
  }).strict(),
  possibleTotalWork: schedulerWorkloadSummarySchema,
}).strict().superRefine((value, ctx) => {
  const allBucketsComplete = Object.values(value.buckets).every(
    (bucket) => bucket.enumerationComplete,
  );
  if (value.possibleTotalWork.enumerationComplete !== allBucketsComplete) {
    ctx.addIssue({
      code: "custom",
      path: ["possibleTotalWork", "enumerationComplete"],
      message: "possible total completeness must match every bucket",
    });
  }
});
export type SchedulerWorkloadSnapshot = z.infer<typeof schedulerWorkloadSnapshotSchema>;

export interface SchedulerWorkloadItem {
  taskRef: z.input<typeof schedulerTaskRefSchema>;
  buckets: SchedulerWorkloadBucketKey[];
  serviceEstimate: unknown | null;
  runningElapsedSeconds?: number;
}

export interface BuildSchedulerWorkloadSnapshotInput {
  observedAt: string;
  bucketEnumerationComplete: z.input<typeof bucketCompletenessSchema>;
  items: SchedulerWorkloadItem[];
}

export interface BuildSchedulerWorkloadSnapshotFromVisibleQueueInput {
  enabled: boolean;
  observedAt: string;
  pendingEnumerationComplete: boolean;
  runningEnumerationComplete: boolean;
  pending: readonly MuninQueryResult[];
  running: readonly MuninQueryResult[];
  eligibleTaskRefs: readonly z.input<typeof schedulerTaskRefSchema>[];
  resolveServiceEstimate: (task: MuninQueryResult) => unknown | null;
}

interface NormalizedWorkItem {
  buckets: Set<SchedulerWorkloadBucketKey>;
  contributionSeconds: number | null;
  evidenceFingerprint: string;
  conflicted: boolean;
}

function itemIdentity(taskRef: z.infer<typeof schedulerTaskRefSchema>): string {
  return `${taskRef.namespace}\0${taskRef.key}`;
}

function normalizeContribution(
  item: SchedulerWorkloadItem,
  buckets: SchedulerWorkloadBucketKey[],
  observedAtMs: number,
): { contributionSeconds: number | null; evidenceFingerprint: string } {
  const parsedEstimate = item.serviceEstimate === null
    ? null
    : schedulerServiceEstimateSchema.safeParse(item.serviceEstimate);
  const estimate = parsedEstimate?.success === true
    && Date.parse(parsedEstimate.data.historyThrough) <= observedAtMs
    ? parsedEstimate.data
    : null;
  const isRunning = buckets.includes("runningRemaining");
  const elapsed = item.runningElapsedSeconds;
  const elapsedValid = elapsed !== undefined
    && Number.isFinite(elapsed)
    && elapsed >= 0;
  if (!estimate || (isRunning && !elapsedValid)) {
    return {
      contributionSeconds: null,
      evidenceFingerprint: canonicalizeJcs({
        estimate: estimate ?? null,
        runningElapsedSeconds: isRunning && elapsedValid ? elapsed : null,
      }),
    };
  }
  const contributionSeconds = isRunning
    ? Math.max(0, estimate.seconds - elapsed!)
    : estimate.seconds;
  return {
    contributionSeconds,
    evidenceFingerprint: canonicalizeJcs({
      estimate,
      runningElapsedSeconds: isRunning ? elapsed : null,
    }),
  };
}

function summarize(
  items: NormalizedWorkItem[],
  enumerationComplete: boolean,
): z.infer<typeof schedulerWorkloadSummarySchema> {
  const knownSeconds = items.reduce(
    (total, item) => total + (item.contributionSeconds ?? 0),
    0,
  );
  const missingEstimates = items.filter(
    (item) => item.contributionSeconds === null || item.conflicted,
  ).length;
  const knownWorkMinutes = knownSeconds / 60;
  return schedulerWorkloadSummarySchema.parse({
    taskCount: items.length,
    knownWorkMinutes,
    estimatedWorkMinutes:
      enumerationComplete && missingEstimates === 0 ? knownWorkMinutes : null,
    missingEstimates,
    enumerationComplete,
  });
}

/**
 * Build a behavior-neutral workload observation. Diagnostic buckets may
 * overlap, but possibleTotalWork always counts each safe task reference once.
 * Unknown, future, or conflicting estimates remain explicit missing evidence.
 */
export function buildSchedulerWorkloadSnapshot(
  input: BuildSchedulerWorkloadSnapshotInput,
): SchedulerWorkloadSnapshot {
  const observedAt = isoTimestampSchema.parse(input.observedAt);
  const observedAtMs = Date.parse(observedAt);
  const completeness = bucketCompletenessSchema.parse(
    input.bucketEnumerationComplete,
  );
  const byTask = new Map<string, NormalizedWorkItem>();

  for (const rawItem of input.items) {
    const taskRef = schedulerTaskRefSchema.parse(rawItem.taskRef);
    const buckets = schedulerWorkloadBucketKeySchema
      .array()
      .min(1)
      .parse(rawItem.buckets);
    const running = buckets.includes("runningRemaining");
    if (running && buckets.length !== 1) {
      throw new Error("runningRemaining must be exclusive of non-running buckets");
    }
    if (!running && rawItem.runningElapsedSeconds !== undefined) {
      throw new Error("running elapsed requires runningRemaining membership");
    }
    if (rawItem.runningElapsedSeconds !== undefined) {
      nonnegativeFiniteSchema.parse(rawItem.runningElapsedSeconds);
    }
    const normalized = normalizeContribution(rawItem, buckets, observedAtMs);
    const identity = itemIdentity(taskRef);
    const existing = byTask.get(identity);
    if (!existing) {
      byTask.set(identity, {
        buckets: new Set(buckets),
        contributionSeconds: normalized.contributionSeconds,
        evidenceFingerprint: normalized.evidenceFingerprint,
        conflicted: false,
      });
      continue;
    }
    if (existing.buckets.has("runningRemaining") !== running) {
      throw new Error("runningRemaining must be exclusive of non-running buckets");
    }
    for (const bucket of buckets) existing.buckets.add(bucket);
    if (existing.evidenceFingerprint !== normalized.evidenceFingerprint) {
      existing.contributionSeconds = null;
      existing.conflicted = true;
    }
  }

  const uniqueItems = [...byTask.values()];
  const bucketItems = (bucket: SchedulerWorkloadBucketKey) =>
    uniqueItems.filter((item) => item.buckets.has(bucket));
  const allEnumerationComplete = schedulerWorkloadBucketKeySchema.options.every(
    (bucket) => completeness[bucket],
  );

  return schedulerWorkloadSnapshotSchema.parse({
    schemaVersion: SCHEDULER_WORKLOAD_SNAPSHOT_VERSION,
    observedAt,
    estimatorVersion: SCHEDULER_ESTIMATOR_VERSION,
    buckets: {
      dispatchable: summarize(bucketItems("dispatchable"), completeness.dispatchable),
      groupBlocked: summarize(bucketItems("groupBlocked"), completeness.groupBlocked),
      pipelineBlocked: summarize(bucketItems("pipelineBlocked"), completeness.pipelineBlocked),
      approvalGated: summarize(bucketItems("approvalGated"), completeness.approvalGated),
      otherNonterminal: summarize(
        bucketItems("otherNonterminal"),
        completeness.otherNonterminal,
      ),
      runningRemaining: summarize(
        bucketItems("runningRemaining"),
        completeness.runningRemaining,
      ),
    },
    possibleTotalWork: summarize(uniqueItems, allEnumerationComplete),
  });
}

/**
 * Convert the pending/running pages already fetched by the claim loop into a
 * conservative workload observation. Disabled or incomplete enumeration
 * returns before traversing queue rows or resolving estimates.
 *
 * Pending tasks are the only tasks with enough evidence to carry estimates in
 * this first live binding. Running tasks remain explicit missing work until an
 * authenticated elapsed-time boundary exists.
 */
export function buildSchedulerWorkloadSnapshotFromVisibleQueue(
  input: BuildSchedulerWorkloadSnapshotFromVisibleQueueInput,
): SchedulerWorkloadSnapshot | null {
  if (!input.enabled
    || !input.pendingEnumerationComplete
    || !input.runningEnumerationComplete) {
    return null;
  }

  const eligible = new Set(input.eligibleTaskRefs.map((rawTaskRef) => {
    const taskRef = schedulerTaskRefSchema.parse(rawTaskRef);
    return itemIdentity(taskRef);
  }));
  const items: SchedulerWorkloadItem[] = [];
  for (const task of input.pending) {
    const taskRef = schedulerTaskRefSchema.parse({
      namespace: task.namespace,
      key: task.key,
    });
    const orchestrated = task.tags.includes("orch-v1");
    items.push({
      taskRef,
      buckets: [
        orchestrated
          ? "otherNonterminal"
          : eligible.has(itemIdentity(taskRef))
            ? "dispatchable"
            : "groupBlocked",
      ],
      serviceEstimate: orchestrated ? null : input.resolveServiceEstimate(task),
    });
  }
  for (const task of input.running) {
    const taskRef = schedulerTaskRefSchema.parse({
      namespace: task.namespace,
      key: task.key,
    });
    items.push({
      taskRef,
      buckets: ["runningRemaining"],
      serviceEstimate: null,
    });
  }

  return buildSchedulerWorkloadSnapshot({
    observedAt: input.observedAt,
    bucketEnumerationComplete: {
      dispatchable: true,
      groupBlocked: true,
      pipelineBlocked: false,
      approvalGated: false,
      otherNonterminal: false,
      runningRemaining: true,
    },
    items,
  });
}

export function hashSchedulerWorkloadSnapshot(value: unknown): string {
  const snapshot = schedulerWorkloadSnapshotSchema.parse(value);
  return createHash("sha256")
    .update(canonicalizeJcs(snapshot), "utf8")
    .digest("hex");
}
