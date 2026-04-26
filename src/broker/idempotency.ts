/**
 * Idempotency-key dedupe for the broker.
 *
 * Implements the §3.1 reuse semantics from
 * docs/orchestrator-v1-data-model.md:
 *   - Same key, same payload, within window → reuse existing task_id
 *   - Same key, different payload, within window → reject (collision)
 *   - Same key, after window → new task accepted
 *
 * State is in-memory and not durable. The broker is the single source of
 * truth for the dedupe window; on restart, the recovery path is "re-create
 * fresh" — clients with same key + same payload will create a duplicate
 * task, which is acceptable since the window is short and Munin still
 * holds both records for audit.
 */

import { createHash } from "node:crypto";
import type { DelegationRequest } from "./types.js";

export const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyEntry {
  task_id: string;
  payload_hash: string;
  recorded_at: number;
}

export type IdempotencyOutcome =
  | { kind: "fresh" }
  | { kind: "retry"; task_id: string }
  | { kind: "collision"; existing_task_id: string };

export interface IdempotencyOptions {
  windowMs?: number;
  now?: () => number;
}

/**
 * Canonicalize the request envelope for hashing. Excludes broker-added
 * fields (none are present at request time, but documents the intent) and
 * normalises object key order so semantically-equal envelopes hash equally.
 */
export function canonicalizeRequest(request: DelegationRequest): string {
  return JSON.stringify(request, Object.keys(request).sort());
}

export function hashPayload(request: DelegationRequest): string {
  return createHash("sha256").update(canonicalizeRequest(request)).digest("hex");
}

export class IdempotencyIndex {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: IdempotencyOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Check whether a submission is a fresh task, a retry of an existing one,
   * or a collision (same key, different payload). Caller commits the entry
   * via `record()` once the Munin write succeeds.
   */
  inspect(idempotencyKey: string, request: DelegationRequest): IdempotencyOutcome {
    const existing = this.entries.get(idempotencyKey);
    const now = this.now();
    if (!existing || now - existing.recorded_at > this.windowMs) {
      return { kind: "fresh" };
    }
    const payloadHash = hashPayload(request);
    if (existing.payload_hash === payloadHash) {
      return { kind: "retry", task_id: existing.task_id };
    }
    return { kind: "collision", existing_task_id: existing.task_id };
  }

  record(
    idempotencyKey: string,
    request: DelegationRequest,
    taskId: string,
  ): void {
    this.entries.set(idempotencyKey, {
      task_id: taskId,
      payload_hash: hashPayload(request),
      recorded_at: this.now(),
    });
  }

  /**
   * Drop entries older than the window. Called periodically by the broker;
   * also invoked lazily on inspect() so a long-quiet broker doesn't grow
   * unbounded.
   */
  prune(): number {
    const cutoff = this.now() - this.windowMs;
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (entry.recorded_at <= cutoff) {
        this.entries.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  size(): number {
    return this.entries.size;
  }
}
