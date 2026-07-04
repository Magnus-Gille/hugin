# Orchestrator

Hugin's native fanout engine (`Runtime: orchestrator`): a planner decomposes the task
into subtasks, cheap workers execute them concurrently, an optional verifier checks
each output, and a synthesizer merges survivors into the final answer. Design docs:
[docs/orchestrator-redesign.md](../../docs/orchestrator-redesign.md),
[docs/orchestrator-verdict-layer.md](../../docs/orchestrator-verdict-layer.md) (#140),
[docs/orchestrator-savings-tracker.md](../../docs/orchestrator-savings-tracker.md) (#142, #144).

## Savings data: which series to read

The savings tracker reports **two series**:

- `savedUsd` — the RAW series: `baselineCostUsd − actualCostUsd` over covered calls,
  no verdict conditioning.
- `qualityAdjustedSavedUsd` — the QUALITY-ADJUSTED series (issue #144):
  `qaBaselineCreditUsd − actualCostUsd`, where baseline credit is granted only for
  work that actually held up (see below). Can be negative.

> **THE RULE — any consumer that uses savings data for DECISIONS (routing, model
> selection, delegation policy, dashboards that drive action) MUST read the
> quality-adjusted series (`qualityAdjustedSavedUsd`, or the derived lifetime
> equivalent `totals.qaBaselineCreditUsd − totals.actualCostUsd`), NEVER the raw
> `savedUsd`.** The raw series systematically flatters delegation: a cheap local
> attempt that fails verification still books its full baseline delta as "savings",
> so anything optimizing against it learns to prefer cheap-and-subtly-wrong. The raw
> series is kept only for comparability and debugging.

## How the quality adjustment works

Every worker and verifier call in the engine's per-call ledger carries the
`subtaskId` it was spent on. At savings-computation time (after the run completes —
verification happens inside the run, so every verdict is final by then) each call is
joined to its subtask's verdict outcome and earns baseline credit per these rules:

| Call | Subtask outcome | Baseline credit | Rationale |
|---|---|---|---|
| worker | `pass` | full | Verified correct — the baseline cost was genuinely avoided. |
| worker | `unknown` | full | Never verified this run. Trusted because adaptive verify only skips verification for evidence-based `delegate-local` rows (and re-probes them) — but surfaced separately in `byOutcome` so consumers can discount it. |
| worker | `fail` / `error` / `escalated` | zero | The work still has to be done at the frontier; nothing was avoided. The local spend books as a loss. |
| verifier | any | zero | The all-Claude counterfactual doesn't verify. Verification is overhead CAUSED by delegating locally, so its full cost is attributed back to the local attempt — never booked as neutral independent frontier spend. |
| planner / synthesizer | (run-level, no `subtaskId`) | full | Their output is used regardless of any single subtask's verdict; same treatment as the raw series. |

`escalated` is reserved: the engine has no escalation/retry path yet. When one is
added, escalation calls MUST carry the originating `subtaskId` so their cost is
attributed to the local attempt that caused them.

A call missing token counts or a resolvable price is *uncovered* in both series —
counted, never guessed.

## Where the data lives

**Per task** — the structured result's optional `savings` field
(`src/task-result-schema.ts#savingsSummarySchema`):

```json
{
  "baselineModelId": "claude-sonnet-4-6",
  "coveredCalls": 4, "uncoveredCalls": 0,
  "actualCostUsd": 0.72, "baselineCostUsd": 36.45, "savedUsd": 35.73,
  "qaBaselineCreditUsd": 18.45, "qualityAdjustedSavedUsd": 17.73,
  "byOutcome": {
    "pass":  { "calls": 2, "actualCostUsd": 0.72, "baselineCostUsd": 18.45, "qaBaselineCreditUsd": 18.0 },
    "fail":  { "calls": 2, "actualCostUsd": 0.30, "baselineCostUsd": 18.0,  "qaBaselineCreditUsd": 0 }
  }
}
```

Both series also render as one line each in the human-readable result summary
(`Savings vs <baseline>: …` and `Quality-adjusted savings: …`).

**Lifetime aggregate** — the Munin doc `tasks/_savings` / `report`
(`src/orchestrator/savings-store.ts`): `totals` carries `qaBaselineCreditUsd`
alongside the raw counters, and the doc carries `byOutcome` buckets keyed by
verdict outcome. Ratios and savings are derived at read time, never stored:

- raw: `totals.baselineCostUsd − totals.actualCostUsd`
- **quality-adjusted (use this): `totals.qaBaselineCreditUsd − totals.actualCostUsd`**
