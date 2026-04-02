# Step 2 Live Evaluation

**Date:** 2026-04-02  
**Environment:** `huginmunin` Pi, deployed from branch `codex/step1-live-eval`  
**Service worker observed:** `hugin-huginmunin-732846`

## Goal

Validate the Step 2 pipeline compiler on the live Hugin service before starting Step 3 pipeline operations.

## Pre-evaluation correction

The first live pipeline attempt exposed a real bug before the gate could pass:

- Parent task: `20260402-104543-step2-valid-pipeline`
- The `explore` phase was submitted as `Runtime: ollama-pi`, but the child task did not carry a concrete `Model`.
- Existing ollama host resolution then fell through to the laptop host and the default large model instead of staying pinned to the Pi.

Correction:

- `ollama-pi` now emits `Model: qwen2.5:3b`
- `ollama-laptop` now emits `Model: qwen3.5:35b-a3b`
- The fix was redeployed before rerunning the evaluation

This was a valid evaluation finding, not test noise. The passing results below are from the rerun after that correction.

## Results

### 1. Success path: compile, decompose, and execute a fixed explicit-runtime pipeline

Parent task:
- `20260402-105009-step2-valid-pipeline`

Child tasks:
- `20260402-105009-step2-valid-pipeline-explore`
- `20260402-105009-step2-valid-pipeline-synthesize`
- `20260402-105009-step2-valid-pipeline-review`

Observed behavior:
- Hugin claimed the parent task at `10:50:25`.
- Hugin wrote immutable IR to `tasks/20260402-105009-step2-valid-pipeline/spec`.
- The parent `result` recorded compile/decompose output with one `pending` root task and two `blocked` dependent tasks.
- The child task content preserved pipeline provenance:
  - `Pipeline`
  - `Pipeline phase`
  - `Depends on task ids`
  - `Depends on phases`
- All three child tasks executed on the Pi host with the pinned model:
  - `Using ollama executor ... (host: pi, model: qwen2.5:3b)`
- `explore` completed at `10:50:58` and promoted `synthesize`.
- `synthesize` completed at `10:51:02` and promoted `review`.
- `review` completed at `10:51:04`.
- Child results matched the expected prompts exactly:
  - `STEP2_EXPLORE` terminator present after the count output
  - `STEP2_SYNTHESIZE`
  - `STEP2_REVIEW`

Conclusion:
- `Runtime: pipeline` compile/decompose works on the deployed service.
- Immutable `spec` storage works.
- Step 1 dependency joins are sufficient to drive ordered pipeline execution.
- Explicit ollama runtime IDs must resolve to a concrete model, not just a host preference.

### 2. Invalid runtime rejection

Parent task:
- `20260402-085306-step2-invalid-runtime`

Observed behavior:
- The parent task failed at compile time with:
  `Pipeline compile failed: Phase "explore" uses unknown runtime "mystery-box"`
- No `spec` entry was created.
- No child task namespace was created.

Conclusion:
- Unknown phase runtimes are rejected before decomposition.
- Invalid pipeline definitions do not partially execute.

### 3. Invalid dependency graph rejection

Parent task:
- `20260402-085307-step2-invalid-cycle`

Observed behavior:
- The parent task failed at compile time with:
  `Pipeline compile failed: Pipeline dependency cycle detected at phase "first"`
- No `spec` entry was created.
- No child task namespaces were created.

Conclusion:
- Dependency graph validation works on the live service.
- Cyclic graphs are rejected before any child task is emitted.

## Verdict

**Step 2 passes live evaluation.**

Hugin can now compile a markdown pipeline task into validated IR, persist that IR, decompose phases into child tasks, and execute the resulting graph on the live dispatcher. The next engineering step is **Step 3: Structured results and pipeline operations**.
