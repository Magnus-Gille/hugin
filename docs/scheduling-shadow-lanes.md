# Scheduling shadow lanes and work-minute admission

**Status:** design contract; no scheduling behavior change

**Issue:** [#282](https://github.com/Magnus-Gille/hugin/issues/282)

**Champion:** complete-window deterministic FIFO

## Decision

Hugin keeps complete-window FIFO as the only enforced claim policy. Bounded
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
2. Champion and challenger see the same complete, dispatchable, group/sequence
   eligible window. A truncated window is marked incomplete and is never
   represented as a complete comparison.
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

## Why urgency is deferred

The claim loop initially sees Munin query previews. It reads and verifies the
full task only after FIFO has selected a candidate. Task signing authenticates
the exact task content, but preview fields and tags alone are not authenticated
submission metadata. Reading `Urgency: high` from every preview would therefore
let an unsigned writer poison a supposedly authenticated re-triage experiment.

Re-triage stays unavailable until one of these equivalent contracts exists:

- a principal-authenticated submission surface writes a content-blind urgency
  sidecar bound to the exact task-content digest; or
- Hugin batch-reads candidate revisions and caches successful signature
  verification by `(namespace, updated_at, content digest)` before using their
  urgency.

Unsigned or unverifiable tasks receive no authenticated urgency. They may
still run under FIFO, according to the existing signing policy, but the
re-triage challenger must abstain rather than treating them as normal priority.

## Duration-estimate contract

The first estimator uses realized terminal task evidence already present in
`result-structured`:

- `startedAt`, `completedAt`, and `durationSeconds`;
- requested and effective runtime identity;
- content-blind task type and harness/model identity when mechanically known;
- terminal outcome and failure kind, so policy can state whether failed or
  cancelled attempts belong in a particular estimator.

An estimate is a persisted, versioned value derived from a bounded historical
window. The initial implementation should use a robust statistic such as a
rolling median, require a minimum sample count, and record the history
high-water mark used to build it. Exact window length, minimum sample count,
and grouping keys are calibration parameters, not implicit constants.

Every estimate carries:

```json
{
  "seconds": 480,
  "estimatorVersion": "scheduler-duration-v1",
  "source": "verified-terminal-history",
  "sampleCount": 24,
  "historyThrough": "2026-07-22T20:00:00.000Z"
}
```

If a candidate has no eligible estimate, the bounded-SEJF comparison abstains
for that claim window. Comparing only the known-duration subset would create a
selection bias that looks like scheduler improvement.

## Shadow decision contract

After FIFO wins the task claim CAS, Hugin may persist one internal,
content-blind prediction under a unique decision identity. Prediction and
outcome should be separate create-only records so a crash cannot rewrite what
the challenger originally predicted.

Suggested storage:

- `scheduler/decisions/<decision-id>` / `prediction`
- `scheduler/decisions/<decision-id>` / `outcome`

The prediction records only safe references and aggregates:

```json
{
  "schemaVersion": 1,
  "decisionId": "<uuid>",
  "observedAt": "2026-07-22T20:00:00.000Z",
  "champion": {
    "policy": "complete-fifo-v1",
    "taskRef": { "namespace": "tasks/<id>", "key": "status" }
  },
  "challenger": {
    "policy": "bounded-sejf-v1",
    "overdueThresholdSeconds": 1800,
    "taskRef": { "namespace": "tasks/<id>", "key": "status" },
    "reason": "shortest-estimate",
    "estimateSeconds": 480
  },
  "window": {
    "eligibleTasks": 12,
    "historyComplete": true,
    "estimatedWorkMinutes": 96,
    "missingEstimates": 0
  },
  "estimatorVersion": "scheduler-duration-v1"
}
```

Allowed challenger reasons are `shortest-estimate`, `oldest-overdue`, and
`insufficient-evidence`. An abstention uses a null challenger task reference
and names the missing or incomplete evidence in a bounded enum, not free-form
task content.

When the champion task terminalizes, the outcome record adds its realized
service seconds, terminal outcome class, prediction error, and whether it was
a long job under the experiment definition. It does not claim the unrealized
duration of the challenger task. Comparisons across decisions must join later
realized outcomes by safe task reference instead of inventing counterfactual
service times.

Prometheus-style metrics may aggregate counts and duration buckets by policy
version and reason. Task IDs, decision IDs, principals, and task types with
unbounded cardinality do not become metric labels.

## Bounded-SEJF shadow algorithm

For each complete claim window:

1. Reuse the champion's dispatchability and group/sequence eligibility rules.
2. If the window is truncated or any eligible task lacks an authoritative
   estimate, emit `insufficient-evidence`.
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
The admission shadow computes:

```text
queued_work_minutes = sum(authoritative service estimates for eligible work)
```

It also records missing-estimate count, enumeration completeness, currently
running estimated remainder when available, and the capacity horizon used for
interpretation. If enumeration is truncated or estimates are missing, the
value is explicitly a lower bound and cannot support enforcement.

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

## Delivery sequence

1. **Duration evidence:** implement the versioned historical estimator and
   prediction/outcome schemas; no alternate choice yet.
2. **SEJF shadow:** add the 30-minute challenger behind
   `HUGIN_SCHEDULER_SHADOW=off` by default. Prove that toggling it cannot change
   the champion claim.
3. **Urgency authority:** add digest-bound authenticated urgency, then shadow
   low-to-normal promotion at half of the declared low-class SLA.
4. **Work-minute shadow:** publish complete/lower-bound queued work and validate
   it against realized waits.
5. **Promotion gate:** require a predeclared production experiment, complete
   evidence, zero bound violations, acceptable estimate calibration, and an
   explicit human-reviewed policy decision. The cadence may package evidence;
   it does not silently replace the scheduler.

## Required tests for executable slices

- shadow on/off produces the same claimed namespace for every queue fixture;
- complete FIFO ordering and group/sequence eligibility are reused exactly;
- 30-minute overdue choice has zero selection-rule violations;
- invalid timestamps, truncated enumeration, missing estimates, and mixed
  estimator versions abstain deterministically;
- equal estimates use numeric values and FIFO tie-breaking;
- unsigned/spoofed urgency never enters a re-triage choice;
- prediction is create-only, outcome cannot replace it, and retries are
  idempotent;
- prediction persistence failure does not fail or release the champion claim;
- persisted records and metric labels contain no task content or credentials;
- queued work is marked lower-bound whenever enumeration or estimates are
  incomplete.

## Not decided here

- estimator grouping keys and calibration thresholds;
- an urgency taxonomy or per-class SLA;
- an enforcing queue-work threshold;
- preemption of a running task;
- automatic scheduler promotion.

Those choices require production evidence from the shadow lanes this contract
defines.
