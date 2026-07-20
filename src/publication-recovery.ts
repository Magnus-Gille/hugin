/**
 * Munin-backed durability and recovery for managed-repository publication
 * failures (issue #225).
 *
 * `task-helpers.ts` owns the pure git/gh mechanics (`recoverPublication`,
 * `buildPublicationRecoveryRecord`). This module owns the Munin I/O: writing
 * the durable record when publication fails, and the idempotent,
 * operator-triggered recovery orchestration that reads it back, retries ONLY
 * the publication step, and reconciles the task's terminal state. It never
 * imports or calls anything from the executor/runtime path — recovery cannot
 * re-run paid model work even by accident, because this module has no way to
 * invoke one.
 */
import type { MuninEntry } from "./munin-client.js";
import {
  PUBLICATION_ABANDONED_TAG,
  PUBLICATION_FAILED_TAG,
  PUBLICATION_RECOVERED_TAG,
  buildPublicationRecoveryRecord,
  recoverPublication,
  type BuildPublicationRecoveryRecordInput,
  type PublicationRecoveryAttemptResult,
  type PublicationRecoveryOutcome,
  type PublicationRecoveryRecord,
} from "./task-helpers.js";
import { buildTerminalStatusTags } from "./task-status-tags.js";
import {
  buildStructuredTaskResult,
  structuredTaskResultSchema,
  type StructuredTaskResult,
} from "./task-result-schema.js";

export const PUBLICATION_RECOVERY_KEY = "publication-recovery";

/** Minimal Munin surface this module needs. A real `MuninClient` satisfies it. */
export interface PublicationRecoveryMuninClient {
  read(namespace: string, key: string): Promise<(MuninEntry & { found: true }) | null>;
  write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
  ): Promise<unknown>;
  log(namespace: string, content: string): Promise<unknown>;
}

export type PersistPublicationFailureParams = BuildPublicationRecoveryRecordInput & {
  classification?: string;
};

/** Persist the durable recovery record the moment publication fails. */
export async function persistPublicationFailure(
  client: PublicationRecoveryMuninClient,
  params: PersistPublicationFailureParams,
): Promise<PublicationRecoveryRecord> {
  const record = buildPublicationRecoveryRecord(params);
  await client.write(
    params.taskNamespace,
    PUBLICATION_RECOVERY_KEY,
    JSON.stringify(record, null, 2),
    undefined,
    undefined,
    params.classification,
  );
  return record;
}

/** Read back a previously persisted record. Malformed/missing content -> null. */
export async function readPublicationRecoveryRecord(
  client: PublicationRecoveryMuninClient,
  taskNamespace: string,
): Promise<PublicationRecoveryRecord | null> {
  const entry = await client.read(taskNamespace, PUBLICATION_RECOVERY_KEY);
  if (!entry?.content) return null;
  try {
    const parsed = JSON.parse(entry.content) as Partial<PublicationRecoveryRecord>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.taskId === "string" &&
      typeof parsed.taskNamespace === "string" &&
      typeof parsed.workingDir === "string" &&
      typeof parsed.branchName === "string" &&
      typeof parsed.baseBranch === "string" &&
      typeof parsed.baseCommit === "string" &&
      typeof parsed.prBody === "string" &&
      Array.isArray(parsed.allowedEgressHosts) &&
      typeof parsed.failureReason === "string" &&
      typeof parsed.attempts === "number" &&
      typeof parsed.firstFailedAt === "string" &&
      typeof parsed.lastAttemptAt === "string"
    ) {
      return parsed as PublicationRecoveryRecord;
    }
  } catch {
    /* malformed -> treated as no durable record below */
  }
  return null;
}

export interface RecoverPublicationOutcome {
  /**
   * `noop`: nothing to do (already recovered/abandoned, or never failed).
   * `no-record`: tagged `publication:failed` but the durable record is
   * missing or malformed — surfaced so an operator can investigate rather
   * than being silently skipped.
   * Otherwise mirrors {@link PublicationRecoveryOutcome}.
   */
  status: "noop" | "no-record" | PublicationRecoveryOutcome;
  taskNamespace: string;
  prUrl?: string;
  reason?: string;
  error?: string;
}

function currentLifecycle(tags: string[]): "completed" | "failed" | "cancelled" {
  if (tags.includes("cancelled")) return "cancelled";
  if (tags.includes("failed")) return "failed";
  return "completed";
}

async function patchStructuredResultForRecovery(
  client: PublicationRecoveryMuninClient,
  taskNamespace: string,
  attemptResult: PublicationRecoveryAttemptResult,
  classification: string | undefined,
): Promise<void> {
  const entry = await client.read(taskNamespace, "result-structured");
  if (!entry?.content) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.content);
  } catch {
    return;
  }
  const existingResult = structuredTaskResultSchema.safeParse(parsed);
  if (!existingResult.success) return;
  const existing = existingResult.data;
  const baseBranch = existing.repositoryOutcome?.baseBranch ?? existing.repositoryChange?.baseBranch;
  const baseCommit = existing.repositoryOutcome?.baseCommit ?? existing.repositoryChange?.baseCommit;
  if (!baseBranch || !baseCommit) return;

  let patched: StructuredTaskResult;
  try {
    patched = buildStructuredTaskResult({
      ...existing,
      prUrl: attemptResult.prUrl ?? existing.prUrl,
      repositoryOutcome: {
        state: attemptResult.outcome === "abandoned" ? "publication-abandoned" : "publication-recovered",
        baseBranch,
        baseCommit,
      },
    });
  } catch {
    // A patch that fails re-validation must never corrupt the durable
    // result — leave the prior (still-honest "publication-failed") record.
    return;
  }

  await client.write(
    taskNamespace,
    "result-structured",
    JSON.stringify(patched, null, 2),
    ["type:task-result", "type:task-result-structured"],
    undefined,
    classification,
  );
}

async function appendRecoveryNoteToResult(
  client: PublicationRecoveryMuninClient,
  taskNamespace: string,
  attemptResult: PublicationRecoveryAttemptResult,
  classification: string | undefined,
): Promise<void> {
  const entry = await client.read(taskNamespace, "result");
  const baseDoc = entry?.content ?? "## Result\n";
  const note = attemptResult.outcome === "abandoned"
    ? [
      "",
      "### Publication Recovery",
      "",
      "- **Outcome:** abandoned",
      `- **Reason:** ${attemptResult.reason ?? "unrecoverable"}`,
      "- **Action required:** the completed work is preserved (see repository evidence above); publish it manually.",
      "",
    ].join("\n")
    : [
      "",
      "### Publication Recovery",
      "",
      `- **Outcome:** ${attemptResult.outcome}`,
      `- **PR:** ${attemptResult.prUrl}`,
      "",
    ].join("\n");
  await client.write(
    taskNamespace,
    "result",
    `${baseDoc}${note}`,
    undefined,
    undefined,
    classification,
  );
}

/**
 * The single operator-triggered recovery entrypoint. Idempotent: calling it
 * again after a terminal recovery outcome (`published`/`reconciled`/
 * `abandoned`) is a no-op that never touches git/gh again. Calling it after a
 * `failed` attempt retries — still publication-only, still no executor.
 */
export async function recoverPublicationForTask(
  client: PublicationRecoveryMuninClient,
  taskNamespace: string,
  options: { now?: () => Date } = {},
): Promise<RecoverPublicationOutcome> {
  const now = options.now ?? (() => new Date());

  const statusEntry = await client.read(taskNamespace, "status");
  if (!statusEntry) {
    return { status: "noop", taskNamespace, reason: "no status entry for task" };
  }
  if (
    statusEntry.tags.includes(PUBLICATION_RECOVERED_TAG) ||
    statusEntry.tags.includes(PUBLICATION_ABANDONED_TAG)
  ) {
    return { status: "noop", taskNamespace, reason: "publication recovery already reached a terminal outcome" };
  }
  if (!statusEntry.tags.includes(PUBLICATION_FAILED_TAG)) {
    return { status: "noop", taskNamespace, reason: "task is not in a publication:failed state" };
  }

  const record = await readPublicationRecoveryRecord(client, taskNamespace);
  if (!record) {
    return { status: "no-record", taskNamespace, reason: "no durable publication-recovery record found" };
  }

  const attemptResult = await recoverPublication(record);

  const updatedRecord: PublicationRecoveryRecord = {
    ...record,
    attempts: record.attempts + 1,
    lastAttemptAt: now().toISOString(),
    lastError:
      attemptResult.outcome === "failed" || attemptResult.outcome === "abandoned"
        ? attemptResult.error ?? attemptResult.reason
        : undefined,
  };
  await client.write(
    taskNamespace,
    PUBLICATION_RECOVERY_KEY,
    JSON.stringify(updatedRecord, null, 2),
    undefined,
    undefined,
    statusEntry.classification,
  );

  if (attemptResult.outcome === "failed") {
    await client.log(
      taskNamespace,
      `Publication recovery attempt ${updatedRecord.attempts} failed: ${attemptResult.error ?? "unknown error"} — retryable`,
    );
    return { status: "failed", taskNamespace, error: attemptResult.error };
  }

  // published / reconciled / abandoned are all TERMINAL recovery outcomes.
  const newTag = attemptResult.outcome === "abandoned" ? PUBLICATION_ABANDONED_TAG : PUBLICATION_RECOVERED_TAG;
  const runtimeTag = statusEntry.tags.find((t) => t.startsWith("runtime:"));
  const newTags = buildTerminalStatusTags(
    currentLifecycle(statusEntry.tags),
    [...statusEntry.tags.filter((t) => !t.startsWith("publication:")), newTag],
    runtimeTag,
  );

  try {
    await client.write(
      taskNamespace,
      "status",
      statusEntry.content,
      newTags,
      statusEntry.updated_at,
      statusEntry.classification,
    );
  } catch (err) {
    // Someone else touched the status entry between our read and this write
    // (CAS conflict). The recovery record above already reflects the
    // attempt; leave the tag alone so a subsequent recovery run reconciles
    // it instead of masking the conflict.
    return {
      status: "failed",
      taskNamespace,
      error: `status update lost a concurrent write: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await patchStructuredResultForRecovery(client, taskNamespace, attemptResult, statusEntry.classification);
  await appendRecoveryNoteToResult(client, taskNamespace, attemptResult, statusEntry.classification);

  await client.log(
    taskNamespace,
    attemptResult.outcome === "abandoned"
      ? `Publication recovery abandoned: ${attemptResult.reason ?? "unrecoverable"}`
      : `Publication recovered (${attemptResult.outcome}): ${attemptResult.prUrl ?? ""}`,
  );

  return {
    status: attemptResult.outcome,
    taskNamespace,
    prUrl: attemptResult.prUrl,
    reason: attemptResult.reason,
    error: attemptResult.error,
  };
}
