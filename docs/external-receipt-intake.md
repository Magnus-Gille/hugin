# External task/outcome receipt intake (#237)

**Status:** mechanism implemented (`src/external-receipt-schema.ts`,
`src/external-receipt-signing.ts`, `src/external-receipt-intake.ts`); not yet
wired into an HTTP/MCP surface. Wiring `ingestExternalReceipt` behind an actual
endpoint (and provisioning real `HUGIN_RECEIPT_PRODUCER_KEYS` for Codex CLI /
Codex App / Pi) is left to a follow-up so this change stays a self-contained,
independently testable library, matching how #232 itself shipped.

## Why

Magnus's day-to-day work is moving toward Codex App, Codex CLI, and Pi
surfaces that complete real tasks **without** ever entering Hugin's
dispatcher. Without an intake path, the durable learning registry (#232)
stays systematically incomplete and success-biased toward Hugin-managed
execution — every task Hugin never saw is invisible to the registry that is
supposed to be the durable record of what actually happened. Importing whole
chat transcripts would create weak task boundaries and unnecessary privacy
exposure, so external work instead gets an explicit, content-governed
receipt path.

This is the Hugin-side of the pair with `gille-inference#10` (the exposure-
receipt side); `grimnir#90` is the broader rollout/certification program.

## What a receipt is, and is not

A receipt is a small, versioned, content-blind fact: "surface X, capacity
principal Y, using provider/model/harness Z, observed/completed task instance
W, at time T." It is never a transcript, prompt, diff, or output. This is
enforced structurally in `src/external-receipt-schema.ts`, not just by
convention:

- Every envelope object is `.strict()` — Zod rejects any unrecognised field
  outright (e.g. a `transcript` field) rather than stripping it silently.
- Every identity/instance string is an **opaque token**
  (`externalReceiptTokenSchema` / `externalReceiptRefTokenSchema`): a bounded
  character class with no whitespace or control characters, so free text
  structurally cannot fit through an identity field either.
- The one required "independence" annotation
  (`CAPACITY_PRINCIPAL_INDEPENDENCE_NOTE`) is a fixed literal, never
  caller-supplied prose.

## Admission pipeline

`ingestExternalReceipt` (`src/external-receipt-intake.ts`) runs, in order,
each step failing closed with one of `EXTERNAL_RECEIPT_REJECTION_REASONS`:

1. **Structural + content-blindness validation.** `externalReceiptEnvelopeSchema.safeParse`.
   A failure is classified into a specific reason — `non-content-blind` for an
   unrecognised field or a free-text-shaped token, `unsupported-schema-version`
   / `unsupported-contract-version` for a version mismatch, `incomplete-envelope`
   for everything else (missing/malformed required fields) — never one opaque
   "invalid" bucket.
2. **Authenticity.** `verifyExternalReceiptSignature` (`src/external-receipt-signing.ts`)
   — an HMAC-SHA256 scheme deliberately shaped like `task-signing.ts`'s (sorted
   canonical `key=value` payload, `v1:<keyId>:<hex>` wire format, keyId must
   equal or rotation-alias the claimed `capacityPrincipal`), but with its own
   keystore (`HUGIN_RECEIPT_PRODUCER_KEYS` / `_FILE`) — a receipt producer is a
   different trust domain from a task submitter. There is no `off`/`warn`
   policy knob here: this is a brand-new authenticated-only surface, so
   verification is always mandatory. A missing, unknown, mismatched, or
   invalid signature is rejected before anything else is even considered.
3. **Reconciliation binding.** If the receipt asserts
   `instance.reconcilesHuginTaskId`, intake reads the registry's own native
   submission event at that taskId (`getEvent(taskId, deriveEventId({recordKind:
   "submission", taskId}))`) and requires it to exist with
   `payload.originComponent === "hugin"`. An unresolvable or non-native target
   is rejected (`reconciliation-target-not-found` /
   `reconciliation-target-conflict`) rather than silently grafting an import
   onto an unrelated or fabricated taskId.
4. **Idempotent mapping into #232.** See below.

## Mapping into the #232 registry — no double counting

This module never reimplements the registry mechanism; it only decides what
to feed `LearningRegistryStore`'s existing natural-key idempotent API.

- **taskId.** When no reconciliation is asserted, intake derives a stable
  external taskId deterministically from `sha256(surface, capacityPrincipal,
  taskInstanceId)`. When reconciliation *is* asserted and verified, intake
  reuses the **native** taskId instead — so a task done directly on Codex CLI
  and also dispatched through Hugin accumulates evidence under one taskId,
  never two.
- **originComponent.** `submissionEventSchema.payload.originComponent`
  (#232) was widened from `z.literal("hugin")` to
  `z.enum(["hugin", "codex_app", "codex_cli", "pi"])` — a minimal, additive,
  backward-compatible change (every existing native call site still passes
  `"hugin"`). A submission's natural key is still only `{recordKind:
  "submission", taskId}`, so an imported submission can never silently
  overwrite, or be overwritten by, a native one at the same taskId: a
  genuinely different `originComponent` claimed at an existing taskId is a
  natural-key payload conflict (`RegistryNaturalKeyConflictError`), not a
  merge.
- **Submission is written once per taskId.** Intake checks
  `getEvent(taskId, deriveEventId({recordKind:"submission", taskId}))` first.
  If a submission already exists (native, or from an earlier receipt for the
  same external task), it is left untouched — its `taskOutcomeRef` stays
  pinned to whichever receipt (or native record) actually established the
  task, so a later receipt for the same task never fights over that pointer.
- **attemptId.** Derived from `sha256(surface, capacityPrincipal,
  taskInstanceId)` with a distinct salt from the taskId derivation — stable
  across an instance's observation and outcome receipts, so both resolve to
  the same registry attempt. Attempt-reference is likewise written once per
  attemptId, on whichever receipt (observation or outcome-only) arrives first.
- **terminal-outcome** is recorded from an `outcome`-kind receipt via
  `recordTerminalOutcome`, referencing the stored receipt doc.
- **Evidence, referenced not copied.** The full validated (already
  content-blind) receipt envelope, plus intake's own server-stamped
  verification facts (`verifiedCapacityPrincipal`, `keyId`, `receivedAt`,
  `coverage`, `reconciledWithNativeTask` — see `storedExternalReceiptSchema`),
  is persisted once at a content-derived Munin key
  (`tasks/<taskId>/external-receipt-<kind>-<hash>`) and referenced from the
  registry events' `taskOutcomeRef` / `attemptStartRef` — the registry
  mechanism itself never grows a receipt-shaped payload.

## Idempotency and redelivery

A receipt's Munin doc key is content-derived from `(taskId, attemptId, kind,
receiptId)`. Redelivering the **exact same** receipt (bit-for-bit identical
except the server-stamped `receivedAt` / derived `coverage`, which
legitimately differ between two delivery attempts — mirroring
`appendRegistryEvent`'s own `recordedAt` exclusion) is a genuine no-op: the
doc write reports `duplicate`, and every downstream registry call
(`recordSubmission` / `recordAttemptReference` / `recordTerminalOutcome`)
independently resolves to `"exact-existing"` through the registry's own
create-if-absent + canonical-equality replay logic. `ingestExternalReceipt`
reports this back as `{status: "admitted", admission: "exact-existing"}`.

Reusing a `receiptId` for **different** content (a mutated redelivery under
the same id) is rejected as `receipt-id-reused-with-different-content` — the
correct fix is a fresh `receiptId`, or (for a genuine correction to already-
admitted evidence) the registry's own `writeCorrection` path.

## Coverage states — marked honestly, never silently

Every admitted receipt is inherently `"imported"` — it is never claimed as
native Hugin coverage. A terminal receipt whose `occurredAt` is more than
`EXTERNAL_RECEIPT_LATE_THRESHOLD_MS` (7 days) before intake's own
server-stamped `receivedAt` is marked `"imported-late"` instead of silently
folded in as if it had arrived promptly. An unverifiable or incomplete
receipt is never admitted at all — see the rejection reasons above; there is
no "unknown" coverage state for something that was never let in the door.

## Capacity principals are not independent model evidence

A `capacityPrincipal` (e.g. `"codex-cli-work"` vs. a second subscription
`"codex-cli-personal"`) authenticates *who is allowed to report*, not
*independent confirmation of a model's behaviour*. Two receipts from two
different capacity principals — even for what a human would call "the same
underlying task" — derive **different** taskIds/attemptIds (the derivation
includes `capacityPrincipal`), so they are never merged into one
"independently confirmed" record. Every admitted receipt additionally
carries the fixed `reviewerIndependenceNote:
"capacity-principal-not-independent-model-evidence"` literal in its stored
evidence doc, so a downstream reader can never mistake capacity-principal
plurality for reviewer independence (`quality-receipt.ts`'s actual
`reviewerIndependence: "independent" | "self" | "unknown"` concept is a
separate mechanism entirely, and imported receipts never populate it).

## Known limitation — reconciliation proves nativeness, not task identity

Reconciliation (`instance.reconcilesHuginTaskId`) verifies that the claimed
target taskId is a genuine native Hugin submission
(`payload.originComponent === "hugin"`) before honouring it. It does **not**
independently verify that the target is actually *the same underlying unit
of work* as the receipt claims — #232's native submission events carry only
`{taskOutcomeRef, originComponent}`, no `sourceTaskRef` to check the
receipt's own `instance.sourceTaskRef` against. Closing that gap would mean
growing #232's own submission schema, which is out of this module's scope
(`docs/learning-registry.md`'s stated boundary: this module consumes #232's
mechanism, it does not extend it beyond the one additive `originComponent`
widening documented above).

This is an accepted, bounded limitation, not an open vulnerability in the
threat model this repo actually operates under (a closed, single-operator
system — see `docs/security/task-signing.md`'s own framing): only a
capacity principal already holding an operator-provisioned
`HUGIN_RECEIPT_PRODUCER_KEYS` entry can attempt reconciliation at all, and a
wrong or careless reconciliation claim can only *append* an additional
attempt-reference/terminal-outcome onto an already-existing native task's
timeline — it can never fabricate, overwrite, double-count, or remove that
task's own submission or terminal state. A future tightening (e.g. binding
reconciliation to a shared `sourceTaskRef` once native submissions carry
one) is a reasonable follow-up, not a blocker for this ticket.

## Non-goals (per #237 scope)

- No raw transcript/prompt/output/diff ingestion — only opaque, bounded
  identity/reference tokens ever cross this boundary.
- No treatment of two capacity-principal subscriptions as independent
  reviewers.
- No routing or model-promotion decision is ever made from an imported
  receipt alone — this module only appends registry evidence.
