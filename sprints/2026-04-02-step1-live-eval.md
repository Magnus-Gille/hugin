# Step 1 Live Evaluation

## Demo

This sprint delivered the first validated piece of Hugin v2: dependency-aware task orchestration.

What shipped:
- `blocked` task lifecycle support
- `depends-on:*` dependency edges
- `on-dep-failure:fail` and `on-dep-failure:continue`
- event-driven promotion of continuations
- startup and periodic reconciliation for missed promotions
- `blocked_tasks` in heartbeat and health output

What was shown live on `huginmunin`:
1. Two child tasks completed and a blocked continuation promoted only after both were terminal.
2. A continuation failed immediately when an upstream dependency failed under the default policy.
3. A continuation with `on-dep-failure:continue` stayed blocked after one failed dependency, then promoted once the remaining dependency completed.
4. A blocked continuation with already-completed dependencies was promoted after a Hugin restart via reconciliation.

Why it matters:
- Hugin is no longer limited to monolithic single tasks.
- The workflow engine foundation is now proven on the deployed service.
- Step 2 can build on this with a pipeline compiler rather than inventing orchestration and evaluation at the same time.

## Evidence

- Engineering plan: [docs/hugin-v2-engineering-plan.md](/Users/magnus/repos/hugin/docs/hugin-v2-engineering-plan.md)
- Live evaluation record: [docs/step1-live-evaluation.md](/Users/magnus/repos/hugin/docs/step1-live-evaluation.md)
- Dispatcher implementation: [src/index.ts](/Users/magnus/repos/hugin/src/index.ts)
- Dependency logic: [src/task-graph.ts](/Users/magnus/repos/hugin/src/task-graph.ts)

## Feedback

### 2026-04-02 user feedback

Summary:
- The implementation is clean and the live evaluation is comprehensive.
- `task-graph.ts` being pure and side-effect-free is the right shape.
- Missing dependencies are handled correctly by treating them as non-terminal.
- `promoteDependents()` uses the right targeted query shape and should scale better than a full blocked-task scan.
- Reconciliation is the right crash-recovery design, not a workaround.

Specific concern:
- [src/task-graph.ts](/Users/magnus/repos/hugin/src/task-graph.ts#L35) removes `depends-on:*` tags during promotion.
- That means dependency provenance is no longer present on the task's final `status` entry after promotion.
- This may be acceptable if logs and results carry enough context, but it should be reviewed before Step 2 if downstream auditing matters.

## Follow-ups

- Decide whether dependency provenance should survive promotion in status, logs, or result metadata before Step 2 expands orchestration scope.
- If provenance must be preserved, add an explicit mechanism instead of relying on transient `depends-on:*` tags.
- Keep future sprint demos and user feedback in this folder so product-facing progress stays separate from engineering specs.
