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

Before mutation, and again immediately before the owner-owned replace call, the
controller verifies:

- the pinned owner Ed25519 key and owner-signed authorization;
- exact constitution, coverage, owner-attestation, recovery-registry, and
  checkpoint bindings;
- the Hugin-owned domain and exact target scope;
- five distinct identities: owner, controller, watchdog, kill switch, and
  recovery worker;
- that no signed recovery narrowing already reduced the binding to `shadow`;
- fresh kill-switch, evidence, journal, rate-window, liveness, deadline, and
  watch-window facts against a protected clock.

Cross-owner targets are proposal-only. Hugin receives no credential or adapter
that can apply them.

## Durable sequence

The success path is:

`prepare → apply → verify → watch → commit`

The controller writes `prepare`, `apply`, `verify`, and `commit`. The watchdog
writes `watch`. These are distinct journal capabilities, not identity labels on
one writer.

`prepare` is persisted before mutation and can therefore be the one-entry
durable prefix of an attempt. Completed and recovered W0 journal envelopes have
at least two entries. Every entry is content-blind and contains only digests,
bounded references, phase facts, identities, and exact binding metadata.

Commit rechecks current owner authority and all dynamic gates. Authority drift,
failed commit admission, ambiguous readback, or any incomplete non-terminal
attempt enters recovery instead of promotion.

## Recovery and crash reconciliation

Recovery first records `unknown`, then restores the recorded baseline and
performs exact readback. Only the separately bound recovery worker can write:

`revert → disarm`

`revert` is written only after exact baseline readback succeeds. The worker then
signs and checkpoints the exact runtime-narrowing record that binds the domain,
target, prior armed state, recovery identity, and revert receipt digest.
`disarm` is written only after that signature and checkpoint verify.

The worker adapter must make signed narrowing idempotent. The controller
reconciles both important crash windows:

- restore succeeded but its `revert` receipt was not written;
- signed narrowing and checkpoint succeeded but the `disarm` receipt was not
  written.

If restore or exact readback fails, the worker records `terminally-blocked`.
There is no automatic forward retry from that state.

## Adapter contract

An owning adapter must provide:

- an exact compare-and-replace target plus snapshot/readback support;
- three non-aliased Munin capabilities for controller, watchdog, and recovery;
- a protected-clock admission verifier;
- a recovery worker whose Ed25519 key and identity match the owner-signed
  recovery registry;
- atomic, monotonic persistence for owner authorization and runtime-narrowing
  checkpoints.

The exported conformance constants and tests are the compatibility surface for
other owning adapters. They are deliberately non-authorizing.
