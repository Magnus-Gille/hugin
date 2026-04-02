# Step 3 Live Evaluation

**Date:** 2026-04-02  
**Environment:** `huginmunin` Pi, deployed from branch `codex/step1-live-eval`  
**Service worker observed:** `hugin-huginmunin-741842`

## Goal

Validate the first Step 3 slice on the live Hugin service before implementing cancellation and resume logic:

- machine-readable `result-structured` artifacts for executed tasks
- machine-readable parent `summary` artifacts for pipeline execution

## Pre-evaluation finding

The first submission used:

- Parent task: `20260402-122116-step3-artifacts-valid`
- `Submitted by: Codex`

Observed behavior:

- The parent failed immediately with:
  `Unauthorized submitter "Codex". Allowed: [claude-code, claude-desktop, ratatoskr, claude-web, claude-mobile, hugin]`

Conclusion:

- The deployed allowlist still reflects the older `claude-*` naming, not the Codex-facing names in repo docs.
- This is configuration/documentation drift, not a Step 3 artifact-layer failure.
- The live gate below was rerun with `Submitted by: hugin`.

## Results

### 1. Parent pipeline writes `summary` immediately on decomposition

Parent task:

- `20260402-122116-step3-artifacts-valid2`

Child tasks:

- `20260402-122116-step3-artifacts-valid2-gather`
- `20260402-122116-step3-artifacts-valid2-report`

Observed behavior:

- Hugin wrote immutable IR to `tasks/20260402-122116-step3-artifacts-valid2/spec`.
- Hugin wrote the usual decomposition `result` on the parent.
- Hugin also wrote `tasks/20260402-122116-step3-artifacts-valid2/summary` immediately after decomposition.
- The initial `summary` recorded:
  - `executionState: decomposed`
  - `terminal: false`
  - `phaseCounts.pending: 1`
  - `phaseCounts.blocked: 1`
  - parent routing metadata (`replyTo`, `replyFormat`, `group`, `sequence`)

Conclusion:

- The new parent `summary` artifact is created on the live dispatcher at decomposition time, not only after final completion.

### 2. Parent `summary` refreshes across child execution and ends coherent

Observed behavior:

- `gather` started at `2026-04-02T12:22:32.931Z` and completed at `2026-04-02T12:22:40.793Z`.
- `report` was then promoted and later started at `2026-04-02T12:23:11.529Z`.
- `report` completed at `2026-04-02T12:23:13.180Z`.
- Parent summary audit history shows updates at the expected transition points:
  - `12:22:41.191Z` and `12:22:41.442Z` after `gather` completion / downstream promotion
  - `12:23:11.561Z` when `report` was claimed
  - `12:23:13.642Z` after final completion
- The final parent `summary` recorded:
  - `executionState: completed`
  - `terminal: true`
  - `phaseCounts.completed: 2`
  - `startedAt: 2026-04-02T12:22:32.931Z`
  - `completedAt: 2026-04-02T12:23:13.180Z`
  - `durationSeconds: 40`

Conclusion:

- The parent `summary` is not a one-shot snapshot. It refreshes as live execution progresses and converges on a coherent final artifact.

### 3. Child phases write complete machine-readable `result-structured` artifacts

Observed behavior:

- `tasks/20260402-122116-step3-artifacts-valid2-gather/result-structured` recorded:
  - `lifecycle: completed`
  - `outcome: completed`
  - `bodyText: STEP3_GATHER`
  - `requestedModel/effectiveModel: qwen2.5:3b`
  - `requestedHost/effectiveHost: pi`
  - pipeline context with `pipelineId`, `phase`, and empty dependency lists
- `tasks/20260402-122116-step3-artifacts-valid2-report/result-structured` recorded:
  - `lifecycle: completed`
  - `outcome: completed`
  - `bodyText: STEP3_REPORT`
  - the same Pi runtime metadata
  - pipeline context with dependency provenance:
    - `dependencyTaskIds: ["20260402-122116-step3-artifacts-valid2-gather"]`
    - `dependencyPhases: ["gather"]`

Conclusion:

- Successful phase executions now leave machine-readable results with enough context for later aggregation, cancellation, and resume logic.

### 4. Structured failure artifacts work on the live dispatcher

Failure probe:

- Task: `20260402-122116-step3-invalid-model`

Observed behavior:

- The task failed at execution time with:
  `No ollama host available for model "definitely-not-a-real-model:999"`
- The markdown `result` preserved the usual reply-routing metadata.
- `result-structured` recorded:
  - `lifecycle: failed`
  - `outcome: failed`
  - `replyTo: telegram:step3-failure`
  - `replyFormat: summary`
  - `group: step3-artifacts`
  - `sequence: 3`
  - `bodyText` and `errorMessage` containing the failure message
  - runtime metadata:
    - `requestedModel: definitely-not-a-real-model:999`
    - `effectiveHost: none`
    - `fallbackTriggered: false`
    - `fallbackReason: host_unreachable`

Conclusion:

- The structured result schema works on live failure paths as well as successes.

## Verdict

**Step 3 artifact slice passes live evaluation.**

Hugin now writes machine-readable task execution results and machine-readable parent pipeline summaries on the live service. The next engineering step is to build Step 3 operations on top of those artifacts: cancellation and resume-from-failed-phase.
