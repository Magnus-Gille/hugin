# Step 1 Live Evaluation

**Date:** 2026-04-02  
**Environment:** `huginmunin` Pi, deployed from branch `codex/step1-live-eval`  
**Service workers observed:** `hugin-huginmunin-729936`, `hugin-huginmunin-730374`

## Goal

Validate the Step 1 parent/child join implementation on the live Hugin service before starting the pipeline compiler.

## Results

### 1. Success path

Tasks:
- `20260402-093737-step1-success-a`
- `20260402-093737-step1-success-b`
- `20260402-093737-step1-success-join`

Observed behavior:
- Child `...success-b` completed at `09:38:55`.
- Child `...success-a` completed at `09:38:58`.
- The join promoted only after the second child completed:
  `Promoted tasks/20260402-093737-step1-success-join -> pending (deps checked: 2)`
- The join then executed and completed successfully at `09:39:00`.

Conclusion:
- `blocked -> pending` promotion works.
- The continuation did not promote after only one completed dependency.

### 2. Default dependency failure policy (`fail`)

Tasks:
- `20260402-093905-step1-fail-bad`
- `20260402-093905-step1-fail-good`
- `20260402-093905-step1-fail-join`

Setup:
- `...fail-bad` was intentionally invalid (missing `### Prompt`) so Hugin would fail it deterministically during parsing.

Observed behavior:
- `...fail-good` completed at `09:40:02`.
- `...fail-bad` failed at `09:40:03`.
- The blocked continuation failed immediately with:
  `Dependency 20260402-093905-step1-fail-bad failed`

Conclusion:
- `on-dep-failure:fail` behavior works.
- Failed dependencies propagate to blocked continuations with a clear result message.

### 3. Continue-on-failure policy (`continue`)

Tasks:
- `20260402-094110-step1-continue-bad`
- `20260402-094110-step1-continue-good`
- `20260402-094110-step1-continue-join`

Setup:
- `...continue-bad` was intentionally invalid.
- `...continue-good` was created only after the bad child had already failed.

Observed behavior:
- `...continue-bad` failed at `09:41:33`.
- The continuation remained `blocked` with no result after that failure.
- `...continue-good` completed at `09:42:05`.
- The continuation then promoted and completed successfully.

Conclusion:
- `on-dep-failure:continue` waits for all dependencies to become terminal.
- Failed upstream work does not force the continuation to fail.

### 4. Reconciliation on restart

Tasks:
- `20260402-094245-step1-reconcile-a`
- `20260402-094245-step1-reconcile-b`
- `20260402-094245-step1-reconcile-join`

Setup:
- Dependencies `...reconcile-a` and `...reconcile-b` were written directly as `completed`.
- The join was written as `blocked`.
- Hugin was restarted before any dependency-driven promotion event could occur.

Observed behavior:
- Service restart at `09:43:38`.
- On startup, Hugin logged:
  `Promoted tasks/20260402-094245-step1-reconcile-join -> pending (deps checked: 2)`
- It also logged:
  `Blocked-task reconciliation: promoted=1, failed=0, scanned=1, total_blocked=1`
- The join then executed and completed successfully at `09:43:42`.

Conclusion:
- Startup reconciliation works.
- A missed promotion is repaired without requiring a new dependency event.

## Verdict

**Step 1 passes live evaluation.**

The dependency join foundation is now proven on the deployed Pi service. The next engineering step is **Step 2: Pipeline IR + compiler**, still with explicit runtimes only and without routing logic.
