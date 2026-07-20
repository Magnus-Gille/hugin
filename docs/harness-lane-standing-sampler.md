# Standing harness-lane sampler (#267)

**Status:** mechanism implemented; not yet wired into the live dispatch loop.
`src/harness-lane-sampler.ts`, `src/harness-lane-executor.ts`, and
`src/harness-lane-comparison-report.ts` are a self-contained, tested library —
same "ship the mechanism first" shape as `docs/learning-registry.md` (#232)
and `docs/external-receipt-intake.md` (#237). `runHarnessLaneSampledAttempt`
takes both lane executors as injected callbacks rather than calling any real
runtime itself, per #267's explicit instruction not to build a new executor.
Wiring real callbacks (the Broker `/delegate` one-shot path and
`src/opencode-executor.ts` / `src/learning/m5-code-loop-*` for harness) into
`src/index.ts`'s dispatch loop is deliberately left to a follow-up so this
ships as an independently testable, zero-blast-radius library — exactly like
#232 did. The env default (`0%`) means that even once wired, the lane stays
fully shadowed until a human deliberately raises it.

## Why a standing lane, not another campaign

hugin#192 was a one-off wave-5 harvest campaign: a human picked a few real
tickets and manually ran both the one-shot broker lane and the harness lane
(`code_loop` / `opencode`) on matched sub-tasks, then graded both by hand.
That produced the first real evidence that the harness lane exists at all —
but a single campaign is a snapshot. Nothing keeps sampling new evidence once
the campaign ends, so the moment the model, harness version, or task mix
shifts, the evidence goes stale and nobody notices.

This ticket turns that one-off comparison into a standing, sampled harvest:
a configurable fraction of *real*, already-happening bounded coding sub-tasks
gets *additionally* routed through the harness lane, graded with the same
discipline as the one-shot lane, and recorded into the same durable #232
registry the rest of the continuous-improvement cadence (#234 proposer, #266
scheduler) already reads. The result is a rolling, queryable comparison
instead of a dated one-time write-up.

## The three pieces

1. **`src/harness-lane-sampler.ts` — `decideHarnessLane`.** Pure, deterministic,
   side-effect-free. Given a task's natural key (`taskId` + `taskType`), decides
   `"one-shot"` or `"harness"`. No execution, no I/O, no shared state.
2. **`src/harness-lane-executor.ts` — `runHarnessLaneSampledAttempt`.** Asks the
   sampler for a lane, calls the caller-injected executor for that lane
   (`HarnessLaneExecutors.oneShot` / `.harness`), then folds the result into
   the #232 registry (`recordSubmission` → `recordAttemptReference` →
   `recordTerminalOutcome`) with harness identity attached.
3. **`src/harness-lane-comparison-report.ts` + `harness-lane-comparison-report-cli.ts`
   — `npm run report:harness-comparison`.** Read-only. Queries the registry's
   own `terminal-outcome` partition tag for the requested UTC month(s), groups
   by `(taskType, lane)`, and prints attempts / verified attempts / pass rate /
   escalation rate per cell.

## The env var

```
HUGIN_HARNESS_LANE_FRACTION=0.1   # sample 10% of ELIGIBLE tasks into harness
```

- **Absent, empty, or `"0"`** → the lane is fully OFF: every eligible task
  resolves to `"one-shot"` (today's status quo). This is the default.
- **Any other value that is not a finite number in `[0, 1]`** is a **sampler
  malfunction**, not silently treated as off or thrown at the caller:
  `decideHarnessLane` fails closed to `"one-shot"` (the safe default) and
  stamps `reason: "sampler-malfunction"` plus a `malfunctionDetail` string, so
  the misconfiguration stays visible in the #232 registry (`delegation.policyAction
  === "sampler-malfunction"`) instead of masquerading as a clean 0%.
- A digest/hash failure inside the sampler is treated identically — same
  fallback, same recorded reason.

Raising the fraction above 0 is a deliberate, reviewed decision made *after*
reading `npm run report:harness-comparison` and confirming the harness lane
clears whatever gate the operator sets for a given task type — not a default
this ticket flips on its own.

## Eligibility

Only `code-implement`, `code-edit`, and `unit-test-gen` are eligible
(`HARNESS_LANE_ELIGIBLE_TASK_TYPES`) — bounded, multi-file code-edit task
types where an agentic tool loop plausibly has something to iterate against.
hugin#192's one datapoint found the harness's only known soft spot is
import/export wiring across files, which is exactly what these types cover.
Judgment/one-shot types (`extract`, `classify`, `qa-factual`, `summarize`,
`rewrite`, `translate`, ...) are never sampled into the harness lane,
regardless of the configured fraction — a one-shot classification gives an
agentic loop nothing to inspect or edit.

## Determinism

The sampler hashes `HARNESS_LANE_SAMPLER_VERSION + taskType + taskId` (SHA-256,
first 8 hex chars → a `[0, 1)` value) and compares it against the configured
fraction. The same task always lands on the same lane, on every call, on
every process, forever — until a deliberate version bump reshuffles every
assignment on purpose. This is what makes the harvest reproducible: replaying
or re-inspecting a task can never flip its recorded lane.

## Grading discipline and harness identity

Both lanes are graded identically. `LaneAttemptOutcome` (the contract each
injected executor must resolve to) carries the same self-verify → grade shape
as the one-shot lane: a `verifierKind` (`"mechanical"` or `"none"`) and an
M5-style `verdict` (`"pass" | "partial" | "fail" | "error" | "unverified"`).

The harness identity distinguishing the lane reuses the **existing** #163
evidence-identity shape (`delegationProvenanceSchema` in
`src/task-result-schema.ts`) rather than inventing a second, competing
provenance shape. #267 adds exactly one new field to it:

```ts
lane: z.enum(["one-shot", "harness"]).optional();
```

`terminalOutcomeEventSchema.payload` (in `src/learning-registry-schema.ts`)
now optionally carries this exact shape as `delegation`. Both additions are
additive/optional, non-breaking, no schema version bump — the same pattern
every other optional field in these two files already follows.

## Fail-closed semantics

- **Sampler malfunction** (bad env, hash error) → falls back to the one-shot
  lane and is recorded as such (see above). The task still runs; nothing is
  ever aborted because the sampler broke.
- **Harness-lane failure** (the harness executor itself fails) → recorded
  *as the harness lane*, never silently rerouted into a fresh one-shot retry.
  Rerouting would double-spend the task and hide the harness failure from the
  comparison. Escalation of a failed harness attempt follows exactly the same
  path a failed one-shot attempt already follows today — this module does not
  change or duplicate that path.
- **Executor contract violation** (an injected executor rejects instead of
  resolving with a `LaneAttemptOutcome`) → `runHarnessLaneSampledAttempt`
  rethrows rather than fabricating registry evidence for work that produced
  none. An infrastructure fault is a recovery fault, not something to paper
  over with a made-up evidence ref — the same philosophy `AGENTS.md` already
  states for `finalizeTaskCompletion`.
- **No duplicate/lost tasks**: registry writes reuse the store's own
  natural-key idempotency (`taskId`/`attemptId`-derived event ids), so
  replaying the same attempt is a safe no-op — never a duplicate, never lost.

## No routing impact

The sampler and its wiring never touch `src/runtime-registry.ts`'s alias
resolution, auto-routing, or any promotion gate. Sampling a task into the
harness lane only produces **additional, side-channel evidence** for the
comparison report; it never changes which runtime actually serves the
production task. That stays true even once the fraction is raised above 0.
