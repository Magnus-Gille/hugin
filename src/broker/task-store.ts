/**
 * Munin-backed task store for orchestrator-v1 broker submissions.
 *
 * Per docs/orchestrator-v1-data-model.md §12, Munin is the canonical
 * durable record for submission, execution, and completion. This module
 * encapsulates the write/read shape:
 *
 *   namespace: tasks/<task_id>
 *   key:       status              — task envelope + lifecycle tags
 *   key:       result-structured   — DelegationResult JSON (success path)
 *   key:       result-error        — DelegationError JSON (failure path)
 *
 * The status entry tags include `pending | running | completed | failed`,
 * `runtime:<row_id>`, and `orch-v1` to keep these tasks out of the legacy
 * dispatcher's poll loop (filtered in src/index.ts:pollOnce).
 */

import { randomBytes } from "node:crypto";
import type { MuninClient } from "../munin-client.js";
import type {
  AwaitRequest,
  DelegationEnvelope,
  DelegationError,
} from "./types.js";

export interface DelegationResultLike {
  task_id: string;
  result_schema_version: 1;
  [key: string]: unknown;
}

export const ORCH_V1_TAG = "orch-v1";
export const STATUS_KEY = "status";
export const RESULT_STRUCTURED_KEY = "result-structured";
export const RESULT_ERROR_KEY = "result-error";

export interface TaskStoreConfig {
  munin: MuninClient;
}

/**
 * Generate a broker task id of the form
 *   YYYYMMDD-HHMMSS-orch-<8-char-hex>
 * matching the existing Hugin scheme.
 */
export function generateBrokerTaskId(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = now.getUTCDate().toString().padStart(2, "0");
  const hh = now.getUTCHours().toString().padStart(2, "0");
  const mi = now.getUTCMinutes().toString().padStart(2, "0");
  const ss = now.getUTCSeconds().toString().padStart(2, "0");
  const suffix = randomBytes(4).toString("hex");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}-orch-${suffix}`;
}

export function namespaceForTaskId(taskId: string): string {
  return `tasks/${taskId}`;
}

export interface SubmitTaskParams {
  envelope: DelegationEnvelope;
}

export class BrokerTaskStore {
  constructor(private readonly munin: MuninClient) {}

  async submit(params: SubmitTaskParams): Promise<void> {
    const ns = namespaceForTaskId(params.envelope.task_id);
    const tags = buildSubmitTags(params.envelope);
    const content = serializeEnvelope(params.envelope);
    await this.munin.write(ns, STATUS_KEY, content, tags, undefined, "internal");
  }

  /**
   * Read the live status entry for a broker task. Returns null if not found.
   */
  async readStatus(taskId: string) {
    const ns = namespaceForTaskId(taskId);
    return this.munin.read(ns, STATUS_KEY);
  }

  async readStructuredResult(taskId: string) {
    const ns = namespaceForTaskId(taskId);
    return this.munin.read(ns, RESULT_STRUCTURED_KEY);
  }

  async readErrorResult(taskId: string) {
    const ns = namespaceForTaskId(taskId);
    return this.munin.read(ns, RESULT_ERROR_KEY);
  }

  /**
   * Two-phase complete (§12.3): write result first, then CAS the status
   * entry's lifecycle tag. Caller must pass the current status entry for
   * the CAS guard.
   */
  async completeSuccess(
    taskId: string,
    result: DelegationResultLike,
    statusEntry: { content: string; tags: string[]; updated_at: string },
  ): Promise<void> {
    const ns = namespaceForTaskId(taskId);
    await this.munin.write(
      ns,
      RESULT_STRUCTURED_KEY,
      JSON.stringify(result),
      [ORCH_V1_TAG, "result-structured"],
      undefined,
      "internal",
    );
    const newTags = flipLifecycleTags(statusEntry.tags, "completed");
    await this.munin.write(
      ns,
      STATUS_KEY,
      statusEntry.content,
      newTags,
      statusEntry.updated_at,
      "internal",
    );
  }

  async completeFailure(
    taskId: string,
    error: DelegationError,
    statusEntry: { content: string; tags: string[]; updated_at: string },
  ): Promise<void> {
    const ns = namespaceForTaskId(taskId);
    await this.munin.write(
      ns,
      RESULT_ERROR_KEY,
      JSON.stringify(error),
      [ORCH_V1_TAG, "result-error"],
      undefined,
      "internal",
    );
    const newTags = flipLifecycleTags(statusEntry.tags, "failed");
    await this.munin.write(
      ns,
      STATUS_KEY,
      statusEntry.content,
      newTags,
      statusEntry.updated_at,
      "internal",
    );
  }

  /**
   * Find every orch-v1 task currently in `pending` or `running` state.
   * Used by the reconciliation sweep.
   */
  async listInFlight(): Promise<{ namespace: string; tags: string[] }[]> {
    const collected: { namespace: string; tags: string[] }[] = [];
    for (const tag of ["pending", "running"]) {
      const { results } = await this.munin.query({
        query: "task",
        tags: [tag, ORCH_V1_TAG],
        namespace: "tasks/",
        entry_type: "state",
        limit: 200,
      });
      for (const result of results) {
        if (result.key !== STATUS_KEY) continue;
        collected.push({ namespace: result.namespace, tags: result.tags });
      }
    }
    return collected;
  }
}

export function buildSubmitTags(envelope: DelegationEnvelope): string[] {
  return [
    "pending",
    `runtime:${envelope.alias_resolved.runtime}`,
    `runtime-row:${envelope.alias_resolved.runtime_row_id}`,
    `alias:${envelope.alias_resolved.alias}`,
    `task-type:${envelope.task_type}`,
    ORCH_V1_TAG,
  ];
}

const LIFECYCLE_TAGS = new Set(["pending", "running", "completed", "failed"]);

export function flipLifecycleTags(
  currentTags: string[],
  next: "completed" | "failed",
): string[] {
  const filtered = currentTags.filter((t) => !LIFECYCLE_TAGS.has(t));
  return [next, ...filtered];
}

export function serializeEnvelope(envelope: DelegationEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

export function parseAwaitRequest(value: AwaitRequest): AwaitRequest {
  return value;
}
