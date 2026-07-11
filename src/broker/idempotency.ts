/**
 * Idempotency-key dedupe for the broker.
 *
 * Implements the §3.1 reuse semantics from
 * docs/orchestrator-v1-data-model.md:
 *   - Same key, same payload, within window → reuse existing task_id
 *   - Same key, different payload, within window → reject (collision)
 *   - Same key, after window → new task accepted
 *
 * This in-memory index only closes concurrent-submit races. Durable reuse is
 * provided by the principal-scoped deterministic Munin task namespace; after
 * restart the submit handler reads and compares that persisted envelope.
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
  | { kind: "in_flight" }
  | { kind: "retry"; task_id: string }
  | { kind: "collision"; existing_task_id: string };

export interface IdempotencyOptions {
  windowMs?: number;
  now?: () => number;
}

/**
 * Recursively sort object keys so semantically equal payloads serialise
 * identically, regardless of property insertion order. Arrays preserve order.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonicalize the request envelope for hashing. Recursively sorts keys
 * so nested fields (e.g. `worktree.target_files`) participate in the hash —
 * a flat top-level sort would silently drop them via JSON.stringify's
 * array-replacer rules.
 */
export function canonicalizeRequest(request: DelegationRequest): string {
  const { orchestrator_session_id: _sessionId, ...behavior } = request;
  return JSON.stringify(canonicalize(behavior));
}

export function hashPayload(request: DelegationRequest): string {
  return createHash("sha256").update(canonicalizeRequest(request)).digest("hex");
}

export class IdempotencyIndex {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly reservations = new Map<
    string,
    { payload_hash: string; recorded_at: number }
  >();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: IdempotencyOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Atomically check-and-reserve an idempotency_key. If `fresh`, the caller
   * MUST follow up with `record(...)` after the Munin write succeeds, or
   * `release(...)` if the write fails. Concurrent callers observing an
   * outstanding reservation get `in_flight` so they can back off and retry.
   */
  reserve(idempotencyKey: string, request: DelegationRequest): IdempotencyOutcome {
    const now = this.now();
    const cutoff = now - this.windowMs;

    const existing = this.entries.get(idempotencyKey);
    if (existing && existing.recorded_at > cutoff) {
      const payloadHash = hashPayload(request);
      if (existing.payload_hash === payloadHash) {
        return { kind: "retry", task_id: existing.task_id };
      }
      return { kind: "collision", existing_task_id: existing.task_id };
    }

    const reserved = this.reservations.get(idempotencyKey);
    if (reserved && reserved.recorded_at > cutoff) {
      return { kind: "in_flight" };
    }

    this.reservations.set(idempotencyKey, {
      payload_hash: hashPayload(request),
      recorded_at: now,
    });
    return { kind: "fresh" };
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
    this.reservations.delete(idempotencyKey);
  }

  release(idempotencyKey: string): void {
    this.reservations.delete(idempotencyKey);
  }

  /**
   * Drop entries and stale reservations older than the window. Called
   * periodically by the broker; also keeps quiet brokers bounded.
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
    for (const [key, entry] of this.reservations) {
      if (entry.recorded_at <= cutoff) {
        this.reservations.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  size(): number {
    return this.entries.size + this.reservations.size;
  }
}
