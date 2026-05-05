# Hugin — Status

**Last session:** 2026-05-05
**Branch:** main

## Completed This Session (2026-05-05)

### /delegate skill (orch-v1 Step 7)

- `~/.claude/skills/delegate/SKILL.md` — wraps `hugin_submit` → `hugin_await` polling → `hugin_rate`. Aliases (tiny/medium/large-reasoning), task_type taxonomy, sensitivity guard (no `private` via v1 broker), idempotency-key replay, structured error handling.
- Differentiates from `/submit-task`: one-shot bounded transforms (summarize/extract/draft/rewrite) vs autonomous Pi agent.
- Pending dogfood: enable broker on Pi + register hugin-mcp on laptop to actually exercise it.

### friction-mcp built, tested, smoke-tested end-to-end

- `src/friction/schema.ts` — Zod taxonomy (11 friction types, severity, resource_assessment, alias_suggested), `FRICTION_CATEGORY` map, `FRICTION_SCHEMA_VERSION=1`.
- `src/friction/munin-key.ts` — pure builders: namespace, key (task-id + ISO stamp with `:` and `.` → `-`), tags, JSON content.
- `src/friction/tool.ts` — `buildFrictionTool(deps)`, 2s hard timeout, lossy fire-and-forget (write errors → `dropped:true`, not `isError`).
- `src/friction-mcp.ts` — stdio entrypoint; required: `MUNIN_URL`, `MUNIN_API_KEY`; optional: `HUGIN_FRICTION_TASK_ID`, `HUGIN_FRICTION_MODEL_ID`, `HUGIN_FRICTION_WRITE_TIMEOUT_MS`.
- `scripts/friction-report.mjs` — v1 aggregation: `memory_list signals/friction`, group/count by model/type/severity.
- `tests/friction/{schema,munin-key,tool}.test.ts` — 28 tests, all green.
- `tests/sdk-executor.test.ts` — 3 new injection tests (off/on/default-model), all green.
- `src/sdk-executor.ts` — widened mcpServers type to `HttpMcpServer | StdioMcpServer`; friction injection gated on `HUGIN_FRICTION_INJECTION=on` (default off).
- Registered as user-scope MCP in Claude Code (`friction-mcp`), pointing at `http://huginmunin:3030`.
- Two smoke entries verified in `signals/friction/` — one from initial registration, one logging this session's copy-paste friction.

### Pi infrastructure changes (manual, not deployed)
- Munin now binds `0.0.0.0:3030` via systemd drop-in `/etc/systemd/system/munin-memory.service.d/bind.conf`.
- `MUNIN_ALLOWED_HOSTS` in `/home/magnus/munin-memory/.env` extended with `huginmunin:3030` (preserved `munin-memory.gille.ai`).
- UFW enabled: deny incoming, allow lo + tailscale0 + ssh.

### friction-mcp debate (prior session, same date)
- Debate concluded: build it (user override), adopt smaller technical fixes from critique.
- Summary + critique-log committed to `debate/friction-mcp-{summary,critique-log}.md`.

## In Progress

None.

## Last Major Delivery (2026-04-27)

### Steps 5 + 6 done — orch-v1 OpenRouter executor + hugin-mcp server (merged + deployed)

**Step 5 (PR #66, `87ba0e9`):** orch-worker poll loop:
- `orch-worker.ts` — claims orch-v1 `pending` tasks via CAS, dispatches to OpenRouter executor, two-phase complete
- `openrouter-executor.ts` — OpenRouter HTTP client with ZDR allowlist, structured result, error classification
- Codex review (gpt-5.4 xhigh) caught 6 findings, all fixed: lease window derived from `envelope.timeout_ms`, CAS-conflict vs other errors correctly distinguished, `pickPending` scans past unhandleable rows, `await` handler populates lease info from tags, reconciliation backfills `delegation_completed` for terminal tasks.

**Step 6 (PR #67, `dd5ea19`):** hugin-mcp stdio server:
- `src/mcp-server.ts` — entrypoint (`bin: hugin-mcp`), discovers `alias_map_version` from broker at startup
- `src/mcp/broker-client.ts` — HTTP client (bearer auth, AbortController timeout, `BrokerHttpError`/`BrokerNetworkError`, `new URL()` validation)
- `src/mcp/tools.ts` — five MCP tools (`hugin_submit/await/rate/list/models`) with envelope autofill
- Codex review caught 5 findings, all fixed: `alias_map_version` discovered live (F1), `idempotency_key` echoed in response for replay (F2), dropped broken `isMain` guard that defeated npm symlink (F3), `hugin_await` description aligned with broker (F4), URL validated with `new URL()` (F5).
- 579/579 tests passing.

Both PRs squash-merged to main. Deployed to Pi (`huginmunin.local`, PID 2911724). Health: `ok`.

**Broker status on Pi:** disabled — `HUGIN_BROKER_KEYS` not yet set. To enable:
1. Generate token: `openssl rand -hex 32`
2. Add to Pi `.env`: `HUGIN_BROKER_KEYS={"claude-code":"<token>"}`
3. Redeploy: `./scripts/deploy-pi.sh`
4. Register MCP on laptop: `claude mcp add-json hugin '{"command":"node","args":["/Users/magnus/repos/hugin/dist/mcp-server.js"],"env":{"HUGIN_BROKER_URL":"http://huginmunin:3033","HUGIN_BROKER_TOKEN":"<token>"}}' -s user`

## In Progress

None.

## Blockers

None.

## Next Steps

### Orchestrator v1 — enable + wire up
1. Generate `HUGIN_BROKER_KEYS` token (see above) and redeploy
2. Register `hugin-mcp` in Claude Code on laptop
3. Step 7: Write `/delegate` skill — wraps hugin_submit + poll loop + rate on completion
4. Step 8: Dogfood with 5–10 real delegations; spot-audit the journal

### Hygiene (carry-forward)
- **Deploy signing secrets to Pi**: generate one 64-char hex per signer; put matching entries into `HUGIN_SUBMITTER_KEYS` on Hugin; deliver the corresponding secret to each submitter host (`RATATOSKR_SIGNING_SECRET` on Ratatoskr; `HUGIN_SIGNING_SECRET` on laptop claude-code).
- **Flip `HUGIN_SIGNING_POLICY=warn` on Pi** once the first submitter is signing in the field, watch `[signing]` log lines for stragglers, promote to `require` after ≥72h clean.
- **Roll `HUGIN_EXFIL_POLICY` and `HUGIN_EXTERNAL_POLICY` past `warn`** once banner volume on real traffic is understood.

### Multi-host sprint (after dogfood)
1. `Host:` field + peer-claim — extend task schema; coordinator Pi assigns `Host:`; peer Hugins filter poll by matching `Host:`.
2. Agent-harness runtimes — `opencode-spawn` / `aider-spawn` executors.

---

## Previous Sessions (kept for history)

### 2026-04-26

Steps 1-4 + 5a/5b done (see git log for details). Orch-v1 broker, reconciliation, lease reaper, ZDR allowlist all merged.

### 2026-04-24

Fix: status-first ordering in task completion (#57). Research: orchestrator sweep for multi-host placement (stay DIY verdict).

### 2026-04-23

Submitter rollout for HMAC task signing. Ratatoskr + /submit-task skill updated.

### 2026-04-20

Features: prompt-injection scanner, HMAC signing, exfiltration scanner, provenance enforcement (PRs #51–54).

### Earlier sessions
See git log for full history.
