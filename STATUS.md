# Hugin — Status

**Last session:** 2026-04-17
**Branch:** main

## Completed This Session (2026-04-17)

### Fix: stable mcp-session-id forwarded to Agent SDK's Munin MCP client (#48, `7b794ba`, merged)

Hugin's HTTP MCP client was generating a fresh session UUID per request, which broke munin-memory outcome-aware retrieval Phase 2 (session windows couldn't be correlated). Unblocks munin-memory#31.

- Added `muninSessionId?: string` to `SdkTaskConfig`; when set, `executeSdkTask` includes `"mcp-session-id": task.muninSessionId` in the MCP server headers.
- Call sites in `index.ts` now pass `munin.getSessionId()` (3 locations).
- Tests: 2 new cases in `tests/sdk-executor.test.ts` verifying header forwarding when set/omitted.
- Codex reviewed → no issues.

### Feature: `think:false` support for Ollama reasoning models (#30, PR #49, open)

Reasoning models (qwen3, qwen3.5, deepseek-r1, magistral) spent 90s on chain-of-thought for trivial prompts. Ollama's native `/api/chat` accepts `think:false` to skip this (90s → 2s on Pi); the OpenAI-compat endpoint does not.

- Auto-routes reasoning models to `/api/chat` (NDJSON) and passes `think:false` by default; opt-in override via `**Reasoning: true**` task field.
- Captures native timing/token fields (`prompt_eval_count`, `eval_count`, `total_duration`, `load_duration`).
- Tests: 10 new cases in `tests/ollama-executor.test.ts`.
- Codex review caught 4 medium + 1 low; all fixed in the same branch:
  1. Native-path banner leaked into `resultText` (JSON corruption) → write banner via `logStream.write` only.
  2. Final NDJSON chunk without trailing newline stranded `done:true` payload → extracted `processLine()` + post-loop flush.
  3. `gpt-oss` uses level-based `think` (low/medium/high), not boolean → removed from auto-detect list; documented caveat.
  4. `message.thinking` trace was discarded → stream to log file only (never `resultText`).
  5. (low) AGENTS.md stale → synced with CLAUDE.md.
- **Status: PR #49 open, not merged yet.** Awaiting merge.

### Fix: reap expired leases mid-poll (#38, `293292f`, merged)

`recoverStaleTasks()` only ran at startup. A runtime crash or OOM kill left tasks stuck with the `running` tag until the next dispatcher restart. Added `reapExpiredLeases()` running every 5 polls (~2.5 min at the default 30s interval) — transitions tasks with truly-expired leases to `failed` with reason `lease-expired`. Fail-fast (no auto-retry to `pending`) per the issue author's recommendation.

- Pure decision helper `shouldReapExpiredLease` in `task-helpers.ts` (9 unit tests).
- Safety properties: never reaps the currently-executing task on this worker; never reaps legacy tasks missing `lease_expires:` metadata; re-reads authoritative tags before writing (so a lease renewal landing between query and write is respected); swallows CAS failures.
- Codex reviewed → no issues found (clean review, noted residual risk is the absence of an I/O-side integration test, which composes existing tested paths).

### RCA + fix: branch-per-task with PR delivery (#47, `afb50b3`, deployed)

A research spike task targeting `/home/magnus/repos/grimnir` failed with exit -1 before execution. The error was "1 commits behind origin/main and cannot fast-forward. Manual intervention required."

**Root cause:** `syncRepoBeforeTask` used `git pull --ff-only`, which hard-fails if the local repo has diverged (local commits + remote ahead). The Pi's grimnir repo was in exactly that state. The hard-fail applied uniformly to all task types, including read-only research spikes that don't need a clean working tree at all.

**Fix:** replaced the pre-task sync + post-task push model entirely with **branch-per-task + PR delivery**:

- **Pre-task** (`checkoutTaskBranch`): `git fetch origin` (same SSH retry/bypass from #42) + `git checkout -b hugin/<taskId> origin/main`. Always branches from the remote ref, bypasses local state. Non-fatal on failure — task proceeds without branching rather than hard-failing.
- **Post-task** (`finalizeTaskBranch`): auto-commits any uncommitted changes the task left behind, then:
  - **No commits** (research spikes, read-only tasks): detach + delete the branch, done.
  - **Commits exist**: `git push -u origin hugin/<taskId>` → `gh pr create --base main` → PR URL included in result.
- **`prUrl`** surfaced in both the human-readable result doc (`- **PR:** https://...`) and the structured result schema.
- Removed `syncRepoBeforeTask`, `postTaskGitPush`, and all associated ff-only/rebase logic.

**Tests:** 16 new tests in `tests/repo-sync.test.ts` covering `checkoutTaskBranch` (skips, SSH retry, checkout failure) and `finalizeTaskBranch` (no-changes cleanup, auto-commit + PR, egress block, push failure, gh failure, correct PR title/base). 272/272 passing. Closes #47.

**Known limitation:** pipeline sequences — task B branches from `origin/main`, not from task A's unmerged branch. Acceptable for now; noted in issue for future work.

## Blockers
None.

## Next Steps
- **Merge PR #49** (`feat/ollama-think-false`) — Codex-approved, Pi-side win waiting behind the merge
- Watch next task run to confirm lease-reaper behaves (it's scoped to every 5 polls; first opportunity to observe is after a worker crash in the wild)
- **Orphan branch cleanup** — prune `hugin/*` branches older than 7d with no open PR (follow-up to #47)
- **Phase 7: Methodology templates** (#5) — next feature phase
- **Security backlog:** #10-13 (prompt injection, task signing, provenance, exfiltration)

## Plan Status
- **Phases 1-6** — done and live-validated.
- **Phase 7: Methodology templates** — not started.
- **Bet 1, Bet 2** — closed.

---

## Previous Sessions (kept for history)

### 2026-04-12 (evening — git-fetch retry/bypass, CI pipeline, branch protection)

**Fix: pre-task git fetch retry + bypass system SSH config (#42, PR #43, `a59c8e3`, deployed)**
Fetch failures in systemd-user context (SSH strict-modes error on `/etc/ssh/ssh_config.d/`) caused tasks to hard-fail. Fix: `fetch-failed` action is non-fatal (warn + proceed), retry up to 3 attempts, retries set `GIT_SSH_COMMAND='ssh -F /home/magnus/.ssh/config'` to bypass system SSH config.

**CI pipeline added (PR #44, `98dcc57`)**
`.github/workflows/ci.yml` — build + test on push/PR. Branch protection: `build-test` required, linear history.

### 2026-04-11 (afternoon — silent write-failure fix, locomo recovery)

**Fix: silent Munin write rejections + artifact classification clamping (`1ef43e2`, PR #41)**
`munin.write()` swallowed `{ok: false}` rejections silently. `getTaskArtifactClassification()` let owner-override tasks write below the `tasks/*` namespace floor (`internal`), causing every post-task write to be rejected. Fix: `write()` now throws on `{ok: false}`; artifact classification clamps up to namespace floor.

### Earlier sessions
See git log for full history.
