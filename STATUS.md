# Hugin — Status

**Last session:** 2026-05-18
**Branch:** main

## Completed This Session (2026-05-18)

### Artifact delivery #68 — Round 2 adversarial review

- Wrote `debate/artifact-delivery-68-codex-rebuttal-1.md` (local debate artifact; `debate/*` is gitignored).
- Verdict: runtime-owned artifact delivery remains the right architecture, but the revised design is not safe to implement until the `delivery:pending` lifecycle protocol is pinned down.
- Key findings: first checkpoint must stay nonterminal (`running + delivery:pending` with active lease), Ratatoskr treats non-numeric exit codes as success, artifact delivery reconciliation is net-new, host allowlisting alone is insufficient without user/path-prefix constraints, and current tag builders drop `delivery:*`.
- Munin intentionally skipped for this review per user instruction.

## Completed This Session (2026-05-17)

### Friction-mcp — wired up end-to-end

- `HUGIN_FRICTION_INJECTION=on` set in Pi `.env` (`/home/magnus/repos/hugin/.env`) and verified in running process.
- Friction reporting directive added to `~/.claude/CLAUDE.md` on laptop (by user) — instructs Claude Code to proactively call `report_friction` at medium+ severity.
- Root cause of zero organic signals: tool existed and was Connected but nothing prompted the model to call it. Both gaps now closed.

### hugin-deploy.service — two bugs fixed (`12a5f6b`)

The Pi path-unit that rebuilds/restarts Hugin on commit had been silently failing for 4 days:

1. **`tsc: not found`** — `node_modules` was installed production-only (`npm ci --omit=dev`), so TypeScript devDeps were missing. Fixed: `ExecStart` now runs `npm install --include=dev && npm run build` (inline shell).
2. **Wrong manager context** — `ExecStartPost` ran `sudo systemctl restart hugin.service` against the *system* manager, but `hugin.service` is a *user* unit. Fixed: `systemctl --user restart hugin.service` with `User=magnus` + `XDG_RUNTIME_DIR=/run/user/1000`, no sudo.

Committed to `main`, pushed. Pi rebuilt, restarted, verified healthy. Unit is now `enabled` (was `disabled` — wouldn't have survived a Pi reboot before).

### deploy.sh user-scope fix (grimnir PR #20, `44696c8`)

Root cause of a deploy-induced outage: `deploy.sh` assumed all services are system units. For user-unit services (hugin, verdandi) it stopped+disabled the user instance, then tried `sudo systemctl restart` against a nonexistent system unit — taking the service offline.

- `services.json`: `systemd_units[].scope` field (`"system"` default, `"user"` for hugin and verdandi).
- `scripts/lib/registry.js`: emits `unit_scope` as 7th field in deploy query.
- `deploy.sh`: branches on scope — user units get `systemctl --user restart`, no stop/disable sabotage.

On `grimnir:fix/deploy-user-units` (PR #20). Tested: hugin redeploy now restarts cleanly with zero downtime.

### Security scan analysis

`grimnir-security-scan` (weekly, Sun 03:00) is healthy and already caught the hugin npm vulns this morning (03:06, `overall_status: critical`). The data went unread — identical failure mode to friction-mcp. Root issue: working collector, no sink.

### GitHub Issues filed + on Grimnir Roadmap board

- grimnir#21 — Security scan never surfaces: add delta-aware notification
- grimnir#22 — Secret-scan test-file exclusion broken (12 false positives/week; forces `overall_status: critical` permanently)
- grimnir#23 — Meta: build delta-surfacing component once for all collectors (friction, security, validate)
- grimnir#24 — `sync-repos.service` has no journal entries — auto git-pull may not be running
- hugin#69 — Dependency vulns: 5 high / 8 moderate (`npm audit fix` pending)

All added to Grimnir Roadmap project board.

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

## Next Steps (from 2026-05-17)

1. **`npm audit fix`** (hugin#69) — `npm audit fix` → build → test → deploy. Fast, no breaking changes.
2. **Merge grimnir PR #20** (`fix/deploy-user-units`) — deploy.sh user-scope fix. Has no conflicts.
3. **grimnir#22** — fix secret-scan test-file exclusion (note: `fix(security-scan): skip test files in secret scan` commit `776664a` already exists on `feat/tallriksvis-sandbox` — may just need cherry-picking to main).
4. **grimnir#21** after #22 — wire security-scan notification (depends on noise being cleared first).
5. **grimnir#24** — investigate `sync-repos.service` (no journal → possibly never ran; check `loginctl` linger, systemd user session persistence).
6. **Broker still disabled** on Pi — see broker enablement steps below.

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

### Broker enable (carry-forward from 2026-05-05)
1. Generate token: `openssl rand -hex 32`
2. Add to Pi `.env`: `HUGIN_BROKER_KEYS={"claude-code":"<token>"}`
3. Redeploy: `./scripts/deploy-pi.sh` (now safe post grimnir#20)
4. Register MCP on laptop: `claude mcp add-json hugin '{"command":"node","args":["/Users/magnus/repos/hugin/dist/mcp-server.js"],"env":{"HUGIN_BROKER_URL":"http://huginmunin:3033","HUGIN_BROKER_TOKEN":"<token>"}}' -s user`

### Hygiene (carry-forward)
- **Deploy signing secrets to Pi**: `HUGIN_SUBMITTER_KEYS` on Hugin; `RATATOSKR_SIGNING_SECRET` on Ratatoskr.
- **Flip `HUGIN_SIGNING_POLICY=warn`** once first submitter is signing; promote to `require` after ≥72h clean.
- **Roll `HUGIN_EXFIL_POLICY` / `HUGIN_EXTERNAL_POLICY`** past `warn` once banner volume understood.

### Multi-host sprint (after dogfood)
1. `Host:` field + peer-claim — coordinator Pi assigns `Host:`; peers filter poll by matching `Host:`.
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
