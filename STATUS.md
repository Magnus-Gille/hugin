# Hugin — Status

**Last session:** 2026-04-02
**Branch:** main

## Completed This Session
- **Sprint artifact convention added** — created `sprints/` for human-facing sprint demos and feedback capture, with the Step 1 demo and first user feedback recorded in `sprints/2026-04-02-step1-live-eval.md`.
- **Step 1 live evaluation passed on the Pi** — deployed branch `codex/step1-live-eval` to `huginmunin`, then validated success-path promotion, `on-dep-failure:fail`, `on-dep-failure:continue`, and startup reconciliation. Evidence recorded in `docs/step1-live-evaluation.md`.
- **Engineering plan derived from orchestrator draft** — wrote `docs/hugin-v2-engineering-plan.md` with phased delivery, explicit evaluation gates, and a recommendation to stop after Step 1 for live validation before building the pipeline compiler.
- **Step 1 parent/child joins implemented** — blocked-task dependency evaluation, `depends-on:` / `on-dep-failure:` semantics, event-driven promotion on child completion/failure, periodic blocked-task reconciliation, and blocked task observability in heartbeat/health.
- **Task-graph helper module + tests** — added `src/task-graph.ts` and `tests/task-graph.test.ts` to cover dependency parsing, failure policy semantics, promotion behavior, fan-out limit enforcement, and missing dependency handling.
- **Verification pass green** — `npm test` and `npm run build` both passed after the Step 1 changes.
- **Worker/lease model** (0a23885) — worker identity (`hugin-<hostname>-<pid>`), lease tags on claimed tasks (`claimed_by:`, `lease_expires:`), 60s lease renewal, lease-based stale recovery. Foundation for multi-worker setups.
- **Graceful shutdown** (0a23885) — marks current task as failed in Munin before exiting, preventing zombie tasks on service restart.
- **First laptop ollama dispatch** — submitted task to qwen3.5:35b-a3b on laptop via Tailscale from Pi. End-to-end golden path validated.
- **Architecture debate with Codex** — 2-round adversarial review of multi-agent orchestration plan. Changed sequencing: worker/lease before DAG. See `debate/multi-agent-orch-summary.md`.
- **Step 1 spec written** — `docs/step1-parent-child-joins.md` specifies parent/child task dependencies with fan-out/fan-in, failure policy, reconciliation loop.

## Previous Session (earlier 2026-04-01)
- MCP connectivity fix for spawned agents (12b533c)
- Removed dead email notification code (6446262)
- **debate-codex skill improvements debate** — 2-round adversarial review of 8 proposed improvements. Codex cut it to 2: type-specific prompts + calibrated severity. See `debate/skill-improvements-summary.md`
- **Implemented debate results** — patched SKILL.md Steps 3, 6, 8 (b793a46 in claude-skills repo)

## Blockers
- mDNS (huginmunin.local) flaky — Tailscale IP 100.97.117.37 is reliable fallback

## Next Steps
- **Step 2: Pipeline IR + compiler** — Step 1 is now validated. Next build `Runtime: pipeline` parsing, validated IR storage, and child-task decomposition with explicit runtimes only.
- **Review dependency provenance retention** — current promotion strips `depends-on:*` tags; decide whether downstream auditability needs explicit provenance storage before Step 2.
- **Step 3: Structured results + pipeline operations** — only after Step 2 compile/decompose evaluation passes.
- **Step 5+: Capability registry + routing** — still deferred until Bet 1 is proven end to end.
- Deploy latest Ratatoskr features (poll recovery, delivery confirmation)
- Task progress streaming (partial results before completion)
