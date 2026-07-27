# Hugin-produced Gille roster proposal v2 fixtures

`gille-roster-proposal-v2-positive.json` is a byte-pinned output of the real
`hugin-roster-proposal-v1` serializer after its Hugin-owned Ed25519 provenance
issuer signs the closed envelope. Its committed SHA-256 is
`d03d263b5f9cf6606d98fe9f1cfd85ec390eec0706dffffd80675538150dc963`.

`hugin-roster-provenance-v1-test-public.pem` is the public half of the
fixture-only issuer. No private key is stored in this repository. Hugin tests
generate an independent ephemeral issuer to exercise the real producer, while
the committed public key verifies the exact fixture signature and its pinned
bytes.

The v2 adversarial manifest applies strict JSON-Patch-subset mutations to the
byte-pinned positive artifact. Its cases cover source receipt/base, candidate,
evidence set, policy, principal, proposal-content digest, and outer signature
tampering. Gille #118 must cross-import these exact artifacts and validate
them against its pinned fixture public key before the cross-repo #117 issue can
close.

The source W4 receipt is carried as exact evidence and bound by the outer
Ed25519 envelope. The producer has no shared HMAC key, external credential
input, transport, actuator, deployment, or roster-mutation capability.
