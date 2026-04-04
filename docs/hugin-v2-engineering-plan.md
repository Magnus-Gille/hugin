# Hugin v2 Engineering Plan

**Source:** [hugin-v2-pipeline-orchestrator.md](/Users/magnus/repos/hugin/docs/hugin-v2-pipeline-orchestrator.md)  
**Status:** Phases 1-4 complete and live-validated; security precondition closed; Phase 5 started  
**Date:** 2026-04-04

## Goal

Ship Hugin v2 as three validated bets:

1. Workflow engine
2. Security-aware routing
3. Reusable methodology templates

Each bet must earn the next one. No later phase starts until the current gate is met on the live system.

## Guiding constraints

- Build on the existing dispatcher, lease model, Munin task schema, and Step 1 spec.
- Keep Munin as the only shared state bus.
- Preserve backwards compatibility for existing single-task submissions.
- Treat sensitivity as a hard routing constraint.
- Keep authoring markdown separate from machine-executed IR.

## Delivery plan

### Phase 1: Dependency-aware task joins

**Scope**
- Add `blocked` task lifecycle support.
- Add `depends-on:*` and `on-dep-failure:*` tag handling.
- Promote blocked continuations to `pending` when dependencies are satisfied.
- Fail blocked continuations immediately when a dependency fails and policy is `fail`.
- Add reconciliation so blocked tasks recover from dispatcher crashes between child completion and promotion.
- Expose `blocked_tasks` in heartbeat and health output.

**Code**
- [src/index.ts](/Users/magnus/repos/hugin/src/index.ts)
- [src/task-graph.ts](/Users/magnus/repos/hugin/src/task-graph.ts)
- [tests/task-graph.test.ts](/Users/magnus/repos/hugin/tests/task-graph.test.ts)

**Definition of done**
- Manual task graphs can be submitted directly to Munin.
- Continuations promote deterministically.
- Dependency failure policy behaves as specified.
- Reconciliation repairs missed promotions after restart.

**Evaluation step required**
- Yes. Run a manual three-task graph:
  1. Two child tasks and one blocked continuation.
  2. Verify continuation stays blocked until both children are terminal.
  3. Verify `on-dep-failure:fail` fails immediately on first failed dependency.
  4. Verify `on-dep-failure:continue` promotes once all dependencies are terminal.
  5. Restart Hugin between child completion and promotion to verify reconciliation.

### Phase 2: Pipeline compiler and decomposition

**Scope**
- Recognize `Runtime: pipeline`.
- Parse markdown pipeline specs into validated `PipelineIR`.
- Reject invalid graphs, unknown runtimes, cycles, and trust violations.
- Store immutable IR in `tasks/<pipeline-id>/spec`.
- Decompose pipeline phases into child tasks using Phase 1 primitives.

**Code**
- `src/pipeline-ir.ts`
- `src/pipeline-compiler.ts`
- `src/index.ts`
- new compiler tests

**Definition of done**
- One submitted pipeline task becomes a concrete set of child tasks plus immutable IR.
- Existing non-pipeline tasks remain unchanged.
- Invalid pipelines fail before any child task is created.

**Evaluation step required**
- Yes. Before building pipeline operations, validate compile/decompose behavior with one fixed four-phase pipeline using explicit runtimes only.

### Phase 3: Structured results and pipeline operations

**Scope**
- Standardize per-phase result schema.
- Add pipeline-level timeout, cancellation, and resume-from-failed-phase support.
- Add priority/preemption rules for urgent work.
- Write pipeline summary artifacts.

**Definition of done**
- Pipelines can run overnight without manual babysitting.
- Operators can cancel or resume without editing raw task state.
- Result aggregation is stable enough for later conditions.

**Evaluation step required**
- Yes. This is the Bet 1 gate rehearsal. Run the full fixed pipeline with cancellation and resume paths exercised.

### Phase 4: Human gates for side effects

**Scope**
- Add `Authority: gated`.
- Define the side-effect taxonomy.
- Represent approval requests in Munin.
- Resume gated phases after approval from Ratatoskr.
- Make side-effect retries idempotent.

**Detailed implementation plan**
- [phase4-human-gates-engineering-plan.md](/Users/magnus/repos/hugin/docs/phase4-human-gates-engineering-plan.md)

**Definition of done**
- Side-effecting phases never execute autonomously unless explicitly allowed.
- Approval and rejection are auditable in Munin.

**Evaluation step required**
- Yes. This completes the Bet 1 gate.

**Status**
- Done and live-validated. See [step4-live-evaluation.md](/Users/magnus/repos/hugin/docs/step4-live-evaluation.md).

### Bet 1 gate

Do not start routing work until all of these are true:

- One fixed, non-sensitive, four-phase pipeline runs unattended end to end.
- The pipeline is compiled to validated IR.
- Cancellation and resume both work.
- Any side-effecting phase is gated.
- The result is review-ready and materially better or faster than the current manual flow.
- Hugin records completion rate, wall-clock time, runtime choice, and manual interventions.

### Phase 5: Sensitivity classification

**Scope**
- Add `Sensitivity:` parsing to task and pipeline specs.
- Build a local rule-based classifier.
- Implement monotonic sensitivity propagation across pipeline inputs.

**Detailed implementation plan**
- [phase5-sensitivity-classification-engineering-plan.md](/Users/magnus/repos/hugin/docs/phase5-sensitivity-classification-engineering-plan.md)

**Security precondition**
- Before normal Phase 5 implementation, close the critical holes in [security-critical-holes-engineering-plan.md](/Users/magnus/repos/hugin/docs/security-critical-holes-engineering-plan.md).
- Sequence them as:
  1. remove the legacy Claude spawn executor
  2. apply outbound egress filtering
  3. start Phase 5 with context-ref classification enforcement as Step 0

**Status**
- Security precondition complete and live-validated. Phase 5 Step 0 is now implemented: shared sensitivity substrate, context-ref classification enforcement, runtime sensitivity limits, and classification-aware Munin artifact writes. See [security-critical-holes-live-evaluation.md](/Users/magnus/repos/hugin/docs/security-critical-holes-live-evaluation.md).

**Evaluation step required**
- Yes. Validate on a corpus of representative public, internal, and private tasks before enabling automatic routing.

### Phase 6: Router

**Scope**
- Add `Runtime: auto`.
- Filter by trust tier, availability, and capability.
- Rank candidates with simple deterministic rules first.
- Keep explicit runtimes as the default path.

**Evaluation step required**
- Yes. This is the Bet 2 gate: routed tasks must match or beat manually chosen runtimes with zero sensitivity violations.

### Phase 7: Methodology templates

**Scope**
- Version templates in git.
- Expand templates before submission.
- Start with a small set of fixed, high-value workflows.

**Evaluation step required**
- Yes. Only proceed if templates produce repeated value over multiple runs, not just one good demo.

## Immediate execution order

1. Implement Phase 1 in the dispatcher.
2. Evaluate Phase 1 on live manual DAGs.
3. If Phase 1 passes, implement Phase 2.
4. Stop again for compile/decompose evaluation before pipeline operations.

## Current recommendation

Bet 1 is closed and the critical pre-Phase-5 security hardening pass is now live. The next implementation target is the **remaining Phase 5 sensitivity work** beyond Step 0: broader standalone/pipeline propagation, richer artifact audit trail, and the representative corpus evaluation before any Phase 6 routing.
