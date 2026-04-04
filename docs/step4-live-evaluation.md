# Step 4 Live Evaluation

Date: 2026-04-04
Environment: `huginmunin` (`hugin-huginmunin-874413`)
Goal: validate Phase 4 human gates for side-effecting pipeline phases on the live dispatcher

## Scope

Validated on the live system:

- `Authority: gated` phases stop in `awaiting-approval`
- Hugin writes exactly one `approval-request` artifact for the gated phase
- parent pipeline `summary` exposes `executionState: awaiting_approval`
- approved gated phases resume and execute only after an `approval-decision`
- rejected gated phases fail without execution
- structured results retain approval metadata for both approved and rejected paths

## Probe 1: approval path

Parent task:
- `tasks/20260404-123200-step4-gated-approve`

Gated child:
- `tasks/20260404-123200-step4-gated-approve-deploy`

Observed:
- `gather`, `synthesize`, and `review` completed normally
- `deploy` moved to `awaiting-approval`
- Hugin wrote `tasks/20260404-123200-step4-gated-approve-deploy/approval-request`
- parent `summary` showed `executionState: awaiting_approval` and `approvalStatus: pending`
- after a valid `approval-decision`, `deploy` returned to `pending`, was claimed, and executed
- `deploy/result-structured` recorded:
  - `approval.status: approved`
  - `requestedAt`
  - `decidedAt`
  - `decisionSource: ratatoskr`
  - `operationKey`
- parent `summary` converged to terminal `completed`

Key evidence:
- `tasks/20260404-123200-step4-gated-approve/summary`
- `tasks/20260404-123200-step4-gated-approve-deploy/approval-request`
- `tasks/20260404-123200-step4-gated-approve-deploy/result-structured`

## Probe 2: rejection path

Authoritative parent task:
- `tasks/20260404-124100-step4-gated-reject-clean2`

Gated child:
- `tasks/20260404-124100-step4-gated-reject-clean2-deploy`

Observed:
- `gather`, `synthesize`, and `review` completed normally
- `deploy` moved to `awaiting-approval`
- Hugin wrote `tasks/20260404-124100-step4-gated-reject-clean2-deploy/approval-request`
- parent `summary` showed `executionState: awaiting_approval` and `approvalStatus: pending`
- after a valid `approval-decision` with `decision: rejected`, `deploy` failed before execution
- `deploy/result-structured` recorded:
  - `resultSource: approval`
  - `approval.status: rejected`
  - `requestedAt`
  - `decidedAt`
  - `decisionSource: ratatoskr`
  - `operationKey`
- parent `summary` converged to terminal `completed_with_failures`
- no execution output for the rejected deploy prompt was produced

Key evidence:
- `tasks/20260404-124100-step4-gated-reject-clean2/summary`
- `tasks/20260404-124100-step4-gated-reject-clean2-deploy/approval-request`
- `tasks/20260404-124100-step4-gated-reject-clean2-deploy/result-structured`

## Invalid or non-authoritative runs

- `tasks/20260404-123400-step4-gated-reject` was contaminated by service restart churn during the first attempt and is not the authoritative rejection artifact.
- `tasks/20260404-123830-step4-gated-reject-clean` was submitted with invalid Phase 2/4 pipeline syntax (`#### Phase:` instead of `Phase:`) and correctly failed at compile time. It is not part of the gate result.

## Findings

### 1. Gate passed

Phase 4 behavior is now validated live:

- side-effecting phases do not execute autonomously
- approval requests are durable and auditable in Munin
- approvals resume only the gated phase
- rejections fail the gated phase without execution
- parent summaries and structured child results preserve approval state

### 2. Approval decision contract is stricter than the first manual probe assumed

The live operator must write a full `approval-decision` artifact including:

- `pipelineId`
- `phaseTaskId`
- `decision`
- `decidedAt`

The first approval attempt used an under-specified decision payload and was ignored, which is correct behavior for safety. This is a documentation/producer-contract issue, not a dispatcher bug.

## Outcome

- Phase 4 is live-validated.
- Bet 1 is closed.
- The next implementation target is Phase 5: sensitivity classification.
