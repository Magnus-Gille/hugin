# Step 3 Follow-up Fix Validation

**Date:** 2026-04-02  
**Environment:** `huginmunin` Pi, deployed from branch `codex/step1-live-eval`  
**Service worker observed:** `hugin-huginmunin-747189`

## Goal

Validate the fixes for the tester-reported Step 3 follow-ups:

- intermittent missed intermediate `summary` states under Munin 429 pressure
- stalled live rerun where heartbeat stopped while queued work remained
- leading/trailing newlines in machine-readable `errorMessage`

## Code changes

- `src/munin-client.ts`
  - added request timeout
  - added limited retry/backoff for 429, timeout, and transient fetch failures
- `src/index.ts`
  - made `refreshPipelineSummary()` best-effort
  - changed per-phase summary reads from parallel bursts to sequential reads
- `src/task-result-schema.ts`
  - trim `errorMessage` while preserving raw `bodyText`

## Live validation

### 1. Intermediate `running` summary state is now written

Pipeline:

- `tasks/20260402-144300-step3-fixcheck-pipeline`

Observed behavior:

- Parent `summary` entered `executionState: running` after `gather` completed and before `report` executed.
- The `running` summary showed:
  - `phaseCounts.completed: 1`
  - `phaseCounts.pending: 1`
  - `terminal: false`
- Final summary later converged to `executionState: completed`.

Conclusion:

- The previously missed intermediate state now lands on the live service.

### 2. Heartbeat continues while queued work remains

Supporting task:

- `tasks/20260402-144300-step3-fixcheck-standalone`

Observed heartbeat history after submitting the fixcheck queue:

- `2026-04-02T14:43:43Z`
- `2026-04-02T14:43:50Z`
- `2026-04-02T14:44:22Z`
- `2026-04-02T14:44:54Z`

Observed live heartbeat content during the queue:

- `queue_depth: 1`
- `blocked_tasks: 1`
- `current_task: null`

Conclusion:

- The live dispatcher-stall issue did not reproduce after the Munin client hardening.
- Heartbeat kept moving even while the pipeline was non-terminal and additional work remained queued.

### 3. Machine-readable `errorMessage` is trimmed

Timeout probe:

- `tasks/20260402-144300-step3-fixcheck-timeout`

Observed behavior:

- Markdown `result` preserved the raw timeout output, including surrounding blank lines.
- `result-structured` recorded:
  - `bodyText: "\n[Ollama request aborted after 0s]\n"`
  - `errorMessage: "[Ollama request aborted after 0s]"`

Conclusion:

- The structured error contract is now normalized without losing raw output fidelity.

## Verdict

**The Step 3 follow-up fixes pass live validation.**

The tester-reported artifact issues are addressed, and the fresh heartbeat stall did not reproduce on the redeployed worker. Step 3 can proceed to cancellation and resume-from-failed-phase.
