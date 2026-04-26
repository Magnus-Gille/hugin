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
import { executeOpenRouterDelegation } from "./openrouter-executor.js";
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
export const DEFAULT_LEASE_DURATION_MS = 600_000; // 10 min — covers the 5-min one-shot timeout + buffer.

export interface OrchWorkerConfig {
  munin: MuninClient;
  taskStore: BrokerTaskStore;
  journal: DelegationJournal;
  openrouterClient: OpenRouterClient;
  scannerPolicy?: ScannerPolicy;
  workerId: string;
  pollIntervalMs?: number;
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

export class OrchWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;

  constructor(private readonly config: OrchWorkerConfig) {
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.leaseDurationMs = config.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
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
      const candidate = await this.pickPending();
      if (!candidate) {
        return mkTick(startedAt, this.now(), { outcome: "idle" });
      }

      let envelope: DelegationEnvelope;
      try {
        envelope = delegationEnvelopeSchema.parse(JSON.parse(candidate.status.content));
      } catch (err) {
        return await this.failUnparseable(candidate, err, startedAt);
      }

      if (!this.canHandle(envelope)) {
        return mkTick(startedAt, this.now(), {
          task_id: candidate.task_id,
          outcome: "skipped",
          message: `runtime=${envelope.alias_resolved.runtime} family=${envelope.alias_resolved.family} not handled by this worker`,
        });
      }

      const claimed = await this.claim(candidate);
      if (!claimed) {
        return mkTick(startedAt, this.now(), {
          task_id: candidate.task_id,
          outcome: "claimed_lost",
          message: "another worker beat us to the CAS",
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

  private async pickPending(): Promise<PendingCandidate | undefined> {
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
      return { task_id: taskId, namespace: row.namespace, status };
    }
    return undefined;
  }

  private canHandle(envelope: DelegationEnvelope): boolean {
    return (
      envelope.alias_resolved.runtime === "openrouter" &&
      envelope.alias_resolved.family === "one-shot"
    );
  }

  private async claim(candidate: PendingCandidate): Promise<boolean> {
    const claimTags = buildClaimTags(
      candidate.status.tags,
      this.config.workerId,
      this.now().getTime() + this.leaseDurationMs,
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
      return true;
    } catch (err) {
      // Munin reports CAS conflicts as generic write rejections — we
      // can't distinguish "lost race" from other failures here. Treat
      // any failure as "skip and retry on next tick"; the lease reaper
      // catches genuinely stuck tasks.
      console.info(
        `[orch-worker] claim failed for ${candidate.task_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
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
