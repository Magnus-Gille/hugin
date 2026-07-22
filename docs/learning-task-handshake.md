# LearningTaskContract v1 producer handshake

**Status:** implemented for the managed direct homeserver `/delegate` lane.
The matching Gille consumer is `gille-inference` #2. A joint live smoke is a
deployment gate, not evidence supplied by Hugin's unit tests.

Hugin is the authority for the managed task and its attempt. Gille is the
authority for the authenticated transport principal and model admission. The
v1 handshake joins those facts without treating a caller-provided JSON claim as
gateway evidence.

## Ordered lifecycle

For every direct M5 attempt Hugin:

1. computes the raw logical-task and rendered-prompt identities;
2. writes an immutable UUID-keyed attempt start under the task namespace;
3. resolves the owner key alias through authenticated `/portal/me` and fetches
   authenticated `/v1/capabilities/learning-task` evidence;
4. constructs the request stamp, writes a content-blind immutable prepared
   receipt, and writes the exact request body to a separately classified replay
   payload;
5. sends the persisted request as
   `/delegate.learningTaskStamp` with an explicit canonical task type;
6. accepts output and provenance only after validating the exact
   `learningTaskGatewayEcho`; and
7. writes the terminal admitted, not-admitted, or join-failed attempt evidence
   before publishing the task result.

The start write is awaited before either authenticated M5 read. Hugin fetches a
fresh advertisement for every attempt, so it does not rely on a capability
cache across restart or serving-epoch changes. The stamp clock is checked after
attempt start and before the advertisement expires. Gille performs its own
admission-time freshness and serving-epoch validation.

The durable records are:

- `tasks/<task-id>/learning-attempt-<uuid>` — immutable attempt start;
- `tasks/<task-id>/learning-attempt-<uuid>-replay` — separately classified,
  exact request bytes retained only for crash recovery;
- `tasks/<task-id>/learning-attempt-<uuid>-prepared` — content-blind request
  stamp plus digest/reference for the replay payload;
- `tasks/<task-id>/learning-attempt-<uuid>-outcome` — exact stamp/echo and
  admission state; and
- `tasks/<task-id>/result-structured` — canonical task outcome with the same
  learning-task evidence references.

The start, prepared, outcome, and structured-result projections contain hashes,
IDs, timestamps, classification, and contract evidence, but no prompt or
response bytes. Only the replay payload contains request bytes; it inherits the
task's classification and is not learning evidence.

## Authenticated source and transport

The source principal comes from either a verified task signature or a canonical
Broker envelope carrying Hugin's server-side HMAC attestation. The attestation
binds the authenticated Broker principal, derived task ID, exact namespace,
and exact envelope. Its domain-separated key is derived from Hugin's server-only
Munin service credential, never from the caller-held Broker bearer token. A
prose `Submitted by` value and an unattested embedded
Broker envelope are not authentication. A verified normal task signer always
wins over embedded Broker claims. Existing unattested `/delegate` tasks remain
operational on the explicit legacy/ineligible lane, but they emit no learning
stamp or evidence.

The expected transport principal is the owner alias returned by authenticated
`/portal/me`; the bearer token is never persisted. Hugin accepts the response
only when Gille's echo:

- reproduces the complete request stamp exactly;
- reports that same authenticated principal with `gateway-owner-auth`;
- carries the complete, undowngraded v1 feature set;
- has a valid admission clock; and
- has the correct JCS principal/request binding digest.

Unsupported or stale advertisements, feature downgrade, source or transport
principal substitution, missing/malformed echoes, and stamp mutation all
produce negative evidence and no accepted inference output.

## Replay boundary

Each attempt gets new UUID-derived attempt, prepared, replay, request, and
idempotency identities. On restart Hugin may send only the exact classified
replay payload with the exact persisted stamp. It accepts only Gille's durable
stored-admission response (`recovered: true`, `outcomeAvailable: false`) and its
exact authenticated echo; a fresh/full result is discarded rather than treated
as recovered output. Gille performs this exact lookup before current epoch,
quota, or GPU admission gates and never starts a second inference for a stored
admission. Conflicting joins remain rejected by authenticated principal,
idempotency key, request ID, and task/attempt pair.

Recovery first reloads the immutable attempt start and preserves its complete
Hugin task identity, including the rendered-prompt identity. One canonical join
then binds the prepared receipt to the task, attempt, start time, every evidence
reference, replay digest, raw fingerprint, complete request stamp and digest,
and any gateway echo and digest. The attempt start, prepared receipt, replay
payload, and existing outcome must all have the same classification as the task
status. Classification drift fails closed, and newly recovered attempt outcomes
plus `result-structured` retain that exact status classification.

Startup selects the newest immutable attempt start and reads only the prepared
row derived from that attempt ID; it never falls back to an older prepared
attempt. If the newest attempt stopped before prepared persistence, recovery
emits content-blind pre-dispatch failure evidence for that attempt. Even when an
outcome row already exists, Hugin reloads the classified replay, recomputes its
digest, schema-validates the stored delegate prompt, recomputes its #230
rendered-prompt fingerprint, and exact-binds the replay's complete Hugin
identity to the attempt start before considering the outcome. A malformed or
differently classified outcome, or a failed immutable outcome write, is
reported as outcome-persistence failure without an `attemptOutcomeRef`; startup
continues with the ordinary failed task result rather than pointing at an
unusable row.

After an eligible stamped request gets an ambiguous transport failure or a
non-backpressure 5xx without an authoritative echo, Hugin also makes one
immediate, short-timeout probe through this same stored-row validation path.
The probe reuses the byte-identical classified replay payload and every original
task, attempt, request, idempotency, principal, namespace, and stamp identity.
Only an authenticated exact stored-admission recovery may improve the admission
join. Missing, malformed, mismatched, unavailable, or fresh/non-recovery
responses leave the original `transport-not-admitted` evidence unchanged.
This improves evidence coverage only: the ambiguous task remains failed, and
neither the ambiguous response nor the recovery response supplies trusted task
output or provenance. Normal 429/503 backpressure never enters this probe path.

This contract does not create the learning registry, choose a model, or promote
evidence. Those remain Hugin #232 and Gille policy/capture responsibilities.

## Joint live-smoke gate

After the matching Hugin and Gille revisions are deployed, submit one
authenticated Broker `homeserver` task with an innocuous unique prompt and an
explicit canonical task type. Await the ordinary task result, then verify:

1. the start, classified replay, and content-blind prepared keys exist, and the
   start timestamp precedes the embedded stamp;
2. the prepared, outcome, and `result-structured` rows name the same task and
   attempt, and every recorded digest recomputes exactly;
3. the exact gateway echo validates and the state is `m5-admitted`;
4. the M5 admission/model clocks follow the stamp clock; and
5. learning-task attempt/admission rows and health views expose only
   IDs/digests—not the smoke prompt or response bytes. The ordinary Hugin task
   result and task log retain their existing output semantics and are outside
   this content-blind evidence projection.

Repeat once with an intentionally unsupported preflight fixture or isolated
stale advertisement in a non-production test gateway. It must create negative
attempt evidence, make no model call, and publish no accepted output. Do not
simulate downgrade or replay against the production gateway epoch.

Both halves of this procedure are committed as `scripts/learning-task-joint-smoke.ts`,
reusing the real digest/canonicalization/validation functions above rather than
reimplementing them:

- `npm run smoke:learning-task:live -- --nonce=<unique-token>` — the live
  positive smoke. Requires `HUGIN_BROKER_URL`, `HUGIN_BROKER_TOKEN`,
  `HUGIN_BROKER_SUBMITTER`, `MUNIN_URL`, and `MUNIN_API_KEY`; the nonce is
  always caller-supplied, never generated by the script. Submits the task
  against the deployed gateway, awaits the ordinary result, and checks all
  five gate points above against the durable Munin evidence. Never run in CI.
- `npm run smoke:learning-task:negative` — the negative gate. Fully local: an
  in-process loopback-only HTTP stub advertises an unsupported preflight
  (missing required feature), and the script asserts negative attempt
  evidence is created, `/delegate` is never hit, and no accepted output is
  published. CI-safe and also exercised automatically by
  `tests/learning-task-joint-smoke.test.ts` as part of `npm test`.
