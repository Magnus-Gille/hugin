# Hugin — Status

**Last session:** 2026-03-22 (evening)
**Branch:** main

## Completed This Session
- **Agent SDK migration** — replaced CLI spawn with `@anthropic-ai/claude-agent-sdk` `query()` for claude runtime
  - New `src/sdk-executor.ts`: async generator based execution, structured result extraction
  - Two-stage timeout: `AbortController.abort()` → `query.close()` with 10s grace
  - Spawn executor preserved as fallback via `HUGIN_CLAUDE_EXECUTOR=spawn`
  - Codex runtime path completely unchanged
  - 7 new tests for SDK executor (mock-based)
  - All 14 tests passing
  - Adversarial Codex review completed (design + implementation)
  - Cost tracking: `total_cost_usd` from SDK result logged per task

## Previous Session (2026-03-21)
- Grimnir system architecture review & cleanup
- Standardized deploy path to ~/repos/hugin
- Stop hook for result capture (e0a141a)
- Email notifications via Heimdall (e945a3b)

## Blockers
- Munin embedding model failing (cache dir ENOENT under ProtectHome=read-only) — lexical search works
- mDNS (huginmunin.local) not resolving — using Tailscale IP 100.97.117.37

## Next Steps
- Monitor SDK executor in production (first few tasks)
- If SDK issues: `HUGIN_CLAUDE_EXECUTOR=spawn` in .env, restart
- Consider MCP server injection for per-task Munin access (currently uses ambient config)
- Skuld Phase 2: Fortnox financial awareness
- Heimdall: bind to 127.0.0.1
