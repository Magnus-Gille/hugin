# Hugin R-exact mutation controller

Hugin owns the adapter-neutral controller for its ADR-008 `R-exact` domains:
`macro-routing`, `prompt`, `harness`, and `tool-policy`. The controller consumes
the exact Grimnir W0.1 authority vocabulary pinned by constitution digest
`sha256:51efdb78c4524780919649f285862543db8b38a6a3a07894f0fad8bdab40fc6c`.

This module does **not** arm production. It contains no production credentials,
artifact loader, target adapter, watchdog, or recovery worker. An owning
deployment must provide those capabilities separately, and W0 remains disarmed
until the owner completes a separate arming action.

## Authority and admission

The seven canonical Grimnir W0.1 JSON Schemas are vendored byte-exact and
SHA-256 pinned to the source revision recorded in
`docs/autonomy-r-exact-controller.provenance.json`. Hugin applies those closed
schemas before its cryptographic and cross-artifact semantic checks; it has no
schema overlay.

Before mutation, immediately before the owner-owned replace call, and again
before commit, the controller asynchronously reads the protected authority
checkpoint and verifies:

- the pinned owner Ed25519 key and owner-signed authorization;
- exact constitution, coverage, owner-attestation, recovery-registry, and
  checkpoint bindings;
- every coverage row's constitutional levels, owner scope, owner, recovery
  class, target state, binding state, independently attested configuration
  owner, and fleet-wide non-aliasing authority identities—not only the selected
  Hugin target;
- the Hugin-owned domain and exact target scope;
- five distinct identities: owner, controller, watchdog, kill switch, and
  recovery worker;
- an owner-signed protected role-service pin set binding each writer identity
  to one independently pinned Ed25519 public-key fingerprint;
- that no signed recovery narrowing already reduced the binding to `shadow`;
- fresh kill-switch, evidence, journal, rate-window, liveness, deadline, and
  watch-window facts against a protected clock;
- the canonical one-hour maximum for both attempt deadline and watch window;
- exact admission subject fields matching the signed proposal digest, base
  revision/digest, candidate digest, target scope, and evidence fingerprints.

Cross-owner targets are proposal-only. Hugin receives no credential or adapter
that can apply them.

## Durable sequence

The success path is:

`prepare → apply → verify → watch → commit`

Matching the upstream W0.1 semantics, the controller service writes `prepare`,
`apply`, `verify`, `watch`, and `commit`; the watchdog service may write
`unknown`; and the recovery service writes `revert`, `disarm`, and
`terminally-blocked`. Each service returns a signed write receipt. The
orchestrator has only RPC-shaped service handles and public pins—not watchdog
or recovery private keys or a generic journal write credential. The
orchestrator freezes the owner-pinned role, identity, and public key at
admission, rechecks the live service binding after every asynchronous write,
and verifies the receipt with the frozen key. An in-flight key or identity
swap is therefore rejected. Every role receipt also signs the exact prepared
record digest. On restart, the journal reader's result remains untrusted until
the tail receipt is verified against the independently retained historical
role key, including action, previous tail, binding, prepared digest, and new
tail.

`prepare` is persisted before mutation and can therefore be the one-entry
durable prefix of an attempt. Completed and recovered W0 journal envelopes have
at least two entries. Every entry is content-blind and contains only digests,
bounded references, phase facts, identities, and exact binding metadata.
Every envelope with at least two entries is also checked directly against the
canonical closed mutation-journal schema. Hugin adds no private binding fields:
owner-authorization and prepared-record correlation remain in the separately
authenticated prepared record, historical resolver, recovery descriptor, and
signed role receipt.

The controller service persists `prepare` and acquires the atomic
`domain + target-scope` claim in one operation; mutation cannot begin until
both exist. This removes every half-state at that boundary: snapshot failure
leaves neither, and a service crash yields either neither or a durable prepare
with its claim. A concurrent loser receives `busy` and no journal, so it cannot
later restore an obsolete baseline over the winner. The claim is held through
terminalization. Before mutation, the orchestrator independently reads back the
exact signed prepared record and the independently resolved historical
authority, pins, keys, and role capabilities, and verifies that both are
durable. Commit rechecks exact prepared owner authority and immutable
admission fields. Authority drift, failed commit admission, ambiguous readback,
or any incomplete non-terminal attempt enters recovery instead of promotion.

## Recovery and crash reconciliation

Recovery first records `unknown`, then restores the recorded baseline and
performs exact readback. Only the separately bound recovery worker can write:

`revert → disarm`

The durable prepared record explicitly binds the signed proposal receipt,
target identity/scope, base revision/digest, snapshot ref/digest, prepared
authority, historical owner-key fingerprint, and owner-signed role pins. Its
digest is bound both into the recovery descriptor and every signed role
receipt. Recovery resolves the corresponding owner authorization, owner key,
role pins, and role public keys from a protected historical authority service;
the stored sidecar cannot nominate its own trust root. Recovery can therefore
restore after owner rotation while using the current protected authority only
for kill-switch observation and narrowing.

Apply snapshots signed pins, public keys, and role-service capabilities before
its first asynchronous boundary, then takes the owner-authority snapshot from
the protected asynchronous reader before fresh admission. Atomic prepare/claim
retains that exact historical set for the lifetime of the attempt. Recovery
therefore does not depend on today's role-service handles or keys.

Live proposal expiry and the current proposer-key registry are apply-time
admission concerns. Once `prepare` is durable, restart authenticates the raw
receipt by its exact digest inside the signed prepared record; expiry or later
proposer-key retirement—or loss of the current authority reader—cannot strand
recovery or terminal replay.

`revert` is written only after exact baseline revision and digest readback
succeed. The worker deterministically constructs the terminal `disarm` or
`terminally-blocked` entry, then signs and checkpoints narrowing bound to that
exact terminal receipt digest, domain, target, prior armed state, and recovery
identity. Only after the signed narrowing verifies may the same terminal entry
be appended. A wrong-target or prior-receipt narrowing cannot terminalize.

The worker adapter must make signed narrowing idempotent. The controller
reconciles both important crash windows:

- restore succeeded but its `revert` receipt was not written;
- signed narrowing and checkpoint succeeded but the `disarm` or
  `terminally-blocked` receipt was not written.

In the second window, restart reconstructs and appends the same deterministic
terminal receipt already named by the narrowing checkpoint before attempting
another restore or other recovery action. It never substitutes a differently
bound terminal state. Its reason comes from the authenticated durable `unknown`
entry, not a newly sampled kill-switch digest, so changing protection evidence
cannot change the precomputed receipt. The protected resolver searches
authenticated narrowing history by exact domain, target, prior state, recovery
worker, owner-authorization epoch, and terminal receipt. The returned binding
must equal the prepared historical authority except for its authenticated
`shadow` effective state. The entry need not be the global ledger tail and
remains discoverable after later unrelated narrowing, owner-epoch rotation,
global disarm, or binding removal.

If current protected coverage is globally disarmed, removed, or already
shadowed, recovery recognizes that the target is already safe and does not try
to widen or re-create the old binding. Baseline restoration still uses the
authenticated historical prepared authority.

If restore or exact readback fails, the worker records `terminally-blocked`.
There is no automatic forward retry from that state.

## Adapter contract

An owning adapter must provide:

- an exact compare-and-replace target plus snapshot/readback support;
- independently deployed controller, watchdog, and recovery role services,
  each holding only its own private key and journal capability;
- an owner-signed protected pin artifact for those three public keys;
- a protected historical-authority resolver retaining independently pinned
  owner and role public keys for every nonterminal prepared attempt;
- an asynchronous protected authority reader used immediately before fresh
  apply and commit; an in-process mutable object is not an authority source;
- a protected narrowing-history resolver bound to the expected owner epoch,
  recovery identity, prior state, domain, target, and terminal receipt;
- an atomic controller prepare/claim store that creates both or neither, holds
  the claim through terminalization, and permits reuse only after a terminal
  receipt;
- a protected-clock admission verifier;
- a recovery worker whose Ed25519 key and identity match the owner-signed
  recovery registry and whose `narrowAndVerify` call atomically persists the
  returned narrowing before it reports success;
- atomic, monotonic persistence for owner authorization and runtime-narrowing
  checkpoints.

The deployment composition root must inject RPC clients only. Recovery private
keys, owner private keys, raw journal credentials, and protected checkpoint
write credentials must remain inside their owning services and must never be
materialized in the controller process.

The exported conformance constants and tests are the compatibility surface for
other owning adapters. They are deliberately non-authorizing.
