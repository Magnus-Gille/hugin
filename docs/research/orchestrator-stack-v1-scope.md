# Orchestrator Stack v1 — Scope

> **⚠ Superseded by [`docs/orchestrator-v1-data-model.md`](../orchestrator-v1-data-model.md).**
>
> This scope doc is kept for historical context. The contract spec is the single source of truth. Notable contract changes since this doc was written:
>
> - **`hugin_run` (sync) is dropped.** A 30s poll + serial dispatcher cannot deliver real sync. v1 is async-only: `hugin_submit` + `hugin_await`.
> - **Single `~/.hugin/orchestrator-journal.jsonl` is replaced** by an append-only `delegation-events.jsonl` event log + read-time projection. Hugin is the sole journal writer; the laptop MCP never writes to a Pi-side journal.
> - **Pi-harness (Option B)** entered v1 scope after a parallel-session aider eval (`pi --no-session --provider openrouter` against `qwen/qwen3-coder-next` scored 5/6 strict, 6/6 lenient). Worktrees live on the Pi; Hugin never auto-pushes; diffs return to Claude for review.
> - **Stable aliases** (`tiny`, `medium`, `large-reasoning`, `pi-large-coder`) replace literal model names at the MCP boundary.
> - **Pi-side broker** with Tailscale-only bearer auth replaces laptop-side signing keys for orchestrator submissions.
> - **Orthogonal policy fields** (`provider`, `egress`, `zdrRequired`, `autoEligible`) replace stretching the trust tier.

**Status:** Superseded — see banner above.
**Date:** 2026-04-25
**Decision:** Build it. Run it. Learn from real usage. Defer the formal go/no-go evaluation until we have a corpus of real ratings.

## What we're building

A way for Claude Code (in an interactive session) to delegate sub-tasks to cheaper inference — local Ollama on the Pi or MBA, or OpenRouter as a proxy for the future Mac Studio. Three pieces:

1. **`hugin-mcp`** — MCP server exposing 5 tools to Claude Code
2. **OpenRouter executor** in Hugin — new runtime alongside `ollama` and `claude`
3. **`delegate` skill** — `~/.claude/skills/delegate/` — guidelines for *when* and *what* to delegate, not just *how*

Plus a separate journal for delegation telemetry so we can analyze it without polluting the main Hugin journal.

## Decisions locked

| # | Decision | Value |
|---|---|---|
| 1 | Entry point | Skill (`delegate`), Claude consults it when orchestrating; tooling lives in MCP |
| 2 | Sync vs async | Both — Claude picks per call (`hugin_run` for sync ≤ 30s tasks, `hugin_submit` + `hugin_await` for async) |
| 3 | OpenRouter in v1 | Yes — needed to test "is the Studio good enough" before buying |
| 4 | Transport | MCP server, not CLI or direct HTTP |
| 5 | Orchestrator logic location | Skill (under Claude's control, not hardcoded in MCP) |
| 6 | Heuristics | Both — skill gives guidelines + Claude has discretion. Always log enough data to refine guidelines later. |
| 7 | Quality rating | **Always** — every delegated call rated `pass / partial / redo / wrong` + one-line reason via `hugin_rate` |
| 8 | Telemetry storage | New file `~/.hugin/orchestrator-journal.jsonl`, full prompts + outputs (Pi disk is cheap, corpus value is high) |
| 9 | Pi model | `qwen2.5:3b` (only viable Pi model per `ollama-performance-spike.md`) |
| 10 | MBA model (M4, 32 GB) | `qwen3:14b` (validated via aider eval, runs cleanly) |
| 11 | Studio proxy via OpenRouter | `gpt-oss-120b` (general/reasoning) + `qwen3-coder` (code) — same shortlist as the harness eval |
| 12 | Model picker | Claude picks via the skill's guidelines. MCP rejects unknown models. |
| 13 | OpenRouter trust | "Anything goes" for the trial — OpenRouter is a Studio proxy, treated as `internal` ceiling. **ZDR-only:** MCP fetches the OR model catalog at startup and rejects models without zero-data-retention policy. |
| 14 | Fallback on failure | Hard fail. MCP returns the error to Claude; skill decides whether to retry on a different runtime or escalate to itself (Claude). No automatic Claude fallback — that hides the failure signal. |
| 15 | Sensitivity guard | No content blocking. Trust Claude. ZDR enforcement on OpenRouter is the only hard floor. |
| 16 | Skill path | `~/.claude/skills/delegate/` |
| 17 | "v1 done" criterion | Magnus decides — eat your own dogfood, iterate, evaluate when there's enough signal |

## MCP tools

```
hugin_submit(prompt, runtime?, model?, host?, sensitivity?, capabilities?, timeout?, task_type)
  → { task_id, expected_duration_estimate }
  Submits an async task. Returns immediately.

hugin_await(task_id, timeout?)
  → { status, output, tokens, cost, duration, model_effective, host_effective, fallback_triggered }
  Blocks until the task completes or timeout. Polls Munin under the hood.

hugin_run(prompt, runtime?, model?, host?, sensitivity?, capabilities?, timeout?, task_type)
  → { output, tokens, cost, duration, model_effective, host_effective }
  Synchronous wrapper. Submit + await in one call. For tasks under ~30s.

hugin_rate(task_id, rating, reason)
  → { ok }
  rating: "pass" | "partial" | "redo" | "wrong"
  reason: one-line string
  Records Claude's quality grade in the orchestrator journal. Required after every delegation.

hugin_list(filter?)
  → [{ task_id, runtime, model, status, cost, duration }, ...]
  Lists Claude's recent delegations in the current session for inspection.
```

`task_type` is a Claude-supplied tag from a small enum: `summarize | extract | draft | code-edit | reason | classify | other`. Used for retrospective analysis — what task types have which quality profile on which models.

## Orchestrator journal schema

`~/.hugin/orchestrator-journal.jsonl`, one record per delegated call. Append-only. Different from the main Hugin journal because cardinality and consumers differ.

```json
{
  "ts": "2026-04-25T...",
  "task_id": "20260425-...",
  "parent_session_id": "<claude-code-session-uuid>",
  "task_type": "summarize",
  "runtime": "ollama" | "openrouter",
  "model_requested": "qwen3:14b",
  "model_effective": "qwen3:14b",
  "host": "pi" | "mba" | "openrouter",
  "sync": true | false,
  "prompt": "<full prompt text>",
  "prompt_chars": 1234,
  "prompt_tokens": 432,
  "output": "<full output text>",
  "output_chars": 2345,
  "completion_tokens": 567,
  "duration_s": 4.2,
  "load_ms": 120,
  "cost_usd": 0.00021,
  "exit_code": 0,
  "fallback_triggered": false,
  "rating": "pass",
  "rating_reason": "correct summary, no edits needed",
  "rated_at": "2026-04-25T...",
  "sensitivity": "internal",
  "zdr_enforced": true
}
```

The `rating` and `rating_reason` fields are populated when `hugin_rate` is called — `null` until then. A periodic check can flag unrated tasks.

## OpenRouter executor — minimum viable

- New runtime `openrouter` in `runtime-registry.ts`, trust tier reused as `semi-trusted` (no new tier introduced — the debate flagged this as cross-cutting; for v1 we treat OR as Claude-equivalent trust).
- HTTPS client to `https://openrouter.ai/api/v1/chat/completions`, OpenAI-compatible.
- Reads `OPENROUTER_API_KEY` from env on Pi.
- ZDR enforcement: at startup, fetch `/api/v1/models`, filter to `data_policy.zero_data_retention === true`, build allowlist. Reject any task targeting a non-allowlisted model.
- Cost tracking from response `usage` block + OR's per-model pricing table (cached).
- Same `Sensitivity:` cap as Claude (`internal`).
- Same exfiltration scanner pass on output as other cloud runtimes.

## Delegate skill — what it actually says

The skill is the orchestration brain. It tells Claude:

1. **When to consider delegating.** Heuristics: small focused prompt (< 4 KB), mechanical transformation (summarize/extract/classify/reformat), no need for repo context or multi-file reasoning, output verifiable by Claude after.
2. **How to pick the runtime.**
   - Pi `qwen2.5:3b` for tiny mechanical tasks (≤ 500 tokens output expected)
   - MBA `qwen3:14b` for medium tasks (general reasoning, 32GB unified)
   - OpenRouter `qwen3-coder` for code tasks (the Studio-coder proxy)
   - OpenRouter `gpt-oss-120b` for reasoning-heavy tasks (the Studio-large proxy)
3. **Sync vs async.** Sync if the task is the critical path; async if Claude can do other work meanwhile.
4. **Verification protocol.** Always sanity-check the output before using it. Never let unverified delegated output flow into a commit, a Munin write, or another tool call without a Claude pass.
5. **Rating discipline.** Call `hugin_rate` on *every* delegation. No exceptions — the corpus depends on it.
6. **Failure handling.** On hard fail: rate as `wrong` with reason, then either retry on a different runtime or do it locally in Claude. Don't silently fall back.

## Build order

1. **MCP server skeleton** — `hugin-mcp` package in this repo, 5 tool stubs returning hardcoded results. Wire into Claude Code. Verify Claude can call all 5.
2. **OpenRouter executor** — new runtime in Hugin, ZDR enforcement at startup, end-to-end test against `gpt-oss-120b`.
3. **Orchestrator journal** — schema + append helper + integration into Hugin's task completion path. New separate file.
4. **Wire MCP → Hugin** — `hugin_submit/await/run` call into Hugin's existing submit/result paths over Munin. `hugin_rate` writes to the orchestrator journal directly. `hugin_list` reads the journal.
5. **Delegate skill** — `~/.claude/skills/delegate/SKILL.md` with the guidelines above.
6. **Dogfood** — use it for a week on real work. Iterate the skill based on what Claude actually does. Look at the rated corpus for patterns.

## Out of scope for v1

- New trust tier (`cloud-third-party`). Reuse `semi-trusted` for OR.
- `Priority:` field or scheduler changes.
- `Group:` repurposing.
- Pipeline integration (delegated tasks are flat; no nested pipelines).
- The schema-v2 telemetry redesign for the *main* journal — orchestrator journal is separate.
- Anthropic-fallback automation in MCP.

## Limitations Magnus accepts up front

- ZDR enforcement is on OR's self-declared metadata. We trust OR's policy claims.
- No automated quality grading — Claude's self-rating is the only signal. Self-rating bias is a known risk; it's still better than no rating.
- Studio model choices freeze on today's eval. When the Studio actually arrives, we re-test on hardware before treating OR results as ground truth.
- Pi `qwen2.5:3b` is small; on-Pi delegation will mostly be a "is anything ever a fit for this tier?" question, not a primary throughput path.

## Estimate

| Piece | LOC | Wall-clock |
|---|---|---|
| MCP skeleton | ~250 | half-day |
| OpenRouter executor + ZDR filter | ~350 | half-day |
| Orchestrator journal | ~120 | hour |
| MCP ↔ Hugin wiring | ~250 | half-day |
| Delegate skill | ~300 lines markdown | hour |
| **Total v1** | **~1,000 LOC + skill** | **2 days focused** |

About half the original ~2,090 LOC estimate because we're punting on the trust-tier rework, schema v2, and pipeline integration.

## Acceptance to start

Magnus signs off → start at step 1 (MCP skeleton). Each step ends with a working artifact that's been smoke-tested before moving to the next.
