# Autonomy proposal receipts (W4.1)

Hugin's ADR-008 boundary is a proposal boundary, not an apply boundary. The
closed, runtime-deep-frozen versioned target registry in
`src/autonomy/proposal-receipts.ts` names the only
Hugin-owned targets that a later controller may consider: macro-routing,
prompt, harness, and Hugin tool-policy. Every receipt is still
`proposal-only`; this module contains no adapter, mutation, reload, deploy, or
promotion entry point.

The same registry explicitly names cross-owner targets for Gille and Brokkr so
they cannot be silently re-labelled as Hugin-owned. Logging, test harnesses,
models, and model configuration are protected and refused. Unknown targets are
also refused.

A receipt is closed, JCS-canonical, HMAC-signed, and contains only opaque refs,
revisions, timestamps, and SHA-256 digests. It binds the proposal identity,
experiment/evidence identities, exactly one target/axis, independently supplied
base revision/digest, candidate-content digest, expiry, and the immutable
ownership-registry version/digest. The registry itself pins the adopted Grimnir
ADR-008 constitution ID and digest rather than accepting a caller-selected
policy label. It never stores candidate configuration, prompt,
fixture, secret, or gateway response.

`storeAutonomyProposalReceipt` verifies target ownership, registry and policy
authority, expiry, current base, canonical digest, and signer before a Munin
`create_if_absent` write. An exact canonical replay is successful; a
conflicting record under the same proposal ID is rejected. Receipt persistence
does not call a configuration or deployment surface. W4.2 owns any future
R-exact journal/controller and must revalidate this receipt rather than treating
persistence as authority.
