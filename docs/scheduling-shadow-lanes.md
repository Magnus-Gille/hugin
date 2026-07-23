# Scheduling shadow lanes and work-minute admission

**Status:** prediction, in-process terminal outcomes, and a live-process
runtime estimator are active; bounded-SEJF comparison is opt-in shadow only;
recovery preservation is deferred; no scheduling behavior change

**Issue:** [#282](https://github.com/Magnus-Gille/hugin/issues/282)

**Champion:** deterministic FIFO; complete enumeration normally, visible-window
FIFO during explicitly reported pagination truncation

## Decision

Hugin keeps its current deterministic FIFO selector as the only enforced claim
policy. Normal polls enumerate the complete queue. If Munin pagination reports
the exceptional same-timestamp-bucket truncation, enforcement truthfully
continues FIFO over the visible window and reports lower-bound queue health;
it does not claim that omitted rows were considered. Bounded
shortest-estimated-job-first (SEJF), urgency re-triage, and work-minute
admission begin as content-blind shadow evidence. A shadow choice must never
change which task is claimed, delay a claim, or turn missing evidence into a
guessed priority.

This follows the 2026-07-21 discrete-event study:

- complete FIFO removes the historical query-window starvation mechanism;
- bounded SEJF at a 30-minute overdue threshold improved mean slowdown by at
  least 25% in only 1 of 16 primary cells and weakened as estimate noise or
  load increased;
- low-to-normal re-triage reduced low-class waits beyond two hours while
  preserving high-class p95 in the simulated cells, but depends on trusted
  urgency;
- at or above saturation, ordering only redistributes delay. Capacity control
  must use estimated work, explicit deferral, or more capacity.

The study is evidence for experiments, not authority to enable a challenger.

## Non-negotiable invariants

1. `selectNextTask` remains the enforced selector until a separate reviewed
   promotion changes it.
2. Champion and challenger see the same visible, dispatchable,
   group/sequence-eligible rows. The challenger abstains unless both pending
   and running enumeration are complete. A truncated enforced claim is labelled
   visible-window FIFO and is never represented as a complete comparison.
3. The 30-minute SEJF bound is absolute: if any eligible task has waited at
   least 30 minutes, the shadow choice is the globally oldest overdue task,
   with the same timestamp and namespace tie-break as FIFO.
4. `Timeout` is a safety ceiling, not a duration estimate. It must not be used
   as predicted service time.
5. Prompt, response, injected context, submitter names, bearer tokens, and raw
   task content never enter scheduler observations or metric labels.
6. Self-declared urgency is untrusted. It cannot influence a shadow choice
   until Hugin has authenticated the exact task revision that supplied it.
7. Missing estimates cause an explicit abstention. They must not silently make
   unknown work look shorter, longer, or lower priority.
8. Shadow persistence is best-effort after a successful champion claim. A
   telemetry failure cannot undo, delay, or fail the claimed task.
9. A successful claim's scheduler identity and prediction digest survive every
   in-process rewrite backed by claim authority. A later recovery may preserve
   them only after validating the create-only prediction against the exact
   claim-bound digest; mutable lifecycle and lease tags are not proof.

## Why urgency is deferred

The claim loop initially sees Munin query previews. It reads and verifies the
full task only after FIFO has selected a candidate. The current v1 signature
binds task ID, submitter, submission time, runtime, prompt digest, and
context-ref digest. It does **not** bind the complete task revision or fields
such as `Urgency`, `Group`, or `Sequence`. Reading `Urgency: high` from a
preview—or merely batch-reading the full task and rechecking its v1
signature—would therefore let a writer change unsigned scheduling metadata
without invalidating the signature.

`Group` and `Sequence` already influence the champion's eligibility check
through this legacy unbound preview boundary. Shadow code must reuse that
behavior so it does not diverge from the champion, label its authority as
legacy/unbound, and must not treat it as precedent for adding another unsigned
priority field. Hardening those fields is a prerequisite for any promoted
alternate scheduler.

This hardening prerequisite is tracked in
[#295](https://github.com/Magnus-Gille/hugin/issues/295).

Re-triage stays unavailable until one of these equivalent contracts exists:

- a principal-authenticated submission surface writes a content-blind urgency,
  group, and sequence sidecar bound to the exact task-revision digest; or
- a versioned signing contract binds the full canonical task revision (or
  explicitly binds every scheduling field) and Hugin verifies that version
  before using the fields.

Unsigned or unverifiable tasks receive no authenticated urgency. They may
still run under FIFO, according to the existing signing policy, but the
re-triage challenger must abstain rather than treating them as normal priority.

## Duration-estimate contract

Current `result-structured.durationSeconds` is executor-span evidence. It
starts after some claim-time preparation and ends before delivery,
publication, learning capture, dependent promotion, and pipeline refresh. The
current result also has one `runtime` field rather than a reliable general
requested/effective pair, and has no general structured failure-kind field.
It must not be presented as authoritative single-dispatcher service time or be
used for work-minute admission.

The first executable estimator slice therefore adds a scheduler-service clock
whose interval is the successful claim CAS through release of `currentTask`
after all synchronous task post-processing. It includes checkout and
preflight, executor time, delivery/publication handling, learning capture,
dependent promotion, pipeline refresh, and other work that prevents the
single poller from claiming its next task. The shadow outcome records:

- `claimedAt`, `releasedAt`, and `schedulerServiceSeconds`;
- requested runtime captured at claim and effective runtime captured at
  terminalization;
- content-blind task type and harness/model identity when mechanically known;
- a bounded scheduler terminal class derived explicitly for this schema; and
- whether the service clock is complete.

The initial estimator trains on every terminal attempt with a complete
scheduler-service clock and mechanically known grouping identity, including
successful, failed, timed-out, and cleanly cancelled attempts. Terminal class
is retained for calibration and stratified reporting but cannot filter the
estimate based on an outcome unknown at claim time. Otherwise a class that
succeeds quickly but often times out would look artificially cheap.

Only genuinely incomplete clocks—such as a crash where the exact release
boundary cannot be recovered—are censored or excluded with a bounded reason.
Recovered tasks with a mechanically proven complete clock remain eligible;
recovery alone is not an exclusion. The old executor-span `durationSeconds`
may be compared during calibration but never substituted for the new service
clock.

An estimate is a versioned value derived from a bounded historical window. The
initial executable calibration groups by requested dispatcher runtime (the
only identity mechanically known for every candidate before claim), uses a
rolling numeric median over the newest 24 complete outcomes, requires three
samples, and records the history
high-water tuple used to build it. Equal release timestamps are ordered by the
content-blind decision UUID; repeated identical outcomes are counted once and
conflicting outcomes under one UUID fail closed. These grouping and window
values are explicit calibration parameters, not a scheduler-promotion claim.

Every estimate carries:

```json
{
  "seconds": 480,
  "estimatorVersion": "scheduler-duration-v1",
  "serviceClock": "claim-to-release-v1",
  "source": "verified-terminal-history",
  "sampleCount": 24,
  "historyThrough": "2026-07-22T20:00:00.000Z",
  "historyThroughDecisionId": "12953e2e-dfb0-44eb-abda-2725d12fa2fa"
}
```

If a candidate has no eligible estimate, the bounded-SEJF comparison abstains
for that claim window. Comparing only the known-duration subset would create a
selection bias that looks like scheduler improvement.

## Shadow decision contract

Before attempting the task claim CAS, Hugin generates a decision UUID, builds
the complete schema-valid prediction (including an abstention), and hashes its
JCS-canonical bytes. It removes caller-supplied `scheduler-decision:*` and
`scheduler-prediction-sha256:*` tags, then includes its own
`scheduler-decision:<uuid>` and `scheduler-prediction-sha256:<digest>` tags in
the claim write. The UUID and digest become authoritative only if that CAS
succeeds. Because the winning claim and pointer are one Munin mutation,
restart recovery can reuse the same identity and validate any stored
prediction against the claim-bound digest instead of inventing a second
prediction for the claim.

The implementation must register both scheduler tag prefixes as conditionally
persistent status tags and carry the winning claim tags—not the pre-claim entry
tags—into lease renewal. In-process delivery checkpoints and terminalization
may preserve the pointer from that authoritative snapshot. Reclaim and later
recovery must first validate the create-only prediction and its digest; until
that validation is wired, they strip any pointer rather than promoting mutable
status metadata. Keeping the content-blind pointer after terminal outcome
persistence is acceptable; it must not become a metric label.

After FIFO wins the CAS, Hugin may persist one internal, content-blind
prediction under that durable decision identity. Prediction and outcome are
separate `create_if_absent` records so a crash cannot rewrite what the
challenger originally predicted. An existing record is reusable only when its
schema-valid JCS digest matches the winning claim tag; a different payload at
the same identity is a conflict, never an update. After a restart, a missing
prediction remains explicitly missing because the original queue snapshot
cannot be reconstructed; recovery must not generate a new prediction from the
later queue state.

The first live shadow slice attempts to persist an explicit `estimate-missing`
abstention for each accepted claim because no production duration estimator
is active yet. Evidence construction fails open to an unmodified FIFO claim
with caller pointer tags stripped. Eligible-window collection uses indexed
per-group minimum sequences rather than a nested scan. A dedicated Munin client
and fire-and-forget write ensure evidence latency cannot enter the
claim-to-execution critical path.

An outcome enters estimator memory only after the complete authenticated chain
has been persisted or re-verified. The live writer serializes prediction,
claim attestation, outcome, and outcome attestation on the isolated telemetry
client. A crash between any two writes leaves an incomplete chain; it is never
reconstructed from later state and is excluded after restart. Every record is
`create_if_absent`; an exact JCS replay is reusable, while conflicting content
is rejected.

At startup Hugin reads at most the newest 24 outcome-attestation candidates per
requested runtime. It admits a candidate only when all four immutable evidence
rows exist, both domain-separated MACs verify, the prediction and outcome share
the attested decision/task identity, the outcome claim boundary equals the
attested successful-CAS timestamp, and the current exact
`result-structured` revision and raw SHA-256 still match the terminal binding.
The task status content must also still hash to the content bound by the claim
attestation. Missing rows, tag/runtime mismatch, malformed schemas, stale
terminal revisions, and MAC or digest conflicts fail closed for that sample.
The cache retains at most the 24 newest complete verified outcomes per
requested runtime and still abstains until three samples exist.

### Authenticated claim/outcome chain

The first provenance primitive uses the dispatcher-only
`HUGIN_SENSITIVITY_CHECKPOINT_SECRET` through separate domain-derived HMAC
keys; scheduler MACs cannot be replayed as sensitivity checkpoints, claim MACs,
or outcome MACs across protocols. No task content enters the attestation.

The versioned claim attestation binds:

- decision UUID, safe task reference, and SHA-256 of the exact task content;
- the claim CAS precondition revision and Munin's successful claim
  acknowledgement timestamp;
- the exact prediction SHA-256 already attached to that claim;
- worker and process-instance identity.

The versioned outcome attestation then binds the exact JCS outcome digest and
terminal-result revision/hash to the full authenticated claim-attestation
digest. Both use constant-time MAC comparison, reject weak secrets, and fail
closed on malformed or changed fields. This chain lets the bounded history
reader distinguish Hugin-authored samples from arbitrary create-only rows
without storing task content in scheduler telemetry.

The primitive alone does **not** prove that a mutable current status row is a
continuous descendant of an older claim. Recovery therefore continues to
strip scheduler pointers. Verified terminal-history hydration does not grant
recovery authority: it authenticates a completed evidence chain, while pointer
preservation requires a separate proof that every mutable status transition
descends continuously from the successful claim.

`HUGIN_SCHEDULER_SHADOW=on` enables challenger computation. It defaults to
`off`; the disabled state persists a bounded `shadow-disabled` abstention.
Whether enabled or disabled, `eligibleTasks[0]` remains the exact FIFO claim
candidate selected before evidence construction, and evidence failure falls
open only to that same candidate with caller scheduler pointers stripped.

Startup, lease-reaper, and interrupted-delivery recovery continue to strip the
pointer. Schema and digest validation proves content integrity but not that the
first writer was Hugin or that the pointer came from the successful claim CAS.
Recovery preservation therefore still requires proof of continuous
current-status descent; the authenticated terminal history described above is
not sufficient authority.

For a terminal result written by the live in-process claim owner, Hugin retains
the exact serialized `result-structured` SHA-256 and Munin revision returned by
that successful write. After synchronous delivery/publication, learning
capture, dependent promotion, pipeline refresh, quota sampling, and invocation
journaling finish, Hugin records the release boundary, clears `currentTask`, and
queues a create-only outcome on the same isolated telemetry client. The outcome
write is therefore outside the dispatch critical path. If Munin did not return
the exact claim-CAS timestamp, the outcome records an incomplete
`claim-boundary-unavailable` clock instead of borrowing the older pending
timestamp. A release timestamp preceding the claim timestamp is likewise
incomplete rather than coerced. The initial `longJob` threshold is the same
explicit 1,800-second bound used by the shadow overdue policy.

Prediction and outcome use separate retry comparisons. A prediction retry
must match the claim-bound prediction digest. An outcome is deterministically
derived from the same decision ID plus the exact terminal
`result-structured` revision and SHA-256 used for its terminal class and
service-clock evidence. An outcome retry reads the create-only record and
compares its full JCS digest and terminal-result binding with that expected
outcome; it does not compare outcome bytes with the prediction digest.

Suggested storage:

- `scheduler/decisions/<decision-id>` / `prediction`
- `scheduler/decisions/<decision-id>` / `outcome`

The prediction records only safe references and aggregates:

`champion.policy` is `complete-fifo-v1` only when both enumerations were
complete. It is `visible-window-fifo-v1` when enforcement proceeded through a
reported truncation; that case always carries an abstaining challenger.

```json
{
  "schemaVersion": 1,
  "decisionId": "<uuid>",
  "observedAt": "2026-07-22T20:00:00.000Z",
  "champion": {
    "policy": "complete-fifo-v1",
    "taskRef": { "namespace": "tasks/<id>", "key": "status" },
    "serviceEstimate": {
      "seconds": 720,
      "estimatorVersion": "scheduler-duration-v1",
      "serviceClock": "claim-to-release-v1",
      "source": "verified-terminal-history",
      "sampleCount": 24,
      "historyThrough": "2026-07-22T20:00:00.000Z",
      "historyThroughDecisionId": "12953e2e-dfb0-44eb-abda-2725d12fa2fa"
    }
  },
  "challenger": {
    "policy": "bounded-sejf-v1",
    "overdueThresholdSeconds": 1800,
    "taskRef": { "namespace": "tasks/<id>", "key": "status" },
    "reason": "shortest-estimate",
    "serviceEstimate": {
      "seconds": 480,
      "estimatorVersion": "scheduler-duration-v1",
      "serviceClock": "claim-to-release-v1",
      "source": "verified-terminal-history",
      "sampleCount": 24,
      "historyThrough": "2026-07-22T20:00:00.000Z",
      "historyThroughDecisionId": "12953e2e-dfb0-44eb-abda-2725d12fa2fa"
    }
  },
  "window": {
    "eligibleTasks": 12,
    "pendingEnumerationComplete": true,
    "runningEnumerationComplete": true,
    "eligibilityAuthority": "legacy-unbound-group-sequence",
    "estimatedWorkMinutes": 96,
    "missingEstimates": 0
  },
  "estimatorVersion": "scheduler-duration-v1"
}
```

Allowed challenger reasons are `shortest-estimate`, `oldest-overdue`, and
`insufficient-evidence`. An abstention uses a null challenger task reference
and one or more bounded evidence reasons such as `window-truncated`,
`estimate-missing`, `estimator-version-mismatch`,
`candidate-timestamp-invalid`, or `shadow-disabled`, never free-form task
content.

When the champion task terminalizes, the outcome record adds its realized
service seconds, terminal outcome class, and whether it was a long job under
the experiment definition. Prediction error is computed only against the
champion estimate persisted in the same prediction record and is null when
that estimate is absent. It never compares the challenger's estimate with the
champion's duration and never recomputes an old estimate using a newer history
window. The record does not claim the unrealized duration of the challenger
task. Comparisons across decisions must join later realized outcomes by safe
task reference instead of inventing counterfactual service times.

Prometheus-style metrics may aggregate counts and duration buckets by policy
version and reason. Task IDs, decision IDs, principals, and task types with
unbounded cardinality do not become metric labels.

## Bounded-SEJF shadow algorithm

For each complete claim window:

1. Reuse the champion's dispatchability and group/sequence eligibility rules.
2. Select one estimator version for the decision. If pending or running
   enumeration is truncated, any eligible task lacks an authoritative
   estimate, or any estimate has an unknown or different version, emit
   `insufficient-evidence` with the applicable bounded reason.
3. If one or more eligible tasks have waited at least 30 minutes, choose the
   oldest overdue task by FIFO ordering.
4. Otherwise choose the smallest estimated service time; break equal estimates
   by FIFO ordering.
5. Assert and count overdue-bound violations. Any nonzero count invalidates the
   experiment implementation rather than becoming a performance trade-off.

This algorithm is shadow-only. It does not introduce a new task metadata field
or caller-controlled duration estimate.

## Work-minute admission design

Queue depth remains useful operational context but is not a capacity measure.
The admission shadow computes separate work buckets rather than calling only
currently dispatchable work the whole backlog:

```text
dispatchable_work_minutes
group_blocked_work_minutes
pipeline_blocked_work_minutes
approval_gated_work_minutes
other_nonterminal_work_minutes
running_remaining_work_minutes
possible_total_work_minutes = sum(one estimate per distinct task ref in the bucket union)
```

Every bucket records task count, missing-estimate count, and enumeration
completeness. Higher-sequence siblings and other accepted nonterminal work are
therefore visible even though `selectNextTask` correctly excludes them from
the immediate eligible set. If a category cannot be enumerated, enumeration
is truncated, estimates are missing, or running remainder is unavailable, the
affected bucket and possible total are explicitly incomplete/lower-bound and
cannot support enforcement. `dispatchable_work_minutes` alone is never named
or used as total admitted load.

Bucket memberships may overlap for diagnostics: for example, one task can be
both group-blocked and approval-gated. `possible_total_work_minutes` is
therefore computed from the deduplicated union of safe task references, using
at most one authoritative estimate per task—not by arithmetically adding the
displayed bucket totals. Conflicting estimates for the same task make the
total incomplete instead of choosing one silently.

The first stage only reports workload bands and compares them with observed
wait and throughput. A later enforcing policy must define, in a separate PR:

- which authenticated submitters and task classes may be deferred or refused;
- the work-minute threshold, capacity horizon, and hysteresis;
- a durable deferral/retry state rather than hidden queue delay or task loss;
- behavior for required, grouped, pipeline, approval-gated, and delivery work;
- overload recovery, operator override, and rollback;
- proof that classification and sensitivity cannot be downgraded by admission.

No ordering policy is promoted as an overload fix. When offered work exceeds
capacity, Hugin must say so truthfully.

### Executable workload snapshot primitive

`src/scheduler-workload.ts` now defines the strict, behavior-neutral
`schedulerWorkloadSnapshotSchema` and pure
`buildSchedulerWorkloadSnapshot(...)` builder. It does not query Munin, write
evidence, defer a task, reject a task, or influence the claim candidate.

The version-1 snapshot contains only aggregate summaries. This abbreviated
example omits the other five required bucket members for readability:

```json
{
  "schemaVersion": 1,
  "observedAt": "2026-07-23T08:00:00.000Z",
  "estimatorVersion": "scheduler-duration-v1",
  "buckets": {
    "dispatchable": {
      "taskCount": 4,
      "knownWorkMinutes": 18,
      "estimatedWorkMinutes": null,
      "missingEstimates": 1,
      "enumerationComplete": true
    }
  },
  "possibleTotalWork": {
    "taskCount": 11,
    "knownWorkMinutes": 67,
    "estimatedWorkMinutes": null,
    "missingEstimates": 2,
    "enumerationComplete": false
  }
}
```

All six bucket keys are always present in a schema-valid record. A bucket's
`knownWorkMinutes` is the subtotal from available nonnegative estimates.
`estimatedWorkMinutes` is present only when enumeration is complete and every
distinct task in that summary has usable evidence. Otherwise it is null; zero
is never used to disguise missing work. `possibleTotalWork` has the same rule
and requires every bucket enumeration to be complete.

The builder accepts safe task references only as transient deduplication
identities; task references and task content are absent from its aggregate
output. Overlapping diagnostic membership remains visible in each bucket, but
the possible total counts one contribution per distinct task. Exact duplicate
evidence is reusable. Conflicting estimates or running clocks for one task
invalidate that task's contribution everywhere instead of selecting a value.
An estimate whose history looks ahead past `observedAt` is missing evidence.
For a running task, the contribution is
`max(estimate.seconds - runningElapsedSeconds, 0)`; without a valid elapsed
clock the running contribution is missing.

A later live-shadow wiring slice must prove these inputs rather than infer
them from mutable previews:

- complete pagination for every included lifecycle bucket;
- bucket membership from the canonical status/lifecycle contract;
- one verified estimator version selected for the observation;
- running elapsed time derived from an authenticated claim boundary;
- explicit incompleteness when a lifecycle category or classification cannot
  be enumerated safely.

The aggregate snapshot is not an admission verdict. It intentionally has no
threshold, capacity horizon, submitter exception, deferral state, rejection
reason, or override field. Those belong to a separately reviewed enforcing
policy only after live workload observations are calibrated.

## Delivery sequence

1. **Duration evidence:** implement the versioned historical estimator and
   prediction/outcome schemas; no alternate choice yet.
2. **SEJF shadow:** the 30-minute challenger is implemented behind
   `HUGIN_SCHEDULER_SHADOW=off` by default. Toggling it cannot change the
   champion claim; it needs production observation and calibration before this
   delivery step is complete.
3. **Urgency authority:** add digest-bound authenticated urgency, then shadow
   low-to-normal promotion at half of the declared low-class SLA.
4. **Work-minute shadow:** the strict aggregate primitive is implemented but
   not live-wired. Next publish complete/known-subtotal queued work from
   bounded enumerations and validate it against realized waits.
5. **Promotion gate:** require a predeclared production experiment, complete
   evidence, zero bound violations, acceptable estimate calibration, and an
   explicit human-reviewed policy decision. The cadence may package evidence;
   it does not silently replace the scheduler.

## Required tests for executable slices

- shadow on/off produces the same claimed namespace for every queue fixture;
- deterministic FIFO ordering and group/sequence eligibility are reused
  exactly, with complete versus visible-window policy labelled honestly;
- 30-minute overdue choice has zero selection-rule violations;
- invalid timestamps, truncated enumeration, missing estimates, and mixed
  estimator versions abstain deterministically;
- equal estimates use numeric values and FIFO tie-breaking;
- unsigned/spoofed urgency never enters a re-triage choice;
- the successful claim CAS carries one dispatcher-owned decision identity;
  caller-supplied decision tags are removed, prediction is create-only,
  outcome cannot replace it, restart retries reuse only exact records, and a
  crash gap never creates a prediction from a later queue snapshot;
- scheduler pointers survive lease renewal, reclaim, delivery, terminal, and
  recovery tag transforms; prediction and outcome retries use their distinct
  exact digest/binding rules;
- prediction persistence failure does not fail or release the champion claim;
- persisted records and metric labels contain no task content or credentials;
- each nonterminal work bucket and the possible total are marked
  incomplete/lower-bound whenever enumeration, estimates, classification, or
  running remainder are incomplete.
- a multiply blocked task may appear in multiple diagnostic buckets but is
  counted exactly once in the deduplicated possible total.

## Not decided here

- estimator grouping keys and calibration thresholds;
- an urgency taxonomy or per-class SLA;
- an enforcing queue-work threshold;
- preemption of a running task;
- automatic scheduler promotion.

Those choices require production evidence from the shadow lanes this contract
defines.
