# Zombie Procs Debate Summary

**Date:** 2026-04-09
**Participants:** Claude (author + adversarial reviewer), Codex (rate-limited — Claude stood in)
**Rounds:** 2
**Topic:** Root cause and fix for accumulating zombie `node dist/index.js` processes on the Pi

---

## Diagnosis confirmed

**Primary cause: Dual systemd service registration.**
Both `/etc/systemd/system/hugin.service` (system-level, installed by `deploy-pi.sh`) and `~/.config/systemd/user/hugin.service` (user-level) are enabled with `Restart=always`. User-level service wins port 3032; system-level crash-loops indefinitely. Confirmed by: active PID cgroup is `/user.slice/...`, system-level `MainPID=0, NRestarts=60+, ActiveState=activating`.

**Same issue on Ratatoskr** (port 3034).

---

## Concessions accepted

| Issue | Original position | Revised |
|-------|------------------|---------|
| C02 ReadWritePaths | Assumption / may be problem | Confirmed real bug: user-level service can't write to `.hugin/logs/` — tasks will fail |
| C03 Fix 3 shutdown | Add process.exit at end of shutdown() | Must await child exit first; hard timer is the only unconditional exit path |
| C05 Migration atomicity | Manual one-time step | deploy-pi.sh needs idempotent system-service removal block |
| C09 Repo service file | Not discussed | hugin.service (repo) has wrong directives for user-level (`User=magnus`, `WantedBy=multi-user.target`) |

---

## Defenses accepted by adversarial reviewer

- Dual-service diagnosis is correct (C01 resolved by cgroup evidence)
- Linger=yes confirmed (C06 moot)
- Fix 1 + Fix 2 are sound as core fixes
- Revised Fix 3 (await child exit, hard timer backstop) is correct

---

## Unresolved / open questions

- **ReadWritePaths scope** (C08): Option A (`/home/magnus`) vs Option B (`/home/magnus/repos/hugin /home/magnus/.hugin`). Needs write-path audit. Use Option A as safe default until audited.
- **munin-memory.service scope** (C04): Is it user-level or system-level? `After=` dependency may be silently ignored. Worth verifying but non-blocking.

---

## Action items

| # | Action | Severity | Notes |
|---|--------|----------|-------|
| 1 | Remove system-level hugin + ratatoskr services from Pi (one-time) | Critical | `sudo systemctl stop/disable/rm` both |
| 2 | Fix `scripts/deploy-pi.sh`: user-level install, idempotent legacy-removal block, `systemctl --user` for restart | Critical | Single commit |
| 3 | Fix repo `hugin.service`: remove `User=magnus`, change `WantedBy=default.target`, fix `ReadWritePaths` (use `/home/magnus /tmp` for now) | Critical | Part of same commit |
| 4 | Fix `src/index.ts` `shutdown()`: await child exit before process.exit; hard 30s timer as only unconditional exit | Major | Follow-up commit |
| 5 | Audit Hugin write paths to determine correct `ReadWritePaths` | Major | `strace` or code grep; resolve C08 |
| 6 | Verify munin-memory.service scope; clean up `After=` if needed | Minor | SSH check |

---

## Files

- `debate/zombie-procs-snapshot.md`
- `debate/zombie-procs-claude-draft.md`
- `debate/zombie-procs-claude-self-review.md`
- `debate/zombie-procs-codex-critique.md`
- `debate/zombie-procs-claude-response-1.md`
- `debate/zombie-procs-codex-rebuttal-1.md`
- `debate/zombie-procs-critique-log.json`
- `debate/zombie-procs-summary.md`

---

## Costs

| Invocation | Notes |
|------------|-------|
| Codex R1 | Rate-limited; Claude substituted |
| Codex R2 | Rate-limited; Claude substituted |
