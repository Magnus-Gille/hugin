# Debate Index

| Date | Topic | Rounds | Key decision | Critique points | Self-review catch rate |
|------|-------|--------|--------------|----------------|-----------------------|
| 2026-03-15 | [Architecture Guide](arch-guide-summary.md) | 2 | Guide needs trustworthiness pass before it qualifies as internal reference; 3 factual inaccuracies found in Hugin sections | 15 | 2/15 (13%) |
| 2026-04-01 | [Multi-agent orchestration](multi-agent-orch-summary.md) | 2 | Worker/lease model before DAG, not after | 12 | 2/12 (17%) |
| 2026-04-01 | [debate-codex skill improvements](skill-improvements-summary.md) | 2 | Adopt type-specific prompts + severity calibration only; defer tiers and structural changes | 14 | 3/14 (21%) |
| 2026-04-09 | [Zombie process root cause](zombie-procs-summary.md) | 2 | Dual systemd service confirmed; repo hugin.service + deploy-pi.sh need user-level rewrite; shutdown() needs child-await before exit | 9 | 3/9 (33%) |
| 2026-04-25 | [Orchestrator stack plan](orch-stack-summary.md) | 2 | Run falsifiable go/no-go with existing telemetry before writing any new code; multi-host sprint is still the approved priority | 11 | 3/11 (27%) |
| 2026-04-25 | [Orchestrator v1 build (HOW)](orch-v1-build-summary.md) | 2 | Build it, but contracts-first: define delegation data model + state machine + journal event model + broker auth boundary BEFORE any executor/MCP code; drop `hugin_run` from v1; use overlay journal not shadow; new provider/egress/zdr fields orthogonal to trust tier | 17 | 6/17 (35%) |
| 2026-04-26 | [Orchestrator v1 Steps 1-3 review](orch-v1-impl-review-summary.md) | 2 | Step 1-3 contracts NOT locked enough for Step 4: scanner-redact-on-diff is a contract bug (must escalate to scanner_blocked); durability/runtime-row-identity model must be spec'd before broker; copy_node_modules default flips to false; add envelope_version + result_schema_version | 12 | 3/12 (25%) |
