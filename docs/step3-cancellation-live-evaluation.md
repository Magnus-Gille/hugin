# Step 3 Cancellation Live Evaluation

Date: 2026-04-02
Branch: `codex/step1-live-eval`
Final deployed worker: `hugin-huginmunin-750305`

## Goal

Validate the first Step 3 operations slice on the live Pi:

1. Cancel a pipeline while a child phase is actively running.
2. Verify blocked downstream phases are cancelled immediately.
3. Verify the parent pipeline converges to a coherent cancelled state with:
   - parent `status = cancelled`
   - parent `result` rewritten to cancellation metadata
   - parent `summary.executionState = cancelled`
   - child `result-structured` artifacts marked `cancelled`

## Deploy Sequence

1. `9af474a` — initial cancellation support
2. `cd69ed0` — retry-safe parent cancellation finalization
3. `bc590f9` — classify fully cancelled pipelines correctly in summary

## Probe 1 — Initial Cancellation Path

Task namespace: `tasks/20260402-151545-step3-cancel-pipeline`

### Setup

- Two-phase pipeline:
  - `gather` uses `claude-sdk` and sleeps in the shell
  - `report` depends on `gather`
- Parent tagged with `cancel-requested` during execution

### Observed

- The cancel request landed too late to interrupt the running phase.
- The parent eventually reached `status: cancelled`.
- The parent `result` remained the stale decomposition record.

### Finding

`finalizePipelineCancellationIfReady()` wrote parent `status` before parent `result`. A Munin `429` between those writes cleared the retry path and left stale parent result content.

### Action Taken

Fixed in `cd69ed0` by writing the cancellation `result` before the terminal parent `status`, so retries remain possible until the parent is fully finalized.

## Probe 2 — Active Running-Phase Cancellation

Task namespace: `tasks/20260402-152140-step3-cancel-pipeline2`

### Setup

- Two-phase pipeline with a longer-running `gather` phase (`claude-sdk`, shell sleep)
- Remote loop waited for `current_task = ...-gather`
- Parent then tagged with `cancel-requested`

### Observed

- Hugin logged:
  - `Cancellation requested for tasks/20260402-152140-step3-cancel-pipeline2-gather`
  - `Task ...-gather cancelled (exit: CANCELLED, executor: agent-sdk, duration: 25s)`
- `gather` ended as `cancelled`
- `report` ended as `cancelled`
- Parent `status` ended as `cancelled`
- Parent `result` was correctly rewritten to the cancellation record
- Parent `summary` still reported `executionState: decomposed` despite both phases being cancelled

### Finding

`buildPipelineExecutionSummary()` classified pipelines with zero completed/failed phases as `decomposed` before checking whether all phases were cancelled.

### Action Taken

Fixed in `bc590f9` by changing execution-state precedence:

- `running` if any phase is running
- `decomposed` only when there are no terminal phases at all
- `cancelled` once no active phases remain and any phase is cancelled

## Probe 3 — Final Confirmation

Task namespace: `tasks/20260402-152550-step3-cancel-pipeline3`

### Setup

- Same two-phase `claude-sdk` cancellation probe
- Remote loop waited for the `gather` phase to become the live `current_task`
- Parent tagged with `cancel-requested`

### Observed

- `gather` was actively running and then aborted:
  - parent cancellation detected at `2026-04-02T15:25:56Z`
  - `gather` status: `cancelled`
  - `gather` structured result:
    - `lifecycle: cancelled`
    - `outcome: cancelled`
    - `exitCode: CANCELLED`
    - `executor: agent-sdk`
    - `resultSource: agent-sdk`
- `report` never ran and was cancelled by the dispatcher:
  - status: `cancelled`
  - structured result:
    - `executor: dispatcher`
    - `resultSource: cancellation`
- Parent artifacts converged correctly:
  - `tasks/20260402-152550-step3-cancel-pipeline3/status` -> `cancelled`
  - `tasks/20260402-152550-step3-cancel-pipeline3/result` -> cancellation metadata
  - `tasks/20260402-152550-step3-cancel-pipeline3/summary` ->
    - `executionState: cancelled`
    - `terminal: true`
    - `phaseCounts.cancelled: 2`

## Conclusion

Step 3 cancellation is now validated live.

What is proven:

- A running pipeline phase can be cancelled in-flight.
- Blocked downstream phases are cancelled instead of being promoted.
- Parent cancellation converges despite intermediate Munin `429` pressure.
- The final parent summary is machine-readable and correctly classified as `cancelled`.

Residual operational note:

- Munin `429` responses still appear in live logs during heavy summary/log/heartbeat traffic.
- The cancellation path now converges safely under that pressure, but the service still emits noisy poll errors and stale heartbeat metrics occasionally.

## Next Step

Step 3 resume-from-failed-phase, built on the now-validated cancellation state:

- reuse stored `spec`
- inspect child `result-structured`
- rerun only failed/cancelled or unfinished phases
- keep parent summary coherent across cancel -> resume
