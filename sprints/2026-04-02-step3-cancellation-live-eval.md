# Step 3 Cancellation Live Evaluation

## Demo

This sprint delivered the first Step 3 operations milestone: live pipeline cancellation.

What shipped:
- parent-level `cancel-requested` handling
- active task abort for `claude-sdk`, `ollama`, and spawned runtimes
- immediate cancellation of blocked downstream phases
- cancelled task/result contracts in markdown and `result-structured`
- cancelled parent pipeline result and summary state

What was shown live on `huginmunin`:
1. A two-phase pipeline was submitted and decomposed into `gather -> report`.
2. The `gather` phase was claimed and started running under `claude-sdk`.
3. A parent `cancel-requested` tag landed while `gather` was active.
4. Hugin aborted the running `gather` phase and marked it `cancelled`.
5. The blocked `report` phase never ran and was cancelled by the dispatcher.
6. The parent pipeline converged to:
   - `status: cancelled`
   - cancellation `result`
   - parent `summary.executionState: cancelled`
   - `terminal: true`

Why it matters:
- Hugin now has a real operator stop mechanism for multi-phase work.
- Cancellation is based on durable state, not process-local best effort.
- Resume-from-failed-phase now has a solid state boundary to build on.

## Evidence

- Live evaluation record: [docs/step3-cancellation-live-evaluation.md](/Users/magnus/repos/hugin/docs/step3-cancellation-live-evaluation.md)
- Dispatcher cancellation flow: [src/index.ts](/Users/magnus/repos/hugin/src/index.ts)
- Summary reducer: [src/pipeline-summary.ts](/Users/magnus/repos/hugin/src/pipeline-summary.ts)
- Structured result schema: [src/task-result-schema.ts](/Users/magnus/repos/hugin/src/task-result-schema.ts)

## Feedback

### 2026-04-02 live evaluation findings

Two real bugs surfaced during the live gate and were fixed before the final pass:

1. Parent pipeline cancellation could leave a stale decomposition result if Munin returned `429` between parent writes.
Resolution:
- Fixed by making cancellation finalization write the parent cancellation `result` before terminal parent `status`, so retries remain possible.

2. A fully cancelled pipeline summary could still classify as `decomposed`.
Resolution:
- Fixed by changing summary execution-state precedence so all-cancelled pipelines end as `cancelled`.

### Residual observation

Munin `429` pressure still appears in live logs during heavy summary/log/heartbeat traffic.

Impact:
- Cancellation now converges safely under that pressure.
- Heartbeat and poll-loop logs are still noisier than they should be.

## Follow-ups

- Continue Step 3 with resume-from-failed-phase.
- Run the next live gate as cancel -> resume on one fixed pipeline.
- Decide whether the remaining Munin `429` log noise needs another hardening pass.
- Align the submitter allowlist with the Codex-facing docs.
