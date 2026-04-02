# Munin 429 Hardening Live Evaluation

Date: 2026-04-02
Branch: `codex/step1-live-eval`
Deployed worker: `hugin-huginmunin-765069`

## Goal

Validate a focused Munin-pressure hardening slice on the live Pi:

1. Startup should tolerate the existing backlog of historical pipeline parents without failing summary-watchlist priming.
2. Dispatcher hot paths should issue fewer bursty reads by using `memory_read_batch` where possible.
3. The client should pace and serialize requests instead of letting parallel call sites hammer Munin.
4. A representative live pipeline should complete without fresh `429` or timeout noise in the journal.

## Code Under Test

- `src/munin-client.ts`
  - serialized request slots with minimum spacing
  - exponential retry/backoff with `Retry-After` support
  - `memory_read_batch` support
  - automatic chunking to Munin's 20-read batch limit
  - SSE parsing hardened to accept both `data:` and `data: ` lines
- `src/index.ts`
  - batched reads for pipeline summary refresh
  - batched reads for dependency-state checks, cancellation/resume scans, and pipeline child-existence checks
  - summary fingerprint caching so unchanged pipeline summaries are not rewritten just because `generatedAt` would differ
- `src/pipeline-summary.ts`
  - stable fingerprint helper that ignores `generatedAt`

## Live Findings During Rollout

The first two deploys surfaced real HTTP-bridge integration bugs:

1. **SSE parser assumption was too narrow**
   - The Pi's MCP HTTP bridge emits `data:` without a guaranteed trailing space.
   - The client parser originally only accepted `data: `.
   - Fixed by accepting `data:` and trimming optional whitespace.

2. **Munin enforces a 20-read batch limit**
   - Startup watchlist priming hit `memory_read_batch` with 39 summary reads and received:
     - `validation_error`
     - `Maximum 20 reads per batch.`
   - Fixed by chunking all client-side batch reads to `20`.

These were production-only compatibility failures. They are part of the sprint outcome, not incidental noise.

## Final Live Evaluation

### Probe A — Clean startup against real historical load

Environment:

- Existing Munin data already contained `39` pipeline-parent task namespaces with `runtime:pipeline`.
- Hugin restart therefore exercised watchlist priming immediately on boot.

Observed after final deploy:

- Service started cleanly with no `Failed to prime pipeline summary watchlist` error.
- Batch priming succeeded against the real historical backlog after client-side chunking was added.

### Probe B — Representative long-running pipeline

Task namespace: `tasks/20260402-202957-hardening-summary-dedupe`

Pipeline:

- `gather`
  - `claude-sdk`
  - shell sleep for ~70 seconds, then `HARDENING_GATHER_OK`
- `report`
  - `ollama-pi`
  - depends on `gather`
  - returns `HARDENING_REPORT_OK`

Observed:

- Parent pipeline accepted from `Submitted by: Codex`.
- `gather` claimed at `2026-04-02T18:30:23Z` and completed at `2026-04-02T18:31:45Z`.
- `report` claimed at `2026-04-02T18:31:50Z` and completed at `2026-04-02T18:31:58Z`.
- Parent `summary` converged to:
  - `executionState: completed`
  - `terminal: true`
  - `phaseCounts.completed: 2`
  - `durationSeconds: 95`

Operational note:

- During a running child phase, Hugin's single-task execution model means the main poll loop is not cycling normally, so this probe does **not** prove per-poll no-op summary rewrites in the abstract.
- What it *does* prove is that the hardened client and batched dispatcher paths can boot, claim, execute, promote, and finalize a real pipeline without producing fresh `429` noise in the journal.

### Journal inspection

Checked `journalctl -u hugin --since '2026-04-02 20:29:45'`.

Observed:

- normal claim/execute/reconcile messages
- no fresh `429`
- no `Too many requests`
- no timeout errors
- no startup watchlist-prime errors after the final deploy

## Conclusion

This hardening sprint passed live.

What is proven:

- client-side batch reads now work against the real HTTP bridge
- startup watchlist priming survives real historical pipeline volume
- request pacing + batching + chunking removed the immediate production compatibility failures
- a representative live pipeline completed without fresh `429` or timeout noise

What remains true:

- Hugin still relies on Munin for a large amount of orchestration state, so future mixed workloads may still reveal more pressure points
- the single-task execution model limits how much continuous-poll summary dedupe can be exercised during a long-running child phase
