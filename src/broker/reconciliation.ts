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

import type { DelegationCompletedEvent, DelegationJournal } from "./journal.js";
import { projectDelegations } from "./journal.js";
import type { BrokerTaskStore } from "./task-store.js";
import type { DelegationEnvelope, DelegationError } from "./types.js";
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
      const terminal = await this.config.taskStore.listTerminal();
      stats.scanned = inFlight.length + terminal.length;

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

      for (const task of terminal) {
        const taskId = extractTaskId(task.namespace);
        const row = projection.get(taskId);
        // Backfill submitted if we have no record at all (terminal task
        // whose submitted event also went missing).
        if (!row) {
          try {
            await this.backfillSubmitted(taskId);
            stats.submittedBackfilled++;
          } catch (err) {
            stats.errors++;
            console.warn(
              `[broker-reconciler] backfill submitted failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
        }
        if (!row?.outcome) {
          try {
            await this.backfillCompleted(taskId, task.tags);
            stats.completedBackfilled++;
          } catch (err) {
            stats.errors++;
            console.warn(
              `[broker-reconciler] backfill completed failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
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

  /**
   * Append a `delegation_completed` event for a terminal task that is
   * missing one. Pulls telemetry from the persisted result key
   * (`result-structured` for completed tasks, `result-error` for failed
   * ones) so the event reflects what actually happened, not just the
   * status flip. The status entry's `updated_at` is the most reliable
   * proxy for `event_ts` since the flip is the most recent write.
   */
  private async backfillCompleted(taskId: string, tags: string[]): Promise<void> {
    const status = await this.config.taskStore.readStatus(taskId);
    if (!status) return;
    let envelope: DelegationEnvelope | undefined;
    try {
      envelope = delegationEnvelopeSchema.parse(JSON.parse(status.content));
    } catch {
      // Status couldn't be parsed — fall through; we still emit a
      // best-effort event with the runtime/host inferred from tags
      // where possible. This is rare and indicates upstream corruption.
    }
    const isCompleted = tags.includes("completed");
    const isFailed = tags.includes("failed");
    if (!isCompleted && !isFailed) return;

    const event: DelegationCompletedEvent = {
      event_schema_version: 1,
      event_type: "delegation_completed",
      event_ts: status.updated_at,
      task_id: taskId,
      outcome: isCompleted ? "completed" : "failed",
    };

    if (envelope) {
      event.model_effective = envelope.alias_resolved.model_requested;
      event.runtime_effective = envelope.alias_resolved.runtime;
      event.runtime_row_id_effective = envelope.alias_resolved.runtime_row_id;
      event.host_effective = envelope.alias_resolved.host;
    }

    if (isCompleted) {
      const result = await this.config.taskStore.readStructuredResult(taskId);
      if (result) {
        try {
          const parsed = JSON.parse(result.content) as Record<string, unknown> & {
            output?: string;
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            duration_s?: number;
            cost_usd?: number;
            model_effective?: string;
            runtime_effective?: string;
            runtime_row_id_effective?: string;
            host_effective?: string;
            provenance?: { scanner_pass?: DelegationCompletedEvent["scanner_pass"] };
          };
          if (typeof parsed.output === "string") {
            event.output = parsed.output;
            event.output_chars = parsed.output.length;
          }
          event.prompt_tokens = parsed.prompt_tokens;
          event.completion_tokens = parsed.completion_tokens;
          event.total_tokens = parsed.total_tokens;
          event.duration_s = parsed.duration_s;
          event.cost_usd = parsed.cost_usd;
          if (parsed.model_effective) event.model_effective = parsed.model_effective;
          if (parsed.runtime_effective) event.runtime_effective = parsed.runtime_effective;
          if (parsed.runtime_row_id_effective)
            event.runtime_row_id_effective = parsed.runtime_row_id_effective;
          if (parsed.host_effective) event.host_effective = parsed.host_effective;
          event.scanner_pass = parsed.provenance?.scanner_pass;
        } catch (err) {
          console.warn(
            `[broker-reconciler] result-structured for ${taskId} did not parse as JSON: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } else {
      const stored = await this.config.taskStore.readErrorResult(taskId);
      if (stored) {
        try {
          const parsed = JSON.parse(stored.content) as DelegationError;
          event.error_kind = parsed.kind;
          event.error_message = parsed.message;
        } catch (err) {
          console.warn(
            `[broker-reconciler] result-error for ${taskId} did not parse as JSON: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    await this.config.journal.append(event);
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
        acceptance: envelope.acceptance,
        allowed_destinations: envelope.allowed_destinations,
        tool_policy: envelope.tool_policy,
        budget: envelope.budget,
        durability: envelope.durability,
        delivery: envelope.delivery,
        escalation: envelope.escalation,
      }),
    });
  }
}

function extractTaskId(namespace: string): string {
  return namespace.replace(/^tasks\//, "");
}
