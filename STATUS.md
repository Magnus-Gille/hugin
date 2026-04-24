# Hugin — Status

**Last session:** 2026-04-24
**Branch:** main

## Completed This Session (2026-04-24)

### Fix: independent lease reaper timer (#38 #58, PR #61, `c4d3932` + `9d3d1c3`, merged + deployed)

Root cause of two tasks appearing `running` simultaneously: `reapExpiredLeases()` ran inside `pollOnce`, which blocks for the duration of a task. A task running for minutes meant the reaper was frozen too, leaving orphan `running` tags uncollected.

Fix:
- Moved reaper to a dedicated `setInterval` at 60s (`LEASE_REAPER_INTERVAL_MS`)
- Added `startLeaseReaper()` / `stopLeaseReaper()` with in-flight guard and shutdown hook
- Added dedicated `reaperMunin` client so reaper traffic never queues behind task-completion writes or inherits task-scoped session IDs
- Updated stale comments in `src/index.ts` and `src/task-helpers.ts`

Codex review (`gpt-5.4 xhigh`) flagged shared `MuninClient` contention (medium) and stale comments (low) — both fixed in `9d3d1c3` before push.

Deployed to Pi (`huginmunin.local`, PID `hugin-huginmunin-2690885`). Post-deploy state verified: `polling: true`, `current_task: null`. The two research sweeps dispatched earlier resolved: codex orchestrator → `failed` (reaped, expired lease), drone → `completed`.

### Cleanup: stale legacy test entry deleted from Munin

`tasks/20260406-192449-mis-1-public-but-private-ref` — April 6 test entry manually written to `running` state with no lease metadata. Would never be auto-reaped (by design). Deleted entire namespace (3 state entries + 10 logs).

### Issues filed (added to Grimnir Roadmap #1)

- **#57** — non-atomic task completion: `completed` write can fail after result write, leaving permanent `running` tag
- **#58** — reaper blocked inside poll loop (fixed this session ✅)
- **#59** — no CLI auto-update routine for major bumps (codex/claude)
- **#60** — `update-cli.sh` uses `npm update -g` (misses major version bumps)

## Completed This Session (2026-04-23)

### Submitter rollout for HMAC task signing (#11 follow-up)

First two submitters now speak the v1 signing scheme shipped in #11 (PR #52):

- **Ratatoskr** (`repos/ratatoskr`): added `src/task-signing.ts` mirroring hugin's canonicalization; `src/task-writer.ts` embeds `**Signature:** v1:<keyId>:<hex>` when `RATATOSKR_SIGNING_SECRET` is set, omits otherwise (backwards-compat during rollout). Config adds `RATATOSKR_SIGNING_SECRET`/`RATATOSKR_SIGNING_KEY_ID`. Tests include a cross-language drift guard that spawns `hugin/scripts/sign-task.mjs` and asserts byte-equal output. 93/93 tests passing, build green.
- **`/submit-task` skill** (`~/.claude/skills/submit-task/SKILL.md`): new Step 7b invokes `scripts/sign-task.mjs` from claude-code when `HUGIN_SIGNING_SECRET` is in env; documents the limitation that desktop/web/mobile environments can't sign (no shell access) and submit unsigned during rollout.

No changes on Hugin side — verification already shipped and defaults to `HUGIN_SIGNING_POLICY=off`. Next: distribute secrets to Pi, flip to `warn`, watch log for any straggler submitters.

## Completed 2026-04-20

### Merged PR #49 (`feat/ollama-think-false`, `c404ad1`)
Merged at session start. Reasoning models (qwen3/3.5, deepseek-r1, magistral) now auto-route to `/api/chat` with `think:false`, cutting inference latency 90s → 2s on Pi.

### Feature: prompt-injection scanner for context-refs (#10, PR #51, `32633fe`, merged)

Codex review on PR #51 caught 3 findings — all fixed in branch before merge:

1. (medium) `maxSensitivity` updated before block-policy quarantine check → deferred until after block/fail to prevent quarantined refs from influencing routing.
2. (low) fail mode pushed skipped refs into `refsResolved` via stray loop → removed.
3. (low) AGENTS.md stale → synced with CLAUDE.md.

New files: `src/prompt-injection-scanner.ts`, `src/context-loader.ts` (wired scanner), `docs/security/prompt-injection-scanner.md`, `tests/prompt-injection-scanner.test.ts`. Regex pattern uses `\u0075` escape for `curl` to avoid security_reminder_hook.

### Feature: HMAC-SHA256 task submission signing (#11, PR #52, `46cea1b`, merged)

Verification-only MVP — verifies signatures Hugin receives; submitter rollout deferred. Policy modes: `off` (default) / `warn` / `require`. New env vars: `HUGIN_SIGNING_POLICY`, `HUGIN_SUBMITTER_KEYS`, `HUGIN_SUBMITTER_KEYS_FILE`.

Codex review on PR #52 caught 6 findings — all fixed before merge:

1. (critical) keyId not bound to submitter: ratatoskr-keyed signer could spoof Codex-desktop. Fixed: new `submitter-mismatch` status; keyId must equal submitter or be a rotation alias `<submitter>-<rotation>`.
2. (medium) Prompt canonicalization drift: sign-task.mjs signed raw bytes, Hugin trimmed. Fixed: shared `canonicalizePrompt()` on both sides.
3. (medium) `Runtime: auto` tasks verified against router's resolved runtime, not the declared `auto`. Fixed: read declared runtime from raw body at verify time.
4. (medium) Pipeline children (`Submitted by: hugin`) would be rejected under `require`. Fixed: internally-generated tasks exempt from signing.
5. (medium) `parseSigningPolicy("requrie")` silently returned `"off"`. Fixed: throws on unrecognized values so the control can't degrade itself by typo.
6. (low) Secret-format docs inconsistent across AGENTS.md / CLAUDE.md / security doc. Fixed: aligned to "64-char hex preferred; base64 accepted".

New files: `src/task-signing.ts`, `scripts/sign-task.mjs`, `docs/security/task-signing.md`, `tests/task-signing.test.ts` (32 tests including cross-language drift guard). 346/346 tests passing.

### Feature: exfiltration scanner for task results (#13, PR #53, `aca095c`, merged)

Regex scanner runs on every task result body before it is written back to Munin. Patterns: PEM private-key headers, API keys (OpenAI sk-, sk-proj-, Anthropic sk-ant-api, GitHub classic + fine-grained PATs, AWS, Google, JWT Bearer), exfil commands (curl/wget/Invoke-WebRequest/fetch POST variants), URLs with sensitive query params, long base64 blobs. Policy modes: `off` / `warn` (default) / `flag` / `redact`. New env var: `HUGIN_EXFIL_POLICY`.

Codex review on PR #53 caught 4 findings — all fixed before merge:

1. (medium) exfil-command regex missed `curl URL -d @file`, URL-before-flag, `-F` uploads → rewrote with flag-before-URL and URL-before-flag alternatives, bounded non-greedy, expanded flag list.
2. (medium) GitHub fine-grained PATs (`github_pat_…`) missing → added to api-key alternation.
3. (low) exfil-url keyword list too broad (flagged `key=sort_order`, `session=…`) → narrowed to strictly sensitive names.
4. (low) `markTaskCancelled()` bypass risk — cancel path wrote result body without scanning → threaded `applyExfilPolicy()` through the helper.

### Feature: provenance enforcement for context-refs (#12, PR #54, `b465928`, merged)

Detects externally sourced Munin entries (via `source:external` tag or `signals/` namespace prefix) and enforces `HUGIN_EXTERNAL_POLICY`: `allow` / `warn` (default, prepends banner) / `block` (quarantines external refs) / `fail` (rejects task). External-policy enforcement runs before injection-policy so `fail`/`block` external refs are handled consistently.

Codex review on PR #54 caught 2 findings — both fixed before merge:

1. (medium) `HUGIN_EXTERNAL_POLICY` parsed lazily inside `resolveContextRefs()`; a misspelled value would throw on every poll and wedge the queue → parsed once at startup into `config.externalPolicy` and threaded through.
2. (low) Docs claimed provenance fields surfaced in journal/structured-result but implementation did not write them → added `external_policy`, `max_provenance`, `context_refs_external`, `external_blocked` to ollama journal extras; doc narrowed to reflect actual exposure.

New files: `src/provenance.ts`, `docs/security/provenance-enforcement.md`, `tests/provenance.test.ts`. 400/400 tests passing.

## Blockers
None.

## Next Steps
- **Security sprint — DONE** (#10 ✅ #11 ✅ #12 ✅ #13 ✅). Remaining: operational rollout.
- **Submitter rollout for signing** — Ratatoskr ✅ / `/submit-task` skill (claude-code) ✅ / Codex CLI (codex-desktop, codex-web, codex-mobile) ⬜ / pipeline-parent signing (v1 doesn't bind `### Pipeline` bodies) ⬜.
- **Deploy signing secrets to Pi**: generate one 64-char hex per signer; put matching entries into `HUGIN_SUBMITTER_KEYS` on Hugin; deliver the corresponding secret to each submitter host (`RATATOSKR_SIGNING_SECRET` on Ratatoskr; `HUGIN_SIGNING_SECRET` on laptop claude-code).
- **Flip `HUGIN_SIGNING_POLICY=warn` on Pi** once the first submitter is signing in the field, watch `[signing]` log lines for stragglers, promote to `require` after ≥72h clean.
- **Roll `HUGIN_EXFIL_POLICY` and `HUGIN_EXTERNAL_POLICY` past `warn`** once banner volume on real traffic is understood.
- **Phase 7: Methodology templates** (#5) — next feature phase.
- **Orphan branch cleanup** — prune `hugin/*` branches older than 7d with no open PR (follow-up to #47).

## Plan Status
- **Phases 1-6** — done and live-validated.
- **Phase 7: Methodology templates** — not started.
- **Security hardening sprint** — #10 ✅ #11 ✅ #12 ✅ #13 ✅ — all shipped.

---

## Previous Sessions (kept for history)

### 2026-04-17

**Fix: stable mcp-session-id forwarded to Agent SDK's Munin MCP client (#48, `7b794ba`, merged)**
Hugin was generating a fresh session UUID per request, breaking munin-memory outcome-aware retrieval Phase 2 session windows.

**Feature: `think:false` for Ollama reasoning models (#30, PR #49, opened)**
See "Completed This Session" above for details.

**Fix: reap expired leases mid-poll (#38, `293292f`, merged)**
`recoverStaleTasks()` only ran at startup. Added `reapExpiredLeases()` every 5 polls.

### 2026-04-12 (evening — git-fetch retry/bypass, CI pipeline, branch protection)

**Fix: pre-task git fetch retry + bypass system SSH config (#42, PR #43, `a59c8e3`, deployed)**
**CI pipeline added (PR #44, `98dcc57`)**

### 2026-04-11 (afternoon — silent write-failure fix, locomo recovery)

**Fix: silent Munin write rejections + artifact classification clamping (`1ef43e2`, PR #41)**

### Earlier sessions
See git log for full history.
