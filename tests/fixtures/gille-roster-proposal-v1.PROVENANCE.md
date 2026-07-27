# Hugin-produced gille roster proposal fixtures

Producer revision: this repository's `hugin-roster-proposal-v1` serializer in
`src/autonomy/gille-roster-proposal-producer.ts` (introduced for Hugin #336).
The positive file is the exact JCS byte output of the real serializer for the
deterministic public test input; its byte SHA-256 is
`da6c86260246755688dcc0a409fa2678b869ce4a05cecd7f62fec2018651a96e`.

The adversarial manifest mechanically derives each negative case from those
exact bytes using a strict JSON Patch subset: concrete `add` and `replace`
operations only. Hugin tests the manifest shape and source-byte digest, applies
every operation, rejects malformed paths and operations, and checks the concrete
derived payloads. Downstream consumers can apply the committed operations
unchanged before asserting their own ordering, identity, digest, expiry, and
route-principal gates. Cases intended to reach semantic gates carry recomputed
candidate/proposal digests; the digest-mismatch case alone deliberately does not.

Interop rule settled here: gille-inference checks both the `model_id` sequence
and the `alias` sequence for canonical lexical order. Hugin therefore rejects a
desired roster unless the supplied entry order satisfies both sequences; it does
not silently reorder aliases or change roster semantics.

The serializer runtime parses the W4 proposal receipt as a closed object and
rechecks the exact canonical ownership registry, full policy authority, signer
identity, self-digest, target, candidate, and lifetime bindings. Cryptographic
signature verification remains the upstream W4 seam's precondition: callers
must pass a receipt already accepted by `verifyAutonomyProposalReceipt`; this
serializer has no key store or generic credential access.
