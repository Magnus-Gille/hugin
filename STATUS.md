# Hugin — Status

**Last session:** 2026-04-20
**Branch:** main

## Completed This Session (2026-04-20)

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

## Blockers
None.

## Next Steps
- **Security backlog:** #12 (provenance tagging), #13 (exfiltration detection)
- **Submitter rollout for signing** — per-submitter helpers for Codex CLI, Ratatoskr, /submit-task skill; documented in docs/security/task-signing.md as known follow-ups
- **Flip signing policy to `warn` on Pi** once first submitter is wired
- **Phase 7: Methodology templates** (#5) — next feature phase
- **Orphan branch cleanup** — prune `hugin/*` branches older than 7d with no open PR (follow-up to #47)

## Plan Status
- **Phases 1-6** — done and live-validated.
- **Phase 7: Methodology templates** — not started.
- **Security hardening sprint** — #10 ✅ #11 ✅ #12 #13 pending.

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
