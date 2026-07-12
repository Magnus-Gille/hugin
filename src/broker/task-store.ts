/**
 * Munin-backed task store for durable MCP broker submissions.
 *
 * Per docs/orchestrator-v1-data-model.md §12, Munin is the canonical
 * durable record for submission, execution, and completion. This module
 * encapsulates the write/read shape:
 *
 *   namespace: tasks/<task_id>
 *   key:       status              — task envelope + lifecycle tags
 *   key:       result-structured   — DelegationResult JSON (success path)
 *   key:       feedback            — product usefulness rating
 *
 * New v2 status entries are ordinary `runtime:homeserver` tasks consumed by
 * the canonical dispatcher. The orch-v1 constants/methods below remain only
 * for historical readers and the retired compatibility tests.
 */

import { createHash } from "node:crypto";
import type { MuninClient } from "../munin-client.js";
import type {
  AwaitRequest,
  DelegationEnvelope,
  DelegationError,
} from "./types.js";
import { delegationEnvelopeSchema, delegationRequestSchema } from "./types.js";
import { hashPayload } from "./idempotency.js";
import { deriveAwaitObservation } from "./await-observation.js";
import type { AwaitEvent, AwaitObservation } from "./await-observation.js";

export interface DelegationResultLike {
  task_id: string;
  result_schema_version: 1;
  [key: string]: unknown;
}

export const ORCH_V1_TAG = "orch-v1";
export const STATUS_KEY = "status";
export const RESULT_STRUCTURED_KEY = "result-structured";
export const RESULT_ERROR_KEY = "result-error";
/** Durable-handoff evidence for the #165 trial (#164). */
export const AWAIT_OBSERVATION_KEY = "await-observation";

export interface TaskStoreConfig {
  munin: MuninClient;
}

/**
 * Generate a stable principal-scoped task id. Persisting the request at this
 * namespace is the restart-safe idempotency record; the raw key is never tagged.
 */
export function generateBrokerTaskId(principal: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`${principal}\0${idempotencyKey}`)
    .digest("hex")
    .slice(0, 24);
  return `mcp-m5-${digest}`;
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
    await this.munin.write(
      ns,
      STATUS_KEY,
      content,
      tags,
      undefined,
      params.envelope.sensitivity === "private" ? "client-restricted" : "internal",
    );
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
   * Durable-handoff evidence (#164). Read the stored await observation, if any.
   */
  async readAwaitObservation(taskId: string): Promise<AwaitObservation | null> {
    const entry = await this.munin.read(namespaceForTaskId(taskId), AWAIT_OBSERVATION_KEY);
    if (!entry) return null;
    try {
      return JSON.parse(entry.content) as AwaitObservation;
    } catch {
      // A corrupt observation is evidence we lost, not a reason to fail an
      // await. Start over rather than throw on the hot read path.
      return null;
    }
  }

  /**
   * Fold one await into the task's durable-handoff observation.
   *
   * Lossy and best-effort BY DESIGN — the caller must never await this on the
   * request path. This is trial evidence, not billing: a dropped write under a
   * concurrent-poll race costs one data point, and the monotonic derivation
   * means a genuine handoff will be re-proven by any later collecting await.
   * Blocking or failing a client's `await` to record evidence about that await
   * would be exactly backwards.
   */
  async recordAwait(
    taskId: string,
    event: Omit<AwaitEvent, "submitSessionId">
  ): Promise<void> {
    const status = await this.readStatus(taskId);
    const envelope = status ? parseStoredEnvelope(status.content) : null;
    const prev = await this.readAwaitObservation(taskId);

    const { next, changed } = deriveAwaitObservation(prev, {
      ...event,
      submitSessionId: envelope?.orchestrator_session_id ?? null,
    });
    // Hot polling path: only persist genuinely new evidence.
    if (!changed) return;

    await this.munin.write(
      namespaceForTaskId(taskId),
      AWAIT_OBSERVATION_KEY,
      JSON.stringify(next),
      ["broker:mcp-v2", "await-observation"],
      undefined,
      envelope?.sensitivity === "private" ? "client-restricted" : "internal",
    );
  }

  async writeFeedback(taskId: string, feedback: Record<string, unknown>): Promise<void> {
    const status = await this.readStatus(taskId);
    const envelope = status ? parseStoredEnvelope(status.content) : null;
    await this.munin.write(
      namespaceForTaskId(taskId),
      "feedback",
      JSON.stringify(feedback),
      ["broker:mcp-v2", "feedback"],
      undefined,
      envelope?.sensitivity === "private" ? "client-restricted" : "internal",
    );
  }

  async listCanonical(principal: string, limit = 50): Promise<Array<{
    task_id: string;
    submitted_at: string;
    outcome: "completed" | "failed" | "cancelled" | "running";
    alias: DelegationEnvelope["alias_requested"];
  }>> {
    const { results } = await this.munin.query({
      query: "task",
      tags: ["broker:mcp-v2"],
      namespace: "tasks/",
      entry_type: "state",
      limit: Math.min(500, Math.max(limit * 3, limit)),
    });
    const rows = [];
    for (const result of results) {
      if (result.key !== STATUS_KEY) continue;
      const entry = await this.munin.read(result.namespace, STATUS_KEY);
      if (!entry) continue;
      const parsed = parseCanonicalEnvelope(entry.content);
      if (!parsed.ok || parsed.envelope.broker_principal !== principal) continue;
      const envelope = parsed.envelope;
      rows.push({
        task_id: envelope.task_id,
        submitted_at: envelope.received_at,
        outcome: entry.tags.includes("completed")
          ? "completed" as const
          : entry.tags.includes("failed")
            ? "failed" as const
            : entry.tags.includes("cancelled")
              ? "cancelled" as const
            : "running" as const,
        alias: envelope.alias_requested,
      });
    }
    rows.sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
    return rows;
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
    return this.listByLifecycle(["pending", "running"]);
  }

  /**
   * Find every orch-v1 task in a terminal lifecycle (`completed` or
   * `failed`). The reconciliation sweep uses this to backfill
   * `delegation_completed` events when the worker crashed between the
   * Munin write and the journal append.
   */
  async listTerminal(): Promise<{ namespace: string; tags: string[] }[]> {
    return this.listByLifecycle(["completed", "failed"]);
  }

  private async listByLifecycle(
    lifecycleTags: string[],
  ): Promise<{ namespace: string; tags: string[] }[]> {
    const collected: { namespace: string; tags: string[] }[] = [];
    for (const tag of lifecycleTags) {
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
    "runtime:homeserver",
    `runtime-row:${envelope.alias_resolved.runtime_row_id}`,
    `alias:${envelope.alias_resolved.alias}`,
    `task-type:${envelope.task_type}`,
    "broker:mcp-v2",
    `idempotency:${createHash("sha256").update(`${envelope.broker_principal}\0${envelope.idempotency_key}`).digest("hex")}`,
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
  const verifier = envelope.acceptance.mode === "verifier"
    ? JSON.stringify(envelope.acceptance.verifier)
    : "none";
  return [
    `## Task: MCP M5 leaf ${envelope.task_id}`,
    "",
    "- **Runtime:** homeserver",
    "- **Homeserver path:** delegate",
    `- **Task type:** ${envelope.task_type}`,
    `- **Verifier:** ${verifier}`,
    `- **Acceptance mode:** ${envelope.acceptance.mode}`,
    `- **Allowed destinations:** ${envelope.allowed_destinations.join(",")}`,
    `- **Tool policy:** ${envelope.tool_policy.mode}`,
    `- **Max attempts:** ${envelope.budget.max_attempts}`,
    `- **Max cost USD:** ${envelope.budget.max_cost_usd}`,
    `- **Durability:** ${envelope.durability}`,
    `- **Delivery mode:** ${envelope.delivery.mode}`,
    `- **Escalation mode:** ${envelope.escalation.mode}`,
    `- **Timeout:** ${envelope.timeout_ms ?? 300000}`,
    `- **Max output tokens:** ${envelope.max_output_tokens ?? 4096}`,
    `- **Submitted by:** ${envelope.orchestrator_submitter}`,
    `- **Submitted at:** ${envelope.received_at}`,
    `- **Sensitivity:** ${envelope.sensitivity ?? "internal"}`,
    `- **Idempotency payload SHA256:** ${stableRequestHash(envelope)}`,
    "",
    "### Broker envelope",
    "```json",
    JSON.stringify(envelope, null, 2),
    "```",
    "",
    "### Prompt",
    envelope.prompt,
  ].join("\n");
}

function stableRequestHash(envelope: DelegationEnvelope): string {
  const request = delegationRequestSchema.parse(envelope);
  return createHash("sha256")
    .update(`${envelope.broker_principal}\0${hashPayload(request)}`)
    .digest("hex");
}

export function parseStoredEnvelope(content: string): DelegationEnvelope | null {
  const match = content.match(/### Broker envelope\s*\n```json\s*\n([\s\S]*?)\n```/i);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as DelegationEnvelope;
  } catch {
    return null;
  }
}

export function parseCanonicalEnvelope(content: string):
  | { ok: true; envelope: DelegationEnvelope }
  | { ok: false; error: string } {
  const raw = parseStoredEnvelope(content);
  if (!raw) return { ok: false, error: "Canonical Broker envelope is missing or malformed" };
  const parsed = delegationEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Canonical Broker envelope is invalid" };
  return { ok: true, envelope: parsed.data };
}

export function parseAwaitRequest(value: AwaitRequest): AwaitRequest {
  return value;
}
