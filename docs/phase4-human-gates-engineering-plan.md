# Phase 4 Engineering Plan: Human Gates for Side Effects

**Parent plan:** [hugin-v2-engineering-plan.md](/Users/magnus/repos/hugin/docs/hugin-v2-engineering-plan.md)  
**Status:** Implemented and live-validated (see STATUS.md)  
**Date:** 2026-04-04

## Goal

Close Bet 1 by making side-effecting pipeline phases pause for explicit human approval instead of executing autonomously.

Phase 4 must add a concrete approval protocol on top of the current validated workflow engine:

- pipelines already compile to immutable `spec`
- child phases already have structured results
- parents already support cancellation, resume, and summary reconciliation

The Phase 4 implementation should reuse those primitives instead of inventing a parallel workflow.

## Non-goals

- No sensitivity classification or runtime routing. That starts in Phases 5-6.
- No generalized human-in-the-loop editing workflow. This is approval/rejection only.
- No new side-effect execution engine. Gated phases still run through the existing runtime dispatch path after approval.
- No support for gated standalone tasks in the first pass. Scope is pipeline phases.

## Current baseline

The current system already has most of the substrate needed for Phase 4:

- `src/pipeline-ir.ts` already defines `authority: "autonomous" | "gated"` in `PipelinePhaseIR`.
- `src/pipeline-compiler.ts` currently rejects `Authority: gated` with a deferred-until-Step-4 error.
- `src/pipeline-dispatch.ts` already owns parent compile/decompose semantics.
- `src/pipeline-control.ts` already owns pipeline cancellation and resume semantics.
- `src/pipeline-summary.ts` and `src/pipeline-summary-manager.ts` already compute and refresh pipeline state from child task lifecycle plus structured results.

The missing piece is a stable way to stop before execution, request approval, and then continue or fail in a way that remains auditable in Munin.

## Design decisions

### 1. Authority is compiler-validated, not inferred at execution time

`Authority: gated` remains an explicit field in the pipeline spec and child task content. Hugin should not try to guess whether a phase is side-effecting from prompt text at runtime.

The compiler is responsible for validating:

- `Authority: autonomous` is allowed for non-side-effecting phases.
- Side-effecting phase types must declare `Authority: gated`.
- `Authority: gated` is now accepted instead of rejected.

### 2. Human approval is represented as task state in Munin

Approval must be auditable and resumable from the shared state bus, not hidden in Ratatoskr logs or local process memory.

The first-pass model:

- the phase task stays in Munin under its normal namespace
- the phase lifecycle becomes `awaiting-approval` instead of `pending`
- a separate immutable approval-request artifact is written under the phase namespace
- Ratatoskr writes an approval decision artifact back into the same namespace
- Hugin promotes the phase from `awaiting-approval` to `pending` after approval, or to `failed` after rejection

This keeps the approval loop local to the phase task and avoids introducing a second coordination namespace for the first iteration.

### 3. Approval is phase-level, not parent-level

The parent pipeline stays active while a phase is waiting for approval. The gated child phase is the unit that pauses and later resumes.

Why:

- the existing DAG model already reasons about blocked/pending/running/terminal child phases
- approval is needed for one concrete side effect, not for the entire pipeline
- phase-level gating composes cleanly with existing cancellation and resume logic

### 4. Rejection is terminal failure, not cancellation

If Magnus rejects a gated phase, that phase becomes `failed` with a structured rejection result. Downstream phases then follow normal dependency failure semantics (`fail` or `continue`).

This keeps rejection behavior aligned with the existing task-graph model.

### 5. Idempotency is phase-instance based in the first pass

The first implementation should not attempt universal deduplication of arbitrary side effects. Instead, it should guarantee:

- one approval decision applies to one pipeline phase task id
- once approved, Hugin executes that phase at most once per phase task id unless a deliberate resume/reset creates a new execution attempt
- repeated approval writes for the same approved phase are harmless

For side effects that have a natural operation key, Phase 4 should also leave a machine-readable `operationKey` field in structured artifacts so later phases can harden idempotency without redesigning the protocol.

## Side-effect taxonomy

Phase 4 needs a typed list because “side effect” cannot remain a prompt-level social convention.

### First-pass side-effect classes

- `git.push`
- `git.merge`
- `github.pr.create`
- `github.pr.merge`
- `deploy.service`
- `message.telegram.send`
- `message.email.send`
- `file.write.outside_workspace`

### First-pass non-side-effect classes

- research
- analysis
- summarization
- code changes in local working tree
- test execution
- read-only GitHub inspection
- pipeline compilation/decomposition

### Representation

Each pipeline phase gets a new optional IR field:

- `sideEffects: string[]`

Rules:

- empty or omitted means non-side-effecting
- non-empty means side-effecting and therefore `authority` must be `gated`
- unknown side-effect ids are rejected at compile time

This is intentionally explicit and conservative. Later versions can infer defaults from templates or runtime capabilities, but Phase 4 should start with declared side effects.

## Munin data model

### Phase task status tags

Add one new non-terminal lifecycle tag:

- `awaiting-approval`

Phase tags while waiting:

- `awaiting-approval`
- `runtime:<...>`
- `type:pipeline`
- `type:pipeline-phase`
- `authority:gated`
- `pipeline:<pipeline-id>`
- `phase:<phase-slug>`
- existing `type:*` carry-through tags

The task must not also carry `pending` while waiting for approval.

### Phase approval-request artifact

Key:

- `tasks/<phase-task-id>/approval-request`

Suggested JSON shape:

```json
{
  "schemaVersion": 1,
  "pipelineId": "20260404-example",
  "phaseName": "deploy",
  "phaseTaskId": "20260404-example-deploy",
  "authority": "gated",
  "sideEffects": ["deploy.service"],
  "status": "pending",
  "requestedAt": "2026-04-04T08:00:00Z",
  "requestedByWorker": "hugin-huginmunin-123456",
  "replyTo": "telegram:1234",
  "replyFormat": "summary",
  "summary": {
    "runtime": "claude-sdk",
    "context": "repo:hugin",
    "promptPreview": "Deploy the reviewed change to huginmunin...",
    "dependencyTaskIds": ["..."]
  }
}
```

This artifact is immutable for the first pass. Later decision state lives in a separate artifact.

### Phase approval-decision artifact

Key:

- `tasks/<phase-task-id>/approval-decision`

Suggested JSON shape:

```json
{
  "schemaVersion": 1,
  "pipelineId": "20260404-example",
  "phaseTaskId": "20260404-example-deploy",
  "decision": "approved",
  "decidedAt": "2026-04-04T08:05:00Z",
  "decidedBy": "magnus",
  "source": "ratatoskr",
  "comment": "Looks good"
}
```

Allowed decisions:

- `approved`
- `rejected`

Ratatoskr is the expected writer, but Hugin should only rely on the artifact shape, not on Telegram-specific details.

### Structured result extensions

When a gated phase is rejected or approved/executed, `result-structured` should expose:

- `authority`
- `sideEffects`
- `approvalStatus`
- `approvalRequestedAt`
- `approvalDecidedAt`
- `approvalDecisionSource`
- optional `operationKey`

This gives Phase 4 auditable outputs and gives later routing/template work something structured to build on.

## Dispatcher behavior

### A. Compile/decompose

Update `src/pipeline-compiler.ts` and `src/pipeline-ir.ts` to:

- parse `Authority:` as today
- parse new `Side-effects:` field at phase level
- stop rejecting `Authority: gated`
- validate:
  - gated phases must declare at least one side effect
  - autonomous phases must declare none
  - unknown side-effect ids fail compile

Child phase drafts should carry:

- `Authority: gated|autonomous`
- `Side-effects: ...`

### B. Claim loop and gating

When the dispatcher encounters a phase task whose effective authority is `gated`:

1. Do not send it to the runtime executor.
2. If no approval request exists yet:
   - write `approval-request`
   - transition `status` from `pending` to `awaiting-approval`
   - log the gate request
   - refresh parent summary
3. If `approval-request` exists and there is no decision yet:
   - leave it in `awaiting-approval`
   - do not re-notify on every poll
4. If `approval-decision` is `approved`:
   - atomically transition `awaiting-approval` back to `pending`
   - log approval
   - clear any in-memory dedupe for this gate
   - allow normal claim/execution on the next poll
5. If `approval-decision` is `rejected`:
   - mark the phase `failed`
   - write markdown `result`
   - write `result-structured`
   - refresh parent summary

### C. Summary behavior

`src/pipeline-summary.ts` should add one new non-terminal phase lifecycle:

- `awaiting_approval`

Parent `summary.executionState` should surface this distinctly when no phase is running and at least one phase is awaiting approval, for example:

- `awaiting_approval`

This matters because operators need to distinguish “pipeline is blocked on dependencies” from “pipeline is paused for a human decision.”

### D. Cancellation and resume interaction

Phase 4 must define explicit behavior for the existing control paths:

- cancelling a pipeline with a phase in `awaiting-approval` cancels that phase without executing it
- resuming a cancelled pipeline should recreate the approval wait for any gated phase that has not already been approved
- an existing approval decision for a previously cancelled phase must not silently auto-apply after resume unless it still matches the same phase task id and attempt

First-pass rule:

- approvals are bound to the current phase task id
- a resumed phase that keeps the same task id may reuse its decision
- a resumed phase that gets reset to a new attempt must require a new decision

If the current resume model does not track attempt number, add:

- `attempt` to `PipelinePhaseIR` summaries/results, or
- an `operationKey`/`approvalToken` field in artifacts

### E. Idempotent approval processing

Hugin must treat duplicate approval writes as harmless. Safe pattern:

- if phase is already `pending`, `running`, or terminal, ignore approval
- if phase is `awaiting-approval` and the same approval artifact is seen again, no-op
- if rejection lands after approval already advanced the phase to execution, ignore it and log the race

## Code plan

### 1. IR and compiler

Files:

- [src/pipeline-ir.ts](/Users/magnus/repos/hugin/src/pipeline-ir.ts)
- [src/pipeline-compiler.ts](/Users/magnus/repos/hugin/src/pipeline-compiler.ts)
- [tests/pipeline-compiler.test.ts](/Users/magnus/repos/hugin/tests/pipeline-compiler.test.ts)

Changes:

- add side-effect schema/registry
- add `sideEffects` to phase IR
- allow `Authority: gated`
- validate `authority` vs `sideEffects`
- include new fields in child task drafts

### 2. Dispatcher/task status handling

Files:

- [src/index.ts](/Users/magnus/repos/hugin/src/index.ts)
- [src/pipeline-dispatch.ts](/Users/magnus/repos/hugin/src/pipeline-dispatch.ts)
- [src/task-status-tags.ts](/Users/magnus/repos/hugin/src/task-status-tags.ts)

Changes:

- add `awaiting-approval` lifecycle/tag handling
- preserve `authority:*` tags on transitions where needed
- intercept gated phases before executor dispatch
- write approval-request artifacts exactly once

### 3. Approval decision processing

Files:

- [src/pipeline-control.ts](/Users/magnus/repos/hugin/src/pipeline-control.ts)
- likely new [src/pipeline-gates.ts](/Users/magnus/repos/hugin/src/pipeline-gates.ts)
- [tests/pipeline-control.test.ts](/Users/magnus/repos/hugin/tests/pipeline-control.test.ts)
- new gate-focused tests

Changes:

- poll for approval-decision artifacts on tracked gated phases
- promote approved phases back to pending
- fail rejected phases with stable result contracts
- integrate with cancellation/resume semantics

### 4. Structured artifacts and summaries

Files:

- [src/task-result-schema.ts](/Users/magnus/repos/hugin/src/task-result-schema.ts)
- [src/pipeline-summary.ts](/Users/magnus/repos/hugin/src/pipeline-summary.ts)
- [src/pipeline-summary-manager.ts](/Users/magnus/repos/hugin/src/pipeline-summary-manager.ts)
- associated tests

Changes:

- extend structured results with approval metadata
- add `awaiting_approval` lifecycle in phase snapshots
- add summary execution-state precedence for approval waits

## Testing plan

### Unit tests

- compiler accepts valid gated phase with declared side effect
- compiler rejects:
  - gated phase with no side effects
  - autonomous phase with side effects
  - unknown side-effect id
- summary reducer classifies `awaiting_approval` correctly
- structured result schema accepts approval metadata

### Integration-style tests

- pending gated phase transitions to `awaiting-approval` and writes one approval-request
- repeated poll does not duplicate request writes
- approved phase transitions back to `pending` and later executes
- rejected phase fails and triggers downstream failure semantics
- pipeline cancellation while awaiting approval converges cleanly
- pipeline resume recreates approval wait correctly

### Live evaluation required

Run one fixed four-phase non-sensitive pipeline with exactly one gated side-effect phase, for example:

1. `explore` — autonomous
2. `synthesize` — autonomous
3. `review` — autonomous
4. `deploy` — gated, declared `deploy.service`

Acceptance checks:

1. Parent compiles and decomposes successfully.
2. The gated phase does not execute automatically after dependencies complete.
3. Hugin writes `approval-request` exactly once.
4. Ratatoskr writes `approval-decision: approved`.
5. Hugin resumes and executes only the gated phase.
6. Rejection path fails cleanly and audibly on a second run.
7. Parent `summary` distinguishes `awaiting_approval` from dependency blocking.
8. Structured results retain approval metadata.

## Implementation order

1. Extend IR/compiler for `Authority: gated` plus `Side-effects:`.
2. Add `awaiting-approval` lifecycle and summary support.
3. Add approval-request artifact creation on the dispatcher path.
4. Add approval-decision processing and rejection handling.
5. Integrate cancellation/resume semantics.
6. Run local tests.
7. Deploy and run the live gate.

## Definition of done

Phase 4 is done when all of the following are true:

- `Authority: gated` is accepted by the compiler with explicit side-effect declarations.
- Gated phases pause before execution and write auditable approval requests in Munin.
- Approval from Ratatoskr resumes the phase without manual state editing.
- Rejection fails the phase and propagates through the DAG using existing dependency rules.
- Parent summaries and structured results represent approval state explicitly.
- Cancellation and resume remain coherent when a pipeline contains gated phases.
- A live four-phase pipeline passes the evaluation above on `huginmunin`.

## Recommendation

Keep Phase 4 narrow. The first implementation should solve human gating for one pipeline phase at a time with explicit side-effect declarations and a minimal approval protocol. Do not mix this with sensitivity routing, template expansion, or broad capability inference.
