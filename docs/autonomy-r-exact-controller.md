# Hugin R-exact mutation controller

Hugin owns the adapter-neutral controller for its ADR-008 `R-exact` domains:
`macro-routing`, `prompt`, `harness`, and `tool-policy`. The controller consumes
the exact Grimnir W0.2 authority vocabulary pinned by constitution digest
`sha256:836aba8abbc48e05294dac301354ec6b1aa21307b992db78202342ce29aa8dc1`.

This module does **not** arm production. It contains no production credentials,
artifact loader, target adapter, watchdog, or recovery worker. An owning
deployment must provide those capabilities separately, and W0.2 remains disarmed
until the owner completes a separate arming action.

## Authority and admission

The seven canonical Grimnir W0.2 authority schemas are vendored byte-exact and
SHA-256 pinned to the source revision recorded in
`docs/autonomy-r-exact-controller.provenance.json`. Hugin applies those closed
schemas before its cryptographic and cross-artifact semantic checks; it has no
schema overlay.

The prior v1 constitution, coverage, journal schemas, and fixtures remain
vendored as historical provenance. Hugin never shipped this controller:
PR #335 remained draft, neither its v1 code nor its policy epoch reached
`main` or deployment, and W0/W0.1 armed nothing. There are therefore no
legitimate Hugin v1 attempts to migrate or recover. New proposals and
authorities must be a complete v2 epoch; v1 admission and mixed v1/v2 bundles
fail closed, and no in-place journal migration is attempted.

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
- the signature, chain, recovery-key binding, and exact fleet coverage binding
  of every runtime narrowing entry across all seven ADR-008 domains; unrelated
  valid non-Hugin entries do not change the selected Hugin target state;
- fresh kill-switch, evidence, journal, rate-window, liveness, deadline, and
  timing facts against a protected clock;
- the exact 300-second apply/readback/verify-to-durable-watch budget, a watch
  of at least 3600 seconds derived from the durable authenticated watch
  receipt, at most 300 seconds of commit grace, a 4200-second total attempt
  deadline, separate protected attempt-interval/window predicates, and the
  900-second maximum watchdog silence;
- Grimnir's exact canonical UTC spelling: whole-second timestamps use `Z`,
  nonzero milliseconds use exactly three digits, and redundant `.000Z` is
  rejected;
- exact admission subject fields matching the signed proposal digest, base
  revision/digest, candidate digest, target scope, and evidence fingerprints.

Cross-owner targets are proposal-only. Hugin receives no credential or adapter
that can apply them.

## Durable sequence

The success path is:

`prepare → apply → verify → watch → commit`

Matching the upstream W0.2 semantics, the controller service writes `prepare`,
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
tail. Every role write also atomically advances an independently protected,
monotonic checkpoint for the exact proposal and attempt. That checkpoint binds
the current sequence and tail receipt, and permanently binds the terminal
receipt after `commit`, `disarm`, or `terminally-blocked`. Recovery requires the
signed journal tail to equal this checkpoint before acquiring a claim or
accessing the target, so an older authentic signed prefix cannot be replayed
after a later or terminal write.

`prepare` is persisted before mutation and can therefore be the one-entry
durable prefix of an attempt. Completed and recovered W0 journal envelopes have
at least two entries. Every entry is content-blind and contains only digests,
bounded references, phase facts, identities, and exact binding metadata.
Every envelope with at least two entries is also checked directly against the
canonical closed mutation-journal schema. Hugin adds no private binding fields:
owner-authorization and prepared-record correlation remain in the separately
authenticated prepared record, historical resolver, recovery descriptor, and
signed role receipt.

The authenticated `watch` write receipt is the sole time anchor from which the
minimum watch and commit-grace bounds are derived; no watch deadline is
prebound at prepare time. The controller role service replaces the caller's
proposed watch timestamp with its protected persistence time, recomputes the
entry digest, atomically persists the entry and checkpoint, and then signs the
result. The full watch therefore begins only after durable receipt. A
deployment must provide an idempotent protected-watch service that owns the
one-hour wait outside the controller process and returns an exact,
attempt-, target-, candidate-, watch-receipt-, and watchdog-bound proof of
continuous kill-switch, evidence, journal, liveness, and maximum-silence
health. A restarted controller rejoins that same protected watch and may
commit only after its proof and a new protected admission pass; an early,
late, stale, replayed, silent, or unhealthy proof enters R-exact recovery. No
in-process sleep or assumption that one controller process survives for an
hour is part of this seam.

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
authenticated historical prepared authority. When a current authority bundle
is readable, Hugin first validates its canonical schemas, artifact digests,
pinned owner key, owner signature, checkpoint, cross-artifact bindings,
recovery registry, and complete narrowing chain even on this already-safe
path. It then derives the exact target posture from that signed authority and
requires the protected posture service to agree; a still-armed binding cannot
be labeled already safe, and matching a posture-reported raw digest alone is
insufficient. If the
live authority reader itself is unavailable, the protected posture service and
the retained historical authority preserve the deliberately degraded recovery
path.

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
- a protected monotonic journal-checkpoint store that advances atomically with
  every role write and cannot regress or move past a terminal receipt;
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
