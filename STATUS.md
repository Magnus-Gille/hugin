# Hugin — Status

**Last session:** 2026-04-11 (silent write-failure fix + stuck LoCoMo task recovered, deployed)
**Branch:** main

## Completed This Session (2026-04-11 — afternoon)

### Fix: silent Munin write rejections + task artifact classification clamping (`1ef43e2`, PR #41, deployed)

A LoCoMo-baseline research task submitted 2026-04-10 completed successfully on Hugin (exit 0, 404s, $3.84) but sat as `running` for 18+ hours with "No result yet" in the UI. Root-caused, fixed, and recovered.

**Root cause — two bugs stacked:**
1. **`munin.write()` silently swallowed `{ok: false}` rejections.** `src/munin-client.ts` returned the raw envelope; post-task call sites in `src/index.ts` (`result`, `result-structured`, terminal `status` flip) never checked `ok`. The subsequent `munin.log("Task completed in 404s...")` succeeded because `memory_log` takes no classification, so systemd journal and Munin's log stream both claimed completion while state was never updated. (Filed as #39.)
2. **Owner-override downgraded task artifact classification below the `tasks/*` namespace floor.** The task declared `Sensitivity: public`; detector inferred `internal`; the owner-override escape hatch from #36/#37 lowered effective to `public`. `getTaskArtifactClassification()` piped that straight into `sensitivityToMuninClassification`, producing writes at `classification: public` against a namespace whose floor is `internal`. Munin rejected every post-task write with `validation_error: "Classification \"public\" is below namespace floor \"internal\"..."`. Confirmed with a diagnostic probe write. (Filed as #40.)

**Fix (PR #41, squash-merged, `1ef43e2`):**
- `src/munin-client.ts` — `write()` throws `Munin write rejected for {ns}/{key}: {error} — {message}` on `{ok: false}`. Return type narrowed to `Record<string, unknown>`. Any future write rejection now propagates to `pollLoop`'s existing `catch (err) { console.error("Poll error:", err) }`.
- `src/index.ts` — `getTaskArtifactClassification()` clamps up to `namespaceFallbackSensitivity("tasks/")` (= `internal`). Owner-override tasks continue to run at effective `public` (runtime trust unchanged); only artifact storage classification is clamped up. Claim and lease-renewal sites simplified — the manual `!ok` checks are now redundant (their existing try/catches handle the throw path).
- **Tests:** `tests/munin-client.test.ts` asserts `write()` rejects on `{ok: false}` with the classification-floor error message. `tests/sensitivity.test.ts` adds regression tests for the clamp invariant (`max(public, tasks-floor) = internal`, `max(private, tasks-floor) = private`). 265/265 passing.
- **Deployed:** `./scripts/deploy-pi.sh huginmunin.local` clean — worker `hugin-huginmunin-606190`, up since 16:28:05 CEST, health green, polling. The mid-flight `fort-gille-c6-tech-paths` task actually finished at 16:21 before the redeploy (classified `internal`, no bug) and was unaffected.

**Stuck task recovered manually:** wrote `tasks/20260410-181800-locomo-baseline/result` (classification `internal`, with a recovery note referencing #39/#40/#41 and the response body extracted from `/home/magnus/.hugin/logs/20260410-181800-locomo-baseline.log`) and flipped `status` tags from `["running", ...]` to `["completed", "runtime:claude", "type:research", "recovered:hugin-39"]`. Task now shows as Completed in the UI.

**Impact assessment:** The silent-swallow bug would also have masked CAS conflicts, tag validation errors, and any other Munin-side rejection. Fix is reliability-critical for the whole task lifecycle, not just owner-override cases. Owner-override tasks remain the most likely trigger going forward.

### Fix: host-suffixed submitter variants (`63277f5`, deployed — earlier session)
A Claude Code laptop session submitting as `Claude-Code-laptop` was rejected by the allowlist (strict exact-match, list only had `claude-code`). The task showed up as a failed LoCoMo baseline research spike.

- **Fix:** new `isSubmitterAllowed()` helper in `src/index.ts` does case-insensitive exact match OR `<entry>-<host>` prefix match. So `Claude-Code-laptop` now matches `claude-code`. Wired into both the submitter allowlist check and `isOwnerSubmitter()` (owner-override path).
- **Word-boundary safety:** the suffix match requires a literal `-` separator, so `huginx` does not match `hugin` and `codex` does not match `Codex-desktop`. `Codex`-like bare entries still do catch-all their `-<host>` variants — this is intended since `Codex` is already trusted.
- **Tests:** `tests/dispatcher.test.ts` local helper updated to mirror prod logic. New cases for case-insensitivity, `-<host>` suffix (the regression), and word-boundary. 262/262 passing.
- **Deployed:** committed, pushed, `./scripts/deploy-pi.sh` ran clean. Pi health green, `hugin.service` active since 21:29:56 CEST on 2026-04-10. Allowed submitters line in journal unchanged (still lists the canonical entries — the new matching logic just relaxes comparison).
- **Note:** the failed LoCoMo baseline task entry was not re-run. To retry, resubmit or flip its tag back to `pending`.

## Completed Previous Session (2026-04-10)

### PR #35 — sensitivity classifier robustness (MERGED, `f98278d`)
Three rounds of codex adversarial review. Each round's findings fixed or formally deferred:
- **Round 1 fix (`e5ebcdd`):** Credential assignment detection with `hasCredentialAssignment()` helper, 60-char window, placeholder rejection, `-ed` form additions to `TECHNICAL_CONTEXT`.
- **Round 2 fix (`f57d01b`):** `matchAll` scan across multiple credential keywords per line, newline normalization, `isSecretShapedValue()` entropy fallback, `CREDENTIAL_PLACEHOLDER_ASSIGNMENT` guard in per-line loop.
- **Round 3 narrow fix (`38c1005`):** `normalizeForClassification()` — NFKC + zero-width/bidi stripping + Cyrillic/Greek homoglyph map + whitespace collapse. Defeats tab/NBSP/ZWSP/fullwidth/Cyrillic-`а` bypasses.
- **Round 3 Findings 1 & 3 deferred to #36** — alphabetic-only secret detection and RFC-example JWT false positives are in fundamental tension that regex cannot resolve. Owner-override is the architectural fix.

### PR #37 — owner-override escape hatch (MERGED, `38bac07`)
Closes #36. Squash-merged. Three commits on `feat/owner-override` before merge:
- **`67997c3` feat:** `detectPromptSensitivity()` returning `{ sensitivity, hardPrivate }`. Only `SECRET_SHAPED_PATTERNS` is hard. `buildSensitivityAssessment` gains `allowOwnerOverride` + `hardPrivate` inputs; when set, `effective` clamps DOWN to `declared` unless hard. `mismatch` still fires on detector disagreement even when override is honored (audit trail). Pipeline compiler + dispatch threaded through. `assessTaskSecurity` warns on every applied override.
- **`0b307e8` security:** `HUGIN_OWNER_SUBMITTERS` default narrowed — `hugin` and `ratatoskr` removed. Only human-driven clients (claude-code/desktop/web/mobile, Codex*) trusted to declare sensitivity by default. Agent principals must be explicitly added via env var if they need override access.
- **`62f292c` docs:** STATUS.md update folded into PR.

### Security model (documented in PR body)
- This is a policy knob, not a tamper-proof gate. Check is string match on self-reported `Submitted by` front-matter.
- Protects against: accidental misclassification, out-of-allowlist submitters, secret-shaped strings (hardPrivate), agent self-escalation (via default exclusion).
- Does NOT protect against: prompt-injected Claude Code holding the Bearer token, compromised tools with `MUNIN_API_KEY`. In those cases the attacker had Munin write access and could `memory_read` private data directly — the override doesn't meaningfully expand blast radius.
- Future hardening (not in #37): bind owner identity to Munin OAuth principal, out-of-band consent, rate limiting, dedicated audit log.

### Tests
- 259/259 passing (248 before #37 + 11 new in `tests/sensitivity.test.ts`)
- New coverage: detectPromptSensitivity hard/soft split, override happy path, hard-private block, missing-declared guard, detector<=declared, legacy behavior, real-world #36 case (research prompt with auth vocabulary), counter-case (real `sk-ant-…` still blocked)

## Active PRs
- None.

## Pending Follow-ups
- **Deploy to Pi.** `main` is ahead of deployed code by `f98278d` + `38bac07`. Restart will invalidate any active MCP sessions (known issue).
- **Monitor override usage** post-deploy — every applied override emits `[sensitivity] owner override` warning. If no overrides fire in a week, the detector is precise enough. If many fire, mine them for classifier tuning targets.
- **`managed-agents-fit` research** — no longer needed. Prior research at `~/mimir/research/managed-agents-fit.md` (2026-04-09) already covers it with a "reject adoption, cherry-pick design ideas" verdict. The failed Munin task entry stays as history.

## Next Session Options
- **#30 `think:false` for ollama reasoning models** — small, clear scope, big Pi win (90s → 2s on qwen3.5:2b). See `docs/research/ollama-performance-spike.md`.
- **#5 Phase 7: Methodology templates** — biggest value unlock. Managed-agents research flags "outcome grader pattern" as design input.
- **Stale-tracker sweep** — cheap roadmap hygiene. This session already found 2 stale trackers (gille-ai#1 banner, heimdall#4 favicon) that were both fixed weeks ago. Worth a one-pass sweep across all "Todo" items.

## Plan Status
- **Phase 1: Dependency-aware task joins** — done and live-validated.
- **Phase 2: Pipeline compiler and decomposition** — done and live-validated.
- **Phase 3: Structured results and pipeline operations** — done and live-validated.
- **Phase 4: Human gates for side effects** — done and live-validated.
- **Critical pre-Phase-5 security hardening** — done and live-validated.
- **Phase 5: Sensitivity classification** — done and corpus-evaluated (19/19). Hardening in flight via #35 (merged) + #37 (open).
- **Phase 6: Router (`Runtime: auto`)** — **DONE.** Fully live-evaluated. All 7/7 eval scenarios pass. Safety gate: zero sensitivity violations.
- **Phase 7: Methodology templates** — not started.
- **Bet 1 status** — closed.
- **Bet 2 status** — **CLOSED. All 7/7 eval tasks pass.** Safety gate confirmed. Root cause of Pi parse failures was orphan dispatcher processes (fixed).

---

## Previous Sessions (kept for history)

### 2026-04-09 (afternoon, Cleanup batch + #33 session-id rotation)

## Plan Status
- **Phase 1: Dependency-aware task joins** — done and live-validated.
- **Phase 2: Pipeline compiler and decomposition** — done and live-validated.
- **Phase 3: Structured results and pipeline operations** — done and live-validated.
- **Phase 4: Human gates for side effects** — done and live-validated.
- **Critical pre-Phase-5 security hardening** — done and live-validated.
- **Phase 5: Sensitivity classification** — done and corpus-evaluated (19/19).
- **Phase 6: Router (`Runtime: auto`)** — **DONE.** Fully live-evaluated. All 7/7 eval scenarios pass. Safety gate: zero sensitivity violations.
- **Phase 7: Methodology templates** — not started.
- **Bet 1 status** — closed.
- **Bet 2 status** — **CLOSED. All 7/7 eval tasks pass.** Safety gate confirmed. Root cause of Pi parse failures was orphan dispatcher processes (fixed).

## Completed This Session (2026-04-09, afternoon)
- **Closed 4 stalled cleanup issues (#24, #25, #31, #32)** in one batch — tasks dispatched in the `20260408-cleanup-v2` group hadn't landed (blocked by the zombie crash loop), so implemented manually. Commit: d0b0fca.
  - **#24** registry unification: deleted `PIPELINE_RUNTIME_REGISTRY` from `pipeline-ir.ts`, `pipeline-compiler.ts` now uses `getRegistryEntryById` from `runtime-registry.ts`.
  - **#25** `routing:auto` tag: at claim time, auto-routed tasks get `routing:auto` added and `runtime:auto` replaced with the resolved runtime. Required also adding `routing:` to the preserved tag families in `buildClaimTags` (index.ts) and `getPersistentTags` (task-status-tags.ts) — both filtered tags to a fixed allowlist that would have stripped it. Fix commit: 36175d9.
  - **#31** pre-warm ollama: `warmModel()` in `ollama-hosts.ts` fires a zero-prompt `/api/generate` with `keep_alive: "1h"` on the pi host at dispatcher startup (fire-and-forget). Verified live: `qwen2.5:3b` in `/api/ps` with `expires_at` matching.
  - **#32** loaded models in heartbeat: `getLoadedModels()` queries `/api/ps` on each available host and adds `ollama_loaded` to the heartbeat. First deploy showed empty result because `probeAllHosts` is only called during auto-routing — fix commit a62f0a8 now probes availability inside `getLoadedModels` first.
- **Fix: MCP session-id rotation (#33)** — `MuninClient` previously generated one session UUID per process, so every MCP call across the dispatcher's entire lifetime carried the same `mcp-session-id`. Munin's 5-minute outcome-correlation window never fired (zero outcomes in production). Fix: added `setSessionId()` to the client, and rotate to a fresh UUID before each task claim and again in the `pollOnce` finally block. All MCP calls made during one task execution now share one session; background poll/heartbeat calls get a different one. Test added. Commit: 2543665.
- **Skills update: debate-codex and review-pr-codex pin `gpt-5.4 / xhigh`** — adversarial reviews now explicitly pass `-m gpt-5.4 -c model_reasoning_effort='"xhigh"'` instead of inheriting the everyday `config.toml` defaults. Verified live. Skills repo commit: 89d7209.
- **All 240 tests passing** (+1 new session-id test). Deployed 3 times to Pi in this session.

## Completed Previous Session (2026-04-09, morning)
- **Fix: zombie Hugin processes (#34)** — root cause was dual systemd service registration. deploy-pi.sh was installing to `/etc/systemd/system/` (system-level, crash-looped 542+ times) while user-level service at `~/.config/systemd/user/` held port 3032. Fix: idempotent migration block removes legacy system-level service; deploy now installs user-level only. Also fixed: `ReadWritePaths` too narrow (task logs would fail), `hugin.service` had wrong directives for user-level (`User=magnus`, `WantedBy=multi-user.target`), `shutdown()` didn't await child exit before `process.exit`. Adversarial debate in `debate/zombie-procs-*`. Commit: be6bd87.

## Completed Previous Session (2026-04-08)
- **Bug fix: #29 sensitivity classifier false positives** — split keyword patterns into always-private and context-sensitive tiers. Context-sensitive keywords (secret, invoice, tax, bank, journal) suppressed when same line has technical modifiers. Commit: d3c31d7.
- **Bug fix: #28 FIFO dispatch ordering** — pollOnce queries limit:10 and sorts by created_at. Dispatched via Hugin task. Commit: 4b500dd.
- **Bug fix: #27 group sequencing** — selectNextTask skips tasks whose group has lower-sequence siblings pending/running. Dispatched via Hugin task. Commit: 11eac04.
- **Refactor: extract functions from index.ts** — moved pickEarliestTask and syncRepoBeforeTask to task-helpers.ts to fix test crashes (index.ts has module-level side effects). Commit: facc649.
- **Root cause: Pi parse failures** — orphan Hugin processes from tasks running `npm test` in the hugin repo. Old instances lacked `Runtime: auto` support and raced the real dispatcher. Fixed with EADDRINUSE guard (ac690f0), startup orphan cleanup (11447ff), and deploy-time cleanup (43fd2e9).
- **Fix: auto-routed model selection** — was using registry host default (qwen3.5:35b-a3b for laptop) instead of global default. Scoped to ollama runtimes only. Commits: 8f4dbfe, feafb7b.
- **Ollama performance research spike** — benchmarked Pi and laptop. qwen3.5:2b reasoning overhead (270 think tokens, 90s) makes it unusable on Pi. qwen2.5:3b is best (1.9s warm). Report: docs/research/ollama-performance-spike.md.
- **Reverted default model to qwen2.5:3b** — the qwen3.5:2b upgrade was a regression. Commit: b65fa2d.
- **Set OLLAMA_KEEP_ALIVE=-1 on Pi** — model stays loaded permanently, eliminating cold starts.
- **Bet 2 evaluation completed** — all 7/7 scenarios pass. Safety gate confirmed.
- **3 new issues filed** — #30 (think:false support), #31 (pre-warm model), #32 (ollama model status in heartbeat).
- **Fix: CAS conflict after task claim** — `entry.updated_at` wasn't refreshed after claiming, causing `failTaskWithMessage` to silently fail (CAS reject). Tasks got stuck as `running` forever. Commit: c8ae08c.
- **Fix: Pi repo drift** — deploy script now runs `git reset --hard origin/main` after rsync. Enabled `sync-repos.timer` (15-min periodic pull). Commit: db7a1b6.
- **Resubmitted cleanup batch** — 5 tasks (#23, #24, #25, #31, #32) as group `20260408-cleanup-v2`. First batch failed from stale repo (pre-fix).
- **239 tests passing.** Deployed 10 times to Pi.

## Bet 2 Final Evaluation Scorecard
| # | Test | Expected | Result | Pass? |
|---|------|----------|--------|-------|
| 1 | auto + internal | ollama or claude | ollama-pi ✅ | ✅ |
| 2 | auto + private | ollama only | ollama-laptop, 2s, zero cloud leak | ✅ |
| 3 | auto + capabilities | claude-sdk | claude-sdk, 4s, `ROUTING_EVAL_3_OK` | ✅ |
| 4 | auto + public | free ollama | ollama-laptop | ✅ |
| 5 | Pipeline mixed | explicit + auto routing | All 3 phases correct | ✅ |
| 6 | auto + private, no ollama | clean failure | Proven by earlier eval | ✅ |
| 7 | Routing metadata | Present in results | Present in all structured results | ✅ |

**Safety gate: PASS** — zero sensitivity violations across all runs.

## Next Steps
- **Phase 7: Methodology templates** (#5) — next feature phase
- **Ollama: #30 (think:false support)** — pairs naturally with ollama perf work; may unlock qwen3.5:2b by disabling the 270-token reasoning overhead
- **#26 autonomous dependency bump PRs** — infra/automation
- **Security backlog:** #10 (prompt injection scanning for context-refs), #11 (task signing), #12 (provenance tagging), #13 (exfiltration detection)

## Previous Session
- **Agent orchestration research dispatched** — submitted two Hugin tasks for cross-disciplinary research on agent orchestration, swarm intelligence, and related fields (biology, economics, distributed systems, org theory).
  - First task (`20260404-212219-agent-orchestration-research`) failed due to Pi Claude API rate limit.
  - Combined research+design task (`20260405-143948-design-orchestration-experiments`) succeeded — committed as `a76a64d`.
  - Report at `docs/research/agent-orchestration-experiments.md` with 3 experiment proposals.
- **RemoteTrigger API explored** — attempted to schedule delayed task submission via remote triggers, API field format not yet documented/figured out.

## Previous Session
- **AI user testing review** — 3 Claude models (Opus, Sonnet, Haiku) did code review + hands-on task submission. Codex CLI did separate doc-focused review. All 3 hands-on ollama tasks completed successfully (8-9/10 ratings). Reviews at `docs/ai-user-testing-review.md` and `docs/ai-user-testing-review-codex.md`.
- **4 bug/enhancement fixes landed** (from dispatched tasks, rebased onto main):
  - #16 (0bfa4e6) — Missing dependencies now treated as failed instead of blocking forever
  - #17 (06807bd) — Ollama streaming timeout has 5s minimum floor
  - #18 (4eff369) — Context-refs now fetched via readBatch() instead of sequential reads
  - #19 (2dfa515) — Shared helpers extracted to task-helpers.ts module
- **postTaskGitPush hardened** (#20, 64bcba1) — now does `git fetch + rebase` before pushing, preventing cascade failures when Pi repo is behind remote
- **Root cause analysis** of dispatched task failures: Pi repo was 4 commits behind remote, all tasks committed but couldn't push, cascade failure. Filed #20, #21, #22.
- **submit-task skill updated** — added Phase 0 repo sync step to code task template
- **Doc fixes** — CLAUDE.md updated (pipeline runtime, Sensitivity field, result-structured, path contract). Stale phase 4/5 engineering plan headers corrected.
- **7 new issues filed** — #16-#22 (bugs, enhancements, operational)
- **Test suite at 159 tests**, all passing. Deployed to Pi.

## Previous Session
- **AI user testing review completed (Codex)** — ran a repo-local AI-agent usability pass on `55195cf` using Codex CLI plus `gpt-5.4-mini`/`low` and `gpt-5.4`/`xhigh` sub-agents.
- **Issue triage** — reviewed all 14 open GitHub issues. Closed 6: #1, #2, #7, #8, #9, #14. 8 issues remained open.
- **Bug fix: mDNS fallback** (#2, ccbb9b1) — `deploy-pi.sh` and `sync-claude-config.sh` now auto-detect mDNS and fall back to Tailscale IP.
- **Bug fix: prompt sensitivity false positive** (#14, ccbb9b1) — `classifyPromptSensitivity()` now strips code blocks, inline code, and namespace paths before keyword matching.
- **Created `/issues` skill** — global skill for checking GitHub issues on the current repo.
- **Test suite at 154 tests**, all passing. Deployed to Pi.

## Previous Session
- **Post-Codex review of pre-Phase-5 security hardening** — reviewed 654b046, found no critical issues. Egress-policy test coverage added (26 tests), context-loader sensitivity logic hardened, CLAUDE.md updated. Test suite at 153 tests. Shipped in `13ce918`.
- **Critical security hardening implemented and deployed** — removed the legacy Claude spawn executor, added a first-pass outbound allowlist (`fetch` + git remote host checks + service address-family narrowing), and introduced a shared sensitivity model in [src/sensitivity.ts](/Users/magnus/repos/hugin/src/sensitivity.ts) plus first-pass egress controls in [src/egress-policy.ts](/Users/magnus/repos/hugin/src/egress-policy.ts).
- **Context-ref classification enforcement is now live** — [src/context-loader.ts](/Users/magnus/repos/hugin/src/context-loader.ts), [src/munin-client.ts](/Users/magnus/repos/hugin/src/munin-client.ts), and [src/index.ts](/Users/magnus/repos/hugin/src/index.ts) now read Munin classification, compute effective task sensitivity, fail closed before prompt injection on unsafe runtimes, and write classification-aware artifacts back to Munin.
- **Pipeline runtime sensitivity limits now enforce at compile time** — [src/pipeline-compiler.ts](/Users/magnus/repos/hugin/src/pipeline-compiler.ts) now derives effective phase sensitivity from pipeline sensitivity plus heuristics/dependencies and rejects private-sensitive cloud phases before decomposition.
- **Live validation record added** — [docs/security-critical-holes-live-evaluation.md](/Users/magnus/repos/hugin/docs/security-critical-holes-live-evaluation.md) captures the standalone private-ref denial, the private pipeline compile-time rejection, the live-found `private -> client-confidential` mapping fix, and the current first-pass egress posture.
- **Security-focused regression coverage added** — new [tests/sensitivity.test.ts](/Users/magnus/repos/hugin/tests/sensitivity.test.ts) and [tests/context-loader.test.ts](/Users/magnus/repos/hugin/tests/context-loader.test.ts), plus expanded compiler, client, dispatch, and control expectations. Local verification is green with `npm test` (127 tests) and `npm run build`.
- **Critical security hardening plan written** — added [docs/security-critical-holes-engineering-plan.md](/Users/magnus/repos/hugin/docs/security-critical-holes-engineering-plan.md) to capture the lethal-trifecta response as a concrete engineering plan. It sequences the three critical holes as: remove the legacy Claude spawn executor, apply outbound egress filtering, and implement context-ref classification enforcement as Phase 5 Step 0 because it depends on the same sensitivity substrate.
- **Main v2 roadmap updated with the security precondition** — [docs/hugin-v2-engineering-plan.md](/Users/magnus/repos/hugin/docs/hugin-v2-engineering-plan.md) now states that normal Phase 5 work should not begin until the critical pre-Phase-5 hardening pass is closed, and points to the new plan as the immediate next implementation target.
- **Phase 5 detailed engineering plan written** — added [docs/phase5-sensitivity-classification-engineering-plan.md](/Users/magnus/repos/hugin/docs/phase5-sensitivity-classification-engineering-plan.md) and linked it from [docs/hugin-v2-engineering-plan.md](/Users/magnus/repos/hugin/docs/hugin-v2-engineering-plan.md). The plan covers the shared sensitivity model, Munin classification plumbing, standalone task sensitivity, pipeline sensitivity propagation, artifact/schema changes, test slices, and the live corpus evaluation gate for Phase 6.
- **Phase 4 human gates live-validated** — on `huginmunin`, a clean approval probe (`tasks/20260404-123200-step4-gated-approve`) reached `awaiting-approval`, wrote `approval-request`, resumed only after approval, and completed with structured approval metadata; a clean rejection probe (`tasks/20260404-124100-step4-gated-reject-clean2`) reached the same gate, was rejected, failed without execution, and converged to a terminal parent summary with `completed_with_failures`. Evidence is in [docs/step4-live-evaluation.md](/Users/magnus/repos/hugin/docs/step4-live-evaluation.md).
- **Phase 4 sprint artifact added** — captured the human-facing demo and follow-ups in [sprints/2026-04-04-step4-live-eval.md](/Users/magnus/repos/hugin/sprints/2026-04-04-step4-live-eval.md).
- **Approval decision contract clarified by live use** — the first manual approval attempt used an under-specified decision payload and was ignored safely. The live-eval record now documents that `approval-decision` producers must include at least `pipelineId`, `phaseTaskId`, `decision`, and `decidedAt`.
- **Phase 4 human gates implemented locally** — added [src/pipeline-gates.ts](/Users/magnus/repos/hugin/src/pipeline-gates.ts), extended [src/pipeline-ir.ts](/Users/magnus/repos/hugin/src/pipeline-ir.ts) and [src/pipeline-compiler.ts](/Users/magnus/repos/hugin/src/pipeline-compiler.ts) to accept `Authority: gated` plus explicit `Side-effects:`, and updated [src/index.ts](/Users/magnus/repos/hugin/src/index.ts) so gated pipeline phases pause in `awaiting-approval`, write `approval-request`, consume `approval-decision`, resume on approval, and fail on rejection without executing.
- **Structured artifacts and summaries now understand approval state** — [src/task-result-schema.ts](/Users/magnus/repos/hugin/src/task-result-schema.ts) now carries approval metadata plus pipeline side effects, [src/pipeline-summary.ts](/Users/magnus/repos/hugin/src/pipeline-summary.ts) adds `awaiting_approval` execution state and phase-level approval status, and [src/task-status-tags.ts](/Users/magnus/repos/hugin/src/task-status-tags.ts) now preserves `authority:*` across lifecycle transitions and can build `awaiting-approval` tags.
- **Resume/cancellation semantics updated for gated phases** — [src/pipeline-ops.ts](/Users/magnus/repos/hugin/src/pipeline-ops.ts) now treats `awaiting_approval` as active, so existing pipeline control paths remain coherent when a pipeline is paused on human approval.
- **Phase 4 regression coverage added** — added [tests/pipeline-gates.test.ts](/Users/magnus/repos/hugin/tests/pipeline-gates.test.ts) plus expanded compiler, summary, resume, dispatch, control, structured-result, and tag-helper tests for gated phases and approval state. Local verification is green with `npm test` (117 tests) and `npm run build`.
- **Phase 4 now has a detailed engineering plan** — added [docs/phase4-human-gates-engineering-plan.md](/Users/magnus/repos/hugin/docs/phase4-human-gates-engineering-plan.md) and linked it from [docs/hugin-v2-engineering-plan.md](/Users/magnus/repos/hugin/docs/hugin-v2-engineering-plan.md). The plan defines the side-effect taxonomy, Munin approval-request/approval-decision artifacts, `awaiting-approval` lifecycle, summary/result extensions, cancellation/resume interaction, testing plan, and live gate for closing Bet 1.
- **Execution-plan status and next steps documented explicitly** — STATUS now maps the repo against [docs/hugin-v2-engineering-plan.md](/Users/magnus/repos/hugin/docs/hugin-v2-engineering-plan.md): Phases 1-3 are done and validated; Phase 4 (human gates) is the next implementation target; Phases 5-7 remain deferred until Bet 1 is closed.
- **Orchestration control paths extracted out of the live dispatcher** — moved pipeline cancellation and resume entry handling into [src/pipeline-control.ts](/Users/magnus/repos/hugin/src/pipeline-control.ts) and pipeline summary refresh/reconcile state into [src/pipeline-summary-manager.ts](/Users/magnus/repos/hugin/src/pipeline-summary-manager.ts), leaving [src/index.ts](/Users/magnus/repos/hugin/src/index.ts) to own only query loops, current-task state, and injected hooks.
- **New integration-level tests now cover the previously untested seams** — added [tests/pipeline-control.test.ts](/Users/magnus/repos/hugin/tests/pipeline-control.test.ts) for pipeline cancellation/resume entry handling and [tests/pipeline-summary-manager.test.ts](/Users/magnus/repos/hugin/tests/pipeline-summary-manager.test.ts) for summary refresh/reconcile behavior. Local verification is green with `npm test` (107 tests) and `npm run build`.
- **Main redeployed after the extraction and smoke-validated** — `huginmunin` restarted cleanly on worker `hugin-huginmunin-831470`, localhost health stayed `ok`, and smoke task `tasks/20260403-183909-control-summary-smoke` compiled, decomposed, executed, and converged with child response `CONTROL_SUMMARY_SMOKE_OK`.
- **Workflow-engine branch merged to main** — `codex/step1-live-eval` fast-forwarded cleanly into `main`, so the Step 1-3 pipeline/orchestration work, hardening passes, sprint artifacts, and live-evaluation docs are now the canonical mainline history instead of branch-only state.
- **Reviewer-2 fix set pushed, deployed, and smoke-validated** — commit `e8a520c` is live on `huginmunin`, health is green on worker `hugin-huginmunin-829542`, and smoke task `tasks/20260403-181159-pipeline-review-fix-smoke` compiled, decomposed, executed, and converged with child response `PIPELINE_REVIEW_FIX_SMOKE_OK`.
- **Reviewer-2 pre-merge fixes implemented locally** — mixed failed+cancelled pipelines no longer collapse to `cancelled`; [src/pipeline-summary.ts](/Users/magnus/repos/hugin/src/pipeline-summary.ts) now lets failure states outrank cancellation when computing terminal execution state, so downstream summary consumers see `failed` or `completed_with_failures` instead of a misleading blanket cancellation.
- **Pipeline decomposition now fails closed on partial child creation** — [src/pipeline-dispatch.ts](/Users/magnus/repos/hugin/src/pipeline-dispatch.ts) tracks created child tasks during decomposition and cancels any already-written children if a later write fails before the parent commit, preventing orphaned pending phases from running without a committed parent. Summary refresh and success logging are also best-effort after the parent commit instead of retroactively failing a successful decomposition.
- **Regression coverage added for both review findings** — [tests/pipeline-summary.test.ts](/Users/magnus/repos/hugin/tests/pipeline-summary.test.ts) now covers mixed completed/failed/cancelled terminal states, and [tests/pipeline-dispatch.test.ts](/Users/magnus/repos/hugin/tests/pipeline-dispatch.test.ts) now simulates a mid-decomposition child write failure and verifies rollback to cancelled children plus failed parent. `npm test` now passes with 100 tests, and `npm run build` succeeds.
- **Pipeline dispatcher extraction pushed, deployed, and smoke-validated** — commit `b6a539c` is live on `huginmunin`, and smoke task `tasks/20260403-123648-pipeline-dispatch-smoke` compiled, decomposed, executed, and converged to a terminal parent `summary` with child response `PIPELINE_DISPATCH_SMOKE_OK`.
- **Dispatcher-level pipeline execution path is now covered** — extracted the `Runtime: pipeline` parent-handling branch from [src/index.ts](/Users/magnus/repos/hugin/src/index.ts) into [src/pipeline-dispatch.ts](/Users/magnus/repos/hugin/src/pipeline-dispatch.ts) so it can be tested without importing the live Express/poll-loop bootstrap.
- **New execution-path tests exercise real decomposition behavior** — added [tests/pipeline-dispatch.test.ts](/Users/magnus/repos/hugin/tests/pipeline-dispatch.test.ts) with an in-memory Munin store that verifies valid pipeline decomposition, compile-time rejection, and child-namespace collision handling, including parent `status/result`, child task writes, and parent `summary` refresh.
- **Verification stayed green after the extraction** — `npm test` now passes with 98 tests, and `npm run build` still succeeds after routing the live dispatcher through the new module.
- **Reviewer 2 hardening fixes shipped, deployed, and live-validated** — split lease renewal and current-task cancellation polling onto dedicated Munin clients so they no longer share the background request slot, and tightened `readBatch()` to fail closed on count or identity mismatches instead of trusting positional fallbacks.
- **Lease renewal was proven live after the client split** — `tasks/20260403-092221-lease-renewal-probe` ran for 81 seconds on `huginmunin`, logged a lease renewal at the 60-second mark, and completed successfully from `Submitted by: Codex`. Evidence is recorded in `docs/munin-hardening-reviewer2-fix-validation.md`.
- **Batch validation is now a hard trust boundary** — new client tests reject partial and out-of-order batch responses, and startup plus live execution still worked against the real bridge after the stricter validation was deployed.
- **Munin 429 hardening sprint shipped, deployed, and live-validated** — batched the dispatcher’s hottest Munin read paths, added client-side request serialization/pacing plus `Retry-After` support, and cached stable pipeline-summary fingerprints so unchanged summaries are not rewritten just because `generatedAt` changes.
- **Live rollout exposed and fixed two real HTTP-bridge compatibility bugs** — the client now accepts both `data:` and `data: ` SSE lines, and `memory_read_batch` is chunked to Munin’s live 20-read validation limit. Final validation is recorded in `docs/munin-429-hardening-live-evaluation.md`.
- **Startup watchlist priming now survives real historical load** — the final deploy booted cleanly against a live backlog of 39 historical pipeline parents without throwing a watchlist-prime error.
- **Representative live pipeline completed without fresh 429/timeouts** — probe `tasks/20260402-202957-hardening-summary-dedupe` ran end to end on `huginmunin`, and the post-deploy journal for that run contained normal claim/execute/reconcile messages with no fresh `429`, `Too many requests`, or timeout errors.
- **Submitter allowlist drift fixed, deployed, and live-verified** — Hugin now defaults `HUGIN_ALLOWED_SUBMITTERS` to both current Codex-facing names (`Codex`, `Codex-desktop`, `Codex-web`, `Codex-mobile`) and legacy `claude-*` names during the transition. Deployed to `huginmunin` and validated live with `tasks/20260402-200746-allowlist-codex`, which completed successfully from `Submitted by: Codex`.
- **Repo docs and tests aligned to the new transition allowlist** — updated [AGENTS.md](/Users/magnus/repos/hugin/AGENTS.md), [CLAUDE.md](/Users/magnus/repos/hugin/CLAUDE.md), and [tests/dispatcher.test.ts](/Users/magnus/repos/hugin/tests/dispatcher.test.ts) so the documented default and submitter-validation coverage match the shipped runtime behavior.
- **Step 3 resume-from-failed-phase validated live** — recorded in `docs/step3-resume-live-evaluation.md` with two probes:
  - Full restart probe `tasks/20260402-193721-step3-resume-partial5` proved that an all-cancelled pipeline can be resumed end to end and that the parent `summary` now converges to `completed` after the last rerun phase finishes.
  - Keep-completed probe `tasks/20260402-194512-step3-resume-partial-keep1` proved that Hugin keeps completed head phases intact, resumes only the cancelled tail, and writes `Pipeline action: resumed`, `Resumed phases: 2`, `Completed phases kept: 1`.
- **Tracked summary reconciliation fixed the original live blocker** — non-terminal pipeline parents are now added to a small reconciliation watchlist and refreshed on later poll cycles until their `summary` reaches a terminal state. This closed the previous bug where the final resumed child could complete while the parent `summary` stayed stuck in a pre-terminal state.
- **Startup priming was narrowed after first deploy feedback** — broad priming of all historical pipeline parents caused avoidable Munin `429` bursts. The watchlist now only seeds from already-existing, parseable, non-terminal summaries instead of trying to backfill old runs with missing summaries.
- **Live behavior under Munin `429` is now characterized** — summary refresh, blocked-task promotion, and parent cancellation/result finalization can still lag under rate limiting, but the dispatcher now eventually converges both the full-restart and keep-completed resume paths without manual repair.
- **Step 3 sprint demo live-tested** — submitted 3 targeted pipeline tasks, observed `result-structured` and `summary` artifacts at each lifecycle stage.
- **Two Step 3 bugs found and written up** — `docs/step3-bug-report.md`:
  - Bug 1 (medium): `refreshPipelineSummary` parallel reads burst Munin rate limit → intermediate `running` state silently dropped; fixed by making reads sequential + best-effort catch.
  - Bug 2 (low): `errorMessage` in timed-out ollama tasks had leading/trailing newlines; trimmed.
- **Step 2 live re-test after bug fixes** — all four Step 2 regressions confirmed resolved: `type:*` tags preserved on successful pipeline parent, `on-dep-failure:continue` survives task completion, missing-runtime error message clear, result formatting clean.
- **AGENTS.md fixed and committed** — corrected Codex→claude substitution errors introduced during generation (runtime names, script paths, env var descriptions, allowed submitters).
- **Bug reports and tickets committed and pushed** — `3a4c7a7` on `codex/step1-live-eval`.

- **Critical security hardening implemented and deployed** — removed the legacy Claude spawn executor, added a first-pass outbound allowlist (`fetch` + git remote host checks + service address-family narrowing), and introduced a shared sensitivity model in [src/sensitivity.ts](/Users/magnus/repos/hugin/src/sensitivity.ts) plus first-pass egress controls in [src/egress-policy.ts](/Users/magnus/repos/hugin/src/egress-policy.ts).
- **Context-ref classification enforcement is now live** — [src/context-loader.ts](/Users/magnus/repos/hugin/src/context-loader.ts), [src/munin-client.ts](/Users/magnus/repos/hugin/src/munin-client.ts), and [src/index.ts](/Users/magnus/repos/hugin/src/index.ts) now read Munin classification, compute effective task sensitivity, fail closed before prompt injection on unsafe runtimes, and write classification-aware artifacts back to Munin.
- **Pipeline runtime sensitivity limits now enforce at compile time** — [src/pipeline-compiler.ts](/Users/magnus/repos/hugin/src/pipeline-compiler.ts) now derives effective phase sensitivity from pipeline sensitivity plus heuristics/dependencies and rejects private-sensitive cloud phases before decomposition.
- **Live validation record added** — [docs/security-critical-holes-live-evaluation.md](/Users/magnus/repos/hugin/docs/security-critical-holes-live-evaluation.md) captures the standalone private-ref denial, the private pipeline compile-time rejection, the live-found `private -> client-confidential` mapping fix, and the current first-pass egress posture.

## Previous Sessions
- **Step 3 resume-from-failed-phase implemented locally** — added pipeline parent `resume-requested` handling in [src/index.ts](/Users/magnus/repos/hugin/src/index.ts), a pure resume planner in [src/pipeline-ops.ts](/Users/magnus/repos/hugin/src/pipeline-ops.ts), and logic to reset only non-completed phases while keeping successful phases intact.
- **Resume planning now supports retry after partial progress** — the planner distinguishes between a genuinely active pipeline and a partially resumed pipeline after a Munin `429`. If some phases are already reactivated while the parent still looks cancelled/failed, Hugin now finalizes the parent back to the resumed state instead of discarding the resume request.
- **Summary refresh no longer surfaces stale old results during resumed attempts** — [src/index.ts](/Users/magnus/repos/hugin/src/index.ts) now ignores prior `result` / `result-structured` artifacts for non-terminal phase states, so a resumed phase that is back in `pending`, `blocked`, or `running` does not inherit stale failure/cancellation metadata in the parent summary.
- **Resume regression coverage added** — new tests in [tests/pipeline-ops.test.ts](/Users/magnus/repos/hugin/tests/pipeline-ops.test.ts) cover keeping completed phases, requeuing cancelled descendants, restarting failed roots, rejecting already-active pipelines, and retrying partial resume states. Local verification passed with `npm test` (85 tests) and `npm run build`.
- **Step 3 cancellation shipped, deployed, and live-validated** — added explicit cancellation handling for running tasks, blocked descendants, and pipeline parents, then deployed the feature to `huginmunin` and validated it on live pipeline probes using `claude-sdk` phases that were cancelled mid-run.
- **Running-phase abort path now works live** — probe `tasks/20260402-152140-step3-cancel-pipeline2` proved that a parent `cancel-requested` tag aborts the active `gather` phase, marks it `cancelled`, prevents the blocked `report` phase from running, and converges the parent to `status: cancelled` plus a cancellation result record.
- **Two live-found cancellation bugs were fixed immediately** — probe 1 exposed stale parent results when a Munin `429` landed between parent status/result writes, fixed in commit `cd69ed0` by making parent finalization retry-safe; probe 2 exposed an all-cancelled pipeline summary being classified as `decomposed`, fixed in commit `bc590f9` by correcting summary-state precedence.
- **Final cancellation contract validated** — probe `tasks/20260402-152550-step3-cancel-pipeline3` ended with parent `status: cancelled`, parent `result` rewritten to cancellation metadata, and parent `summary.executionState: cancelled` / `terminal: true` / `phaseCounts.cancelled: 2`. Evidence is recorded in `docs/step3-cancellation-live-evaluation.md`.
- **Cancellation coverage expanded** — `tests/pipeline-summary.test.ts` now covers fully cancelled pipelines, and the local verification pass finished green with `npm test` (80 tests) and `npm run build`.
- **Step 3 tester follow-ups fixed in code** — hardened `src/munin-client.ts` with request timeouts plus limited retry/backoff for 429/timeout/network failures, made `refreshPipelineSummary()` sequential and best-effort in [src/index.ts](/Users/magnus/repos/hugin/src/index.ts), and normalized machine-readable `errorMessage` values in [src/task-result-schema.ts](/Users/magnus/repos/hugin/src/task-result-schema.ts) without changing raw `bodyText`.
- **New regression coverage added** — added [tests/munin-client.test.ts](/Users/magnus/repos/hugin/tests/munin-client.test.ts) for 429/timeout retry behavior and expanded [tests/task-result-schema.test.ts](/Users/magnus/repos/hugin/tests/task-result-schema.test.ts) to confirm `errorMessage` trimming. Local verification passed with `npm test` (75 tests) and `npm run build`.
- **Follow-up fixes pushed, deployed, and live-revalidated** — deployed commit `2b4f366` to `huginmunin`, restarted Hugin onto worker `hugin-huginmunin-747189`, and reran live Step 3 probes successfully.
- **Intermediate pipeline summary state now lands live** — the pipeline `tasks/20260402-144300-step3-fixcheck-pipeline` wrote a `summary` with `executionState: running` after `gather` completed and before `report` ran, proving the missing intermediate-state bug is fixed under live conditions.
- **Heartbeat continued under queued work** — `tasks/_heartbeat` kept updating at `14:43:43Z`, `14:43:50Z`, `14:44:22Z`, and `14:44:54Z` while the pipeline summary was still non-terminal and queued work remained, so the fresh dispatcher-stall issue did not reproduce after the Munin client hardening.
- **Structured timeout error is now normalized** — the forced-timeout task `tasks/20260402-144300-step3-fixcheck-timeout/result-structured` kept raw `bodyText` as `\"\\n[Ollama request aborted after 0s]\\n\"` while exposing trimmed `errorMessage: \"[Ollama request aborted after 0s]\"`.
- **Follow-up validation record added** — recorded the tester-feedback fix pass in `docs/step3-follow-up-fix-validation.md`.
- **Fresh Step 3 verification rerun completed locally** — reran `npm test` (72 passing tests) and `npm run build`, then re-read the new `task-result-schema` and `pipeline-summary` reducers/tests before attempting a fresh live pass.
- **Existing Step 3 live artifacts cross-checked successfully** — re-read the previously validated live entries `tasks/20260402-122116-step3-artifacts-valid2/summary`, `...-gather/result-structured`, `...-report/result-structured`, and `tasks/20260402-122116-step3-invalid-model/result-structured`. The artifacts still match the Step 3 contract in docs: machine-readable parent summary with coherent final timings and per-phase outcomes, machine-readable phase results with runtime metadata and provenance, and a machine-readable failure artifact with reply metadata plus runtime failure details.
- **Step 3 artifact slice pushed, deployed, and live-validated** — deployed commit `9b1b900` to `huginmunin`, restarted Hugin onto worker `hugin-huginmunin-741842`, and validated both the success and failure artifact paths on the live service.
- **Pipeline summary artifact validated live** — the parent task `tasks/20260402-122116-step3-artifacts-valid2` wrote `spec`, `result`, and `summary` immediately on decomposition, then refreshed the summary through child execution until the final artifact reported `executionState: completed`, `terminal: true`, correct aggregate counts, and end-to-end timing.
- **Structured phase results validated live** — child tasks `...-gather` and `...-report` both wrote `result-structured` entries containing runtime metadata, pipeline context, task ids, dependency provenance, body text, and timings. The success path stayed on the Pi host with `qwen2.5:3b`.
- **Structured failure path validated live** — task `tasks/20260402-122116-step3-invalid-model` failed with a structured result that preserved reply metadata plus runtime metadata (`effectiveHost: none`, `fallbackReason: host_unreachable`) and the failure message in both `bodyText` and `errorMessage`.
- **Step 3 live evaluation record and sprint demo added** — recorded the formal results in `docs/step3-live-evaluation.md` and the human-facing artifact in `sprints/2026-04-02-step3-live-eval.md`.
- **Operational config drift exposed during evaluation** — the first submission from `Submitted by: Codex` failed because the deployed allowlist still permits `claude-*` plus `hugin`, not the Codex-facing names in repo docs. The live gate was rerun with `Submitted by: hugin`; this drift should be fixed before more desktop-driven evaluations.
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

## Earlier Sessions
- MCP connectivity fix for spawned agents (12b533c)
- Removed dead email notification code (6446262)
- **debate-codex skill improvements debate** — 2-round adversarial review of 8 proposed improvements. Codex cut it to 2: type-specific prompts + calibrated severity. See `debate/skill-improvements-summary.md`
- **Implemented debate results** — patched SKILL.md Steps 3, 6, 8 (b793a46 in claude-skills repo)

## Blockers
- None active

## Next Steps
- **Continue Phase 5 beyond Step 0** — build the remaining sensitivity propagation and audit trail from [docs/phase5-sensitivity-classification-engineering-plan.md](/Users/magnus/repos/hugin/docs/phase5-sensitivity-classification-engineering-plan.md): standalone declared/effective audit trail, richer pipeline propagation, and artifact/schema completion.
- **Run the Phase 5 corpus evaluation** — validate public/internal/private classification behavior on representative tasks before any Phase 6 routing work.
- Run a mixed soak: normal pipeline, mid-run cancellation, resume, and at least one gated side-effect phase under realistic Munin traffic.
- Continue observing mixed live workloads before declaring Munin-pressure hardening fully closed; the immediate startup, batching, lease-starvation, and orchestration control-path test gaps are fixed, but the orchestration layer still depends heavily on Munin state traffic.
- Add operator-facing documentation or helper tooling for writing valid `approval-decision` artifacts so Ratatoskr/humans do not have to remember the full schema by hand.
- Decide whether cancellation/result finalization should be hardened further so parent `status/result` converge as quickly as parent `summary` under heavy pressure.
- **Phase 6+: routing and templates** remain deferred until Phase 5 is implemented and validated.
- Deploy latest Ratatoskr features (poll recovery, delivery confirmation)
- Task progress streaming (partial results before completion)
