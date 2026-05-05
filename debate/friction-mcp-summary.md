# Debate Summary: friction-mcp

**Date:** 2026-05-05  
**Participants:** Claude (author), Codex gpt-5.5 xhigh (adversary)  
**Rounds:** 2  
**Topic:** Whether to build a `report_friction` MCP tool for AI self-reporting of capability gaps, environmental failures, and task specification problems — and whether to do it now.

---

## Concessions accepted by Claude

**Critical — changed position:**

- **Priority inverted.** The broker is not yet enabled; `hugin_rate` has never been dogfooded. Building a new telemetry surface before exercising the existing feedback path is the wrong order. Friction-mcp is deferred until after orch-v1 is enabled and a rated delegation corpus exists.
- **Gap not proven.** The plan rejected `hugin_rate` as "insufficient" before it had been used. The precondition for any self-report experiment is a concrete blind spot that `hugin_rate` + existing journal telemetry cannot explain.
- **Schema doesn't speak the router's language.** `cheap/mid/frontier/local-large` is not the active alias vocabulary (`tiny/medium/large-reasoning/pi-large-coder`). If friction signals are ever meant to inform routing, they must use `alias_suggested` and `runtime_row_id_effective`.
- **Aggregation needs denominators.** Friction rate cannot be computed from `signals/friction/*` alone; it requires a join against all tasks (including zero-friction tasks) from the delegation journal.
- **Trust/provenance gap.** Model-authored events must not be written as `Classification: internal` without `source:model-self-report`, `observer_model`, and `schema_version` tags. The broker contract already encodes this discipline for submissions — friction events need the same.
- **Degradation must be lossy by design.** Write failures must not block task execution, must not trigger model-visible retries, and must drain within a hard timeout (~2s). Dropped events should be counted for operator visibility.
- **Success criteria too weak.** "Tool writes to Munin" is an implementation milestone. Real success is: friction self-report correlates with `hugin_rate` outcomes better than existing telemetry, on a pre-registered task set.

**Major — partially changed:**

- **`resource_assessment` reframed.** Not a "direct routing signal" — it is a *candidate signal* requiring calibration against outcomes, model family, and task type before it can drive decisions.
- **SDK injection scope narrowed.** The original plan framed multi-runtime comparison (laptop, MBP, Strix Halo AI+) as the primary use. The hardware doesn't exist yet. SDK injection should be scoped to Claude SDK tasks only, described honestly, and deferred until the signal is validated.

---

## Defenses accepted by Codex

- **Self-reported friction is not useless in principle.** Codex's own recommended experiment (20-50 task comparison testing whether self-report adds predictive value) implicitly accepts the signal might be worth something. The question was always *when* and *how* to validate it cheaply.
- **Per-task stdio MCP is lower operational burden than a new long-running service.** The corrected claim — that friction-mcp would avoid a new database and daemon *if it ever graduates from experiment* — is defensible.

---

## New issues from Round 2

- **Observer identity ambiguity.** The revised experiment collapses two different products: *evaluator annotation* (orchestrating Claude reviewing output post-hoc) and *delegate self-report* (executing model during task). These have different trust properties and potentially opposite biases. A frontier orchestrator saying "the small model was under-resourced" is different data from the small model saying it. They must be tracked separately.
- **Explicit kill criteria missing.** The plan needs to name conditions under which friction-mcp is *not* built — if the journal experiment shows existing telemetry is sufficient, the outcome should be "no friction-mcp," not a polished deferred design.
- **SDK injection targets the wrong path.** The active orch-v1 broker routes through OpenRouter, not the Claude Agent SDK executor. Injecting into `sdk-executor.ts` would miss the very corpus needed for baseline validation.

---

## Unresolved disagreements

None material — both sides converged on the same next step and sequencing. Codex's sample-size concern (20-30 tasks too small for multi-model/alias claims) is valid but moot until the experiment is actually designed.

---

## Final verdict

**Both sides:** The single most important next step is finishing and dogfooding the existing orch-v1 feedback loop — enable the broker, register `hugin-mcp`, write `/delegate`, and collect the first rated delegation corpus.

Friction-mcp is not cancelled — the concept is sound. It is correctly deferred until:
1. The delegation journal has real outcomes
2. A specific diagnostic blind spot is identified that `hugin_rate` + existing telemetry cannot explain
3. The smallest possible experiment (optional journal fields, not a new MCP) tests whether self-report adds predictive signal

Build a separate `friction-mcp` only if that experiment demonstrably changes routing decisions and beats the baseline. Include explicit kill criteria: if the journal experiment shows no incremental value, the outcome is "no friction-mcp."

---

## Action items

| Item | Owner | Notes |
|------|-------|-------|
| Enable broker (`HUGIN_BROKER_KEYS`), register `hugin-mcp` | Magnus | Existing next step from STATUS.md |
| Write `/delegate` skill | Claude/Magnus | Depends on broker being live |
| Run 20-30 real delegations with `hugin_rate` outcomes | Magnus | Baseline corpus |
| Review corpus: identify blind spots in existing telemetry | Claude/Magnus | Precondition for any friction work |
| If blind spot found: add optional `resource_assessment` + `friction_note` to `hugin_rate`, not a new MCP | deferred | Smallest experiment |
| Update plan file to reflect deferred status | Claude | Done during this session |

---

## Critique point statistics

| Round | Points raised | Critical | Major | Minor |
|-------|--------------|---------|-------|-------|
| Round 1 | 11 | 2 | 7 | 2 |
| Round 2 | 5 | 0 | 3 | 2 |
| **Total** | **16** | **2** | **10** | **4** |

Self-review catch rate: 3/16 (19%) — the self-review caught degradation semantics, success criteria, and the self-review-absorption meta-issue, but missed the two critical blockers (priority and the duplication of the unfinished loop) and most of the major architectural findings.

---

## Debate files

- `friction-mcp-snapshot.md` — original plan
- `friction-mcp-claude-draft.md` — Claude's position paper
- `friction-mcp-claude-self-review.md` — pre-Codex self-review
- `friction-mcp-codex-critique.md` — Round 1 critique
- `friction-mcp-claude-response-1.md` — Claude's response
- `friction-mcp-codex-rebuttal-1.md` — Round 2 rebuttal
- `friction-mcp-critique-log.json` — structured critique log
- `friction-mcp-summary.md` — this file

---

## Costs

| Invocation | Wall-clock time | Model |
|------------|-----------------|-------|
| Codex R1 | ~5m | gpt-5.5 xhigh |
| Codex R2 | ~3m | gpt-5.5 xhigh |
