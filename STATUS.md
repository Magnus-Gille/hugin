# Hugin — Status

**Last session:** 2026-03-21
**Branch:** main

## Completed This Session
- Fixed Pi MCP config: removed broken stdio bridge (`/home/magnus/munin-memory/dist/bridge.js` — missing), replaced with HTTP transport pointing at `localhost:3030/mcp` with Bearer auth. `claude mcp list` now shows `munin-memory: ✓ Connected`
- Switched Pi GitHub auth from Magnus-Gille → grimnir-bot (`gh auth login` as grimnir-bot, SSH key `grimnir-bot.pub` uploaded)
- Dispatched 8 Heimdall tasks (all completed successfully, ~66 min total):
  1. MCP health probe (642s) — new collector probe for MCP transport health
  2. Fix task widget filtering (220s) — exclude tasks/admin from Hugin Tasks card
  3. Fix backup detection (981s) — Munin DB and Mimir freshness
  4. SQL injection fix in heimdall-query (246s) — H2 security finding
  5. CSP + HSTS headers (276s) — H4 + L3 security findings
  6. Input validation on metrics API (261s) — M7 security finding
  7. Hugin heartbeat consumption (432s) — dispatcher status on dashboard
  8. Dream project: Skuld created (1052s) — see below
- **Skuld — The Daily Oracle** born: proactive daily intelligence briefing system
  - Repo: github.com/grimnir-bot/skuld (private, Magnus-Gille added as admin collaborator)
  - Phase 1 MVP complete: CLI (`skuld briefing/dry-run/serve`), 28 tests, Munin integration
  - README task also completed (512-line AI-readable README)
- Updated noxctl project status in Munin (Tier 3 resources shipped: 254→323 tests, 4 new modules)
- noxctl tier3 task from last night confirmed completed (projects, cost centers, tax reductions, price lists)

## In Progress
- Nothing actively running

## Blockers
- Munin embedding model failing (cache dir ENOENT under ProtectHome=read-only) — lexical search works
- mDNS (huginmunin.local) not resolving — using Tailscale IP 100.97.117.37
- Magnus-Gille/skuld (old repo) still exists on GitHub — needs manual deletion

## Next Steps
- Skuld Phase 2: Fortnox financial awareness (invoice aging, revenue pulse)
- Consider running Skuld via Hugin daily task instead of API key (uses Claude Code subscription)
- Delete stale Magnus-Gille/skuld repo
- Add grimnir-bot as collaborator on all repos Hugin pushes to
- Review Heimdall task outputs in detail (8 tasks shipped but not individually reviewed)
- P1 fixes to architecture guide: source-of-truth pointers, decision rationale
- Task completion notifications (so dispatched tasks don't surprise you days later)
