# Durable append-only task/outcome learning registry (#232)

**Status:** mechanism, managed capture, and direct homeserver capture are
active. The authenticated Gille ledger join in
[gille-inference #61](https://github.com/Magnus-Gille/gille-inference/issues/61)
was deployed on 2026-07-22.
`src/learning-registry-schema.ts`, `src/learning-registry-store.ts`, and
`src/learning-registry-view.ts` own the append-only mechanism. The dispatcher
now writes native events for the standing managed harness sampler and, through
`src/homeserver-learning-registry-bridge.ts`, authenticated direct
homeserver/M5 attempts. The latter is deliberately restricted to
`repositoryOutcome: not-managed`; it does not grant Broker tasks a checkout or
file-edit authority.
The dispatcher first terminalizes the task and writes `result-structured`,
then resolves the held `ledgerId` through authenticated `GET /ledger/{id}`.
The returned evidence-identity hash, task ID, attempt ID, model, and task type
must all be present and match before registry writes begin. Status tag
`learning-registry:pending` is the durable retry checkpoint; idempotent replay
advances it to `learning-registry:captured`, while a permanent mismatch becomes
`learning-registry:rejected`.
External Codex/Pi receipt ingestion (#237) is now implemented on top of this
mechanism — see `docs/external-receipt-intake.md`; it widened
`submissionEventSchema.payload.originComponent` from `z.literal("hugin")` to
an enum (`"hugin" | "codex_app" | "codex_cli" | "pi"`) as its one additive
schema change here, and otherwise consumes `recordSubmission` /
`recordAttemptReference` / `recordTerminalOutcome` / `getEvent` exactly as
documented below.

## Scope boundary vs #241

Per hugin#241's 2026-07-20 "Boundary clarification" comment:

- **#232 (this module) owns the mechanism** — the append-only registry, its
  natural keys, membership evidence issued at capture, and the
  partition/high-water proof primitives, including their issuance.
- **#241 owns consumption** — period closes, monthly statements, and
  cross-owner accounting that *verify and consume* #232's proofs. It must not
  re-implement or re-issue them.

Concretely: this module never computes a monthly close, never talks to
`gille-inference`, never ingests external Codex/Pi receipts (#237), and never
packages evaluation candidates (#233). It only appends events, resolves
correction chains, and issues/verifies partition proofs that #241 will later
consume as its authoritative "is this period complete" input.

## Store choice: Munin envelopes, not SQLite

The task brief's framing ("Munin envelopes like `task-store.ts`, or SQLite
like `learning-task-store.ts`") does not match this repository: **there is no
SQLite (or other embedded database) dependency anywhere in Hugin.**
`src/learning-task-store.ts` — the "immutable artifacts" module the issue
points at — is itself Munin-backed (`createImmutableLearningArtifact` calls
`munin.write(..., create_if_absent: true)`), exactly like `src/broker/task-store.ts`.

The registry therefore uses Munin envelopes, for two reasons:

1. **It sits next to the evidence it references.** The existing durable
   LearningTask attempt rows this registry points at
   (`tasks/<taskId>/learning-attempt-<uuid>`, `-prepared`, `-replay`,
   `-outcome`, and `tasks/<taskId>/result-structured` — see
   `docs/learning-task-handshake.md`) already live in Munin under the task's
   own namespace. Registry events live at `tasks/<taskId>/reg-<hash>` in that
   same namespace, so a reader never crosses a storage boundary to join them.
2. **Munin already provides the two primitives this registry needs.**
   `create_if_absent` gives atomic idempotent-create; `expected_updated_at`
   gives compare-and-swap. Both are used throughout the existing codebase
   (`BrokerTaskStore.recordAwait`, `BrokerTaskStore.writeQualityReceipt`,
   `createImmutableLearningArtifact`). Introducing SQLite would mean a second
   persistence technology, a second backup/restore/deploy story, and a second
   set of failure modes — for no capability this registry actually needs.

## Record model

Six append-only record kinds, each content-blind (ids, digests, refs, closed
classifications — never prompt/response bytes):

| `recordKind` | Natural key | Purpose |
|---|---|---|
| `submission` | `{taskId}` | One per task: the task entered the registry. |
| `attempt-reference` | `{taskId, attemptId}` | References (never copies) the existing durable LearningTask attempt-start row. |
| `terminal-outcome` | `{taskId, attemptId}` | The attempt's closed execution outcome (`completed\|failed\|timed_out\|cancelled`) plus optional repository-outcome state. |
| `publication` | `{taskId, attemptId, publicationRef}` | A publication/label event (PR published, quality receipt, experiment product rating, ...). |
| `correction` | `{taskId, predecessorEventId}` | A new, distinctly-keyed event chained to an immutable predecessor. |
| `exclusion-adjustment` | `{taskId, targetEventId}` | Records that a target's referenced content was erased/excluded, without touching the target. |

Every event's Munin key (`eventId`, `reg-<32 hex chars>`) is **content-derived
from its natural key** (`deriveEventId` = truncated SHA-256 of the JCS
canonicalization of the natural key). This is what makes idempotency and
no-fork-on-correction structural rather than merely convention:

- Two calls describing the same natural key always target the same row.
  `create_if_absent` makes the first writer's create atomic; a racing
  duplicate gets a typed `already_exists` conflict, reads back the winner's
  bytes, and — if genuinely identical — returns the same result. A
  **different** payload at the same natural key is refused
  (`RegistryNaturalKeyConflictError`); the caller must express the change as
  a correction instead.
- A correction's own natural key is `{recordKind: "correction", taskId,
  predecessorEventId}`. At most one correction can therefore exist per
  predecessor — a second, different correction targeting the same
  predecessor collides structurally instead of silently forking the chain.
  To correct a correction, target the correction's own event id.

`recordedAt` (when the registry durably accepted the event) is intentionally
excluded from the idempotency/collision comparison: it is store-observed, not
caller-asserted, so two calls racing to persist the exact same logical fact
legitimately differ there. `appendRegistryEvent` always returns the
**actually-persisted** event (the true winner's `recordedAt`), never the
caller's locally-built candidate, so a reader is never told two different
truths for one natural key.

## Membership evidence at capture

Every event carries a `membership` object bound at capture time (see the
2026-07-19 owner-review comment on #232):

```
membership: {
  naturalKey,             // the identity above
  occurrencePeriodUtc,    // half-open UTC month, derived from occurredAt
  counter,                // == naturalKey.recordKind (Hugin-owned counters only)
  counterOwner: "hugin",
  issuedAt,                // == occurredAt — never backdated or re-derived later
}
```

`occurredAt` (when the underlying fact happened) and `recordedAt` (when the
registry accepted it) are separate fields; `occurredAt` must not be after
`recordedAt`, and `membership.issuedAt` must equal `occurredAt` exactly — a
correction cannot retroactively move an event's period, counter, or owner.

## Partition / high-water proof primitives

A per-`(counter, occurrencePeriodUtc)` high-water document tracks, as an
append-ordered list, every member event plus a running SHA-256 hash chain
over each member's canonical digest. Every `appendRegistryEvent` call updates
this document through the same bounded CAS-retry idiom already used by
`BrokerTaskStore.writeQualityReceipt` (re-read, compute next state, write with
`expected_updated_at`, retry on conflict) — concurrent writers to one
partition serialize instead of clobbering each other's membership count, and
a duplicate delivery that already appears in the document's member list is
skipped rather than double-counted.

`issuePartitionProof(counter, period)` reads that authoritative document and:

- returns `status: "complete"` only after **recomputing** the chain digest
  from the actual persisted member events (not merely trusting the document's
  own digest field) and confirming it matches;
- returns `status: "empty-confirmed"` when no high-water document exists
  *and* a bounded tag probe finds no tagged events either — a legitimate
  zero-event partition, distinguished from "haven't checked";
- returns `status: "partial"` — and therefore `isEligibleForCertification() ===
  false` — for every inconsistency: a missing document despite tagged events,
  a member event that cannot be read back, a member belonging to a different
  partition, or a recomputed digest that disagrees with the stored one.

`verifyPartitionProof` never trusts the proof body alone. It re-derives
validity from the store's current state: for `"complete"`, it requires the
proof's `highWaterSeq`/`chainDigest` to match the *current* high-water
document (this is the "stale" check — a full-period view must use the
authoritative current mark, not a claim`s frozen at some earlier point) and
independently recomputes the chain from the proof's own claimed members (this
is the "forged" check — a fabricated digest cannot borrow another partition's
real chain). A caller can pass `{ requireCurrent: false }` to ask only "was
this proof honestly derived as of its own high-water mark", which is what a
future consumer verifying a historical close would need — but the default is
`true`, matching the acceptance criterion that a full-period view is only
ever backed by the authoritative *current* high-water proof.

A `"partial"` proof is never eligible for certification, structurally: there
is no code path that lets a caller recompute a digest over whatever subset it
happened to load and have that subset accepted as `"complete"` —
`issuePartitionProof` is the only way to obtain a non-`"partial"` status, and
it always reads the authoritative document rather than caller-supplied input.

## Erasure-safe exclusion adjustments

`writeExclusionAdjustment` never deletes, mutates, or re-keys the target
event. It appends a new, separately-partitioned `exclusion-adjustment` event
recording that the target's referenced content was erased/excluded. The
target's own natural key, occurrence period, counter, and owner — and
therefore its partition membership count — are untouched. Because this
registry never stored prompt/response bytes to begin with (content-blind by
design), there is nothing to "resurrect"; the adjustment exists purely so a
downstream reader honors the upstream erasure when it later dereferences the
target's evidence refs.

## Lifecycle read view

`src/learning-registry-view.ts`'s `buildTaskLifecycleTimeline(store, taskId)`
joins one task's primary lifecycle events (submission, attempt-reference,
terminal-outcome, publication) into one chronologically ordered timeline,
resolving each to its correction-chain effective leaf and flagging exclusion
state — without removing superseded or excluded events from the underlying
audit trail (`timeline.corrections`, `timeline.exclusionAdjustments`). This is
the query #233's candidate packager and #237's ingest are expected to build
on.

## What is deliberately out of scope here

- Monthly closes, cross-owner `gille-inference` accounting, and membership
  tokens for cross-owner erasure — #241.
- Ingesting external Codex/Pi receipts — implemented in #237 as a consumer of
  this mechanism (`docs/external-receipt-intake.md`), not inside it.
- Candidate packaging/promotion — #233.
- Adding new live producer paths beyond the managed sampler and admitted
  direct homeserver bridge. Every new writer must define its authority and
  evidence bindings explicitly rather than copying another attempt's refs.
