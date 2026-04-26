/**
 * Express handlers for the orchestrator broker (POST /v1/delegate/*).
 *
 * Per docs/orchestrator-v1-data-model.md:
 *   - submit  (§3, §3.1, §12.2)
 *   - await   (§4, §12.4)
 *   - rate    (§5)
 *   - list    (§5 projection)
 *   - models  (§2 alias map + §6 registry view)
 *
 * All five endpoints assume `brokerAuthMiddleware` has already populated
 * `req.brokerPrincipal`.
 */

import type { Request, Response } from "express";
import { ZodError } from "zod";
import {
  ALIAS_MAP_V1,
  RUNTIME_REGISTRY,
  type AliasMap,
} from "../runtime-registry.js";
import { POLICY_VERSION, resolveAliasForBroker } from "./alias-resolution.js";
import type { DelegationJournal } from "./journal.js";
import { projectDelegations } from "./journal.js";
import type { IdempotencyIndex } from "./idempotency.js";
import { hashPayload } from "./idempotency.js";
import type { BrokerTaskStore } from "./task-store.js";
import { generateBrokerTaskId } from "./task-store.js";
import {
  awaitRequestSchema,
  delegationRequestSchema,
  listRequestSchema,
  rateRequestSchema,
  type DelegationEnvelope,
} from "./types.js";
import type { AuthenticatedRequest } from "./auth.js";

export interface BrokerHandlerDependencies {
  taskStore: BrokerTaskStore;
  journal: DelegationJournal;
  idempotency: IdempotencyIndex;
  now?: () => Date;
}

function nowFn(deps: BrokerHandlerDependencies): () => Date {
  return deps.now ?? (() => new Date());
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

    if (request.envelope_version !== 1) {
      res.status(400).json({
        error: "policy_rejected",
        message: `unsupported envelope_version ${request.envelope_version}`,
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

    const idemOutcome = deps.idempotency.reserve(request.idempotency_key, request);
    if (idemOutcome.kind === "retry") {
      res.status(200).json({
        task_id: idemOutcome.task_id,
        received_at: nowFn(deps)().toISOString(),
        reused_idempotency: true,
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
    const taskId = generateBrokerTaskId(now);
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
      deps.idempotency.release(request.idempotency_key);
      res.status(500).json({
        error: "internal",
        message: `munin submit failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    deps.idempotency.record(request.idempotency_key, request, taskId);

    try {
      await deps.journal.append({
        event_schema_version: 1,
        event_type: "delegation_submitted",
        event_ts: now.toISOString(),
        task_id: taskId,
        envelope,
        prompt_chars: request.prompt.length,
        prompt_sha256: hashPayload({ ...request, prompt: request.prompt }),
      });
    } catch (err) {
      console.warn(
        `[broker] journal append failed for ${taskId}; reconciliation will backfill: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    res.status(202).json({
      task_id: taskId,
      received_at: envelope.received_at,
      reused_idempotency: false,
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

    const lifecycle = pickLifecycleTag(status.tags);
    if (lifecycle === "completed") {
      const result = await deps.taskStore.readStructuredResult(parsed.task_id);
      if (!result) {
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
      res.status(200).json({
        status: "completed",
        result: JSON.parse(result.content),
      });
      return;
    }
    if (lifecycle === "failed") {
      const stored = await deps.taskStore.readErrorResult(parsed.task_id);
      const error = stored
        ? JSON.parse(stored.content)
        : {
            task_id: parsed.task_id,
            kind: "internal",
            message: "result-error key missing; reconciliation pending",
            retryable: true,
          };
      res.status(200).json({ status: "failed", error });
      return;
    }

    res.status(200).json({
      status: "running",
      lease: emptyLeaseInfo(),
      orphan_suspected: false,
    });
  };
}

// Lease metadata stays empty until the orch-v1 executor lands (Step 5).
// Once an executor claims a task it will populate `claimed_by`, lease
// expiry, and heartbeat — at that point this handler will compute
// `running` vs `stale` from the expiry timestamp.

export function createRateHandler(deps: BrokerHandlerDependencies) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

    try {
      await deps.journal.append({
        event_schema_version: 1,
        event_type: "delegation_rated",
        event_ts: nowFn(deps)().toISOString(),
        task_id: parsed.task_id,
        rating: parsed.rating,
        rating_reason: parsed.rating_reason,
        verification_outcome: parsed.verification_outcome,
        rated_by: req.brokerPrincipal ?? "unknown",
        retries_count: parsed.retries_count,
      });
    } catch (err) {
      res.status(500).json({
        error: "internal",
        message: `journal append failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    res.status(204).send();
  };
}

export function createListHandler(deps: BrokerHandlerDependencies) {
  return async (req: Request, res: Response): Promise<void> => {
    let parsed;
    try {
      parsed = listRequestSchema.parse(
        req.method === "GET" ? coerceQueryToList(req.query) : req.body,
      );
    } catch (err) {
      respondZodError(res, err);
      return;
    }

    const events = await deps.journal.readAll();
    const projection = projectDelegations(events);
    const rows = Array.from(projection.values()).filter((row) => {
      if (parsed.outcome === "completed" && row.outcome !== "completed") return false;
      if (parsed.outcome === "failed" && row.outcome !== "failed") return false;
      if (parsed.outcome === "running" && row.outcome) return false;
      if (parsed.alias && row.envelope?.alias_requested !== parsed.alias) return false;
      if (parsed.since_ts) {
        const submittedAt = row.submitted_at ?? "";
        if (submittedAt < parsed.since_ts) return false;
      }
      return true;
    });
    rows.sort((a, b) =>
      (b.submitted_at ?? "").localeCompare(a.submitted_at ?? ""),
    );
    const limited = rows.slice(0, parsed.limit ?? 50);
    res.status(200).json({ rows: limited, total: rows.length });
  };
}

export function createModelsHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    const map: AliasMap = ALIAS_MAP_V1;
    const aliases = Object.values(map.aliases).map((entry) => ({
      ...entry,
      runtime_row_id: entry.runtimeId,
    }));
    const rows = RUNTIME_REGISTRY.filter((row) =>
      row.dispatcherRuntime === "ollama" ||
      row.dispatcherRuntime === "openrouter" ||
      row.dispatcherRuntime === "pi-harness",
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
  for (const tag of ["completed", "failed", "running", "pending"]) {
    if (tags.includes(tag)) return tag;
  }
  return undefined;
}

function emptyLeaseInfo() {
  return {
    claimed_by: null,
    claimed_at: null,
    lease_expires_at: null,
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
