/**
 * Orchestrator-v1 worker (§12.2 → §12.3).
 *
 * Polls Munin for pending orch-v1 tasks, claims one at a time via a
 * CAS lease, hands the envelope to the OpenRouter executor, and writes
 * the result through the two-phase complete in `BrokerTaskStore`.
 *
 * Scope (Step 5b):
 *   - One task per worker tick. No parallelism. Multiple workers can
 *     run side-by-side because the claim is CAS-guarded by the status
 *     entry's `updated_at`.
 *   - Only handles `runtime: openrouter`, `family: one-shot`. Tasks
 *     resolved to other runtimes are left in `pending` for a future
 *     pi-harness worker (Step 5b/pi-harness).
 *   - Lease metadata uses the same `claimed_by:<id>` / `lease_expires:<ms>`
 *     tags as the legacy dispatcher so the existing reaper can recover
 *     orphaned orch-v1 tasks.
 *
 * Out of scope:
 *   - Lease renewal / heartbeat. One-shot OpenRouter calls are bounded
 *     by `timeout_ms` (default 300s), well under a fresh lease window.
 *   - Retry / queue-back. The journal carries `retryable: true` for
 *     callers that want to resubmit, but the worker itself does not
 *     re-enqueue.
 *   - Pi-harness execution. That is Step 5b/pi-harness — separate
 *     executor, separate worker.
 */

import type { MuninClient, MuninEntry } from "../munin-client.js";
import type {
  DelegationResult,
  ScannerPolicy,
} from "../finalize-delegated-output.js";
import type { OpenRouterClient } from "../openrouter-client.js";
import {
  ONE_SHOT_DEFAULT_TIMEOUT_MS,
  executeOpenRouterDelegation,
} from "./openrouter-executor.js";
import type { DelegationJournal } from "./journal.js";
import {
  BrokerTaskStore,
  ORCH_V1_TAG,
  RESULT_ERROR_KEY,
  STATUS_KEY,
  flipLifecycleTags,
} from "./task-store.js";
import {
  delegationEnvelopeSchema,
  type DelegationEnvelope,
  type DelegationError,
} from "./types.js";

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
/**
 * Buffer added to the envelope's `timeout_ms` when computing the lease
 * window. A lease must outlive the executor call by enough margin to
 * cover the two-phase complete writes; otherwise the reaper could
 * recover a task that is still running.
 */
export const LEASE_BUFFER_MS = 60_000;

export interface OrchWorkerConfig {
  munin: MuninClient;
  taskStore: BrokerTaskStore;
  journal: DelegationJournal;
  openrouterClient: OpenRouterClient;
  scannerPolicy?: ScannerPolicy;
  workerId: string;
  pollIntervalMs?: number;
  /**
   * Override the lease window. When omitted, the worker derives the
   * lease from the envelope's `timeout_ms` plus `LEASE_BUFFER_MS`.
   */
  leaseDurationMs?: number;
  now?: () => Date;
}

export interface OrchWorkerTick {
  startedAt: string;
  finishedAt: string;
  task_id?: string;
  outcome: "idle" | "claimed_lost" | "completed" | "failed" | "skipped" | "error";
  message?: string;
}

interface PendingCandidate {
  task_id: string;
  namespace: string;
  status: MuninEntry;
}

interface PickResult {
  candidate: PendingCandidate;
  envelope?: DelegationEnvelope;
  parseError?: unknown;
}

export class OrchWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationOverrideMs: number | undefined;
  private readonly now: () => Date;

  constructor(private readonly config: OrchWorkerConfig) {
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.leaseDurationOverrideMs = config.leaseDurationMs;
    this.now = config.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    const tick = (): void => {
      void this.runOnce().catch((err) => {
        console.error(
          `[orch-worker] tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    };
    this.timer = setInterval(tick, this.pollIntervalMs);
    // Fire immediately so a freshly-submitted task is not stuck waiting
    // a full poll interval.
    tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<OrchWorkerTick> {
    if (this.running) {
      return mkTick(this.now(), this.now(), {
        outcome: "skipped",
        message: "tick already running",
      });
    }
    this.running = true;
    const startedAt = this.now();
    try {
      const picked = await this.pickPending();
      if (!picked) {
        return mkTick(startedAt, this.now(), { outcome: "idle" });
      }

      if (picked.parseError) {
        return await this.failUnparseable(picked.candidate, picked.parseError, startedAt);
      }

      // pickPending only returns rows where canHandle(envelope) is true
      // (or rows that failed to parse, handled above). Anything that is
      // for a different runtime/family is left in `pending` for whichever
      // worker handles it.
      const envelope = picked.envelope!;
      const candidate = picked.candidate;

      const claim = await this.claim(candidate, envelope);
      if (claim.kind === "lost") {
        return mkTick(startedAt, this.now(), {
          task_id: candidate.task_id,
          outcome: "claimed_lost",
          message: "another worker beat us to the CAS",
        });
      }
      if (claim.kind === "error") {
        return mkTick(startedAt, this.now(), {
          task_id: candidate.task_id,
          outcome: "error",
          message: `claim write failed (non-CAS): ${claim.message}`,
        });
      }

      const outcome = await executeOpenRouterDelegation(envelope, {
        client: this.config.openrouterClient,
        scannerPolicy: this.config.scannerPolicy,
        now: () => this.now().getTime(),
      });

      // Re-read status so the two-phase complete CAS sees the current
      // updated_at after our claim write landed.
      const claimedStatus = await this.config.taskStore.readStatus(candidate.task_id);
      if (!claimedStatus) {
        return mkTick(startedAt, this.now(), {
          task_id: candidate.task_id,
          outcome: "error",
          message: "status entry vanished between claim and complete",
        });
      }

      if (outcome.ok) {
        await this.config.taskStore.completeSuccess(
          candidate.task_id,
          outcome.result as unknown as Parameters<BrokerTaskStore["completeSuccess"]>[1],
          claimedStatus,
        );
        await this.appendCompleted(envelope, outcome.result);
        return mkTick(startedAt, this.now(), {
          task_id: candidate.task_id,
          outcome: "completed",
        });
      }

      await this.config.taskStore.completeFailure(
        candidate.task_id,
        outcome.error,
        claimedStatus,
      );
      await this.appendCompleted(envelope, undefined, outcome.error);
      return mkTick(startedAt, this.now(), {
        task_id: candidate.task_id,
        outcome: "failed",
        message: outcome.error.message,
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Walk the FIFO-ordered pending queue, parsing each envelope and
   * returning the first one this worker can handle. Rows for runtimes
   * or families this worker does not handle are skipped — leaving them
   * in `pending` for whichever worker (e.g. pi-harness) does. Rows that
   * fail to parse are returned immediately so the worker can flip them
   * to `failed` rather than letting them block the queue.
   */
  private async pickPending(): Promise<PickResult | undefined> {
    const { results } = await this.config.munin.query({
      query: "task",
      tags: ["pending", ORCH_V1_TAG],
      namespace: "tasks/",
      entry_type: "state",
      limit: 50,
    });
    const statusRows = results
      .filter((r) => r.key === STATUS_KEY)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const row of statusRows) {
      const taskId = row.namespace.replace(/^tasks\//, "");
      const status = await this.config.taskStore.readStatus(taskId);
      if (!status) continue;
      // The query is eventually-consistent; another worker may already
      // have flipped this past `pending`.
      if (pickLifecycleTag(status.tags) !== "pending") continue;
      const candidate: PendingCandidate = {
        task_id: taskId,
        namespace: row.namespace,
        status,
      };
      let envelope: DelegationEnvelope;
      try {
        envelope = delegationEnvelopeSchema.parse(JSON.parse(status.content));
      } catch (parseError) {
        return { candidate, parseError };
      }
      if (!this.canHandle(envelope)) continue;
      return { candidate, envelope };
    }
    return undefined;
  }

  private canHandle(envelope: DelegationEnvelope): boolean {
    return (
      envelope.alias_resolved.runtime === "openrouter" &&
      envelope.alias_resolved.family === "one-shot"
    );
  }

  private leaseDurationFor(envelope: DelegationEnvelope): number {
    if (this.leaseDurationOverrideMs !== undefined) {
      return this.leaseDurationOverrideMs;
    }
    const timeout = envelope.timeout_ms ?? ONE_SHOT_DEFAULT_TIMEOUT_MS;
    return timeout + LEASE_BUFFER_MS;
  }

  private async claim(
    candidate: PendingCandidate,
    envelope: DelegationEnvelope,
  ): Promise<
    | { kind: "ok" }
    | { kind: "lost"; message: string }
    | { kind: "error"; message: string }
  > {
    const claimTags = buildClaimTags(
      candidate.status.tags,
      this.config.workerId,
      this.now().getTime() + this.leaseDurationFor(envelope),
    );
    try {
      await this.config.munin.write(
        candidate.namespace,
        STATUS_KEY,
        candidate.status.content,
        claimTags,
        candidate.status.updated_at,
        "internal",
      );
      return { kind: "ok" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isCasConflict(message)) {
        console.info(`[orch-worker] CAS conflict on ${candidate.task_id}: ${message}`);
        return { kind: "lost", message };
      }
      // Non-CAS failure (auth, network, 5xx) — surface as `error` so
      // operators see infrastructure problems rather than misreading
      // them as benign "lost the race" outcomes.
      console.warn(
        `[orch-worker] claim write failed for ${candidate.task_id} (non-CAS): ${message}`,
      );
      return { kind: "error", message };
    }
  }

  private async failUnparseable(
    candidate: PendingCandidate,
    err: unknown,
    startedAt: Date,
  ): Promise<OrchWorkerTick> {
    const message = `stored envelope is not parseable: ${err instanceof Error ? err.message : String(err)}`;
    const error: DelegationError = {
      task_id: candidate.task_id,
      kind: "internal",
      message,
      retryable: false,
    };
    try {
      await this.config.munin.write(
        candidate.namespace,
        RESULT_ERROR_KEY,
        JSON.stringify(error),
        [ORCH_V1_TAG, "result-error"],
        undefined,
        "internal",
      );
      const newTags = flipLifecycleTags(candidate.status.tags, "failed");
      await this.config.munin.write(
        candidate.namespace,
        STATUS_KEY,
        candidate.status.content,
        newTags,
        candidate.status.updated_at,
        "internal",
      );
    } catch (writeErr) {
      console.warn(
        `[orch-worker] failed to flip ${candidate.task_id} to failed after parse error: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
      );
    }
    return mkTick(startedAt, this.now(), {
      task_id: candidate.task_id,
      outcome: "error",
      message,
    });
  }

  private async appendCompleted(
    envelope: DelegationEnvelope,
    result?: DelegationResult,
    error?: DelegationError,
  ): Promise<void> {
    try {
      await this.config.journal.append({
        event_schema_version: 1,
        event_type: "delegation_completed",
        event_ts: this.now().toISOString(),
        task_id: envelope.task_id,
        outcome: result ? "completed" : "failed",
        output: result?.output,
        output_chars: result?.output?.length,
        prompt_tokens: result?.prompt_tokens,
        completion_tokens: result?.completion_tokens,
        total_tokens: result?.total_tokens,
        duration_s: result?.duration_s,
        cost_usd: result?.cost_usd,
        model_effective: result?.model_effective ?? envelope.alias_resolved.model_requested,
        runtime_effective: result?.runtime_effective ?? envelope.alias_resolved.runtime,
        runtime_row_id_effective:
          result?.runtime_row_id_effective ?? envelope.alias_resolved.runtime_row_id,
        host_effective: result?.host_effective ?? envelope.alias_resolved.host,
        scanner_pass: result?.provenance?.scanner_pass,
        error_kind: error?.kind,
        error_message: error?.message,
      });
    } catch (err) {
      console.warn(
        `[orch-worker] journal append failed for ${envelope.task_id}; reconciliation will backfill: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function mkTick(
  startedAt: Date,
  finishedAt: Date,
  body: Omit<OrchWorkerTick, "startedAt" | "finishedAt">,
): OrchWorkerTick {
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    ...body,
  };
}

function pickLifecycleTag(tags: string[]): string | undefined {
  for (const tag of ["completed", "failed", "running", "pending"]) {
    if (tags.includes(tag)) return tag;
  }
  return undefined;
}

/**
 * Distinguish a Munin CAS conflict (another writer beat us) from any
 * other write failure (auth, network, 5xx). Munin surfaces CAS
 * conflicts via the `cas_conflict` error code in the rejection
 * message — see `MuninClient.write` in src/munin-client.ts.
 */
function isCasConflict(message: string): boolean {
  return /cas_conflict/i.test(message);
}

/**
 * Strip the old lifecycle tag and any prior lease metadata, then add
 * `running` plus fresh `claimed_by:` / `lease_expires:` tags. The
 * existing lease reaper (src/index.ts) parses the same tag format.
 */
export function buildClaimTags(
  currentTags: string[],
  workerId: string,
  leaseExpiresAtMs: number,
): string[] {
  const filtered = currentTags.filter(
    (t) =>
      t !== "pending" &&
      t !== "running" &&
      t !== "completed" &&
      t !== "failed" &&
      !t.startsWith("claimed_by:") &&
      !t.startsWith("lease_expires:"),
  );
  return [
    "running",
    ...filtered,
    `claimed_by:${workerId}`,
    `lease_expires:${leaseExpiresAtMs}`,
  ];
}
