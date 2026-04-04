# Phase 5 Engineering Plan: Sensitivity Classification

**Parent plan:** [hugin-v2-engineering-plan.md](/Users/magnus/repos/hugin/docs/hugin-v2-engineering-plan.md)  
**Status:** Step 0 implemented; remaining work planned  
**Date:** 2026-04-04

**Sequencing note:** The first executable slice of this phase was delivered through [security-critical-holes-engineering-plan.md](/Users/magnus/repos/hugin/docs/security-critical-holes-engineering-plan.md): context-ref classification enforcement landed as Phase 5 Step 0 after legacy Claude spawn removal and outbound egress filtering. The remaining sections below are still open.

## Goal

Add a conservative, auditable sensitivity system that produces a trustworthy effective sensitivity for every task and pipeline artifact before Phase 6 introduces `Runtime: auto`.

Phase 5 should give Hugin three things it does not currently have:

- standalone task sensitivity, not just pipeline sensitivity
- monotonic propagation of sensitivity through pipeline structure
- durable artifact metadata that later routing logic can trust without reparsing prompt text

This phase is about classification and propagation, not routing. Its output is a stable contract for later trust-tier decisions.

## Non-goals

- No runtime selection or `Runtime: auto`. That starts in Phase 6.
- No content redaction, masking, or secret-removal layer.
- No ML classifier or external policy service. First pass is local and deterministic.
- No attempt to infer side effects. That remains Phase 4 behavior.
- No blocking of tasks solely because the declared sensitivity is too low. First pass should ratchet up safely, log the mismatch, and continue.

## Current baseline

The codebase already contains some sensitivity substrate, but it is partial:

- [src/pipeline-ir.ts](/Users/magnus/repos/hugin/src/pipeline-ir.ts) defines `public | internal | private`.
- [src/pipeline-compiler.ts](/Users/magnus/repos/hugin/src/pipeline-compiler.ts) parses top-level pipeline `Sensitivity:` and defaults missing values to `internal`.
- `PipelinePhaseIR.effectiveSensitivity` exists, but today it is just copied from the parent pipeline value.
- [src/pipeline-summary.ts](/Users/magnus/repos/hugin/src/pipeline-summary.ts) and [src/task-result-schema.ts](/Users/magnus/repos/hugin/src/task-result-schema.ts) can carry pipeline sensitivity, but not a full declared-vs-effective audit trail.
- [src/index.ts](/Users/magnus/repos/hugin/src/index.ts) does not parse standalone task `Sensitivity:` at all.
- [src/context-loader.ts](/Users/magnus/repos/hugin/src/context-loader.ts) resolves `Context-refs`, but it discards Munin entry classification metadata.
- [src/munin-client.ts](/Users/magnus/repos/hugin/src/munin-client.ts) does not expose or write Munin `classification`, so Hugin-generated artifacts cannot currently inherit effective sensitivity into Munin’s own security metadata.

Phase 5 should close those gaps without disturbing the already-validated workflow engine.

## Design decisions

### 1. Separate declared sensitivity from effective sensitivity

The system needs to distinguish:

- what the task author declared
- what Hugin inferred from stronger inputs
- what final value downstream routing is allowed to trust

Phase 5 should therefore preserve both:

- `declaredSensitivity?: public | internal | private`
- `effectiveSensitivity: public | internal | private`

The effective value is the only one later routing logic may use as a hard constraint.

### 2. Sensitivity is a monotonic lattice

Use a strict ordering:

- `public < internal < private`

Every combination rule is `max()` over that lattice.

Examples:

- explicit `public` + private `Context-refs` => effective `private`
- explicit `internal` + no stronger signals => effective `internal`
- explicit `private` + public-looking prompt => effective `private`

Phase 5 must never lower a task’s sensitivity because of a heuristic. Heuristics can only preserve or raise.

### 3. The first-pass classifier is conservative by design

The first implementation should be asymmetric:

- default to `internal`
- escalate to `private` on strong signals
- accept explicit `public` only when no stronger source forces ratcheting upward

That means the classifier should not try to be clever about proving a task is public from prompt text alone. Public should normally come from explicit declaration or already-public inputs.

This is the right tradeoff before routing exists. False positives toward `internal` are acceptable; false negatives toward `public` are not.

### 4. Reuse Munin classification instead of inventing a parallel trust system

When Hugin reads a Munin entry through `Context-refs`, that entry’s `classification` is already a valuable signal. Phase 5 should use it directly.

When Hugin writes artifacts, it should also write Munin `classification` based on the effective sensitivity of the artifact being created.

That gives all environments one shared trust signal:

- Hugin’s internal effective sensitivity
- Munin’s classification field

Tags can mirror this as `sensitivity:<level>` for queryability, but tags are secondary. Munin `classification` should be the canonical storage-level control.

### 5. Dependency edges propagate sensitivity

Even though Hugin’s current pipeline model is mostly orchestration rather than rich dataflow, downstream phases should inherit the maximum effective sensitivity of upstream dependencies.

Reason:

- later phases are expected to operate on the outputs or conclusions of earlier phases
- Phase 6 routing must be safe under future workflow growth, not just the current minimal compiler

This means every phase’s effective sensitivity is at least:

- pipeline effective sensitivity
- its own declared/inferred sensitivity
- the maximum effective sensitivity of its dependencies

### 6. Mismatches are visible but non-fatal in the first pass

If a user declares `Sensitivity: public` but Hugin sees private inputs, Phase 5 should:

- raise the effective sensitivity to `private`
- log the mismatch
- carry the mismatch into artifacts
- continue execution

Do not hard-fail in Phase 5. Hard policy enforcement belongs to routing or a later policy layer, not the classifier itself.

## Classification model

## Canonical levels

- `public`
- `internal`
- `private`

## Signal sources

### Strong sources

These can raise effective sensitivity directly:

- explicit `Sensitivity:` on a standalone task
- explicit top-level `Sensitivity:` on a pipeline
- explicit per-phase `Sensitivity:` in a pipeline phase
- Munin `classification` on any resolved `Context-ref`
- upstream dependency phase effective sensitivity

### Heuristic sources

These are deterministic and local:

- working directory / context alias
- absolute path classification
- prompt-pattern rules
- namespace fallback when a referenced Munin entry lacks explicit classification

## First-pass heuristics

### Filesystem and context heuristics

- `Context: files` or paths under `/home/magnus/mimir` => `private`
- paths under `/home/magnus/.claude`, `/home/magnus/.codex`, or credential/config homes => `private`
- `Context: repo:<name>`, `/home/magnus/repos/...`, `/home/magnus/workspace`, `scratch` => `internal`
- unknown or missing local path context => no downgrade below `internal`

### Context-ref heuristics

If Munin entry classification exists, use it directly.

If it does not, use conservative namespace fallbacks:

- `people/*` => `private`
- `projects/*`, `decisions/*`, `meta/*`, `tasks/*` => `internal`
- anything else => `internal`

### Prompt heuristics

Only include strong private-elevating rules in the first pass, for example:

- credentials and tokens (`password`, `api key`, `secret`, `bearer token`, `private key`)
- personal records (`medical`, `salary`, `bank`, `invoice`, `tax`, `passport`)
- explicitly private user archives (`journal`, `diary`, `personal notes`)

Do not add broad “public-looking” heuristics in the first pass.

## Data model changes

### 1. New shared sensitivity module

Add a new pure module:

- [src/sensitivity.ts](/Users/magnus/repos/hugin/src/sensitivity.ts)

It should contain:

- canonical sensitivity schema and type
- lattice helpers: `compareSensitivity()`, `maxSensitivity()`
- task/pipeline sensitivity assessment schema
- deterministic classifier helpers
- formatting helpers for mismatch reasons and audit metadata

Move sensitivity ownership out of `pipeline-ir.ts` so standalone tasks can use the same model.

### 2. Extend Munin client types and writes

Update [src/munin-client.ts](/Users/magnus/repos/hugin/src/munin-client.ts) to:

- expose optional `classification` on read/query results
- accept optional `classification` in `write()`

This is required so Hugin-generated artifacts inherit effective sensitivity into Munin’s own metadata.

### 3. Extend context resolution to return classification metadata

Update [src/context-loader.ts](/Users/magnus/repos/hugin/src/context-loader.ts) so it returns:

- resolved refs
- missing refs
- per-ref classification
- maximum resolved ref sensitivity

The resolver should stay mechanically simple. It is not responsible for policy, only for surfacing data the classifier can use.

### 4. Standalone task config gains sensitivity assessment

Extend `TaskConfig` in [src/index.ts](/Users/magnus/repos/hugin/src/index.ts) to include:

- `declaredSensitivity?: Sensitivity`
- `effectiveSensitivity: Sensitivity`
- `sensitivityAssessment: ...`

`parseTask()` should parse optional top-level `**Sensitivity:**`.

Classification should happen before execution and before artifact writes, so every status/result write can inherit the effective value.

### 5. Pipeline IR gains declared and effective sensitivity

Update [src/pipeline-ir.ts](/Users/magnus/repos/hugin/src/pipeline-ir.ts):

- pipeline root should store both declared and effective sensitivity
- phases should store both declared and effective sensitivity
- IR should preserve enough source metadata to explain why a phase is private when it was not explicitly declared private

The current `effectiveSensitivity` field on phases can remain, but Phase 5 should stop treating it as a parent copy and compute it explicitly.

### 6. Structured artifacts surface sensitivity explicitly

Update [src/task-result-schema.ts](/Users/magnus/repos/hugin/src/task-result-schema.ts) and [src/pipeline-summary.ts](/Users/magnus/repos/hugin/src/pipeline-summary.ts) to carry:

- declared sensitivity when present
- effective sensitivity
- mismatch indicator when declared < effective

Use a compact structured shape, for example:

```json
{
  "declared": "public",
  "effective": "private",
  "mismatch": true
}
```

Per-phase summaries should expose effective phase sensitivity; top-level summaries should expose effective pipeline sensitivity.

### 7. Lifecycle tags preserve sensitivity

Extend status-tag helpers so `sensitivity:<level>` persists through:

- pending
- blocked
- awaiting-approval
- running
- terminal states

This is for observability and queryability only. Munin `classification` remains the authoritative storage-level control.

## Classification algorithm

## Standalone tasks

For a normal task, compute:

1. parse explicit `Sensitivity:` if present
2. classify prompt + context/working-dir heuristics
3. load `Context-refs` metadata and compute max referenced sensitivity
4. combine all sources with `maxSensitivity()`
5. default to `internal` if nothing stronger exists

Effective task sensitivity = max of:

- declared sensitivity
- prompt/path heuristic sensitivity
- max `Context-ref` sensitivity

## Pipelines

### Pipeline root

Pipeline effective sensitivity = max of:

- declared top-level pipeline sensitivity
- pipeline-level heuristic sensitivity from the whole pipeline document
- maximum phase effective sensitivity

### Pipeline phase

For each phase in topological order:

Phase effective sensitivity = max of:

- pipeline effective sensitivity floor
- phase declared sensitivity
- phase prompt/path heuristic sensitivity
- max effective sensitivity of dependency phases

That gives monotonic propagation through the DAG.

## Mismatch handling

If declared < effective:

- preserve declared value
- set `mismatch: true`
- log the reason in Munin
- write all artifacts using the effective classification

## Dispatcher behavior changes

### Standalone execution path

Update [src/index.ts](/Users/magnus/repos/hugin/src/index.ts) so that:

- task sensitivity is assessed immediately after parse
- claimed task status is written with `classification = effectiveSensitivity`
- markdown `result` and `result-structured` also use `classification = effectiveSensitivity`
- logs mention when explicit sensitivity was ratcheted upward

### Pipeline compile/decompose path

Update [src/pipeline-compiler.ts](/Users/magnus/repos/hugin/src/pipeline-compiler.ts) and [src/pipeline-dispatch.ts](/Users/magnus/repos/hugin/src/pipeline-dispatch.ts) so that:

- top-level pipeline `Sensitivity:` remains supported
- optional phase-level `Sensitivity:` is added
- effective root and phase sensitivities are computed into IR
- `spec`, parent `result`, parent `summary`, and child statuses are all written with the right Munin classification
- child task content includes both declared and effective pipeline sensitivity if needed for auditability

### Control paths

Update [src/pipeline-control.ts](/Users/magnus/repos/hugin/src/pipeline-control.ts), [src/pipeline-summary-manager.ts](/Users/magnus/repos/hugin/src/pipeline-summary-manager.ts), and any shutdown/cancellation paths so resumed/cancelled artifacts preserve the same effective sensitivity instead of falling back to today’s implicit defaults.

## Implementation slices

### Slice 1: shared sensitivity model

- add `src/sensitivity.ts`
- migrate pipeline sensitivity schema ownership there
- add pure tests for ordering, max, mismatch, and heuristic rules

### Slice 2: Munin/context plumbing

- extend Munin client types and writes with `classification`
- extend context loader to surface classification metadata
- add tests for classification-aware reads and fallback namespace heuristics

### Slice 3: standalone task classification

- parse top-level `Sensitivity:` in `src/index.ts`
- compute standalone effective sensitivity
- write sensitivity into status/result/result-structured
- add dispatcher tests for explicit, default, and ratcheted cases

### Slice 4: pipeline propagation

- add optional phase-level `Sensitivity:`
- compute root + per-phase effective sensitivity in compiler
- update `spec`, child drafts, summary, and structured results
- add compiler/summary/dispatch regression tests

### Slice 5: auditability and evaluation support

- add mismatch logging
- ensure all Hugin-generated artifacts carry correct Munin classification
- add corpus fixtures and evaluation helpers

## Test plan

### Unit tests

Add a new test file:

- [tests/sensitivity.test.ts](/Users/magnus/repos/hugin/tests/sensitivity.test.ts)

Cover:

- lattice ordering
- `maxSensitivity()`
- prompt heuristic escalation
- path/context heuristics
- mismatch detection

### Existing test expansions

- [tests/dispatcher.test.ts](/Users/magnus/repos/hugin/tests/dispatcher.test.ts)
  standalone task parsing and result/status classification
- [tests/pipeline-compiler.test.ts](/Users/magnus/repos/hugin/tests/pipeline-compiler.test.ts)
  root and phase sensitivity propagation
- [tests/pipeline-dispatch.test.ts](/Users/magnus/repos/hugin/tests/pipeline-dispatch.test.ts)
  decomposition artifact classification
- [tests/pipeline-summary.test.ts](/Users/magnus/repos/hugin/tests/pipeline-summary.test.ts)
  declared/effective summary fields and mismatch visibility
- [tests/task-result-schema.test.ts](/Users/magnus/repos/hugin/tests/task-result-schema.test.ts)
  standalone and pipeline result sensitivity metadata
- add [tests/context-loader.test.ts](/Users/magnus/repos/hugin/tests/context-loader.test.ts) if the resolver contract changes enough to merit its own file

## Live evaluation plan

Phase 5 should stop at a corpus evaluation before any routing work starts.

### Corpus

Use a fixed, reviewable corpus with at least:

- 4 public tasks
- 4 internal tasks
- 4 private tasks
- 3 mismatch cases where explicit sensitivity is too low
- 3 pipeline cases that exercise dependency propagation

Representative cases:

- public release-note summarization
- internal repo refactor planning
- private archive/task using `Context: files`
- task with `Context-refs: people/...`
- pipeline with top-level `public` but a private downstream phase
- pipeline where a downstream phase inherits `private` from dependency propagation

Do not use real secrets in fixtures. Use synthetic but realistic prompts.

### Acceptance criteria

- zero under-classifications on the corpus
- explicit low declarations are ratcheted upward safely
- every generated artifact’s Munin `classification` matches its effective sensitivity
- parent summaries, child statuses, and structured results agree on effective sensitivity
- no backwards-compat break for tasks that omit `Sensitivity:`

### Live gate

Run the corpus on `huginmunin` and record:

- declared sensitivity
- effective sensitivity
- mismatch count
- artifact classification correctness
- any false-positive internal/private escalations worth tuning before Phase 6

Phase 6 should not begin until this corpus is reviewed and accepted.

## Risks and watchpoints

- If Hugin cannot write Munin `classification`, the Phase 5 design is incomplete for later routing. Fix the client first.
- Overly aggressive prompt heuristics will create operator fatigue and reduce routing usefulness later.
- Under-classifying `Context-refs` is the most serious failure mode; prefer strong fallback defaults there.
- Phase-level sensitivity can drift from parent summary if propagation is recomputed inconsistently. Keep one shared reducer.

## Recommended implementation order

1. Shared sensitivity module and pure tests
2. Munin client + context-loader classification plumbing
3. Standalone task sensitivity
4. Pipeline root/phase propagation
5. Summary/result/schema updates
6. Corpus evaluation on the live system

## Done condition

Phase 5 is done when:

- every task and pipeline phase has an effective sensitivity
- Hugin-generated artifacts carry that sensitivity both structurally and as Munin classification
- propagation through pipeline dependencies is monotonic
- explicit low declarations are ratcheted upward safely and visibly
- the live corpus passes without under-classification
