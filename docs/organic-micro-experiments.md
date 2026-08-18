# Organic micro-experiments

Hugin's owner-side seam for the [Grimnir organic micro-experiment
contract](https://github.com/Magnus-Gille/grimnir/blob/main/docs/micro-experiment-contract.md)
is intentionally a library boundary first. It does not replace the existing
harness-lane sampler, change normal routing, or authorize configuration
mutation.

## Safety boundary

The seam is default-off and content-blind. An eligible plan requires all of:

- an authenticated Hugin source identity;
- a deterministic verifier and one declared changed axis;
- distinct, owner-resolvable baseline/challenger binding references and digests;
- bounded wall-time and completion-token caps; and
- a non-recursive organic source.

The plan is frozen before baseline dispatch. Plan persistence is a bounded,
fail-open-to-baseline operation: if the artifact store is slow or unavailable,
Hugin does ordinary work and emits no experiment. A plan is create-only and its
digest covers the complete content.

The queue is bounded to one shadow and never awaits its executor. The baseline
remains the only delivered result. Hugin's live seam is narrower than the
library contract: it is enabled only for an authenticated Broker envelope whose
resolved runtime is `homeserver`, family is `one-shot`, `tool_policy.mode` is
`none`, and acceptance mode is `verifier`. Direct homeserver tasks,
Claude/Codex/free-form work, and envelopes missing any of those facts abstain.

When enabled, owner-installed binding references/digests, a challenger model,
and the deterministic oracle reference/digest are all required. Hugin freezes
and create-only persists `micro-experiment-plan` before baseline dispatch. Once
the ordinary `result-structured` commit is durable, it creates a distinct
authenticated LearningTask attempt with the challenger model and enqueues one
no-tools shadow. The caller does not await M5 inference. The content-blind
`micro-experiment-result` is also create-only under the task namespace; queue,
identity, budget, or evidence failures become `INVALID` evidence (or an
explicit abstention if no plan can be persisted). On restart, an exact-existing
plan is treated as an orphan/replay guard and is not scheduled again; after the
rerun baseline commits, Hugin writes one explicit create-only orphan `INVALID`
result bound to that baseline. The in-memory queue never resurrects a paid
shadow. A terminal result makes a duplicate replay a no-op. A future durable
runner may requeue only after adding exact M5 idempotency/admission proof.

The challenger keeps the baseline executor's exact `timeoutMs`; the experiment
adds a fixed 5-second headroom only for LearningTask preparation and
content-blind evidence persistence. Eligibility abstains when that sum would
exceed the 120-second v1 wall cap. One AbortController starts before shadow
preflight, aborts preparation/inference/evidence work at that overall deadline,
and prevents a late model call. Once model work stops, LearningTask terminal
evidence uses a separate two-second cleanup signal so an already-aborted model
signal cannot suppress the terminal receipt. A wall-budget expiry remains
`INVALID` evidence. The configured oracle digest must equal the canonical
SHA-256 digest of the actual task verifier bytes; a stale or different verifier
abstains.

The baseline route is bound twice. Before dispatch, the owner must install
`HUGIN_ORGANIC_BASELINE_MODEL` and it must exactly match the task's explicit
`Model`/gateway `modelId`. After the durable baseline result, Hugin requires the
gateway's effective `modelId` to match that same binding before enqueueing a
challenger; a missing or different effective model produces an `INVALID`
identity result and no shadow.

At startup and every bounded reconciliation interval, Hugin scans at most 200
tagged plan rows even when the organic feature is currently disabled. This lets
a restart after disabling the flag terminalize plans created by the prior
process. It validates the exact plan/result and durable terminal
`result-structured` baseline, then create-only writes one orphan `INVALID` result
for a terminal baseline whose detached shadow disappeared. Running or incomplete
baselines are deferred, malformed artifacts are reported as failed, and no M5
shadow is replayed. Preflight- or prepared-dispatch failures use the existing
model-free negative LearningTask projection before becoming invalid evidence.

## Evidence

`src/organic-micro-experiment.ts` emits the v1 plan/result shapes with the
Grimnir canonical digest algorithm. It stores only hashes, references, bounded
metrics, execution state, deterministic-oracle status, and admission identity;
prompts, inputs, outputs, and response text are not evidence fields.

Terminal results are `PASS`, `HOLD`, or `INVALID`. An unauthenticated local
observation is explicitly `diagnostic-only`; incomplete or mismatched identity
is `INVALID`. Every result says `policy_candidate: not-created`,
`primary_delivery: baseline`, and `production_mutation: none`.

The existing `harness-lane-sampler.ts` remains the owner of its separate sampled
execution lane. No aggregate promotion, policy mutation, deployment, or
production enablement is part of this seam; the feature remains off unless the
operator installs `HUGIN_ORGANIC_BASELINE_BINDING_REF/DIGEST`,
`HUGIN_ORGANIC_BASELINE_MODEL`,
`HUGIN_ORGANIC_CHALLENGER_BINDING_REF/DIGEST`,
`HUGIN_ORGANIC_CHALLENGER_MODEL`, and
`HUGIN_ORGANIC_ORACLE_ID/DIGEST`, then sets
`HUGIN_ORGANIC_MICRO_EXPERIMENT=on`.
