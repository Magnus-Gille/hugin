# Orchestrator Savings Tracker (PR3) — Design / ADR

**Status:** Accepted (2026-07-04) · **Branch:** `feat/orchestrator-savings-tracker`
**Implements:** PR3 of `docs/orchestrator-redesign.md` ("price model × token volume vs
all-Claude baseline → Munin"). Builds directly on PR2's outcomes/store patterns.

## Context

The orchestrator now routes work to cheap/local models with measured quality
(verdict layer, #140). The remaining unmeasured claim is the economic one: "blended
~15–25× cheaper than all-Claude" (D3) is a design estimate, not a number we log.
`orchestratorOutcomes` carries per-worker cost, `model-pricing.ts` has the Anthropic
baseline (`CLAUDE_BASELINE_MODEL_ID = claude-sonnet-4-6`) and `estimateCostUsd` —
but token counts don't survive into outcomes, planner/synth calls leave no per-call
record at all, and nothing accumulates.

## Decisions

### S1 — Per-call ledger from the engine (all roles), computed per call, not per run

`OrchestrationResult` gains `modelCalls: ModelCallRecord[]` —
`{role, provider, model, ok, inputTokens, outputTokens, costUsd, latencyMs}` — pushed
at every existing `allCosts.push(...)` site (planner, each worker, each verifier,
synthesizer). Engine stays pure; this is bookkeeping of data it already holds.
Savings are computed **per call**, never from `totalCostUsd` — the run total is
all-or-nothing-null (one unknown-cost call nulls it), which would skip savings on any
run with a failed worker.

### S2 — Savings semantics: apples-to-apples over covered calls

For each call with **both token counts known**: `baseline = estimateCostUsd(baselineModel,
inputTokens, outputTokens)`; `actual = call.costUsd ?? estimateCostUsd(call.model, …) ??
uncovered`. A call missing tokens or actual price is **uncovered** — counted
(`uncoveredCalls`) but never guessed. `savedUsd = Σ(baseline − actual)` over covered
calls only; the baseline is priced on the SAME token volume the cheap model actually
used (a conservative, honest counterfactual — no attempt to model that Claude might
have used fewer tokens). Baseline model: `HUGIN_SAVINGS_BASELINE_MODEL` (default
`CLAUDE_BASELINE_MODEL_ID`); must exist in `MODEL_PRICING` or savings are disabled
for the run (logged once).

### S3 — Store: `tasks/_savings`/`report`, verdict-store mechanics verbatim

Same pattern as `tasks/_verdicts` (#140): single Munin doc, batched CAS
read-modify-write (one read+write per run), retry-once-then-drop, detached
fire-and-forget (`void …record().catch()`), rows sanitized on parse
(finite nonnegative numbers else drop), unknown `schemaVersion` → read-only + log.
Shares the dedicated background Munin client created for the verdict store (both are
low-stakes background writers; the point of that client is isolation from the task
path, not one-client-per-store).

Doc shape (counters only; ratios derived at read time):
```json
{"schemaVersion": 1,
 "totals": {"runs", "coveredCalls", "uncoveredCalls", "inputTokens", "outputTokens",
            "actualCostUsd", "baselineCostUsd"},
 "byModel": {"<provider>|<modelId>": {"calls", "inputTokens", "outputTokens",
             "actualCostUsd", "baselineCostUsd"}}}
```
`savedUsd` and the savings multiple are derived (`baseline − actual`,
`baseline/actual`), never stored. Costs are stored as USD floats; rows are keyed
`provider|model` (bare gateway slugs stay unambiguous).

### S4 — Per-task surfacing

- `result-structured` gains optional `savings` object: `{baselineModelId,
  coveredCalls, uncoveredCalls, actualCostUsd, baselineCostUsd, savedUsd}` (additive,
  follows `orchestratorOutcomes` precedent).
- `orchestratorOutcomes` rows gain optional `inputTokens`/`outputTokens` (additive) —
  closing the gap that motivated S1 and making outcomes self-sufficient for offline
  analysis.
- The human-readable result gains one line: `Savings vs <baseline>: $X.XXXX
  (actual $Y.YYYY, N covered / M uncovered calls)` when savings were computed.

### S5 — Config

| Var | Default | Meaning |
|---|---|---|
| `HUGIN_ORCH_SAVINGS` | `on` | Master switch for recording + per-task surfacing. `off` = no reads/writes, no result field. |
| `HUGIN_SAVINGS_BASELINE_MODEL` | `CLAUDE_BASELINE_MODEL_ID` | Counterfactual model id; must be in `MODEL_PRICING`. |

## Non-goals

- Heimdall panel for savings (descriptor + plugin work — separate `from:hugin` ticket
  after the data accumulates).
- Savings for non-orchestrator runtimes (claude/codex/ollama tasks) and the broker
  (orch-v1) lane.
- Modeling baseline token counts (we price the baseline on actual token volume).
- Cost-aware routing changes (the router already ranks by price; this PR measures).
