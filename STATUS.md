# Hugin — Status

**Last session:** 2026-04-02 (Step 3 structured results + summary artifacts)
**Branch:** codex/step1-live-eval

## Completed This Session
- **Step 3 structured result schema implemented locally** — regular task execution now writes machine-readable `result-structured` artifacts in addition to the existing markdown `result` entry, with validated fields for lifecycle/outcome, timings, routing metadata, runtime metadata, and pipeline phase context.
- **Pipeline summary artifact implemented locally** — pipeline parents now gain a machine-readable `summary` artifact derived from `spec` plus child task state/results. It reports per-phase lifecycle, timings, runtimes, errors, aggregate counts, and top-level execution state (`decomposed`, `running`, `completed`, `failed`, `completed_with_failures`).
- **Summary refresh wired into execution transitions** — the parent summary is refreshed on pipeline decomposition, child task claim, child task completion/failure, blocked-task promotion/failure, stale-task recovery, and shutdown interruption so the artifact tracks workflow progress instead of only final state.
- **Step 3 artifact coverage added** — added pure tests for the structured task-result schema and pipeline summary reducer. `npm test` and `npm run build` both passed after the Step 3 slice.
- **Step 2 follow-up bug fixes pushed, deployed, and live-validated** — deployed commit `615f98f` to `huginmunin`, restarted Hugin, and verified on live tasks that parent `type:*` tags survive successful decomposition, parent decomposition results now include `Reply-to` / `Reply-format` / `Group` / `Sequence`, dependent child phases keep `on-dep-failure:continue` on terminal status, child result formatting is clean, and missing phase runtimes now fail with a direct compiler error.
- **Step 2 follow-up bug fixes implemented locally** — fixed all five current pipeline follow-ups from `feedback/hugin/step2-pipeline-findings`: terminal phase status now preserves `on-dep-failure:*`, successful pipeline parents preserve incoming `type:*` tags, pipeline parent decomposition results now include reply-routing metadata plus parent `Group`/`Sequence`, missing phase runtimes now fail with a direct validation error, and phase result formatting no longer emits extra blank metadata gaps.
- **Lifecycle-tag and result-format helpers added** — extracted `src/task-status-tags.ts` and `src/result-format.ts` so terminal-tag preservation and result-contract rendering are pure, reusable, and testable instead of staying embedded in dispatcher control flow.
- **Regression coverage expanded for the bug set** — added tests for terminal tag preservation, clean result formatting, parent routing metadata rendering, and the missing-runtime compiler error. `npm test` and `npm run build` both passed after the fixes.
- **Repo-local ticket docs added** — wrote [docs/ticket-pipeline-parent-drops-type-tags-on-success.md](/Users/magnus/repos/hugin/docs/ticket-pipeline-parent-drops-type-tags-on-success.md) and [docs/ticket-pipeline-parent-result-omits-routing-metadata.md](/Users/magnus/repos/hugin/docs/ticket-pipeline-parent-result-omits-routing-metadata.md) so the follow-up bugs now exist both in Munin and in the repo itself.
- **Local demo validation pass completed** — reran `npm test` and `npm run build` successfully, manually compiled/decomposed a valid `explore -> synthesize -> review` pipeline, and reconfirmed invalid-runtime plus cyclic-graph rejection from the compiler surface.
- **Two follow-up bugs identified during demo review** — successful pipeline parents currently drop incoming `type:*` tags instead of preserving them through the task lifecycle, and pipeline decomposition results omit the standard reply-routing metadata contract (`Reply-to`, `Reply-format`, plus current `Group`/`Sequence` forwarding parity).
- **Step 2 live evaluation passed on the Pi** — validated one explicit-runtime pipeline end to end: parent compile/decompose, immutable `spec` write, correct root/dependent child task states, ordered child execution, and successful final child results. Evidence recorded in `docs/step2-live-evaluation.md`.
- **Live rejection paths confirmed** — invalid pipeline parents now fail cleanly before decomposition for both unknown runtimes and cyclic dependency graphs; no `spec` entries or child task namespaces were created for either invalid case.
- **Explicit ollama runtime variants now pin concrete models** — the first live Step 2 attempt exposed a routing leak where `ollama-pi` still fell through to the laptop host because no model was emitted. Fixed by pinning `ollama-pi -> qwen2.5:3b` and `ollama-laptop -> qwen3.5:35b-a3b`, then redeploying and rerunning the evaluation.
- **Step 2 sprint artifact added** — recorded the demo and live-eval feedback in `sprints/2026-04-02-step2-live-eval.md` to keep product-facing progress and operational findings together.
- **Step 2 pipeline compiler implemented locally** — added `src/pipeline-ir.ts` and `src/pipeline-compiler.ts` with a validated `PipelineIR`, explicit runtime registry (`claude-sdk`, `codex-spawn`, `ollama-pi`, `ollama-laptop`), markdown pipeline parsing, dependency/cycle validation, and child-task draft generation.
- **Dispatcher now recognizes `Runtime: pipeline`** — `src/index.ts` compiles pipeline tasks, writes immutable `spec` JSON to Munin, decomposes phases into child tasks using Step 1 join primitives, and records decomposition results on the parent task.
- **Dependency provenance preserved for Step 2** — instead of keeping `depends-on:*` forever on promoted tasks, the compiler stores dependencies in the pipeline `spec` and also writes parent pipeline id, phase name, and dependency task ids into child task content so auditability survives promotion.
- **Pipeline compiler tests added** — `tests/pipeline-compiler.test.ts` covers valid compile/decompose output, dependency provenance, and rejection of `Runtime: auto`, unknown dependencies, cycles, and premature `Authority: gated`.
- **Step 2 local verification green** — `npm test` and `npm run build` both passed after the pipeline compiler changes.
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
- Add dispatcher-level tests for the `Runtime: pipeline` execution path if parent-tag and result-contract behavior should be covered above the current pure-helper and compiler unit tests.
- **Deploy and live-evaluate the Step 3 artifact slice** — verify `result-structured` and parent `summary` on the Pi with one fixed pipeline before adding cancellation/resume behavior.
- **Continue Step 3 with operations** — add cancellation and resume-from-failed-phase support on top of the new structured artifacts.
- **Define the Step 3 live gate in detail** — the next evaluation should exercise cancellation and resume on one fixed pipeline, not just the happy path.
- **Decide on AGENTS.md** — Codex generated this as its CLAUDE.md equivalent; has incorrect substitutions (script names, env var labels). Fix or delete before committing.
- **Step 5+: Capability registry + routing** — still deferred until Bet 1 is proven end to end.
- Deploy latest Ratatoskr features (poll recovery, delivery confirmation)
- Task progress streaming (partial results before completion)
