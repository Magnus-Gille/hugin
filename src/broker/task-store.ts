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
 *   key:       feedback            — append-only exact-bound quality receipts
 *
 * New v2 status entries are ordinary `runtime:homeserver` tasks consumed by
 * the canonical dispatcher. The orch-v1 constants/methods below remain only
 * for historical readers and the retired compatibility tests.
 */

import { createHash } from "node:crypto";
import { MuninWriteRejectedError, type MuninClient } from "../munin-client.js";
import { taskMetadataPrefix } from "../task-document-metadata.js";
import {
  createBrokerAttestation,
  type BrokerAttestation,
} from "./attestation.js";
import type {
  AwaitRequest,
  DelegationEnvelope,
  DelegationError,
} from "./types.js";
import { delegationEnvelopeSchema, delegationRequestSchema } from "./types.js";
import { hashPayload } from "./idempotency.js";
import { deriveAwaitObservation } from "./await-observation.js";
import type { AwaitEvent, AwaitObservation } from "./await-observation.js";
import { queryAllMuninEntries } from "../munin-pagination.js";
import type { ReportFrictionInput } from "../friction/schema.js";
import { muninClassificationToSensitivity } from "../sensitivity.js";
import {
  buildFrictionContent,
  buildFrictionNamespace,
  buildFrictionTags,
  keepCallerFrictionTags,
  sanitiseTaskId,
} from "../friction/munin-key.js";
import {
  advancingQualityCorrectionRatedAt,
  buildQualityCorrectionReceipt,
  foldQualityReceipt,
  type BuildQualityCorrectionReceiptInput,
  type NativeQualityReceipt,
} from "../quality-receipt.js";
import { buildBrokerTaskTypeTags } from "./task-type-metadata.js";

export { MUNIN_QUERY_MAX } from "../munin-pagination.js";

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
const CANONICAL_HISTORY_SCAN_BUDGET = { maxPages: 20, maxResults: 1_000 } as const;
const CANONICAL_HISTORY_READ_CONCURRENCY = 25;
export interface TaskStoreConfig {
  munin: MuninClient;
}

export interface CanonicalListRow {
  task_id: string;
  submitted_at: string;
  outcome: "completed" | "failed" | "cancelled" | "running";
  alias: DelegationEnvelope["alias_requested"];
}

export interface CanonicalListResult {
  rows: CanonicalListRow[];
  /** True when a Munin ambiguity or the bounded history budget may omit matches. */
  truncated: boolean;
}

export interface FrictionWriteResult {
  ok: true;
  dropped: false;
  namespace: string;
  key: string;
  deduplicated: boolean;
}

function frictionClassification(linkedTaskClassification: string | undefined): string {
  const normalized = linkedTaskClassification?.trim().toLowerCase();
  if (normalized === "client-restricted") return "client-restricted";
  return muninClassificationToSensitivity(linkedTaskClassification) === "private"
    ? "client-confidential"
    : "internal";
}

export class FrictionIdempotencyConflictError extends Error {
  constructor(public readonly eventId: string) {
    super(`friction event_id ${eventId} was already used with a different payload`);
    this.name = "FrictionIdempotencyConflictError";
  }
}

function buildBrokerFrictionIdentity(
  input: ReportFrictionInput,
  authenticatedReporter: string,
  resolvedTaskId: string | undefined,
  modelId: string,
): { key: string; payloadHash: string } {
  if (!input.event_id) {
    throw new Error("authenticated Broker friction writes require event_id");
  }
  // event_id identifies one occurrence. The separate payload hash catches an
  // accidental or malicious reuse of that identity for different evidence.
  // Tags are set-like metadata, so ordering does not change payload identity.
  const normalized = {
    reporter: authenticatedReporter,
    model_id: modelId,
    task_id: resolvedTaskId ?? null,
    friction_type: input.friction_type,
    severity: input.severity,
    summary: input.summary,
    detail: input.detail,
    resource_assessment: input.resource_assessment ?? null,
    alias_suggested: input.alias_suggested ?? null,
    tool_name: input.tool_name ?? null,
    tags: [...new Set(input.tags ?? [])].sort(),
  };
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  const eventHash = createHash("sha256")
    .update(`${authenticatedReporter}\0${input.event_id}`)
    .digest("hex")
    .slice(0, 32);
  return {
    key: `friction-broker-${eventHash}`,
    payloadHash,
  };
}

function brokerReporterTag(authenticatedReporter: string): string {
  if (/^[A-Za-z0-9._-]{1,64}$/.test(authenticatedReporter)) {
    return authenticatedReporter;
  }
  const digest = createHash("sha256")
    .update(authenticatedReporter)
    .digest("hex")
    .slice(0, 16);
  const readable = authenticatedReporter
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 47) || "principal";
  return `${readable}-${digest}`;
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
  /** Per-task guard so a poll storm cannot pile up un-awaited observation writes. */
  private readonly awaitWritesInFlight = new Set<string>();
  /** Serialize same-process writes for one friction event identity. */
  private readonly frictionWritesInFlight = new Map<string, Promise<FrictionWriteResult>>();

  constructor(
    private readonly munin: MuninClient,
    private readonly options: { attestationSecret?: string } = {},
  ) {}

  async submit(params: SubmitTaskParams): Promise<void> {
    const ns = namespaceForTaskId(params.envelope.task_id);
    const tags = buildSubmitTags(params.envelope);
    const secret = this.options.attestationSecret;
    const attestation = secret
      ? createBrokerAttestation(params.envelope, secret)
      : undefined;
    const content = serializeEnvelope(params.envelope, attestation);
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
   * Best-effort — the caller must never await this on the request path, and a
   * failure must never affect the client's await.
   *
   * Three things this has to get right, all found by review:
   *
   *  - **CAS, not blind overwrite.** The read-modify-write is guarded by
   *    `expected_updated_at` and retried once. Without it, two overlapping
   *    writers (a deploy/restart overlap, or concurrent polls) can have a later
   *    writer with a stale `durableHandoff:false` fold clobber an earlier
   *    `true` — permanently erasing proven evidence. The in-memory fold is
   *    monotonic; persistence has to be too.
   *  - **Bounded hot-path work.** `/v1/delegate/await` is a poll loop. The
   *    caller hands down the `status` it already read, and a per-task in-flight
   *    guard means a burst of polls can't enqueue a pile of un-awaited writes
   *    faster than a slow Munin drains them.
   *  - **Only write real evidence.** `changed` gates the write, so a re-poll
   *    that reveals nothing new costs no write at all.
   */
  async recordAwait(
    taskId: string,
    event: Omit<AwaitEvent, "submitSessionId">,
    knownStatus?: { content: string; updated_at?: string } | null
  ): Promise<void> {
    // Hot-path guard: one in-flight observation write per task. A poll storm
    // must not create an unbounded backlog of un-awaited Munin writes.
    if (this.awaitWritesInFlight.has(taskId)) return;
    this.awaitWritesInFlight.add(taskId);
    try {
      const status = knownStatus ?? (await this.readStatus(taskId));
      const envelope = status ? parseStoredEnvelope(status.content) : null;
      const classification =
        envelope?.sensitivity === "private" ? "client-restricted" : "internal";

      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await this.munin.read(
          namespaceForTaskId(taskId),
          AWAIT_OBSERVATION_KEY
        );
        let prev: AwaitObservation | null = null;
        if (current) {
          try {
            prev = JSON.parse(current.content) as AwaitObservation;
          } catch {
            prev = null; // corrupt doc: start over rather than throw
          }
        }

        const { next, changed } = deriveAwaitObservation(prev, {
          ...event,
          submitSessionId: envelope?.orchestrator_session_id ?? null,
        });
        if (!changed) return;

        try {
          await this.munin.write(
            namespaceForTaskId(taskId),
            AWAIT_OBSERVATION_KEY,
            JSON.stringify(next),
            ["broker:mcp-v2", "await-observation"],
            // CAS: refuse the write if someone else moved the doc under us.
            current?.updated_at,
            classification,
          );
          return;
        } catch (err) {
          // Lost the CAS race — re-read and re-fold. The derivation ORs the
          // previous evidence in, so the retry preserves the other writer's
          // proof instead of overwriting it. One retry, then give up: this is
          // evidence, not billing, and it must never spin on the hot path.
          if (attempt === 1) throw err;
        }
      }
    } finally {
      this.awaitWritesInFlight.delete(taskId);
    }
  }

  async writeQualityReceipt(
    taskId: string,
    receipt: NativeQualityReceipt,
  ): Promise<{ changed: boolean }> {
    return this.writeQualityReceiptWithFactory(taskId, () => receipt);
  }

  async writeQualityCorrection(
    taskId: string,
    input: BuildQualityCorrectionReceiptInput,
  ): Promise<{ changed: boolean }> {
    return this.writeQualityReceiptWithFactory(taskId, (existing) =>
      buildQualityCorrectionReceipt({
        ...input,
        ratedAt: advancingQualityCorrectionRatedAt(
          existing,
          input.correctsReceiptId,
          input.ratedAt,
        ),
      }));
  }

  private async writeQualityReceiptWithFactory(
    taskId: string,
    buildReceipt: (
      existing: Record<string, unknown> | null,
    ) => NativeQualityReceipt,
  ): Promise<{ changed: boolean }> {
    const status = await this.readStatus(taskId);
    const envelope = status ? parseStoredEnvelope(status.content) : null;
    const namespace = namespaceForTaskId(taskId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.munin.read(namespace, "feedback");
      let existing: Record<string, unknown> | null = null;
      if (current) {
        const parsed = JSON.parse(current.content) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("stored feedback is not a JSON object");
        }
        existing = parsed as Record<string, unknown>;
      }
      const receipt = buildReceipt(existing);
      const folded = foldQualityReceipt(existing, receipt);
      if (!folded.changed) return { changed: false };
      const receiptVersionTags = [...new Set(
        folded.ledger.receipts.map((item) => `quality:receipt-v${item.schemaVersion}`),
      )];
      const expectedConflictReason = current ? "version_mismatch" : "already_exists";
      try {
        const result = await this.munin.write(
          namespace,
          "feedback",
          JSON.stringify(folded.ledger),
          envelope
            ? ["broker:mcp-v2", "feedback", ...receiptVersionTags]
            : ["feedback", ...receiptVersionTags],
          current?.updated_at,
          envelope?.sensitivity === "private"
            ? "client-restricted"
            : current?.classification ?? status?.classification ?? "internal",
          current === null ? true : undefined,
        );
        if (current === null && result.status !== "created") {
          throw new Error(
            "Munin create_if_absent did not return status created; refusing to trust first-write atomicity",
          );
        }
        return { changed: true };
      } catch (err) {
        const expectedConflict = err instanceof MuninWriteRejectedError &&
          err.errorCode === "conflict" &&
          err.conflictReason === expectedConflictReason;
        if (!expectedConflict || attempt === 2) throw err;
      }
    }
    throw new Error("quality receipt update lost repeated CAS races");
  }

  /**
   * Persist a friction signal through the authenticated Broker surface.
   *
   * This deliberately reuses the standalone friction MCP's schema and Munin
   * shape so API, MCP and CLI reports land in one corpus. The Broker principal
   * is retained as a tag even when the caller supplies a more specific model id.
   */
  async writeFriction(
    input: ReportFrictionInput,
    reporter: string,
    recordedAt: Date,
  ): Promise<FrictionWriteResult> {
    // Taxonomy, provenance, task, and classification tags are server-owned.
    // Keep arbitrary routing tags (for example repo:* and issue:*) while
    // preventing callers from adding a second authoritative value.
    const trustedInput: ReportFrictionInput = {
      ...input,
      ...(input.tags ? { tags: keepCallerFrictionTags(input.tags) } : {}),
    };
    const resolvedTaskId = trustedInput.task_id?.trim()
      ? sanitiseTaskId(trustedInput.task_id)
      : undefined;
    const modelId = trustedInput.model_id?.trim() || reporter.trim() || "unknown";
    const namespace = buildFrictionNamespace();
    const authenticatedReporter = reporter || "unknown";
    const reporterTag = brokerReporterTag(authenticatedReporter);
    const { key, payloadHash } = buildBrokerFrictionIdentity(
      trustedInput,
      authenticatedReporter,
      resolvedTaskId,
      modelId,
    );
    // Munin has update-CAS but no create-only CAS. Serialize one key inside the
    // single Broker process so simultaneous retries cannot overwrite a payload
    // conflict before either request observes the durable event.
    while (this.frictionWritesInFlight.has(key)) {
      try {
        await this.frictionWritesInFlight.get(key);
      } catch {
        // The waiting request must re-run the durable read after a failed write.
      }
    }

    const write = (async (): Promise<FrictionWriteResult> => {
      const existing = await this.munin.read(namespace, key);
      if (existing) {
        try {
          const existingPayload = JSON.parse(existing.content) as Record<string, unknown>;
          if (existingPayload.broker_event_payload_sha256 === payloadHash) {
            return { ok: true, dropped: false, namespace, key, deduplicated: true };
          }
        } catch {
          // A corrupt/conflicting durable record must never be mistaken for a
          // successful retry.
        }
        throw new FrictionIdempotencyConflictError(trustedInput.event_id!);
      }
      const tags = [...new Set([
        ...buildFrictionTags({
          input: trustedInput,
          modelId,
          resolvedTaskId,
          source: "broker-api",
        }),
        `reporter:${reporterTag}`,
      ])];
      const contentPayload = JSON.parse(buildFrictionContent({
        input: trustedInput,
        modelId,
        resolvedTaskId,
        recordedAt,
      })) as Record<string, unknown>;
      const content = JSON.stringify({
        ...contentPayload,
        broker_event_payload_sha256: payloadHash,
      }, null, 2);
      const linkedTask = resolvedTaskId
        ? await this.munin.read(namespaceForTaskId(resolvedTaskId), STATUS_KEY)
        : null;
      await this.munin.write(
        namespace,
        key,
        content,
        tags,
        undefined,
        frictionClassification(linkedTask?.classification),
      );
      return { ok: true, dropped: false, namespace, key, deduplicated: false };
    })();
    this.frictionWritesInFlight.set(key, write);
    try {
      return await write;
    } finally {
      if (this.frictionWritesInFlight.get(key) === write) {
        this.frictionWritesInFlight.delete(key);
      }
    }
  }

  /**
   * Enumerate canonical broker tasks for a principal.
   *
   * Deliberately does NOT trust the raw results of a single `broker:mcp-v2`
   * tag query. That tag is shared by a task's `status` entry AND its
   * `feedback` (hugin_rate) and `await-observation` (poll) entries, and the
   * query is capped server-side — so once a task is rated or polled, its own
   * or another task's sibling entries can crowd the `status` entry out of the
   * returned window even though nothing about the status entry changed
   * (#181). Mirrors learning-loop-collector.ts's approach: use whatever
   * matched (any key, either tag) only to learn the task's *namespace*, union
   * with a `runtime:homeserver` tag query (carried only by `status` entries,
   * so it is immune to feedback/await-observation pollution), then read each
   * unique namespace's `status` entry directly rather than relying on it
   * having survived inside the raw query window.
   *
   * Candidate discovery uses the shared capped-window paginator (#183). It
   * selects Munin's temporally ordered filter-only mode, walks backward by
   * updated_at, and probes exact timestamp boundaries so more than 50 tasks
   * (including tasks owned by another principal) cannot crowd out matches.
   * A same-millisecond bucket of 50+ remains explicitly `truncated` because
   * Munin has no `(updated_at,id)` cursor with which to prove it complete.
   */
  async listCanonical(principal: string, sinceTs?: string): Promise<CanonicalListResult> {
    const baseOpts = {
      namespace: "tasks/",
      entry_type: "state" as const,
      ...(sinceTs ? { since: sinceTs } : {}),
    };
    const [tagged, homeserver] = await Promise.all([
      queryAllMuninEntries(
        this.munin,
        { ...baseOpts, tags: ["broker:mcp-v2"] },
        CANONICAL_HISTORY_SCAN_BUDGET,
      ),
      queryAllMuninEntries(
        this.munin,
        { ...baseOpts, tags: ["runtime:homeserver"] },
        CANONICAL_HISTORY_SCAN_BUDGET,
      ),
    ]);
    const truncated = tagged.truncated || homeserver.truncated;
    const namespaces = new Set<string>();
    for (const result of [...tagged.results, ...homeserver.results]) {
      if (typeof result.namespace === "string") namespaces.add(result.namespace);
    }

    const namespaceList = [...namespaces];
    const entries = [];
    for (
      let offset = 0;
      offset < namespaceList.length;
      offset += CANONICAL_HISTORY_READ_CONCURRENCY
    ) {
      const chunk = namespaceList.slice(
        offset,
        offset + CANONICAL_HISTORY_READ_CONCURRENCY,
      );
      entries.push(
        ...(await Promise.all(
          chunk.map((namespace) => this.munin.read(namespace, STATUS_KEY)),
        )),
      );
    }

    const rows = [];
    for (const entry of entries) {
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
    return { rows, truncated };
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
    ...buildBrokerTaskTypeTags(envelope.task_type),
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

export function serializeEnvelope(
  envelope: DelegationEnvelope,
  attestation?: BrokerAttestation,
): string {
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
    ...(attestation
      ? [
          "",
          "### Broker attestation",
          "```json",
          JSON.stringify(attestation, null, 2),
          "```",
        ]
      : []),
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
  const match = taskMetadataPrefix(content).match(
    /### Broker envelope\s*\n```json\s*\n([\s\S]*?)\n```/i,
  );
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

export type HomeserverTaskSourceResolution =
  | { kind: "direct" }
  | { kind: "broker"; envelope: DelegationEnvelope }
  | { kind: "invalid"; error: string };

/**
 * Distinguish a direct signed homeserver task from a canonical Broker task.
 * A Broker section is authoritative when present and fails closed when
 * malformed; a heading literal inside `### Prompt` is untrusted prose.
 */
export function resolveHomeserverTaskSource(content: string): HomeserverTaskSourceResolution {
  const hasBrokerSection = /^###\s*Broker envelope\s*$/im.test(taskMetadataPrefix(content));
  if (!hasBrokerSection) return { kind: "direct" };
  const parsed = parseCanonicalEnvelope(content);
  return parsed.ok
    ? { kind: "broker", envelope: parsed.envelope }
    : { kind: "invalid", error: parsed.error };
}

export function parseAwaitRequest(value: AwaitRequest): AwaitRequest {
  return value;
}
