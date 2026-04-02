# Step 3 Live Evaluation

## Demo

This sprint delivered the first Step 3 layer of Hugin v2: machine-readable execution artifacts.

What shipped:
- `result-structured` for executed tasks
- parent `summary` artifacts for pipeline execution
- summary refresh on decomposition, claim, completion, failure, and recovery transitions
- structured runtime metadata and pipeline provenance on child results

What was shown live on `huginmunin`:
1. One pipeline task decomposed into `spec`, `result`, and a new parent `summary` artifact immediately.
2. The initial summary showed the right graph state: one `pending` phase and one `blocked` phase.
3. The child phases executed in order on the Pi with `qwen2.5:3b`.
4. Both child phases wrote machine-readable `result-structured` entries with timings, runtime metadata, and pipeline context.
5. The parent summary refreshed through execution and ended in a coherent final `completed` state with total timings and per-phase outcomes.
6. A separate failing ollama task also wrote a machine-readable `result-structured` error artifact, proving the failure contract on the live dispatcher.

Why it matters:
- Step 3 now has a real artifact boundary to build on.
- Cancellation and resume no longer need to scrape markdown or guess state from tags alone.
- Pipeline progress can be summarized from durable machine-readable state instead of ephemeral logs.

## Evidence

- Engineering plan: [docs/hugin-v2-engineering-plan.md](/Users/magnus/repos/hugin/docs/hugin-v2-engineering-plan.md)
- Live evaluation record: [docs/step3-live-evaluation.md](/Users/magnus/repos/hugin/docs/step3-live-evaluation.md)
- Structured result schema: [src/task-result-schema.ts](/Users/magnus/repos/hugin/src/task-result-schema.ts)
- Pipeline summary reducer: [src/pipeline-summary.ts](/Users/magnus/repos/hugin/src/pipeline-summary.ts)
- Dispatcher integration: [src/index.ts](/Users/magnus/repos/hugin/src/index.ts)

## Feedback

### 2026-04-02 live evaluation finding

Summary:
- The first Step 3 submission from `Submitted by: Codex` failed immediately.
- The deployed service still authorizes `claude-*` submitter names plus `hugin`, while the repo docs and current workflow now use Codex naming.

Resolution:
- The evaluation was rerun with `Submitted by: hugin`.
- This does not block Step 3, but it is real config/docs drift that should be cleaned up before the next desktop-driven live test.

## Follow-ups

- Continue Step 3 with cancellation and resume-from-failed-phase.
- Define the next live gate around cancel + resume on one fixed pipeline.
- Align the deployed submitter allowlist with the Codex-facing documentation.
