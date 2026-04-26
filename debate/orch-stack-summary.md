# Orch Stack Debate Summary

**Date:** 2026-04-25
**Topic:** Hugin Orchestrator Stack — design and build order for enabling Claude Code to delegate cheap subtasks to Ollama/OpenRouter via Hugin
**Participants:** Claude (proposer), Codex gpt-5.4 xhigh (adversarial reviewer)
**Rounds:** 2

---

## Starting Position

A four-component plan: (1) telemetry schema v2, (2) OpenRouter executor, (3) `hugin-mcp` package, (4) orchestrator skill. Build order: schema → executor → MCP → skill. Estimated ~2,090 LOC over ~5–6 days. Core claim: Claude Code can orchestrate subtask delegation to save Anthropic token spend.

---

## Concessions Accepted by Claude

| Finding | Substance |
|---|---|
| **Latency premise stale** | `think:false` cut Pi Ollama from ~90s to ~2s. Async-queue justification was built on outdated data. Split design (direct sync for fast; queue for slow) is correct. |
| **OpenRouter routing semantics undefined** | `semi-trusted + per-token` loses to Ollama in every router decision. A new `cloud-third-party` trust tier is needed before writing the executor — but this raises a reversibility concern too. |
| **Schema v2 premature** | Existing journal telemetry is richer than the draft acknowledged. Run journal analysis first; defer `orchestratorRating` schema; build `proxy-checks.ts` standalone. |
| **`infer_direct` security regression** | Documentation-only control is inconsistent with Hugin's existing scanning posture. Structural controls required: 500-char cap, local Ollama only, no Context-refs, forced public sensitivity, audit log. |
| **Hugin is serial, not a parallel worker pool** | Delegation's value is token offload + model offload + async offload — not parallel speedup. Value proposition restated. |
| **No success gate** | Added explicit numeric thresholds: ≥20% token reduction, ≤2× latency, ≤30% escalation rate, zero new stuck-running states. |

---

## Defenses Accepted by Codex

- **MCP abstraction is correct.** Thin MCP hiding submission mechanics is better than teaching the orchestrator skill to hand-roll task IDs, front-matter, signing, and await logic.
- **Semantic decomposition belongs in the skill, not the router.** The static policy engine in `router.ts` is not a semantic planner. The distinction is valid.
- **`infer_direct` structural controls (Round 2).** The revised controls — 500-char cap, local-only, forced public, audit log — are adequate as a design correction.
- **Serial-dispatcher reframe (Round 2).** Conceding that delegation is token/model/async offload (not parallelism) is a real improvement.

---

## Unresolved Disagreements

### 1. Scope of the #57 gate
**Claude:** #57 must precede `hugin_rate`; the rest of the stack can proceed in parallel.
**Codex:** All new task submission paths increase completion-path churn before non-atomic completion is fixed. The gate should be broader.
**Status:** Acknowledged, not resolved. A conservative reading (Codex's) would delay MCP submission tools until #57 is fixed.

### 2. Priority vs. multi-host sprint
**Claude:** Schema + OpenRouter executor are additive and don't conflict with multi-host.
**Codex:** The approved next architectural move is DIY multi-host. Orchestrator stack has not earned displacement of that with evidence — build order is still implementation-then-validation.
**Status:** This is the core unresolved tension. Codex's final verdict (below) directly addresses it.

### 3. New trust tier timing
**Claude:** Define `cloud-third-party` before writing OpenRouter executor.
**Codex:** Adding a new cross-cutting trust class before earning reversibility is a coupling cost the plan doesn't account for. OpenRouter may not belong in v1 at all — first prove local-only orchestration is worth anything.

---

## New Issues Raised in Round 2

- **`Group:` / `Priority:` starvation concern** — proposing `priority: high` subtasks introduces new scheduler scope (parser changes, priority field, queue ordering) that was not in scope. `Group:` already has different semantics and cannot be repurposed.
- **Reversibility cost of new trust tier** — `cloud-third-party` is cross-cutting; removing it later requires touching `runtime-registry`, routing rank, sensitivity ceilings. Local-only experiment stays reversible; new trust class does not.

---

## Final Verdict (Codex)

> **Priority has not been earned.** The single most important next step before any code is written is: run a falsifiable go/no-go evaluation using existing telemetry plus a fixed benchmark of manual local-only delegations, and use that to decide whether orchestration deserves priority at all.
>
> 1. Use the existing journal and a fixed task set to measure token savings, wall-clock impact, escalation rate, and queue impact.
> 2. Keep the experiment local-only first — no OpenRouter, no new trust tier, no new scheduler semantics.
> 3. Compare against the opportunity cost of continuing the approved DIY multi-host sprint.
>
> If the experiment passes, argue about proxy-checks, MCP shape, and external runtimes. If not, the correct outcome is: do not prioritize this now.

---

## Action Items

| # | Item | Owner | Blocks |
|---|---|---|---|
| 1 | Fix #57 (non-atomic task completion) | Magnus | `hugin_rate`, new submission paths |
| 2 | Run journal analysis: extract token/cost/latency signal from existing Hugin logs | Magnus | Decision on schema v2 |
| 3 | Define falsifiable go/no-go benchmark: 10–20 tasks, measure token savings and escalation rate using local-only manual delegation | Magnus | Any new code |
| 4 | If go/no-go passes: design `cloud-third-party` trust tier **with explicit rollback plan** | Magnus | OpenRouter executor |
| 5 | Multi-host sprint: continue DIY implementation per orchestrator-sweep decision | Magnus | Mac Studio purchase gate |

---

## Files

- `debate/orch-stack-claude-draft.md`
- `debate/orch-stack-claude-self-review.md`
- `debate/orch-stack-codex-critique.md`
- `debate/orch-stack-claude-response-1.md`
- `debate/orch-stack-codex-rebuttal-1.md`
- `debate/orch-stack-summary.md`
- `debate/orch-stack-critique-log.json`

---

## Costs

| Invocation | Wall-clock time | Model version |
|---|---|---|
| Codex R1 | ~4m | gpt-5.4 xhigh |
| Codex R2 | ~3m | gpt-5.4 xhigh |
