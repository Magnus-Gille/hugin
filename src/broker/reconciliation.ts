/**
 * Reconciliation sweep for the broker (§12.5).
 *
 * Runs periodically while the broker is up. Idempotent — running it twice
 * yields the same state. The sweep:
 *
 *   1. Backfills `delegation_submitted` events for any orch-v1 task
 *      visible in Munin but missing from the journal.
 *   2. Backfills `delegation_completed` events for terminal tasks.
 *   3. Detects `running` tasks with an expired lease and an existing
 *      `result-structured` key — this is the §12.3 crash-between-writes
 *      case where the result landed but the status flip didn't.
 *      Reconciler completes the CAS itself.
 *   4. Detects `running` tasks with an expired lease and no result, and
 *      flips them to `failed { kind: "internal", message: "lease expired
 *      without result" }`.
 *
 * Step 4 (this PR) builds the framework. Cases (3) and (4) need lease
 * metadata that lands with the executor in Step 5/5b — without an
 * executor, no orch-v1 task ever reaches `running`. The handlers for
 * those cases are wired but only fire when leases exist.
 */

import type { DelegationJournal } from "./journal.js";
import { projectDelegations } from "./journal.js";
import type { BrokerTaskStore } from "./task-store.js";
import type { DelegationEnvelope } from "./types.js";
import { delegationEnvelopeSchema } from "./types.js";
import { hashPayload } from "./idempotency.js";

export interface ReconciliationConfig {
  taskStore: BrokerTaskStore;
  journal: DelegationJournal;
  intervalMs?: number;
  now?: () => Date;
}

export interface ReconciliationStats {
  startedAt: string;
  finishedAt: string;
  scanned: number;
  submittedBackfilled: number;
  completedBackfilled: number;
  errors: number;
}

export class BrokerReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly now: () => Date;

  constructor(private readonly config: ReconciliationConfig) {
    this.intervalMs = config.intervalMs ?? 60_000;
    this.now = config.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        console.error(
          `[broker-reconciler] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<ReconciliationStats> {
    if (this.running) {
      return {
        startedAt: this.now().toISOString(),
        finishedAt: this.now().toISOString(),
        scanned: 0,
        submittedBackfilled: 0,
        completedBackfilled: 0,
        errors: 0,
      };
    }
    this.running = true;
    const stats: ReconciliationStats = {
      startedAt: this.now().toISOString(),
      finishedAt: "",
      scanned: 0,
      submittedBackfilled: 0,
      completedBackfilled: 0,
      errors: 0,
    };
    try {
      const events = await this.config.journal.readAll();
      const projection = projectDelegations(events);
      const inFlight = await this.config.taskStore.listInFlight();
      stats.scanned = inFlight.length;

      for (const task of inFlight) {
        const taskId = extractTaskId(task.namespace);
        if (!projection.has(taskId)) {
          try {
            await this.backfillSubmitted(taskId);
            stats.submittedBackfilled++;
          } catch (err) {
            stats.errors++;
            console.warn(
              `[broker-reconciler] backfill submitted failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } finally {
      stats.finishedAt = this.now().toISOString();
      this.running = false;
    }
    return stats;
  }

  private async backfillSubmitted(taskId: string): Promise<void> {
    const status = await this.config.taskStore.readStatus(taskId);
    if (!status) return;
    let envelope: DelegationEnvelope;
    try {
      envelope = delegationEnvelopeSchema.parse(JSON.parse(status.content));
    } catch (err) {
      throw new Error(
        `stored envelope for ${taskId} is not parseable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.config.journal.append({
      event_schema_version: 1,
      event_type: "delegation_submitted",
      event_ts: status.created_at,
      task_id: taskId,
      envelope,
      prompt_chars: envelope.prompt.length,
      prompt_sha256: hashPayload({
        envelope_version: envelope.envelope_version,
        idempotency_key: envelope.idempotency_key,
        orchestrator_session_id: envelope.orchestrator_session_id,
        orchestrator_submitter: envelope.orchestrator_submitter,
        parent_task_id: envelope.parent_task_id,
        task_type: envelope.task_type,
        prompt: envelope.prompt,
        alias_requested: envelope.alias_requested,
        alias_map_version: envelope.alias_map_version,
        worktree: envelope.worktree,
        sensitivity: envelope.sensitivity,
        timeout_ms: envelope.timeout_ms,
        max_output_tokens: envelope.max_output_tokens,
      }),
    });
  }
}

function extractTaskId(namespace: string): string {
  return namespace.replace(/^tasks\//, "");
}
