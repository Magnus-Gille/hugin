/**
 * Express handlers for the orchestrator broker (POST /v1/delegate/*).
 *
 * Per docs/orchestrator-v1-data-model.md:
 *   - submit  (§3, §3.1, §12.2)
 *   - await   (§4, §12.4)
 *   - rate    (§5)
 *   - list    (§5 projection)
 *   - models  (§2 alias map + §6 registry view)
 *   - friction (shared operational evidence corpus)
 *
 * All handlers assume `brokerAuthMiddleware` has already populated
 * `req.brokerPrincipal`.
 */

import type { Request, Response } from "express";
import { z, ZodError } from "zod";
import {
  ACTIVE_ALIAS_MAP,
  RUNTIME_REGISTRY,
  type AliasMap,
} from "../runtime-registry.js";
import { POLICY_VERSION, resolveAliasForBroker } from "./alias-resolution.js";
import {
  brokerAliasAvailability,
  executableBrokerAliases,
  type BrokerExecutorCapabilities,
} from "./executor-capabilities.js";
import type { DelegationJournal } from "./journal.js";
import { projectDelegations } from "./journal.js";
import type { IdempotencyIndex } from "./idempotency.js";
import { hashPayload } from "./idempotency.js";
import type { BrokerTaskStore } from "./task-store.js";
import {
  FrictionIdempotencyConflictError,
  generateBrokerTaskId,
  parseCanonicalEnvelope,
  parseStoredEnvelope,
} from "./task-store.js";
import {
  awaitRequestSchema,
  delegationRequestSchema,
  listRequestSchema,
  rateRequestSchema,
  type DelegationEnvelope,
} from "./types.js";
import type { AwaitLifecycle } from "./await-observation.js";
import type { AuthenticatedRequest } from "./auth.js";
import { computeSubmitWarnings } from "./submit-warnings.js";
import { reportFrictionInputSchema } from "../friction/schema.js";
import {
  QualityReceiptConflictError,
  buildQualityBinding,
  buildQualityReceipt,
} from "../quality-receipt.js";
import { structuredTaskResultSchema } from "../task-result-schema.js";

const brokerFrictionInputSchema = reportFrictionInputSchema.extend({
  event_id: z.string().uuid(),
}).strict();

export interface BrokerHandlerDependencies {
  taskStore: BrokerTaskStore;
  journal: DelegationJournal;
  idempotency: IdempotencyIndex;
  executorCapabilities: BrokerExecutorCapabilities;
  now?: () => Date;
}

function nowFn(deps: BrokerHandlerDependencies): () => Date {
  return deps.now ?? (() => new Date());
}

function scopedIdempotencyKey(principal: string, idempotencyKey: string): string {
  return `${principal}\0${idempotencyKey}`;
}

function storedBrokerPrincipal(content: string): string | null {
  const canonical = parseCanonicalEnvelope(content);
  if (canonical.ok) return canonical.envelope.broker_principal;
  try {
    const historical = JSON.parse(content) as { broker_principal?: unknown };
    return typeof historical.broker_principal === "string"
      ? historical.broker_principal
      : null;
  } catch {
    return null;
  }
}

function requireOwnedBrokerTask(
  req: AuthenticatedRequest,
  res: Response,
  status: { content: string; tags: string[] },
): boolean {
  const canonical = parseCanonicalEnvelope(status.content);
  const historicalTagged = status.tags.includes("orch-v1");
  if (!canonical.ok && !historicalTagged) {
    res.status(404).json({ error: "policy_rejected", message: "task is not a Broker task" });
    return false;
  }
  const owner = canonical.ok
    ? canonical.envelope.broker_principal
    : storedBrokerPrincipal(status.content);
  if (!owner || owner !== req.brokerPrincipal) {
    res.status(403).json({
      error: "policy_rejected",
      message: "task belongs to a different broker principal",
    });
    return false;
  }
  return true;
}

export function createSubmitHandler(deps: BrokerHandlerDependencies) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const principal = req.brokerPrincipal;
    if (!principal) {
      res.status(500).json({ error: "internal", message: "principal missing" });
      return;
    }

    let request;
    try {
      request = delegationRequestSchema.parse(req.body);
    } catch (err) {
      respondZodError(res, err);
      return;
    }
    // #184: same request payload on every success path below (fresh accept
    // or any idempotent reuse), so computed once and reused verbatim.
    const submitWarnings = computeSubmitWarnings(request);

    if (request.envelope_version !== 2) {
      res.status(400).json({
        error: "policy_rejected",
        message: `unsupported envelope_version ${request.envelope_version}`,
      });
      return;
    }

    if (request.alias_map_version !== ACTIVE_ALIAS_MAP.version) {
      res.status(409).json({
        error: "policy_rejected",
        message: `alias_map_version ${request.alias_map_version} does not match Broker version ${ACTIVE_ALIAS_MAP.version}`,
        alias_map_version: ACTIVE_ALIAS_MAP.version,
      });
      return;
    }

    let aliasResolution;
    try {
      aliasResolution = resolveAliasForBroker(request.alias_requested);
    } catch (err) {
      res.status(400).json({
        error: "alias_unknown",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const availability = brokerAliasAvailability(
      aliasResolution.alias_resolved,
      deps.executorCapabilities,
    );
    if (!availability.executable) {
      res.status(availability.retryable ? 503 : 409).json({
        error: "alias_unavailable",
        message: `alias '${request.alias_requested}' is configured but has no live Broker executor`,
        reason: availability.reason,
        retryable: availability.retryable,
        executable_aliases: executableBrokerAliases(deps.executorCapabilities),
      });
      return;
    }

    if (
      aliasResolution.alias_resolved.family === "harness" &&
      !request.worktree
    ) {
      res.status(400).json({
        error: "policy_rejected",
        message: "harness aliases require a worktree spec",
      });
      return;
    }
    if (
      aliasResolution.alias_resolved.family === "one-shot" &&
      request.worktree
    ) {
      res.status(400).json({
        error: "policy_rejected",
        message: "worktree spec is only valid for harness aliases",
      });
      return;
    }

    if (request.orchestrator_submitter !== principal) {
      res.status(400).json({
        error: "policy_rejected",
        message: `orchestrator_submitter '${request.orchestrator_submitter}' does not match authenticated principal '${principal}'`,
      });
      return;
    }

    const taskId = generateBrokerTaskId(principal, request.idempotency_key);
    const persisted = await deps.taskStore.readStatus(taskId);
    if (persisted) {
      const persistedEnvelopeResult = parseCanonicalEnvelope(persisted.content);
      if (!persistedEnvelopeResult.ok) {
        res.status(409).json({
          error: "policy_rejected",
          message: "idempotency task exists but its canonical envelope is unreadable",
          existing_task_id: taskId,
        });
        return;
      }
      const persistedEnvelope = persistedEnvelopeResult.envelope;
      const persistedRequestResult = delegationRequestSchema.safeParse(persistedEnvelope);
      if (!persistedRequestResult.success) {
        res.status(409).json({
          error: "policy_rejected",
          message: "idempotency task exists but its request contract is invalid",
          existing_task_id: taskId,
        });
        return;
      }
      const persistedRequest = persistedRequestResult.data;
      if (hashPayload(persistedRequest) !== hashPayload(request)) {
        res.status(409).json({
          error: "policy_rejected",
          message: "idempotency_key reused with a different payload",
          existing_task_id: taskId,
        });
        return;
      }
      res.status(200).json({
        task_id: taskId,
        received_at: persistedEnvelope.received_at,
        reused_idempotency: true,
        ...(submitWarnings.length > 0 ? { warnings: submitWarnings } : {}),
      });
      return;
    }

    const reservationKey = scopedIdempotencyKey(principal, request.idempotency_key);
    const idemOutcome = deps.idempotency.reserve(reservationKey, request);
    if (idemOutcome.kind === "retry") {
      res.status(200).json({
        task_id: idemOutcome.task_id,
        received_at: nowFn(deps)().toISOString(),
        reused_idempotency: true,
        ...(submitWarnings.length > 0 ? { warnings: submitWarnings } : {}),
      });
      return;
    }
    if (idemOutcome.kind === "collision") {
      res.status(409).json({
        error: "policy_rejected",
        message: "idempotency_key reused with a different payload",
        existing_task_id: idemOutcome.existing_task_id,
      });
      return;
    }
    if (idemOutcome.kind === "in_flight") {
      res.status(503).json({
        error: "in_flight",
        message: "another submission with this idempotency_key is in flight; retry after backoff",
      });
      return;
    }

    const now = nowFn(deps)();
    const envelope: DelegationEnvelope = {
      ...request,
      task_id: taskId,
      broker_principal: principal,
      received_at: now.toISOString(),
      alias_resolved: aliasResolution.alias_resolved,
      policy_version: POLICY_VERSION,
    };

    try {
      await deps.taskStore.submit({ envelope });
    } catch (err) {
      deps.idempotency.release(reservationKey);
      res.status(500).json({
        error: "internal",
        message: `munin submit failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    deps.idempotency.record(reservationKey, request, taskId);

    res.status(202).json({
      task_id: taskId,
      received_at: envelope.received_at,
      reused_idempotency: false,
      ...(submitWarnings.length > 0 ? { warnings: submitWarnings } : {}),
    });
  };
}

export function createAwaitHandler(deps: BrokerHandlerDependencies) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    let parsed;
    try {
      parsed = awaitRequestSchema.parse(req.body);
    } catch (err) {
      respondZodError(res, err);
      return;
    }

    const status = await deps.taskStore.readStatus(parsed.task_id);
    if (!status) {
      res.status(200).json({
        status: "unknown",
        reason: "task_id_not_found",
      });
      return;
    }
    if (!requireOwnedBrokerTask(req, res, status)) return;

    const lifecycle = pickLifecycleTag(status.tags);

    /**
     * Durable-handoff evidence for the #165 trial (#164). Fire-and-forget:
     * recorded AFTER ownership is enforced, never awaited, and its failure can
     * never affect the client's await — evidence collection must not be able to
     * break the thing it observes.
     *
     * `evidenceLifecycle` is what the client ACTUALLY collected, not merely what
     * the status tag said: a `completed` task whose result checkpoint is still
     * missing returns a retryable error and collected nothing, so it must not
     * count toward "tasks completed after the session closed". The already-read
     * `status` is handed down so the recorder needn't re-read it on this hot
     * polling path.
     */
    const recordEvidence = (evidenceLifecycle: AwaitLifecycle): void => {
      void deps.taskStore
        .recordAwait(
          parsed.task_id,
          {
            sessionId: parsed.orchestrator_session_id ?? null,
            at: new Date().toISOString(),
            lifecycle: evidenceLifecycle,
          },
          status
        )
        .catch((err: unknown) => {
          console.warn(
            `[broker] await-observation write failed for ${parsed.task_id}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        });
    };

    if (lifecycle !== "completed") {
      recordEvidence((lifecycle ?? "unknown") as AwaitLifecycle);
    }

    if (lifecycle === "completed") {
      const result = await deps.taskStore.readStructuredResult(parsed.task_id);
      if (!result) {
        // Status says completed but the result checkpoint is missing: the client
        // gets a retryable error and collects NOTHING. Not gate evidence.
        recordEvidence("unknown");
        res.status(200).json({
          status: "failed",
          error: {
            task_id: parsed.task_id,
            kind: "internal",
            message:
              "result-structured key missing for terminal task; reconciliation pending",
            retryable: true,
          },
        });
        return;
      }
      // A completed result was genuinely handed to the caller — this, and only
      // this, is evidence for the #165 completed-after-session criterion.
      recordEvidence("completed");
      res.status(200).json({
        status: "completed",
        result: JSON.parse(result.content),
      });
      return;
    }
    if (lifecycle === "failed") {
      const structured = await deps.taskStore.readStructuredResult(parsed.task_id);
      if (structured) {
        const result = JSON.parse(structured.content) as Record<string, unknown>;
        res.status(200).json({
          status: "failed",
          result,
          error: {
            task_id: parsed.task_id,
            kind: "executor_failed",
            message: String(result.errorMessage ?? result.bodyText ?? "task failed"),
            retryable: false,
          },
        });
        return;
      }
      const legacyStored = await deps.taskStore.readErrorResult(parsed.task_id);
      const error = legacyStored
        ? JSON.parse(legacyStored.content)
        : {
            task_id: parsed.task_id,
            kind: "internal",
            message: "result-error key missing; reconciliation pending",
            retryable: true,
          };
      res.status(200).json({ status: "failed", error });
      return;
    }
    if (lifecycle === "cancelled") {
      const structured = await deps.taskStore.readStructuredResult(parsed.task_id);
      res.status(200).json({
        status: "failed",
        ...(structured ? { result: JSON.parse(structured.content) } : {}),
        error: {
          task_id: parsed.task_id,
          kind: "cancelled",
          message: "task was cancelled",
          retryable: false,
        },
      });
      return;
    }

    const lease = readLeaseInfo(status.tags, status.updated_at);
    const nowMs = nowFn(deps)().getTime();
    const orphanSuspected =
      lease.lease_expires_at !== null &&
      Date.parse(lease.lease_expires_at) < nowMs;
    res.status(200).json({
      status: "running",
      lease,
      orphan_suspected: orphanSuspected,
    });
  };
}

export function createRateHandler(deps: BrokerHandlerDependencies) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const authenticatedPrincipal = req.brokerPrincipal;
    if (!authenticatedPrincipal) {
      res.status(500).json({ error: "internal", message: "principal missing" });
      return;
    }
    let parsed;
    try {
      parsed = rateRequestSchema.parse(req.body);
    } catch (err) {
      respondZodError(res, err);
      return;
    }

    const status = await deps.taskStore.readStatus(parsed.task_id);
    if (!status) {
      res.status(404).json({
        error: "policy_rejected",
        message: `task ${parsed.task_id} not found`,
      });
      return;
    }
    const canonical = parseCanonicalEnvelope(status.content);
    const historicalBrokerTask = status.tags.includes("orch-v1");
    if ((canonical.ok || historicalBrokerTask) && !requireOwnedBrokerTask(req, res, status)) return;
    if (!status.tags.some((tag) => ["completed", "failed", "cancelled"].includes(tag))) {
      res.status(409).json({
        error: "policy_rejected",
        message: "task is not terminal and cannot be rated yet",
      });
      return;
    }

    const structuredEntry = await deps.taskStore.readStructuredResult(parsed.task_id);
    if (!structuredEntry) {
      res.status(409).json({
        error: "policy_rejected",
        message: "task has no structured result to bind the quality receipt to",
      });
      return;
    }
    let structuredTaskId: string;
    let verifiedSubmitter: string | null;
    let binding;
    try {
      const raw = JSON.parse(structuredEntry.content) as unknown;
      const current = structuredTaskResultSchema.safeParse(raw);
      if (current.success) {
        structuredTaskId = current.data.taskId;
        verifiedSubmitter = current.data.provenance?.verifiedSubmitter ?? null;
      } else {
        const legacy = z.object({
          task_id: z.string().min(1),
          result_schema_version: z.literal(1),
        }).passthrough().parse(raw);
        structuredTaskId = legacy.task_id;
        verifiedSubmitter = null;
      }
      binding = buildQualityBinding({
        statusContent: status.content,
        structuredResultContent: structuredEntry.content,
      });
    } catch (err) {
      res.status(409).json({
        error: "policy_rejected",
        message: `task structured result cannot be bound: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (structuredTaskId !== parsed.task_id) {
      res.status(409).json({ error: "policy_rejected", message: "structured result task id mismatch" });
      return;
    }
    const expected = parsed.expected_binding;
    if (expected && (
      expected.task_document_sha256 !== binding.taskDocumentSha256 ||
      expected.structured_result_sha256 !== binding.structuredResultSha256 ||
      (expected.repository_diff_sha256 !== undefined &&
        expected.repository_diff_sha256 !== binding.repository.diffSha256)
    )) {
      res.status(409).json({ error: "policy_rejected", message: "reviewed binding is stale or mismatched" });
      return;
    }
    const principal = authenticatedPrincipal;
    const brokerOwner = canonical.ok
      ? canonical.envelope.broker_principal
      : historicalBrokerTask
        ? storedBrokerPrincipal(status.content)
        : null;
    const reviewerIsOwner = brokerOwner === principal || verifiedSubmitter === principal;
    if (parsed.reviewer_role === "independent" && reviewerIsOwner) {
      res.status(409).json({
        error: "policy_rejected",
        message: "task owner cannot attest that this review is independent",
      });
      return;
    }
    const independence = parsed.reviewer_role === "independent"
      ? "independent"
      : parsed.reviewer_role === "self" || reviewerIsOwner
        ? "self"
        : "unknown";
    const receipt = buildQualityReceipt({
      taskId: parsed.task_id,
      reviewerPrincipal: principal,
      reviewerIndependence: independence,
      rating: parsed.rating,
      ratingReason: parsed.rating_reason,
      verificationOutcome: parsed.verification_outcome,
      retriesCount: parsed.retries_count,
      ratedAt: nowFn(deps)().toISOString(),
      bindingAttestation: expected ? "reviewer-confirmed" : "server-bound",
      binding,
    });
    try {
      await deps.taskStore.writeQualityReceipt(parsed.task_id, receipt);
    } catch (err) {
      res.status(err instanceof QualityReceiptConflictError ? 409 : 500).json({
        error: err instanceof QualityReceiptConflictError ? "policy_rejected" : "internal",
        message: `feedback write failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    res.status(204).send();
  };
}

export function createFrictionHandler(deps: BrokerHandlerDependencies) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const principal = req.brokerPrincipal;
    if (!principal) {
      res.status(500).json({ error: "internal", message: "principal missing" });
      return;
    }

    let parsed;
    try {
      parsed = brokerFrictionInputSchema.parse(req.body);
    } catch (err) {
      respondZodError(res, err);
      return;
    }

    try {
      const result = await deps.taskStore.writeFriction(
        parsed,
        principal,
        nowFn(deps)(),
      );
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof FrictionIdempotencyConflictError) {
        res.status(409).json({
          error: "idempotency_collision",
          message: err.message,
        });
        return;
      }
      res.status(500).json({
        error: "internal",
        message: "friction write failed",
      });
      console.error("[broker] friction write failed:", err);
    }
  };
}

export function createListHandler(deps: BrokerHandlerDependencies) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    let parsed;
    try {
      parsed = listRequestSchema.parse(
        req.method === "GET" ? coerceQueryToList(req.query) : req.body,
      );
    } catch (err) {
      respondZodError(res, err);
      return;
    }

    const principal = req.brokerPrincipal;
    if (!principal) {
      res.status(500).json({ error: "internal", message: "principal missing" });
      return;
    }
    const canonical = await deps.taskStore.listCanonical(principal, parsed.since_ts);
    const historical = Array.from(projectDelegations(await deps.journal.readAll()).values())
      .filter((row) => row.envelope?.broker_principal === principal);
    const canonicalIds = new Set(canonical.rows.map((row) => row.task_id));
    const combined: Array<Record<string, any>> = [
      ...canonical.rows,
      ...historical.filter((row) => !canonicalIds.has(row.task_id)),
    ];
    const rows = combined.filter((row) => {
      if (parsed.outcome === "completed" && row.outcome !== "completed") return false;
      if (parsed.outcome === "failed" && row.outcome !== "failed") return false;
      if (parsed.outcome === "running" && row.outcome && row.outcome !== "running") return false;
      if (parsed.alias && (row.alias ?? row.envelope?.alias_requested) !== parsed.alias) return false;
      if (parsed.since_ts) {
        const submittedAt = row.submitted_at ?? "";
        const submittedAtMs = Date.parse(submittedAt);
        if (!Number.isFinite(submittedAtMs) || submittedAtMs < Date.parse(parsed.since_ts)) return false;
      }
      return true;
    });
    rows.sort((a, b) =>
      (b.submitted_at ?? "").localeCompare(a.submitted_at ?? ""),
    );
    res.status(200).json({
      rows: rows.slice(0, parsed.limit ?? 50),
      total: rows.length,
      truncated: canonical.truncated,
    });
  };
}

export function createModelsHandler(capabilities: BrokerExecutorCapabilities) {
  return async (_req: Request, res: Response): Promise<void> => {
    const map: AliasMap = ACTIVE_ALIAS_MAP;
    const executable = new Set(executableBrokerAliases(capabilities));
    const aliases = Object.values(map.aliases)
      .filter((entry) => executable.has(entry.alias))
      .map((entry) => ({
        ...entry,
        runtime_row_id: entry.runtimeId,
      }));
    const executableRuntimeIds = new Set(aliases.map((entry) => entry.runtimeId));
    const rows = RUNTIME_REGISTRY.filter((row) =>
      executableRuntimeIds.has(row.id),
    ).map((row) => ({
      id: row.id,
      runtime: row.dispatcherRuntime,
      provider: row.provider,
      egress: row.egress,
      family: row.family,
      auto_eligible: row.autoEligible ?? false,
      zdr_required: row.zdrRequired ?? false,
    }));
    res.status(200).json({
      alias_map_version: map.version,
      effective_at: map.effective_at,
      aliases,
      runtime_rows: rows,
      policy_version: POLICY_VERSION,
    });
  };
}

function coerceQueryToList(query: Request["query"]): unknown {
  const out: Record<string, unknown> = {};
  if (typeof query.limit === "string") out.limit = Number(query.limit);
  if (typeof query.since_ts === "string") out.since_ts = query.since_ts;
  if (typeof query.outcome === "string") out.outcome = query.outcome;
  if (typeof query.alias === "string") out.alias = query.alias;
  return out;
}

function pickLifecycleTag(tags: string[]): string | undefined {
  for (const tag of ["completed", "failed", "cancelled", "running", "pending"]) {
    if (tags.includes(tag)) return tag;
  }
  return undefined;
}

interface LeaseInfo {
  claimed_by: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  last_heartbeat_at: string | null;
  queue_depth_when_submitted: number;
}

/**
 * Reconstruct lease metadata from the status entry's tags. The orch-v1
 * worker writes `claimed_by:<id>` and `lease_expires:<epoch-ms>` on
 * every CAS claim (see src/broker/orch-worker.ts:buildClaimTags). The
 * status entry's `updated_at` is the most reliable proxy for
 * `claimed_at` since the claim is the most recent write that touched it.
 *
 * Tasks still in `pending` (no lease yet) return all-null fields.
 * Heartbeat is not yet tracked for one-shot openrouter calls; that
 * field stays null until a long-running runtime needs it.
 */
function readLeaseInfo(tags: string[], updatedAt: string): LeaseInfo {
  const claimedByTag = tags.find((t) => t.startsWith("claimed_by:"));
  const leaseExpiresTag = tags.find((t) => t.startsWith("lease_expires:"));
  const claimedBy = claimedByTag
    ? claimedByTag.slice("claimed_by:".length)
    : null;
  let leaseExpiresAt: string | null = null;
  if (leaseExpiresTag) {
    const raw = leaseExpiresTag.slice("lease_expires:".length);
    const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
    if (!Number.isNaN(ms)) {
      leaseExpiresAt = new Date(ms).toISOString();
    }
  }
  return {
    claimed_by: claimedBy,
    claimed_at: claimedBy ? updatedAt : null,
    lease_expires_at: leaseExpiresAt,
    last_heartbeat_at: null,
    queue_depth_when_submitted: 0,
  };
}

function respondZodError(res: Response, err: unknown): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "policy_rejected",
      message: "envelope validation failed",
      issues: err.issues,
    });
    return;
  }
  res.status(400).json({
    error: "policy_rejected",
    message: err instanceof Error ? err.message : String(err),
  });
}
