# Step 3 Resume Live Evaluation

Date: 2026-04-02
Branch: `codex/step1-live-eval`
Deployed worker: `hugin-huginmunin-759993`

## Goal

Validate Step 3 resume-from-failed-phase on the live Pi:

1. Full restart after all phases are cancelled.
2. Partial restart after one phase completed and later phases were cancelled.
3. Parent `summary` must self-heal to terminal `completed` even if the final child-completion refresh initially lands stale or is delayed by Munin `429` responses.

## Code Under Test

Resume implementation:

- `87c4317` — initial resume handling
- `91ec000` — partial-resume recovery hardening
- `f6e3049` — cancellation sibling sweep
- `752dd95` — retry parent updates after task completion
- `512e9b7` — tracked reconciliation for non-terminal pipeline summaries
- `3852eda` — narrowed startup watchlist priming to active summarized pipelines only

## Probe 1 — Full Restart After Cancellation

Task namespace: `tasks/20260402-193721-step3-resume-partial5`

### Setup

- Three-phase pipeline:
  - `gather` — long-running `claude-sdk`
  - `report` depends on `gather`
  - `publish` depends on `report`
- Parent tagged with `cancel-requested` while `gather` was running.
- After the pipeline converged to a fully cancelled child graph, parent tagged with `resume-requested`.

### Observed

Cancellation:

- `gather`, `report`, and `publish` all ended `cancelled`.
- Parent `summary` self-healed to:
  - `executionState: cancelled`
  - `terminal: true`
  - `phaseCounts.cancelled: 3`
- Parent `status/result` finalization lagged behind summary under repeated Munin `429`, but the summary still converged without manual intervention.

Resume:

- Parent `result` switched to:
  - `Pipeline action: resumed`
  - `Resumed phases: 3`
  - `Completed phases kept: 0`
- Child rerun order on the live dispatcher:
  - `gather` reran and completed at `2026-04-02T17:41:15.061Z`
  - `report` reran and completed at `2026-04-02T17:41:56.182Z`
  - `publish` reran and completed at `2026-04-02T17:43:36.324Z`
- Parent `summary` converged to:
  - `generatedAt: 2026-04-02T17:43:36.919Z`
  - `executionState: completed`
  - `terminal: true`
  - `phaseCounts.completed: 3`

### Conclusion

The full-restart resume path is validated live. The tracked summary reconciliation closed the original bug: after the last resumed phase finished, the parent `summary` ended `completed` instead of staying stuck in a pre-terminal state.

## Probe 2 — Keep Completed Head, Resume Only Tail

Task namespace: `tasks/20260402-194512-step3-resume-partial-keep1`

### Setup

- Three-phase pipeline:
  - `gather` — short `claude-sdk`
  - `report` — longer `claude-sdk`, depends on `gather`
  - `publish` depends on `report`
- `gather` was allowed to complete.
- Parent tagged with `cancel-requested` while `report` was running.
- After the pipeline converged to a terminal cancelled state, parent tagged with `resume-requested`.

### Observed

Cancellation:

- `gather` completed and stayed completed:
  - `completedAt: 2026-04-02T17:45:50.040Z`
  - `status.updated_at: 2026-04-02T17:45:50.074Z`
- `report` was cancelled in-flight:
  - `completedAt: 2026-04-02T17:46:29.617Z`
- `publish` was cancelled downstream:
  - `completedAt: 2026-04-02T17:47:09.854Z`
- Parent `summary` converged to:
  - `executionState: cancelled`
  - `terminal: true`
  - `phaseCounts.completed: 1`
  - `phaseCounts.cancelled: 2`

Resume:

- Parent `result` switched to:
  - `Pipeline action: resumed`
  - `Resumed phases: 2`
  - `Completed phases kept: 1`
  - `Kept completed phases: gather`
- Child rerun behavior:
  - `gather` did **not** rerun; its `status.updated_at` stayed `2026-04-02T17:45:50.074Z`
  - `report` reran and completed at `2026-04-02T17:51:09.381Z`
  - `publish` reran and completed at `2026-04-02T17:52:21.627Z`
- Parent `summary` converged to:
  - `generatedAt: 2026-04-02T17:52:56.849Z`
  - `executionState: completed`
  - `terminal: true`
  - `phaseCounts.completed: 3`

### Conclusion

The keep-completed partial-resume path is validated live. Hugin preserved the already-completed `gather` phase and resumed only the cancelled tail.

## Operational Finding

Munin `429` pressure is still high enough to delay convergence materially:

- parent `status/result` finalization can lag behind child-state truth
- blocked-task promotion can be delayed by one or more poll intervals
- summary refresh can miss an immediate event and rely on later reconciliation

What is now proven despite that pressure:

- delayed summary refresh self-heals without manual intervention
- delayed blocked-task promotion self-heals through later reconciliation
- resume planning still preserves completed phases once the parent reaches a stable cancelled state

## Conclusion

Step 3 resume-from-failed-phase is now validated live.

What is proven:

- full restart from an all-cancelled pipeline
- partial restart that keeps completed head phases and reruns only the tail
- parent `summary` converges to the correct terminal state after the last resumed phase finishes

## Next Step

Step 4 / next workflow-engine layer:

- build higher-level pipeline operations on top of the validated `spec` + `summary` + `result-structured` contract
- decide whether Munin-side rate limiting needs its own remediation sprint before adding more orchestration features
