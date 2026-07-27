# Hugin-produced gille roster proposal fixtures

Producer revision: this repository's `hugin-roster-proposal-v1` serializer in
`src/autonomy/gille-roster-proposal-producer.ts` (introduced for Hugin #336).
The positive file is the exact JCS byte output of the real serializer for the
deterministic public test input; its byte SHA-256 is
`da6c86260246755688dcc0a409fa2678b869ce4a05cecd7f62fec2018651a96e`.

The adversarial manifest mechanically derives each negative case from those
exact bytes. It intentionally does not contain a hand-authored replacement
proposal. Consumers should load the positive bytes, apply one listed mutation,
and assert their own closed schema, digest, expiry, and route-principal gates.

Interop rule settled here: gille-inference checks both the `model_id` sequence
and the `alias` sequence for canonical lexical order. Hugin therefore rejects a
desired roster unless the supplied entry order satisfies both sequences; it does
not silently reorder aliases or change roster semantics.
