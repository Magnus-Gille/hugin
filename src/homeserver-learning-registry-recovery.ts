import type { MuninClient, MuninQueryResult } from "./munin-client.js";
import { queryAllMuninEntries, type MuninPaginationBudget } from "./munin-pagination.js";
import type { LearningRegistryStore } from "./learning-registry-store.js";
import {
  recordAdmittedHomeserverAttempt,
  type HomeserverLearningRegistrySkipReason,
} from "./homeserver-learning-registry-bridge.js";
import type { ResolveM5LedgerAttemptBinding } from "./m5-ledger-attempt-binding.js";
import { structuredTaskResultSchema } from "./task-result-schema.js";

export const LEARNING_REGISTRY_PENDING_TAG = "learning-registry:pending";
export const LEARNING_REGISTRY_CAPTURED_TAG = "learning-registry:captured";
export const LEARNING_REGISTRY_REJECTED_TAG = "learning-registry:rejected";

type RecoveryMunin = Pick<MuninClient, "read" | "write" | "query" | "log">;

export interface HomeserverLearningRegistryRecoveryDeps {
  munin: RecoveryMunin;
  registry: LearningRegistryStore;
  resolveLedgerAttemptBinding: ResolveM5LedgerAttemptBinding;
}

export type CapturePendingHomeserverLearningResult =
  | { status: "not-pending" }
  | { status: "captured"; attemptId: string }
  | { status: "rejected"; reason: HomeserverLearningRegistrySkipReason };

function replaceCaptureTag(tags: string[], replacement: string): string[] {
  return [...tags.filter((tag) => !tag.startsWith("learning-registry:")), replacement];
}

async function writeCaptureStatus(
  munin: RecoveryMunin,
  taskNamespace: string,
  status: NonNullable<Awaited<ReturnType<RecoveryMunin["read"]>>>,
  tag: string,
): Promise<void> {
  await munin.write(
    taskNamespace,
    "status",
    status.content,
    replaceCaptureTag(status.tags, tag),
    status.updated_at,
    status.classification,
  );
}

/** Replays only durable terminal evidence; all registry writes are natural-key idempotent. */
export async function capturePendingHomeserverLearningTask(
  deps: HomeserverLearningRegistryRecoveryDeps,
  taskNamespace: string,
): Promise<CapturePendingHomeserverLearningResult> {
  const status = await deps.munin.read(taskNamespace, "status");
  if (!status?.tags.includes(LEARNING_REGISTRY_PENDING_TAG)) return { status: "not-pending" };
  const resultEntry = await deps.munin.read(taskNamespace, "result-structured");
  if (!resultEntry) throw new Error(`${taskNamespace} has pending learning capture but no result-structured`);

  let raw: unknown;
  try {
    raw = JSON.parse(resultEntry.content);
  } catch {
    throw new Error(`${taskNamespace} has invalid pending result-structured JSON`);
  }
  const result = structuredTaskResultSchema.parse(raw);
  const learningTask = result.runtimeMetadata?.learningTask;
  const provenance = result.runtimeMetadata?.delegation;
  const taskType = provenance?.taskType;
  if (result.runtime !== "homeserver" || !learningTask || !provenance || !taskType) {
    await writeCaptureStatus(deps.munin, taskNamespace, status, LEARNING_REGISTRY_REJECTED_TAG);
    return { status: "rejected", reason: "missing-delegation-identity" };
  }

  const capture = await recordAdmittedHomeserverAttempt({
    registry: deps.registry,
    resolveLedgerAttemptBinding: deps.resolveLedgerAttemptBinding,
  }, {
    taskId: result.taskId,
    taskType,
    occurredAt: result.startedAt ?? result.completedAt,
    outcome: result.outcome,
    repositoryOutcomeState: result.repositoryOutcome?.state ?? "missing",
    learningTask,
    provenance,
  });
  if (capture.status === "skipped") {
    await writeCaptureStatus(deps.munin, taskNamespace, status, LEARNING_REGISTRY_REJECTED_TAG);
    await deps.munin.log(taskNamespace, `Learning registry capture rejected: ${capture.reason}`).catch(() => {});
    return { status: "rejected", reason: capture.reason };
  }
  await writeCaptureStatus(deps.munin, taskNamespace, status, LEARNING_REGISTRY_CAPTURED_TAG);
  await deps.munin.log(
    taskNamespace,
    `Learning registry captured admitted homeserver attempt ${capture.attemptId}`,
  ).catch(() => {});
  return { status: "captured", attemptId: capture.attemptId };
}

export interface ReconcileHomeserverLearningResult {
  scanned: number;
  captured: number;
  rejected: number;
  failed: number;
  truncated: boolean;
}

export async function reconcilePendingHomeserverLearningTasks(
  deps: HomeserverLearningRegistryRecoveryDeps,
  budget: MuninPaginationBudget = { maxPages: 20, maxResults: 1_000 },
): Promise<ReconcileHomeserverLearningResult> {
  const query = await queryAllMuninEntries(
    deps.munin,
    { namespace: "tasks/", tags: [LEARNING_REGISTRY_PENDING_TAG], entry_type: "state" },
    budget,
  );
  const statuses = query.results.filter((entry: MuninQueryResult) => entry.key === "status");
  let captured = 0;
  let rejected = 0;
  let failed = 0;
  for (const status of statuses) {
    try {
      const result = await capturePendingHomeserverLearningTask(deps, status.namespace);
      if (result.status === "captured") captured += 1;
      if (result.status === "rejected") rejected += 1;
    } catch (error) {
      failed += 1;
      const detail = error instanceof Error ? error.message : String(error);
      await deps.munin.log(status.namespace, `Learning registry capture retry failed: ${detail}`).catch(() => {});
    }
  }
  return { scanned: statuses.length, captured, rejected, failed, truncated: query.truncated };
}
