# Hugin — Status

**Last session:** 2026-03-20
**Branch:** main

## Completed This Session
- Operational maturity phase 1 (`d23e290`):
  - `scripts/sync-claude-config.sh` — rsync global ~/.claude/ to Pi during deploy
  - `scripts/update-cli.sh` — daily cron auto-updates claude-code and codex CLIs
  - Heartbeat emission to `tasks/_heartbeat` after each poll cycle
- Fixed stale-recovery to measure time since claimed, not submitted (`6344259`)
- Renamed Jarvis → Grimnir across all docs (`c2c1702`)
- Fixed spawn ENOENT: auto-create working dir before spawning runtime (`c2c1702`)
- Fixed log stream crash: guarded against double-end on error+close race (`c2c1702`)
- Broadened systemd ReadWritePaths to `/home/magnus` for spawned runtimes
- Created `grimnir-bot` machine account:
  - Email: grimnir-bot@outlook.com (Outlook, passkey auth)
  - GitHub: grimnir-bot (SSH key on Pi, collaborator on hugin/noxctl/heimdall)
  - Pi git identity set to Grimnir Bot
- Updated Claude Code CLI on Pi: 2.1.39 → 2.1.80 (removed stale /usr/bin/claude)
- Recovered Munin from missing .env file
- Successfully dispatched noxctl tier3 task (running at session end)

## In Progress
- noxctl tier3 task running on Pi (2hr timeout, ~23:20 UTC start)

## Blockers
- Munin embedding model failing (cache dir issue) — lexical search still works
- mDNS (huginmunin.local) not resolving — using Tailscale IP 100.97.117.37

## Next Steps
- P1 fixes to architecture guide: source-of-truth pointers, decision rationale
- Heimdall integration: consume heartbeat, task history view, CLI drift tracking
- Heimdall bug: `tasks/admin` namespace shown as "Running: Admin" — should filter to Hugin lifecycle tags only
- Task completion notifications (so dispatched tasks don't surprise you days later)
- Consider `docs/runbook.md` for operational procedures
