# Hugin — Status

**Last session:** 2026-04-16
**Branch:** main

## Completed This Session (2026-04-16)

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
- Watch first real task run under branch model to verify end-to-end PR creation works
- **#30 `think:false` for ollama reasoning models** — small change, big Pi win (90s → 2s on qwen3.5:2b)
- **#38 lease-reaper** — dispatcher can't reap tasks whose `lease_expires` is past
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
