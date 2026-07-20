/**
 * Durable append-only task/outcome learning registry — store (#232).
 *
 * Backing store: Munin envelopes, the same idiom as src/broker/task-store.ts
 * and src/learning-task-store.ts. The registry's own natural-key evidence
 * (`tasks/<taskId>/reg-<hash>`) sits directly beside the LearningTaskContract
 * attempt rows it references (`tasks/<taskId>/learning-attempt-<uuid>...`),
 * so a reader never has to cross a storage boundary to join them. There is no
 * SQLite (or other embedded-database) dependency anywhere in this repository
 * to plug into; Munin's create-if-absent / CAS primitives already give us
 * exactly the idempotent-create and no-lost-update guarantees this registry
 * needs, and reusing them keeps the registry's failure modes identical to
 * every other durable Hugin store instead of adding a second persistence
 * technology and a second backup/restore story.
 *
 * Idempotency and concurrency, concretely:
 *  - Every event's Munin key is content-derived from its natural key
 *    (`deriveEventId`), so a duplicate delivery targets the exact same row.
 *    Munin's `create_if_absent` makes the first writer's create atomic; a
 *    racing duplicate gets a typed `already_exists` conflict, reads back the
 *    winner's bytes, and returns the same result — never a second event, and
 *    never a lost one.
 *  - Genuinely different payloads colliding on one natural key are refused
 *    (`RegistryNaturalKeyConflictError`) rather than silently overwritten;
 *    the caller must express the change as a correction, which mints a new,
 *    distinctly-keyed event chained to the immutable predecessor.
 *  - The per-partition high-water document is updated through the same
 *    CAS-retry idiom already used by `BrokerTaskStore.writeQualityReceipt`
 *    (bounded read-modify-write retries against `expected_updated_at`), so
 *    concurrent writers to the same partition serialize instead of clobbering
 *    each other's membership accounting.
 */

import { MuninWriteRejectedError, type MuninClient } from "./munin-client.js";
import { queryAllMuninEntries, type MuninPaginationBudget } from "./munin-pagination.js";
import {
  buildMembership,
  canonicalEqual,
  deriveEventId,
  EMPTY_CHAIN_DIGEST,
  isEligibleForCertification,
  jcsDigestHex,
  LearningRegistryError,
  LEARNING_REGISTRY_COUNTER_OWNER,
  LEARNING_REGISTRY_SCHEMA_VERSION,
  nextChainDigest,
  registryEventKey,
  registryEventNamespace,
  registryEventSchema,
  registryHighWaterDocSchema,
  registryNaturalKeySchema,
  registryPartitionProofSchema,
  registryPartitionTag,
  REGISTRY_EVENT_TAG,
  submissionEventSchema,
  attemptReferenceEventSchema,
  terminalOutcomeEventSchema,
  publicationEventSchema,
  correctionEventSchema,
  exclusionAdjustmentEventSchema,
  type RegistryEvent,
  type RegistryEvidenceRef,
  type RegistryHighWaterDoc,
  type RegistryNaturalKey,
  type RegistryPartitionProof,
  type RegistryRecordKind,
  type SubmissionEvent,
  type AttemptReferenceEvent,
  type TerminalOutcomeEvent,
  type PublicationEvent,
  type CorrectionEvent,
  type ExclusionAdjustmentEvent,
} from "./learning-registry-schema.js";

export * from "./learning-registry-schema.js";

export class RegistryNaturalKeyConflictError extends Error {
  constructor(
    public readonly eventId: string,
    public readonly namespace: string,
    public readonly key: string,
  ) {
    super(
      `learning registry natural key collision at ${namespace}/${key}: a different payload ` +
      `already occupies event id ${eventId}. File a correction instead of retrying the write.`,
    );
    this.name = "RegistryNaturalKeyConflictError";
  }
}

export interface AppendResult<E extends RegistryEvent = RegistryEvent> {
  status: "created" | "exact-existing";
  event: E;
}

const REGISTRY_PARTITION_NAMESPACE = "learning-registry/partitions";
const REGISTRY_PARTITION_DOC_TAG = "learning-registry-partition";
const HIGH_WATER_CAS_ATTEMPTS = 8;
/** Cheap existence probe used only to tell "genuinely zero events" apart from
 * a missing/corrupt high-water doc — doesn't need to enumerate anything. */
const PARTITION_EXISTENCE_PROBE_BUDGET: MuninPaginationBudget = { maxPages: 2, maxResults: 1 };
/** Full enumeration budget for the completeness cross-check below. Proof
 * issuance is period-close-frequency work (#241 is expected to call this
 * roughly once per UTC month per counter), not the hot append path, so a
 * generous page budget is an acceptable cost for actually proving
 * completeness rather than only self-consistency. */
const PARTITION_COMPLETENESS_QUERY_BUDGET: MuninPaginationBudget = { maxPages: 200, maxResults: 5_000 };

function partitionDocKey(counter: RegistryRecordKind, occurrencePeriodUtc: string): string {
  return `${counter}-${occurrencePeriodUtc}`;
}

async function bumpHighWater(
  munin: MuninClient,
  event: RegistryEvent,
  now: string,
): Promise<RegistryHighWaterDoc> {
  const { counter, occurrencePeriodUtc } = event.membership;
  const namespace = REGISTRY_PARTITION_NAMESPACE;
  const key = partitionDocKey(counter, occurrencePeriodUtc);
  const eventDigest = jcsDigestHex(event);

  for (let attempt = 0; attempt < HIGH_WATER_CAS_ATTEMPTS; attempt += 1) {
    const current = await munin.read(namespace, key);
    const doc = current
      ? registryHighWaterDocSchema.parse(JSON.parse(current.content))
      : null;
    if (doc?.members.some((member) => member.eventId === event.eventId)) {
      // Already accounted for by an earlier attempt (ours or a racing
      // duplicate delivery). Bumping again would double-count membership.
      return doc;
    }
    const nextDoc = registryHighWaterDocSchema.parse({
      schemaVersion: LEARNING_REGISTRY_SCHEMA_VERSION,
      counter,
      counterOwner: LEARNING_REGISTRY_COUNTER_OWNER,
      occurrencePeriodUtc,
      highWaterSeq: (doc?.highWaterSeq ?? 0) + 1,
      members: [...(doc?.members ?? []), { taskId: event.taskId, eventId: event.eventId }],
      chainDigest: nextChainDigest(doc?.chainDigest ?? EMPTY_CHAIN_DIGEST, eventDigest),
      updatedAt: now,
    });
    try {
      await munin.write(
        namespace,
        key,
        JSON.stringify(nextDoc),
        [REGISTRY_PARTITION_DOC_TAG, registryPartitionTag(counter, occurrencePeriodUtc)],
        current?.updated_at,
        "internal",
        current === null ? true : undefined,
      );
      return nextDoc;
    } catch (err) {
      if (err instanceof MuninWriteRejectedError) continue; // lost the CAS race — reread and retry
      throw err;
    }
  }
  throw new LearningRegistryError(
    `high-water partition update for ${counter}/${occurrencePeriodUtc} lost ${HIGH_WATER_CAS_ATTEMPTS} repeated CAS races`,
  );
}

function withoutRecordedAt(event: RegistryEvent): Record<string, unknown> {
  const { recordedAt: _recordedAt, ...rest } = event as unknown as Record<string, unknown>;
  return rest;
}

async function appendRegistryEvent<E extends RegistryEvent>(
  munin: MuninClient,
  event: E,
  now: string,
): Promise<AppendResult<E>> {
  const validated = registryEventSchema.parse(event) as E;
  const namespace = registryEventNamespace(validated.taskId);
  const key = registryEventKey(validated.eventId);
  const content = JSON.stringify(validated);
  const tags = [
    REGISTRY_EVENT_TAG,
    `registry-kind:${validated.recordKind}`,
    registryPartitionTag(validated.membership.counter, validated.membership.occurrencePeriodUtc),
  ];

  try {
    const result = await munin.write(namespace, key, content, tags, undefined, "internal", true);
    if (result.status !== "created") {
      throw new LearningRegistryError(
        `registry event write returned non-created status for ${namespace}/${key}`,
      );
    }
  } catch (err) {
    if (err instanceof MuninWriteRejectedError && err.conflictReason === "already_exists") {
      const existing = await munin.read(namespace, key);
      if (!existing) {
        throw new LearningRegistryError(
          `registry event ${namespace}/${key} reported already-existing but could not be read back`,
        );
      }
      let existingEvent: E;
      try {
        existingEvent = registryEventSchema.parse(JSON.parse(existing.content)) as E;
      } catch {
        throw new LearningRegistryError(`registry event ${namespace}/${key} existing content is not a valid registry event`);
      }
      // `recordedAt` is store-observed ("when this was durably accepted"), not
      // caller-asserted content — two calls racing to persist the exact same
      // logical fact will legitimately differ there even though they describe
      // the same natural key. Compare identity on everything else, and always
      // return the actually-persisted (winning) event rather than the caller's
      // locally built candidate, so a later read is never inconsistent with
      // what this call reported.
      if (!canonicalEqual(withoutRecordedAt(existingEvent), withoutRecordedAt(validated))) {
        throw new RegistryNaturalKeyConflictError(validated.eventId, namespace, key);
      }
      // Identical replay: ensure the partition accounting saw it, then stop.
      await bumpHighWater(munin, existingEvent, now);
      return { status: "exact-existing", event: existingEvent };
    }
    throw err;
  }

  await bumpHighWater(munin, validated, now);
  return { status: "created", event: validated };
}

export interface LearningRegistryStoreOptions {
  now?: () => string;
  /** Override the completeness cross-check's query budget — mainly for
   * tests that want to force an honest truncation without enumerating
   * thousands of rows. Defaults to `PARTITION_COMPLETENESS_QUERY_BUDGET`. */
  partitionCompletenessQueryBudget?: MuninPaginationBudget;
}

export class LearningRegistryStore {
  private readonly now: () => string;
  private readonly partitionCompletenessQueryBudget: MuninPaginationBudget;

  constructor(
    private readonly munin: MuninClient,
    options: LearningRegistryStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.partitionCompletenessQueryBudget =
      options.partitionCompletenessQueryBudget ?? PARTITION_COMPLETENESS_QUERY_BUDGET;
  }

  // -- capture-time membership events -------------------------------------

  async recordSubmission(input: {
    taskId: string;
    taskOutcomeRef: RegistryEvidenceRef;
    occurredAt: string;
  }): Promise<AppendResult<SubmissionEvent>> {
    const naturalKey: RegistryNaturalKey = { recordKind: "submission", taskId: input.taskId };
    const recordedAt = this.now();
    const event = submissionEventSchema.parse({
      schemaVersion: LEARNING_REGISTRY_SCHEMA_VERSION,
      eventId: deriveEventId(naturalKey),
      taskId: input.taskId,
      recordKind: "submission",
      membership: buildMembership({ naturalKey, issuedAt: input.occurredAt }),
      occurredAt: input.occurredAt,
      recordedAt,
      payload: { taskOutcomeRef: input.taskOutcomeRef, originComponent: "hugin" },
    });
    return appendRegistryEvent(this.munin, event, recordedAt);
  }

  /** References the existing durable LearningTask attempt row — never copies it. */
  async recordAttemptReference(input: {
    taskId: string;
    attemptId: string;
    attemptStartRef: RegistryEvidenceRef;
    taskOutcomeRef: RegistryEvidenceRef;
    occurredAt: string;
  }): Promise<AppendResult<AttemptReferenceEvent>> {
    const naturalKey: RegistryNaturalKey = {
      recordKind: "attempt-reference",
      taskId: input.taskId,
      attemptId: input.attemptId,
    };
    const recordedAt = this.now();
    const event = attemptReferenceEventSchema.parse({
      schemaVersion: LEARNING_REGISTRY_SCHEMA_VERSION,
      eventId: deriveEventId(naturalKey),
      taskId: input.taskId,
      recordKind: "attempt-reference",
      attemptId: input.attemptId,
      membership: buildMembership({ naturalKey, issuedAt: input.occurredAt }),
      occurredAt: input.occurredAt,
      recordedAt,
      payload: { attemptStartRef: input.attemptStartRef, taskOutcomeRef: input.taskOutcomeRef },
    });
    return appendRegistryEvent(this.munin, event, recordedAt);
  }

  async recordTerminalOutcome(input: {
    taskId: string;
    attemptId: string;
    outcome: TerminalOutcomeEvent["payload"]["outcome"];
    repositoryOutcomeState?: TerminalOutcomeEvent["payload"]["repositoryOutcomeState"];
    taskOutcomeRef: RegistryEvidenceRef;
    attemptOutcomeRef?: RegistryEvidenceRef;
    occurredAt: string;
  }): Promise<AppendResult<TerminalOutcomeEvent>> {
    const naturalKey: RegistryNaturalKey = {
      recordKind: "terminal-outcome",
      taskId: input.taskId,
      attemptId: input.attemptId,
    };
    const recordedAt = this.now();
    const event = terminalOutcomeEventSchema.parse({
      schemaVersion: LEARNING_REGISTRY_SCHEMA_VERSION,
      eventId: deriveEventId(naturalKey),
      taskId: input.taskId,
      recordKind: "terminal-outcome",
      attemptId: input.attemptId,
      membership: buildMembership({ naturalKey, issuedAt: input.occurredAt }),
      occurredAt: input.occurredAt,
      recordedAt,
      payload: {
        outcome: input.outcome,
        taskOutcomeRef: input.taskOutcomeRef,
        // JCS canonicalization rejects an explicit `undefined` value, so an
        // absent optional field must be omitted entirely, never set to
        // `undefined` — otherwise two logically-identical events (one built
        // with the field, one without) would digest differently.
        ...(input.repositoryOutcomeState !== undefined
          ? { repositoryOutcomeState: input.repositoryOutcomeState } : {}),
        ...(input.attemptOutcomeRef !== undefined
          ? { attemptOutcomeRef: input.attemptOutcomeRef } : {}),
      },
    });
    return appendRegistryEvent(this.munin, event, recordedAt);
  }

  async recordPublication(input: {
    taskId: string;
    attemptId: string;
    publicationRef: string;
    label: PublicationEvent["payload"]["label"];
    evidenceRef: RegistryEvidenceRef;
    occurredAt: string;
  }): Promise<AppendResult<PublicationEvent>> {
    const naturalKey: RegistryNaturalKey = {
      recordKind: "publication",
      taskId: input.taskId,
      attemptId: input.attemptId,
      publicationRef: input.publicationRef,
    };
    const recordedAt = this.now();
    const event = publicationEventSchema.parse({
      schemaVersion: LEARNING_REGISTRY_SCHEMA_VERSION,
      eventId: deriveEventId(naturalKey),
      taskId: input.taskId,
      recordKind: "publication",
      attemptId: input.attemptId,
      membership: buildMembership({ naturalKey, issuedAt: input.occurredAt }),
      occurredAt: input.occurredAt,
      recordedAt,
      payload: {
        publicationRef: input.publicationRef,
        label: input.label,
        evidenceRef: input.evidenceRef,
      },
    });
    return appendRegistryEvent(this.munin, event, recordedAt);
  }

  // -- corrections and erasure-safe exclusion adjustments ------------------

  /**
   * Chain a new, distinctly-keyed correction onto an existing event.
   *
   * The predecessor is read but never mutated. At most one correction can
   * exist per predecessor (its natural key is `{correction, predecessorId}`,
   * so a second *different* correction targeting the same predecessor is a
   * natural-key collision, not a silent fork) — to correct a correction,
   * target the correction's own event id instead.
   */
  async writeCorrection(input: {
    taskId: string;
    predecessorEventId: string;
    reason: string;
    evidenceRef?: RegistryEvidenceRef;
    occurredAt: string;
  }): Promise<AppendResult<CorrectionEvent>> {
    const predecessor = await this.getEvent(input.taskId, input.predecessorEventId);
    if (!predecessor) {
      throw new LearningRegistryError(
        `cannot correct unknown predecessor event ${input.predecessorEventId} in task ${input.taskId}`,
      );
    }
    if (Date.parse(input.occurredAt) <= Date.parse(predecessor.occurredAt)) {
      throw new LearningRegistryError(
        "a correction must strictly time-advance past its predecessor's occurredAt",
      );
    }
    const naturalKey: RegistryNaturalKey = {
      recordKind: "correction",
      taskId: input.taskId,
      predecessorEventId: input.predecessorEventId,
    };
    const recordedAt = this.now();
    const event = correctionEventSchema.parse({
      schemaVersion: LEARNING_REGISTRY_SCHEMA_VERSION,
      eventId: deriveEventId(naturalKey),
      taskId: input.taskId,
      recordKind: "correction",
      membership: buildMembership({ naturalKey, issuedAt: input.occurredAt }),
      occurredAt: input.occurredAt,
      recordedAt,
      payload: {
        predecessorEventId: input.predecessorEventId,
        correctedNaturalKey: predecessor.membership.naturalKey,
        reason: input.reason,
        ...(input.evidenceRef !== undefined ? { evidenceRef: input.evidenceRef } : {}),
      },
    });
    return appendRegistryEvent(this.munin, event, recordedAt);
  }

  /**
   * Record that a target event's referenced content has been erased or
   * excluded, without deleting, mutating, or moving the target's own natural
   * key / occurrence period / counter / owner. The target's original
   * denominator membership is therefore preserved exactly — this registry
   * never stored prompt/response bytes to begin with, so there is nothing to
   * "resurrect"; the adjustment exists purely so a reader can honor the
   * upstream erasure when it later dereferences the target's evidence refs.
   */
  async writeExclusionAdjustment(input: {
    taskId: string;
    targetEventId: string;
    adjustmentReason: ExclusionAdjustmentEvent["payload"]["adjustmentReason"];
    note?: string;
    occurredAt: string;
  }): Promise<AppendResult<ExclusionAdjustmentEvent>> {
    const target = await this.getEvent(input.taskId, input.targetEventId);
    if (!target) {
      throw new LearningRegistryError(
        `cannot adjust unknown target event ${input.targetEventId} in task ${input.taskId}`,
      );
    }
    const naturalKey: RegistryNaturalKey = {
      recordKind: "exclusion-adjustment",
      taskId: input.taskId,
      targetEventId: input.targetEventId,
    };
    const recordedAt = this.now();
    const event = exclusionAdjustmentEventSchema.parse({
      schemaVersion: LEARNING_REGISTRY_SCHEMA_VERSION,
      eventId: deriveEventId(naturalKey),
      taskId: input.taskId,
      recordKind: "exclusion-adjustment",
      membership: buildMembership({ naturalKey, issuedAt: input.occurredAt }),
      occurredAt: input.occurredAt,
      recordedAt,
      payload: {
        targetEventId: input.targetEventId,
        targetNaturalKey: target.membership.naturalKey,
        adjustmentReason: input.adjustmentReason,
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
    });
    return appendRegistryEvent(this.munin, event, recordedAt);
  }

  // -- reads -----------------------------------------------------------------

  async getEvent(taskId: string, eventId: string): Promise<RegistryEvent | null> {
    const namespace = registryEventNamespace(taskId);
    const key = registryEventKey(eventId);
    const entry = await this.munin.read(namespace, key);
    if (!entry) return null;
    return registryEventSchema.parse(JSON.parse(entry.content));
  }

  /**
   * Walk the correction chain starting at `rootEventId` and return the id of
   * its unique unsuperseded leaf. Each hop is a direct key lookup (the
   * correction natural key is derived from its predecessor id), so this never
   * needs an index query and cannot silently stop at a stale branch: every
   * hop either finds the real (immutable, content-derived) next link or
   * proves none exists yet.
   *
   * This reflects the chain as of each hop's read, not a single atomic
   * snapshot — Munin has no multi-key transaction. A correction concurrently
   * committed after this walk already passed its hop is invisible to this
   * call, exactly like reading a ref that moves after you resolved it; a
   * later call observes it. This never produces a *wrong* leaf, only a
   * possibly-momentarily-stale one, and corrections themselves cannot fork
   * (at most one exists per predecessor), so there is no ambiguity to race on.
   */
  async findEffectiveLeaf(taskId: string, rootEventId: string, maxHops = 64): Promise<string> {
    let current = rootEventId;
    for (let hop = 0; hop < maxHops; hop += 1) {
      const correctionKey = registryNaturalKeySchema.parse({
        recordKind: "correction",
        taskId,
        predecessorEventId: current,
      });
      const correctionEventId = deriveEventId(correctionKey);
      const existing = await this.munin.read(registryEventNamespace(taskId), registryEventKey(correctionEventId));
      if (!existing) return current;
      current = correctionEventId;
    }
    throw new LearningRegistryError(
      `correction chain for ${taskId}/${rootEventId} exceeded ${maxHops} hops — possible cycle`,
    );
  }

  async listEventsForTask(taskId: string): Promise<{ events: RegistryEvent[]; truncated: boolean }> {
    const paged = await queryAllMuninEntries(
      this.munin,
      { namespace: registryEventNamespace(taskId), tags: [REGISTRY_EVENT_TAG], entry_type: "state" },
      { maxPages: 20, maxResults: 1_000 },
    );
    const reads = await Promise.all(
      paged.results
        .filter((result) => typeof result.key === "string" && result.key.startsWith("reg-"))
        .map((result) => this.munin.read(registryEventNamespace(taskId), result.key as string)),
    );
    const events = reads
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .map((entry) => registryEventSchema.parse(JSON.parse(entry.content)))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId));
    return { events, truncated: paged.truncated };
  }

  // -- partition / high-water proof primitives --------------------------------

  private async readHighWaterDoc(
    counter: RegistryRecordKind,
    occurrencePeriodUtc: string,
  ): Promise<RegistryHighWaterDoc | null> {
    const entry = await this.munin.read(REGISTRY_PARTITION_NAMESPACE, partitionDocKey(counter, occurrencePeriodUtc));
    return entry ? registryHighWaterDocSchema.parse(JSON.parse(entry.content)) : null;
  }

  /**
   * Recompute the chain digest directly from the persisted events a doc
   * claims as members, rather than trusting the doc's own digest field. This
   * is what makes a forged or hand-edited high-water document detectable.
   */
  private async recomputeChain(
    doc: RegistryHighWaterDoc,
  ): Promise<{ ok: true; chainDigest: string } | { ok: false; reason: string }> {
    let chain = EMPTY_CHAIN_DIGEST;
    for (const member of doc.members) {
      const event = await this.getEvent(member.taskId, member.eventId);
      if (!event) {
        return { ok: false, reason: `partition member ${member.taskId}/${member.eventId} is missing from the event store` };
      }
      if (event.membership.counter !== doc.counter || event.membership.occurrencePeriodUtc !== doc.occurrencePeriodUtc) {
        return { ok: false, reason: `partition member ${member.taskId}/${member.eventId} does not belong to ${doc.counter}/${doc.occurrencePeriodUtc}` };
      }
      chain = nextChainDigest(chain, jcsDigestHex(event));
    }
    return { ok: true, chainDigest: chain };
  }

  /**
   * `recomputeChain` only proves that every event a high-water document
   * *claims* as a member actually exists and belongs to this partition — it
   * cannot see an event that was durably written but never folded in. That
   * gap is real: `appendRegistryEvent` persists the event first and folds it
   * into the high-water document second (`bumpHighWater`); a crash between
   * those two writes leaves a durably-written, correctly-tagged event that
   * `bumpHighWater`'s idempotent skip-if-already-present check will only
   * ever fix on a *later redelivery of that same natural key* — which may
   * never come. Without this reverse check, `issuePartitionProof` could
   * certify a partition `"complete"` while silently omitting a persisted
   * event: exactly the "aggregate looks internally consistent but omits an
   * attempt" failure this registry exists to prevent.
   *
   * This queries every event tagged with this partition, cross-repository of
   * task namespace, and reports any whose id is not already in
   * `knownMemberIds`. An honest truncation (the tag query's own budget
   * exhausted before enumerating everything) is reported as its own failure
   * rather than silently treated as "no orphans found".
   */
  private async findPartitionOrphans(
    counter: RegistryRecordKind,
    occurrencePeriodUtc: string,
    knownMemberIds: ReadonlySet<string>,
  ): Promise<{ ok: true; orphanEventIds: string[] } | { ok: false; reason: string }> {
    const probe = await queryAllMuninEntries(
      this.munin,
      { tags: [registryPartitionTag(counter, occurrencePeriodUtc)] },
      this.partitionCompletenessQueryBudget,
    );
    if (probe.truncated) {
      return {
        ok: false,
        reason: "partition completeness tag query truncated before enumerating every tagged event",
      };
    }
    const orphanEventIds = probe.results
      // The high-water document itself carries this same partition tag but
      // lives in a different namespace/key shape (`counter-period`, not
      // `reg-<hash>`) — exclude it so it never mistakes itself for an orphan.
      .filter((result) => typeof result.key === "string" && result.key.startsWith("reg-"))
      .map((result) => result.key as string)
      .filter((eventId) => !knownMemberIds.has(eventId));
    return { ok: true, orphanEventIds };
  }

  /**
   * Issue an authoritative statement that partition (counter, period) is
   * complete up to the registry's own recorded high-water mark — or, when no
   * events ever occurred, an authenticated confirmation of a legitimate
   * zero-event partition. Any inconsistency (missing member, cross-partition
   * member, digest mismatch, truncated cross-check) is reported as `partial`
   * and is never eligible for certification.
   */
  async issuePartitionProof(
    counter: RegistryRecordKind,
    occurrencePeriodUtc: string,
    issuedAt: string = this.now(),
  ): Promise<RegistryPartitionProof> {
    const doc = await this.readHighWaterDoc(counter, occurrencePeriodUtc);
    if (!doc) {
      const probe = await queryAllMuninEntries(
        this.munin,
        { tags: [registryPartitionTag(counter, occurrencePeriodUtc)] },
        PARTITION_EXISTENCE_PROBE_BUDGET,
      );
      if (probe.results.length > 0 || probe.truncated) {
        return registryPartitionProofSchema.parse({
          schemaVersion: LEARNING_REGISTRY_SCHEMA_VERSION,
          counter,
          counterOwner: LEARNING_REGISTRY_COUNTER_OWNER,
          occurrencePeriodUtc,
          status: "partial",
          highWaterSeq: 0,
          members: [],
          chainDigest: EMPTY_CHAIN_DIGEST,
          issuedAt,
          partialReason: "partition high-water record is missing but tagged events were found",
        });
      }
      return registryPartitionProofSchema.parse({
        schemaVersion: LEARNING_REGISTRY_SCHEMA_VERSION,
        counter,
        counterOwner: LEARNING_REGISTRY_COUNTER_OWNER,
        occurrencePeriodUtc,
        status: "empty-confirmed",
        highWaterSeq: 0,
        members: [],
        chainDigest: EMPTY_CHAIN_DIGEST,
        issuedAt,
      });
    }
    const recompute = await this.recomputeChain(doc);
    if (!recompute.ok || recompute.chainDigest !== doc.chainDigest) {
      return registryPartitionProofSchema.parse({
        schemaVersion: LEARNING_REGISTRY_SCHEMA_VERSION,
        counter,
        counterOwner: LEARNING_REGISTRY_COUNTER_OWNER,
        occurrencePeriodUtc,
        status: "partial",
        highWaterSeq: doc.highWaterSeq,
        members: doc.members,
        chainDigest: doc.chainDigest,
        issuedAt,
        partialReason: recompute.ok
          ? "recomputed event chain digest does not match the stored high-water record"
          : recompute.reason,
      });
    }
    // The document is internally consistent — but internal consistency alone
    // cannot rule out an event that was durably written and correctly tagged
    // yet never folded into `doc.members` (see `findPartitionOrphans`). Cross
    // -check the other direction before certifying "complete".
    const knownMemberIds = new Set(doc.members.map((member) => member.eventId));
    const orphanCheck = await this.findPartitionOrphans(counter, occurrencePeriodUtc, knownMemberIds);
    if (!orphanCheck.ok) {
      return registryPartitionProofSchema.parse({
        schemaVersion: LEARNING_REGISTRY_SCHEMA_VERSION,
        counter,
        counterOwner: LEARNING_REGISTRY_COUNTER_OWNER,
        occurrencePeriodUtc,
        status: "partial",
        highWaterSeq: doc.highWaterSeq,
        members: doc.members,
        chainDigest: doc.chainDigest,
        issuedAt,
        partialReason: orphanCheck.reason,
      });
    }
    if (orphanCheck.orphanEventIds.length > 0) {
      // Keep well under the proof's 256-char partialReason cap even when
      // every event id is a full "reg-<32 hex>" string.
      const preview = orphanCheck.orphanEventIds.slice(0, 3).join(", ");
      const suffix = orphanCheck.orphanEventIds.length > 3 ? ", ..." : "";
      return registryPartitionProofSchema.parse({
        schemaVersion: LEARNING_REGISTRY_SCHEMA_VERSION,
        counter,
        counterOwner: LEARNING_REGISTRY_COUNTER_OWNER,
        occurrencePeriodUtc,
        status: "partial",
        highWaterSeq: doc.highWaterSeq,
        members: doc.members,
        chainDigest: doc.chainDigest,
        issuedAt,
        partialReason:
          `${orphanCheck.orphanEventIds.length} tagged event(s) not present in the high-water record: ${preview}${suffix}`,
      });
    }
    return registryPartitionProofSchema.parse({
      schemaVersion: LEARNING_REGISTRY_SCHEMA_VERSION,
      counter,
      counterOwner: LEARNING_REGISTRY_COUNTER_OWNER,
      occurrencePeriodUtc,
      status: "complete",
      highWaterSeq: doc.highWaterSeq,
      members: doc.members,
      chainDigest: doc.chainDigest,
      issuedAt,
    });
  }

  /**
   * Re-derive validity from the store's own current state — never from the
   * proof body alone. A hand-crafted ("forged") proof whose digest does not
   * match any real recomputed chain fails. A proof that is no longer current
   * (the partition has since advanced past it) fails when `requireCurrent`
   * is set, which is the default: a full-period view must use the
   * authoritative *current* high-water mark, not a stale earlier one.
   */
  async verifyPartitionProof(
    proof: RegistryPartitionProof,
    options: { requireCurrent?: boolean } = {},
  ): Promise<{ valid: boolean; reason?: string }> {
    const requireCurrent = options.requireCurrent ?? true;
    const parsed = registryPartitionProofSchema.parse(proof);
    if (!isEligibleForCertification(parsed)) {
      return { valid: false, reason: "a partial proof is never certifiable" };
    }
    const doc = await this.readHighWaterDoc(parsed.counter, parsed.occurrencePeriodUtc);
    if (parsed.status === "empty-confirmed") {
      if (doc) return { valid: false, reason: "partition has recorded events; empty-confirmed proof is forged or stale" };
      const probe = await queryAllMuninEntries(
        this.munin,
        { tags: [registryPartitionTag(parsed.counter, parsed.occurrencePeriodUtc)] },
        PARTITION_EXISTENCE_PROBE_BUDGET,
      );
      if (probe.results.length > 0 || probe.truncated) {
        return { valid: false, reason: "tagged events exist despite no high-water record; cannot confirm empty" };
      }
      return { valid: true };
    }
    // status === "complete"
    if (!doc) return { valid: false, reason: "no high-water record exists for this partition; proof is forged" };
    if (requireCurrent && (doc.highWaterSeq !== parsed.highWaterSeq || doc.chainDigest !== parsed.chainDigest)) {
      return { valid: false, reason: "proof does not match the partition's current high-water mark; it is stale" };
    }
    // Recompute independently from the *proof's own* claimed members — a
    // forged proof cannot borrow another partition's real chain digest.
    const asDoc = registryHighWaterDocSchema.parse({
      schemaVersion: parsed.schemaVersion,
      counter: parsed.counter,
      counterOwner: parsed.counterOwner,
      occurrencePeriodUtc: parsed.occurrencePeriodUtc,
      highWaterSeq: parsed.highWaterSeq,
      members: parsed.members,
      chainDigest: parsed.chainDigest,
      updatedAt: parsed.issuedAt,
    });
    const recompute = await this.recomputeChain(asDoc);
    if (!recompute.ok || recompute.chainDigest !== parsed.chainDigest) {
      return { valid: false, reason: recompute.ok ? "proof chain digest does not recompute from its own claimed members" : recompute.reason };
    }
    return { valid: true };
  }
}
