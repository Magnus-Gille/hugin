# Journal Analysis — Evaluation Track Scoping

**Status:** Draft scope, awaiting approval
**Date:** 2026-04-25
**Purpose:** Produce evidence to make a falsifiable go/no-go decision on the orchestrator stack (per `debate/orch-stack-summary.md`). Does not prejudge the answer.

---

## Why this exists

The Codex debate concluded the orchestrator stack has not earned priority over the multi-host sprint. The agreed gate before any orchestrator code is written:

> Run a falsifiable go/no-go evaluation using existing telemetry plus a fixed benchmark of manual local-only delegations.

The four numeric thresholds the orchestrator stack must clear to be worth building:

| Gate | Threshold |
|---|---|
| Token-cost reduction (orchestrator vs. status-quo Claude) | ≥ 20 % |
| p95 latency increase | ≤ 2× |
| Escalation rate (Ollama → Claude redo) | ≤ 30 % |
| New stuck-running states introduced | 0 |

This document scopes the analysis that produces the evidence to evaluate the first three. Stuck-running is a runtime property and is checked separately during the manual benchmark.

---

## Inputs

- **Journal:** `~/.hugin/invocation-journal.jsonl` on `huginmunin.local` (Pi). 261 entries as of 2026-04-25 (172 claude, 89 ollama).
- **Append site:** `src/index.ts:3465-3484`.
- **Per-runtime fields available:**
  - **All:** `ts, task_id, repo, runtime, executor, model_requested, exit_code, duration_s, timeout_ms, cost_usd, group, quota_before, quota_after, cancellation_reason, cancellation_source`.
  - **Ollama extras:** `runtime_requested/effective, host_requested/effective, model_effective, fallback_triggered, fallback_reason, prompt_tokens, completion_tokens, total_tokens, inference_ms, load_ms, prompt_chars, output_chars, free_mem_before/after_mb, context_refs_*, injection_policy, external_policy, max_provenance, external_blocked`.
- **No tokens recorded for Claude runs.** This is the first known gap — see Limitations.

---

## Track A — Static analysis of the existing journal

Two artifacts:

1. **`scripts/analyze-journal.mjs`** — one-shot Node script, reads JSONL from `--input` (default `~/.hugin/invocation-journal.jsonl`), writes a markdown report to `--out` (default stdout). No deps beyond `node:fs`. Pure aggregation, no external calls.
2. **`docs/research/journal-analysis-report.md`** — the report it produces, committed for traceability.

### Questions the report must answer

Each question maps to a section in the report. Numbers, not narrative.

| # | Question | What it answers |
|---|---|---|
| 1 | Cost distribution by `runtime` × `model_requested` (sum, p50, p95 of `cost_usd`) | What share of spend is concentrated where? |
| 2 | Duration distribution by `runtime` × `model_requested` (p50, p95 of `duration_s`) | Latency baseline for the ≤2× gate |
| 3 | Cost per `repo` (top 10) | Which repos drive spend? Concentration test |
| 4 | Failure rate (`exit_code != 0` ÷ total) by runtime, by model | Quality baseline for the ≤30 % escalation gate |
| 5 | Cancellation rate and reason histogram | Does cancellation noise dominate any class? |
| 6 | Ollama-only: fallback rate, escalation reasons, output-token distribution | What proportion of Ollama runs already fail back to Claude today? |
| 7 | Group/Sequence presence: how many tasks ran as multi-step? | Is the existing pipeline path used at all? |
| 8 | Prompt-token and prompt-char distribution (Ollama only — Claude has no token data) | What fraction of Claude runs have prompts small enough that local could plausibly handle them? Use `repo` + `task_id` heuristics as a proxy. |

### Heuristic: which Claude tasks "look delegable"

The journal has no prompt content, no labels, no runtime spend without tokens. The closest signal we have is:

- `cost_usd` low + `duration_s` short → mechanical task
- `repo` matches a known low-stakes context (`scratch`, daily journal, hygiene scripts)
- `task_id` patterns from `submit-*.sh` scripts (deterministic prefix)
- Heartbeat/status-poll-style names

Report should produce a **candidate-delegable bucket** by intersecting these signals and report:
- Count, total cost, p50/p95 duration of the bucket
- What fraction of total Claude spend the bucket represents

If the bucket is < 10 % of total Claude spend, the orchestrator stack cannot clear the 20 % gate without including riskier tasks. That is a no-go signal at the static-analysis stage.

### Decision criteria from Track A alone

| Outcome | Action |
|---|---|
| Candidate-delegable bucket ≥ 20 % of Claude spend | Proceed to Track B (manual benchmark) |
| Bucket < 10 % | Stop. Recommend deferring orchestrator stack indefinitely, document in `decisions/`. |
| Bucket 10–20 % | Marginal. Proceed to Track B but with a smaller benchmark (5 tasks instead of 15) and a higher quality bar. |

---

## Track B — Manual delegation benchmark

Only run if Track A passes. Goal: take a fixed task set, run each through both Claude (status quo) and a chosen Ollama config (local-only, no OpenRouter, no new trust tier), compare token cost and quality.

### Selection

- 10–20 tasks pulled from the candidate-delegable bucket identified by Track A.
- Stratified across `repo` and `model_requested` so no single source dominates.
- Each task represented as a Hugin submission (already what we have — these are real journal entries).
- Tasks are **replayed by hand**, not auto-rerun. The point is to evaluate quality with eyes on the output.

### Method

For each benchmark task:

1. Submit to Hugin with `Runtime: claude` (or whatever it ran originally) — record output, cost, duration.
2. Submit to Hugin with `Runtime: ollama, Model: <local model>, Fallback: none` — record output, prompt+completion tokens, duration, fallback reason if any.
3. Manually grade Ollama output: `pass` (acceptable as-is), `escalate` (needs Claude redo), `fail` (wrong answer).
4. Record per-task row in `docs/research/journal-benchmark-results.md`.

### What "Ollama config" means

To keep this experiment cheap, do **not** introduce anything new:

- Local Pi Ollama only (`OLLAMA_PI_URL`).
- Existing models already pulled (no new downloads).
- No OpenRouter. No `cloud-third-party` trust tier. No `infer_direct`. No `priority` field.
- Existing context-refs path. No prompt-engineering rounds — single-shot.

If the local-only experiment fails the gates, adding cloud routing or smarter prompts would not save it.

### Aggregate gates

| Gate | Threshold | Computed as |
|---|---|---|
| Token-cost reduction | ≥ 20 % | `(sum_claude_cost − sum_ollama_inferred_cost) ÷ sum_claude_cost` where Ollama cost is imputed as the marginal infra cost (≈ 0 for self-hosted Pi) plus escalation cost |
| p95 latency multiplier | ≤ 2× | `p95(ollama_duration) ÷ p95(claude_duration)` for benchmark tasks only |
| Escalation rate | ≤ 30 % | `count(escalate) + count(fail) ÷ total_tasks` |
| Stuck-running | 0 | Operational check during the run |

The first gate has a subtlety: pure infra cost on the Pi is ~$0, so naively the reduction is 100 %. The real comparison is **Anthropic spend avoided** vs. **escalation cost when Ollama fails**. Concretely:

```
saved   = Σ claude_cost(task)            for tasks where ollama passed
spent   = Σ claude_cost(task)            for tasks that escalated (paid twice)
        + opportunity cost of latency    (qualitative)
net     = saved − spent
gate    = net ÷ Σ claude_cost(all)       ≥ 20 %
```

### Decision criteria from Track B

| Outcome | Action |
|---|---|
| All four gates pass | Re-open orchestrator stack design with the concessions from `debate/orch-stack-summary.md` baked in. |
| Token-cost gate fails | Stop. Local-only delegation is not economic; cloud delegation cannot rescue this without a new trust tier the debate flagged as cross-cutting. |
| Latency gate fails | Stop or scope down to async-only tasks (no synchronous orchestrator). |
| Escalation rate fails | Stop. Quality is the load-bearing assumption; if it fails on hand-picked candidates, it will fail on the unfiltered population. |

---

## Limitations to document up front

These are gaps the analysis cannot close — list them in the report so future readers don't over-trust the numbers:

1. **No prompt-token data for Claude runs.** All token-cost comparisons rely on `cost_usd` from the journal, which is inferred from billing not from prompt size. We cannot say "this task had a 200-token prompt and could run on a 3B model".
2. **No quality grading on historical runs.** We're inferring "this could have been Ollama" from cost/duration heuristics, not from output content. Track B's manual grading is the only quality signal.
3. **Population bias.** 261 entries skew toward what Magnus actually submitted in 2026-Q1. Future workload composition may differ.
4. **No stuck-running comparison.** #57 was just fixed; the journal predates the fix. Stuck-running rate cannot be back-computed from the existing corpus.
5. **Pi is single-host.** Multi-host sprint will change the cost/latency profile. This evaluation freezes that variable; it should be redone after multi-host lands if the answer is borderline.

---

## Cost estimate

| Track | Wall-clock | LOC |
|---|---|---|
| A: static analysis script + report | 2–3 hours | ~250 LOC `analyze-journal.mjs` + ~400 LOC report (mostly tables) |
| B: 15-task manual benchmark | 4–6 hours (mostly waiting on Ollama) | 0 (uses existing Hugin submission paths) + ~200 LOC results report |
| **Total** | **6–9 hours** | **~250 LOC code, rest documentation** |

Compared to the orchestrator stack's ~2,090 LOC estimate, this is < 15 % of the cost, and most of that is documentation that retains value regardless of outcome.

---

## What this scope deliberately excludes

- Any change to the journal schema. If the analysis reveals a missing field, propose schema v2 in a separate doc.
- Any new runtime, MCP tool, executor, or skill.
- Any benchmark that requires non-local inference.
- A "scoring" framework. Grading in Track B is `pass / escalate / fail` — three buckets, eyeball judgement, recorded with a one-line reason.
- Anything that touches multi-host. The analysis runs on the existing single-Pi setup.

---

## Acceptance checklist

This scope is approved to proceed when:

- [ ] User confirms the four gate thresholds are still correct
- [ ] User confirms Track A → Track B handoff criteria (≥ 20 %, 10–20 %, < 10 %)
- [ ] User confirms the limitations list is acceptable (especially "no prompt-token data for Claude")
- [ ] User confirms multi-host sprint stays the priority and this analysis runs in parallel, not blocking it

After approval: Track A is implementable as a single afternoon task. Track B is gated on Track A's outcome.
