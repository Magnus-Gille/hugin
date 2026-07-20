/**
 * Authoritative monthly (period) close — LearningTaskContract consumption
 * layer (hugin#241).
 *
 * Scope boundary (2026-07-20 "Boundary clarification" on hugin#241, echoed in
 * the header of src/learning-registry-schema.ts): hugin#232 owns the
 * *mechanism* — the append-only registry's natural keys, membership evidence
 * issued at capture, and the partition/high-water proof primitives
 * (`issuePartitionProof` / `verifyPartitionProof`). This module owns the
 * *consumption* — period closes, monthly statements, and cross-owner
 * accounting that VERIFY and CONSUME #232's proofs. It does not:
 *   - add a new registry record kind or counter,
 *   - re-issue or re-derive a partition/high-water proof (it always asks
 *     `LearningRegistryStore` for one and then independently verifies it), or
 *   - change #232's natural keys.
 * Correction/exclusion resolution reuses `buildTaskLifecycleTimeline`
 * (#232's own read view) rather than re-walking correction chains here.
 *
 * A period statement is content-addressed and append-only: the same
 * registry state for a period always produces the same `statementId`, so
 * re-closing is a no-op. A later correction or erasure changes the derived
 * corrected/excluded counts (never the underlying partition's own
 * `highWaterSeq` — see #232's "target's own partition membership count never
 * shrinks" invariant), which changes the digest and therefore produces a
 * *new*, distinct statement. The old statement is retained untouched; only a
 * separate, explicitly mutable "latest" pointer moves.
 *
 * Certification is fail-closed: a full-period statement is `"certified"`
 * only when every constituent counter's partition proof is eligible for
 * certification (#232's `isEligibleForCertification`) AND independently
 * re-verifies (`verifyPartitionProof` with `requireCurrent: true`) AND its
 * derived corrected/excluded counts could be computed without a truncated
 * read. Any single failure degrades the *whole* statement to `"partial"` and
 * names exactly which counter/partition blocked certification — never a
 * silent full-period claim over a subset.
 */

import { MuninWriteRejectedError, type MuninClient } from "./munin-client.js";
import { buildTaskLifecycleTimeline } from "./learning-registry-view.js";
import {
  canonicalEqual,
  isEligibleForCertification,
  jcsDigestHex,
  LearningRegistryError,
  LEARNING_REGISTRY_COUNTER_OWNER,
  occurrencePeriodSchema,
  registryEvidenceRefSchema,
  registryPartitionProofSchema,
  type LearningRegistryStore,
  type RegistryEvidenceRef,
  type RegistryPartitionProof,
  type RegistryRecordKind,
} from "./learning-registry-store.js";
import { z } from "zod";

export const PERIOD_CLOSE_SCHEMA_VERSION = 1 as const;

export class PeriodCloseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeriodCloseError";
  }
}

/**
 * The counters whose partitions constitute the Hugin-owned attempt/outcome
 * denominators a period statement certifies. `correction` and
 * `exclusion-adjustment` are not closed as their own partitions here — they
 * are consumed per-member through `buildTaskLifecycleTimeline` to compute
 * `correctedEvents` / `excludedEvents` against *these* counters' events,
 * which is the erasure-safe membership question #241 exists to answer.
 */
export const PRIMARY_ACCOUNTING_COUNTERS = [
  "submission",
  "attempt-reference",
  "terminal-outcome",
  "publication",
] as const satisfies readonly RegistryRecordKind[];
export type AccountingCounter = (typeof PRIMARY_ACCOUNTING_COUNTERS)[number];

const periodCounterStatementSchema = z.object({
  counter: z.enum(PRIMARY_ACCOUNTING_COUNTERS),
  /** The exact #232 partition/high-water proof this count is bound to. */
  proof: registryPartitionProofSchema,
  totalEvents: z.number().int().nonnegative(),
  /** Members whose correction chain resolves to a leaf other than themselves. */
  correctedEvents: z.number().int().nonnegative(),
  /** Members with at least one exclusion-adjustment directly targeting them. */
  excludedEvents: z.number().int().nonnegative(),
  erasureAdjustments: z.number().int().nonnegative(),
  exclusionAdjustments: z.number().int().nonnegative(),
  /** `totalEvents - excludedEvents` — informational only. `totalEvents` (the
   * partition's own high-water count) remains the contract-authoritative
   * denominator; erasure never shrinks it. */
  effectiveCount: z.number().int().nonnegative(),
}).strict();
export type PeriodCounterStatement = z.infer<typeof periodCounterStatementSchema>;

const blockedCounterSchema = z.object({
  counter: z.enum(PRIMARY_ACCOUNTING_COUNTERS),
  reason: z.string().min(1),
}).strict();
export type BlockedCounter = z.infer<typeof blockedCounterSchema>;

/**
 * Cross-owner (gille-inference) basis reference. Hugin owns Hugin counters;
 * gille owns gille counters. This is a *reference* to gille's own
 * owner-issued basis evidence for the same period — never a value Hugin
 * computes or fabricates on gille's behalf.
 */
export const gilleBasisReferenceSchema = z.object({
  ownerComponent: z.literal("gille-inference"),
  period: occurrencePeriodSchema,
  status: z.enum(["referenced", "unavailable"]),
  basisRef: registryEvidenceRefSchema.optional(),
  reason: z.string().min(1).max(512).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "referenced" && !value.basisRef) {
    ctx.addIssue({ code: "custom", path: ["basisRef"], message: "a referenced basis must carry gille's evidence ref" });
  }
  if (value.status === "unavailable" && !value.reason) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "an unavailable basis must explain why" });
  }
  if (value.status === "unavailable" && value.basisRef) {
    ctx.addIssue({ code: "custom", path: ["basisRef"], message: "an unavailable basis cannot carry a ref" });
  }
});
export type GilleBasisReference = z.infer<typeof gilleBasisReferenceSchema>;

/** Injected port to gille-inference's own authoritative period accounting
 * (gille-inference#3, not yet implemented at time of writing). Consumed,
 * never re-implemented: Hugin only ever stores whatever this returns. */
export interface GilleBasisSource {
  fetchBasis(period: string): Promise<GilleBasisReference>;
}

export const periodStatementSchema = z.object({
  schemaVersion: z.literal(PERIOD_CLOSE_SCHEMA_VERSION),
  /** Content-derived: `close-<32 hex>`, digested over every field below
   * except `closedAt` and `supersedes` (call-observed metadata) and each
   * counter proof's own `issuedAt` (re-issued fresh on every call). */
  statementId: z.string().regex(/^close-[0-9a-f]{32}$/),
  counterOwner: z.literal(LEARNING_REGISTRY_COUNTER_OWNER),
  period: occurrencePeriodSchema,
  status: z.enum(["certified", "partial"]),
  counters: z.array(periodCounterStatementSchema),
  blockedCounters: z.array(blockedCounterSchema),
  crossOwner: gilleBasisReferenceSchema.nullable(),
  /** When this exact statement row was durably persisted. Not part of the
   * content digest — a later idempotent re-close legitimately observes a
   * different wall-clock time for the same logical statement. */
  closedAt: z.string(),
  /** The prior latest statement id for this period at the moment this
   * statement was first created, or null for the first close. Lineage
   * metadata only; not part of the content digest. */
  supersedes: z.string().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "certified" && value.blockedCounters.length > 0) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "a statement with any blocked counter cannot be certified" });
  }
  if (value.status === "certified" && value.counters.length !== PRIMARY_ACCOUNTING_COUNTERS.length) {
    ctx.addIssue({ code: "custom", path: ["counters"], message: "a certified statement must bind every accounting counter" });
  }
  if (value.status === "partial" && value.blockedCounters.length === 0) {
    ctx.addIssue({ code: "custom", path: ["blockedCounters"], message: "a partial statement must name at least one blocking counter" });
  }
});
export type PeriodStatement = z.infer<typeof periodStatementSchema>;

// ---------------------------------------------------------------------------
// Content addressing
// ---------------------------------------------------------------------------

function proofWithoutIssuedAt(proof: RegistryPartitionProof): Omit<RegistryPartitionProof, "issuedAt"> {
  const { issuedAt: _issuedAt, ...rest } = proof;
  return rest;
}

/** Everything that makes a statement *this* statement, excluding
 * call-observed metadata (`closedAt`, `supersedes`, each proof's `issuedAt`). */
function digestInput(draft: Omit<PeriodStatement, "statementId" | "closedAt" | "supersedes">): unknown {
  return {
    schemaVersion: draft.schemaVersion,
    counterOwner: draft.counterOwner,
    period: draft.period,
    status: draft.status,
    counters: draft.counters.map((c) => ({ ...c, proof: proofWithoutIssuedAt(c.proof) })),
    blockedCounters: draft.blockedCounters,
    crossOwner: draft.crossOwner,
  };
}

export function deriveStatementId(
  draft: Omit<PeriodStatement, "statementId" | "closedAt" | "supersedes">,
): string {
  return `close-${jcsDigestHex(digestInput(draft)).slice(0, 32)}`;
}

function withoutVolatile(statement: PeriodStatement): unknown {
  const { closedAt: _closedAt, supersedes: _supersedes, statementId: _statementId, ...rest } = statement;
  return digestInput(rest);
}

// ---------------------------------------------------------------------------
// Per-counter accounting
// ---------------------------------------------------------------------------

interface CounterOutcome {
  kind: "ok";
  statement: PeriodCounterStatement;
}
interface CounterBlocked {
  kind: "blocked";
  reason: string;
}

async function statsForCounter(
  registryStore: Pick<LearningRegistryStore, "listEventsForTask">,
  counter: AccountingCounter,
  proof: RegistryPartitionProof,
): Promise<CounterOutcome | CounterBlocked> {
  const eventIdsByTask = new Map<string, string[]>();
  for (const member of proof.members) {
    const list = eventIdsByTask.get(member.taskId) ?? [];
    list.push(member.eventId);
    eventIdsByTask.set(member.taskId, list);
  }

  let correctedEvents = 0;
  let excludedEvents = 0;
  let erasureAdjustments = 0;
  let exclusionAdjustments = 0;

  for (const [taskId, eventIds] of eventIdsByTask) {
    const timeline = await buildTaskLifecycleTimeline(registryStore, taskId);
    if (timeline.truncated) {
      return {
        kind: "blocked",
        reason: `task ${taskId}'s lifecycle timeline could not be enumerated completely (Munin pagination budget exhausted); corrected/excluded counts for counter ${counter} cannot be certified`,
      };
    }
    const byEventId = new Map(timeline.entries.map((entry) => [entry.event.eventId, entry] as const));
    for (const eventId of eventIds) {
      const entry = byEventId.get(eventId);
      if (!entry) {
        return {
          kind: "blocked",
          reason: `partition member ${taskId}/${eventId} for counter ${counter} was not found in its task's lifecycle timeline`,
        };
      }
      if (entry.event.recordKind !== counter) {
        return {
          kind: "blocked",
          reason: `partition member ${taskId}/${eventId} tagged for counter ${counter} is actually recordKind ${entry.event.recordKind}`,
        };
      }
      if (entry.superseded) correctedEvents += 1;
      if (entry.excluded) {
        excludedEvents += 1;
        if (entry.excludedReasons.includes("erasure")) erasureAdjustments += 1;
        if (entry.excludedReasons.includes("exclusion")) exclusionAdjustments += 1;
      }
    }
  }

  return {
    kind: "ok",
    statement: periodCounterStatementSchema.parse({
      counter,
      proof,
      totalEvents: proof.highWaterSeq,
      correctedEvents,
      excludedEvents,
      erasureAdjustments,
      exclusionAdjustments,
      effectiveCount: proof.highWaterSeq - excludedEvents,
    }),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STATEMENT_NAMESPACE = "learning-period-close/statements";
const STATEMENT_TAG = "learning-period-close-statement";
const LATEST_NAMESPACE = "learning-period-close/latest";
const LATEST_CAS_ATTEMPTS = 8;

const latestPointerSchema = z.object({
  schemaVersion: z.literal(PERIOD_CLOSE_SCHEMA_VERSION),
  counterOwner: z.literal(LEARNING_REGISTRY_COUNTER_OWNER),
  period: occurrencePeriodSchema,
  latestStatementId: z.string().regex(/^close-[0-9a-f]{32}$/),
  updatedAt: z.string(),
}).strict();
type LatestPointer = z.infer<typeof latestPointerSchema>;

function latestPointerKey(period: string): string {
  return `${LEARNING_REGISTRY_COUNTER_OWNER}-${period}`;
}

export interface PeriodCloseOptions {
  /** Which counters to actually evaluate. Defaults to every
   * `PRIMARY_ACCOUNTING_COUNTERS` entry — mainly useful for focused tests. A
   * strict subset can never yield `"certified"`: every counter outside the
   * requested set is added to `blockedCounters` as its own named blocker, so
   * the statement always honestly degrades to `"partial"` instead of
   * silently claiming a full period over an evaluated subset. */
  counters?: readonly AccountingCounter[];
  gilleBasisSource?: GilleBasisSource;
  closedAt?: string;
}

export interface PeriodCloseResult {
  statement: PeriodStatement;
  /** True only when this call durably created a new statement row. False
   * both for "exact idempotent replay" and for "content matched an older
   * already-persisted statement". */
  created: boolean;
}

/**
 * Authoritative monthly close store (hugin#241). Wraps a `LearningRegistryStore`
 * (hugin#232) — it never talks to Munin about registry events directly, only
 * about its own statement/pointer documents.
 */
export class LearningPeriodCloseStore {
  private readonly now: () => string;

  constructor(
    private readonly munin: MuninClient,
    private readonly registryStore: LearningRegistryStore,
    options: { now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async readLatestPointer(period: string): Promise<LatestPointer | null> {
    const entry = await this.munin.read(LATEST_NAMESPACE, latestPointerKey(period));
    return entry ? latestPointerSchema.parse(JSON.parse(entry.content)) : null;
  }

  private async readStatement(statementId: string): Promise<PeriodStatement | null> {
    const entry = await this.munin.read(STATEMENT_NAMESPACE, statementId);
    return entry ? periodStatementSchema.parse(JSON.parse(entry.content)) : null;
  }

  async getStatement(statementId: string): Promise<PeriodStatement | null> {
    return this.readStatement(statementId);
  }

  /** The current effective statement for a period, or null if it has never
   * been closed. A later correction/erasure moves this pointer to a new,
   * distinct statement; the statement it superseded remains readable by id. */
  async getLatest(period: string): Promise<PeriodStatement | null> {
    occurrencePeriodSchema.parse(period);
    const pointer = await this.readLatestPointer(period);
    if (!pointer) return null;
    const statement = await this.readStatement(pointer.latestStatementId);
    if (!statement) {
      throw new LearningRegistryError(
        `period close latest pointer for ${period} names statement ${pointer.latestStatementId}, which could not be read back`,
      );
    }
    return statement;
  }

  private async persistStatement(
    statement: PeriodStatement,
  ): Promise<{ statement: PeriodStatement; created: boolean }> {
    const key = statement.statementId;
    try {
      const result = await this.munin.write(
        STATEMENT_NAMESPACE,
        key,
        JSON.stringify(statement),
        [STATEMENT_TAG, `learning-period-close-status:${statement.status}`],
        undefined,
        "internal",
        true,
      );
      if (result.status !== "created") {
        throw new LearningRegistryError(`period statement write returned non-created status for ${STATEMENT_NAMESPACE}/${key}`);
      }
      return { statement, created: true };
    } catch (err) {
      if (err instanceof MuninWriteRejectedError && err.conflictReason === "already_exists") {
        const existing = await this.readStatement(key);
        if (!existing) {
          throw new LearningRegistryError(
            `period statement ${STATEMENT_NAMESPACE}/${key} reported already-existing but could not be read back`,
          );
        }
        if (!canonicalEqual(withoutVolatile(existing), withoutVolatile(statement))) {
          throw new PeriodCloseError(
            `period statement content-address collision at ${key}: a differently-contented statement already occupies this id`,
          );
        }
        return { statement: existing, created: false };
      }
      throw err;
    }
  }

  private async advanceLatestPointer(period: string, statementId: string, updatedAt: string): Promise<void> {
    for (let attempt = 0; attempt < LATEST_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.munin.read(LATEST_NAMESPACE, latestPointerKey(period));
      const currentPointer = current ? latestPointerSchema.parse(JSON.parse(current.content)) : null;
      if (currentPointer?.latestStatementId === statementId) return; // already the latest
      const nextPointer = latestPointerSchema.parse({
        schemaVersion: PERIOD_CLOSE_SCHEMA_VERSION,
        counterOwner: LEARNING_REGISTRY_COUNTER_OWNER,
        period,
        latestStatementId: statementId,
        updatedAt,
      });
      try {
        await this.munin.write(
          LATEST_NAMESPACE,
          latestPointerKey(period),
          JSON.stringify(nextPointer),
          ["learning-period-close-latest"],
          current?.updated_at,
          "internal",
          current === null ? true : undefined,
        );
        return;
      } catch (err) {
        if (err instanceof MuninWriteRejectedError) continue; // lost the CAS race — reread and retry
        throw err;
      }
    }
    throw new LearningRegistryError(
      `latest-statement pointer update for period ${period} lost ${LATEST_CAS_ATTEMPTS} repeated CAS races`,
    );
  }

  /**
   * Close `period`: gather and independently verify #232's partition proof
   * for every accounting counter, derive corrected/excluded counts from the
   * registry's own lifecycle view, optionally join gille's owner-issued
   * cross-owner basis, and persist the resulting content-addressed statement.
   *
   * Fail-closed: any counter whose proof is not eligible for certification,
   * fails independent re-verification, or whose corrected/excluded counts
   * cannot be proven complete blocks that counter — the whole statement
   * degrades to `"partial"` and names exactly which counter(s) blocked it.
   * A `"certified"` statement only ever comes from every counter succeeding.
   */
  async close(period: string, options: PeriodCloseOptions = {}): Promise<PeriodCloseResult> {
    occurrencePeriodSchema.parse(period);
    const closedAt = options.closedAt ?? this.now();
    const counters = options.counters ?? PRIMARY_ACCOUNTING_COUNTERS;

    const previousLatest = await this.readLatestPointer(period);

    const counterStatements: PeriodCounterStatement[] = [];
    const blockedCounters: BlockedCounter[] = [];

    for (const counter of counters) {
      const proof = await this.registryStore.issuePartitionProof(counter, period, closedAt);
      const verdict = await this.registryStore.verifyPartitionProof(proof, { requireCurrent: true });
      if (!isEligibleForCertification(proof)) {
        blockedCounters.push({ counter, reason: proof.partialReason ?? "partition proof is not eligible for certification" });
        continue;
      }
      if (!verdict.valid) {
        blockedCounters.push({ counter, reason: verdict.reason ?? "partition proof failed independent verification" });
        continue;
      }
      const outcome = await statsForCounter(this.registryStore, counter, proof);
      if (outcome.kind === "blocked") {
        blockedCounters.push({ counter, reason: outcome.reason });
        continue;
      }
      counterStatements.push(outcome.statement);
    }

    // A caller-supplied `counters` subset must never be able to earn a
    // "certified" full-period statement over counters it never evaluated —
    // that would be exactly the silent full-period claim over a subset this
    // module exists to prevent. Any counter outside the requested set is
    // itself a named blocker.
    for (const counter of PRIMARY_ACCOUNTING_COUNTERS) {
      if (!counters.includes(counter)) {
        blockedCounters.push({
          counter,
          reason: "excluded from this close by the caller's counters option; a subset cannot be certified as a full period",
        });
      }
    }

    counterStatements.sort((a, b) => a.counter.localeCompare(b.counter));
    blockedCounters.sort((a, b) => a.counter.localeCompare(b.counter));

    const crossOwner = options.gilleBasisSource
      ? await options.gilleBasisSource.fetchBasis(period)
      : null;

    const status: PeriodStatement["status"] = blockedCounters.length === 0 ? "certified" : "partial";

    const draft = {
      schemaVersion: PERIOD_CLOSE_SCHEMA_VERSION,
      counterOwner: LEARNING_REGISTRY_COUNTER_OWNER,
      period,
      status,
      counters: counterStatements,
      blockedCounters,
      crossOwner,
    } satisfies Omit<PeriodStatement, "statementId" | "closedAt" | "supersedes">;

    const statementId = deriveStatementId(draft);

    if (previousLatest?.latestStatementId === statementId) {
      // Exact idempotent replay of the current latest — nothing changed.
      const existing = await this.readStatement(statementId);
      if (!existing) {
        throw new LearningRegistryError(
          `latest pointer for period ${period} names statement ${statementId}, which could not be read back`,
        );
      }
      return { statement: existing, created: false };
    }

    const statement = periodStatementSchema.parse({
      ...draft,
      statementId,
      closedAt,
      supersedes: previousLatest?.latestStatementId ?? null,
    });

    const persisted = await this.persistStatement(statement);
    await this.advanceLatestPointer(period, persisted.statement.statementId, closedAt);
    return persisted;
  }
}

export type { RegistryEvidenceRef };
