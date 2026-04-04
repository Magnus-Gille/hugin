# Step 4 Live Eval

## Demo

This sprint closed Bet 1 for Hugin v2.

Hugin now supports human gates for side-effecting pipeline phases:

- gated phases pause in `awaiting-approval`
- Hugin writes an auditable `approval-request`
- operators can approve or reject through Munin
- approval resumes only the gated phase
- rejection fails the gated phase without executing it
- approval metadata survives in structured child results and parent pipeline summaries

What the live demo showed on `huginmunin`:

1. A four-phase pipeline reached a gated `deploy` phase and stopped in `awaiting-approval`.
2. The parent summary surfaced `executionState: awaiting_approval`.
3. After approval, the gated `deploy` phase resumed and completed with `STEP4_DEPLOY_APPROVED`.
4. A second clean pipeline reached the same gate.
5. After rejection, the gated `deploy` phase failed without execution and the parent summary converged to `completed_with_failures`.

## Evidence

- [step4-live-evaluation.md](/Users/magnus/repos/hugin/docs/step4-live-evaluation.md)
- [phase4-human-gates-engineering-plan.md](/Users/magnus/repos/hugin/docs/phase4-human-gates-engineering-plan.md)
- [pipeline-gates.ts](/Users/magnus/repos/hugin/src/pipeline-gates.ts)
- [pipeline-summary.ts](/Users/magnus/repos/hugin/src/pipeline-summary.ts)
- [task-result-schema.ts](/Users/magnus/repos/hugin/src/task-result-schema.ts)

## Feedback

- The first manual approval decision I wrote was too minimal and Hugin ignored it safely.
- That exposed a documentation point: approval producers must include the full decision identity, not just `decision` plus a comment.

## Follow-ups

- Start Phase 5: sensitivity classification.
- Add operator-facing documentation or helper tooling for writing valid `approval-decision` artifacts.
- Run a mixed soak with normal, cancelled, resumed, and gated pipelines under realistic Munin traffic.
