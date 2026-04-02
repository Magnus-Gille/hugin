# Step 2 Live Evaluation

## Demo

This sprint delivered the second validated piece of Hugin v2: a pipeline compiler that turns one markdown task into validated IR plus executable child tasks.

What shipped:
- `Runtime: pipeline` handling in the dispatcher
- validated `PipelineIR`
- markdown pipeline compiler with dependency and cycle checks
- immutable `spec` storage in Munin
- child-task decomposition using Step 1 join primitives
- explicit ollama runtime variants with pinned models

What was shown live on `huginmunin`:
1. One pipeline task compiled into `spec` plus three child tasks with the expected `pending` and `blocked` initial states.
2. The child tasks preserved dependency provenance in content instead of relying on transient `depends-on:*` tags.
3. The full `explore -> synthesize -> review` flow ran in order on the Pi using `qwen2.5:3b`.
4. An invalid runtime failed the parent task before any `spec` or child task was created.
5. A cyclic dependency graph failed the parent task before any `spec` or child task was created.

Why it matters:
- Hugin can now accept a workflow description instead of only manually pre-expanded task graphs.
- Invalid pipeline definitions fail early and cleanly.
- Step 3 can build on a real compiler boundary instead of mixing parsing, execution, and recovery concerns.

## Evidence

- Engineering plan: [docs/hugin-v2-engineering-plan.md](/Users/magnus/repos/hugin/docs/hugin-v2-engineering-plan.md)
- Live evaluation record: [docs/step2-live-evaluation.md](/Users/magnus/repos/hugin/docs/step2-live-evaluation.md)
- Pipeline IR: [src/pipeline-ir.ts](/Users/magnus/repos/hugin/src/pipeline-ir.ts)
- Pipeline compiler: [src/pipeline-compiler.ts](/Users/magnus/repos/hugin/src/pipeline-compiler.ts)
- Dispatcher integration: [src/index.ts](/Users/magnus/repos/hugin/src/index.ts)

## Feedback

### 2026-04-02 live evaluation finding

Summary:
- The first live pipeline attempt surfaced a real compiler/runtime boundary bug.
- `ollama-pi` and `ollama-laptop` were encoding host intent but not a concrete model.
- Existing host resolution then rerouted a supposedly Pi-bound phase to the laptop because the dispatcher still had to infer the model.

Resolution:
- `ollama-pi` now pins `qwen2.5:3b`.
- `ollama-laptop` now pins `qwen3.5:35b-a3b`.
- The rerun stayed on the Pi and passed end to end.

## Follow-ups

- Start Step 3 with structured phase results and pipeline-level summary artifacts.
- Keep runtime definitions explicit: if a runtime variant implies a host or trust tier, it should also imply a concrete executable model.
