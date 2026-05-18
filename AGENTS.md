# Hugin — AGENTS.md

## What this project is

Hugin is a task dispatcher for the Grimnir personal AI system. Named after one of Odin's ravens (thought). Polls Munin for pending tasks, spawns AI runtimes (Claude Code, Codex) to execute them, and writes results back.

Part of the Grimnir system: **Munin** (memory/brain), **Mímir** (file archive), **Hugin** (task dispatcher).

## Architecture

- **Runtime:** Node.js 20+, TypeScript (strict mode)
- **Framework:** Express (health endpoint only)
- **Deployment:** Hugin-Munin Pi (huginmunin.local), systemd
- **Integration:** Munin HTTP API at localhost:3030

### How it works

1. Polls Munin every 30s for entries in `tasks/` namespace with tag `pending`
2. Claims a task (updates tags to `running` with compare-and-swap)
3. Executes via the configured runtime:
   - `claude` (default): Agent SDK `query()` for structured results
   - `codex`: `codex exec --full-auto` spawn
   - `ollama`: Streams responses from ollama. Non-reasoning models use the OpenAI-compatible `/v1/chat/completions` endpoint; reasoning-model families (qwen3/3.5, deepseek-r1, magistral) auto-route to the native `/api/chat` endpoint with `think:false` so the model skips internal reasoning tokens. Supports context injection via `Context-refs` and infra-only fallback to claude.
4. Captures output (SDK message events or stdout/stderr) + streams to per-task log file
5. Writes result back to Munin, updates tags to `completed` or `failed`
6. Emits heartbeat to `tasks/_heartbeat` after each poll cycle
7. One task at a time — no parallelism

### Task schema

Submit a task by writing to Munin from any environment:

```
Namespace: tasks/<task-id>   (e.g. tasks/20260314-100000-a3f1)
Key: status
Tags: ["pending", "runtime:claude"]
```

Content format:
```markdown
## Task: <title>

- **Runtime:** claude | codex | ollama
- **Context:** repo:heimdall
- **Working dir:** /home/magnus/workspace
- **Timeout:** 300000
- **Submitted by:** Codex-desktop
- **Submitted at:** 2026-03-14T10:00:00Z
- **Reply-to:** telegram:12345678
- **Reply-format:** summary
- **Model:** qwen2.5:7b
- **Ollama-host:** pi | laptop
- **Reasoning:** true | false
- **Fallback:** claude | none
- **Context-refs:** meta/conventions/status, projects/heimdall/status
- **Context-budget:** 8000
- **Group:** batch-20260323
- **Sequence:** 1

### Prompt
<the actual prompt for the AI runtime>
```

**Context resolution:** `Context:` takes priority over `Working dir:` for determining the working directory. Supported aliases:
- `repo:<name>` → `/home/magnus/repos/<name>`
- `scratch` → `/home/magnus/scratch` (non-code tasks)
- `files` → `/home/magnus/mimir`
- Raw absolute paths are passed through unchanged

**Reply routing:** `Reply-to:` and `Reply-format:` are forwarded in the result for downstream consumers (e.g., Ratatoskr).

**Task groups:** `Group:` and `Sequence:` enable multi-step task orchestration. Both are forwarded in results and heartbeats.

**Ollama-specific fields:**
- `Ollama-host:` — prefer a specific host (`pi` for local, `laptop` for remote via Tailscale). Default: auto-select.
- `Reasoning:` — `true` to force `think:true` via native `/api/chat`, `false` to force `think:false`. Omit to auto: reasoning-model families (qwen3/3.5, deepseek-r1, magistral) default to `think:false` via `/api/chat`; other models use the OpenAI-compatible endpoint unchanged. `gpt-oss` uses level-based reasoning and is not auto-routed.
- `Fallback:` — `claude` to fall back to claude on infra failures (host unreachable, 5xx); `none` (default) to fail without fallback. Semantic failure (model responds but poorly) is never retried — that's experiment data.
- `Context-refs:` — comma-separated Munin references (`namespace/key`) to fetch and inject into the prompt. Hugin enforces Munin classification against the task/runtime trust boundary before injecting them.
- `Context-budget:` — max characters for injected context (default 8000). Truncated from end if exceeded.

**Type tags:** Tags matching `type:*` (e.g., `type:research`, `type:email`) are carried forward through the task lifecycle (pending → running → completed/failed).

**Artefact delivery (`### Artifacts` manifest, issue #68):** A task may declare an `### Artifacts` section so **Hugin (not the agent)** owns and verifies delivery of the deliverables; the agent only writes to the declared local staging paths and makes no delivery claims.

- **Grammar (load-bearing):** `### Artifacts` MUST appear *before* `### Prompt` (prompt extraction reads `### Prompt` → EOF, so a manifest after it leaks into the agent prompt). This ordering violation is rejected at submit time **regardless of `HUGIN_DELIVERY_POLICY`**.
- **Shape:** a single fenced ```json array; each entry `{ "id", "local", "remote": "user@host:/abs/path", "required": true|false }`. `local` must be absolute, under an allowed staging prefix, and not a symlink (a staged symlink / a path that realpath-resolves outside the staging root is rejected as `unsafe-local`). `remote` must match an allowed target tuple. Un-substituted `<placeholder>`s, `..`, NUL, newlines, shell metacharacters, and disallowed targets are rejected before the (paid) run.
- **Lifecycle:** after the agent finishes, Hugin writes a durable nonterminal `running + delivery:pending` checkpoint (agent content preserved in `result`), then `statSync` → `rsync` to `<remote>.partial` → remote `sha256sum` match → atomic `ssh mv`. The final `result` is written before the terminal status flip, which CAS-guards a single owner. A terminal delivery failure renders **`- **Exit code:** 2`** + `- **Failure kind:** DELIVERY_FAILED` (positive integer — Ratatoskr treats a non-numeric/negative code as success). Status carries `delivery:verified` / `delivery:failed`; the structured result carries an optional `artifactDelivery` object. A crash mid-delivery is reconciled on restart without a paid rerun.

Results are written to the same namespace under key `result`.

## Project structure

```
hugin/
├── package.json
├── tsconfig.json
├── AGENTS.md
├── hugin.service
├── src/
│   ├── index.ts           # Dispatcher: poll loop, task execution, health endpoint
│   ├── sdk-executor.ts    # Agent SDK executor (query() based, default for claude runtime)
│   ├── ollama-executor.ts # Ollama executor (streaming, OpenAI-compatible API)
│   ├── ollama-hosts.ts    # Lazy host resolution with negative caching
│   ├── context-loader.ts  # Context-refs resolver (fetch Munin entries for prompt injection)
│   ├── prompt-injection-scanner.ts # Regex scanner for adversarial patterns in context-ref content
│   ├── exfiltration-scanner.ts   # Regex scanner for data-leak patterns in task output
│   ├── provenance.ts               # External-vs-trusted provenance detection for context-refs
│   ├── task-signing.ts             # HMAC-SHA256 task submission signing/verification
│   ├── munin-client.ts    # HTTP client for Munin JSON-RPC API
│   ├── artifact-delivery.ts      # Runtime-owned artefact delivery (#68): manifest parse/validate, target allowlist, symlink guard, rsync→sha256→mv deliver+verify
│   ├── mcp-server.ts             # hugin-mcp stdio entrypoint (orchestrator-side, on the laptop)
│   ├── mcp/                      # hugin-mcp internals (broker client + tool definitions)
│   │   ├── broker-client.ts      # HTTP client for /v1/delegate/* (bearer auth, AbortController timeout)
│   │   └── tools.ts              # 5 MCP tools (hugin_submit/await/rate/list/models) with envelope autofill
│   └── broker/                   # Orchestrator-v1 broker (Tailscale-only HTTP, /v1/delegate/*)
│       ├── server.ts             # Express app + opt-in startup (HUGIN_BROKER_KEYS)
│       ├── handlers.ts           # submit/await/rate/list/models endpoint handlers
│       ├── orch-worker.ts        # Polls Munin for orch-v1 tasks, claims via CAS, dispatches to OpenRouter
│       ├── openrouter-executor.ts # OpenRouter one-shot delegation runner
│       ├── reconciliation.ts     # Periodic sweep: backfill journal events for orch-v1 tasks
│       └── task-store.ts         # Munin operations: submit / read / two-phase complete
├── tests/
│   ├── dispatcher.test.ts
│   └── sdk-executor.test.ts
└── scripts/
    ├── deploy-pi.sh
    ├── submit-daily-analysis.sh  # Submit daily journal analysis as ollama task
    ├── sync-claude-config.sh     # Sync ~/.claude/ config to Pi
    └── update-cli.sh             # Auto-update CLI tools (daily cron)
```

## How to build

```bash
npm install
npm run build
```

## How to test

```bash
npm test
```

## How to run locally

```bash
MUNIN_API_KEY=<key> MUNIN_URL=http://localhost:3030 npm run dev
```

## Deployment

```bash
./scripts/deploy-pi.sh [hostname]
```

Default host: `huginmunin.local` (or Tailscale IP `100.97.117.37` if mDNS unavailable).

The Pi needs a `.env` file at `/home/magnus/hugin/.env`:
```
MUNIN_API_KEY=<same key Munin uses>
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HUGIN_PORT` | `3032` | Health endpoint port |
| `HUGIN_HOST` | `127.0.0.1` | Bind address |
| `MUNIN_URL` | `http://localhost:3030` | Munin HTTP endpoint |
| `MUNIN_API_KEY` | — | Bearer token for Munin (required) |
| `HUGIN_POLL_INTERVAL_MS` | `30000` | Poll frequency (ms) |
| `HUGIN_DEFAULT_TIMEOUT_MS` | `300000` | Default task timeout (ms) |
| `HUGIN_WORKSPACE` | `/home/magnus/workspace` | Default working directory |
| `HUGIN_MAX_OUTPUT_CHARS` | `50000` | Max output chars to capture |
| `HUGIN_ALLOWED_SUBMITTERS` | `Codex,Codex-desktop,ratatoskr,Codex-web,Codex-mobile,claude-code,claude-desktop,claude-web,claude-mobile,hugin` | Comma-separated list of allowed `Submitted by:` values. Includes both current Codex-facing names and legacy `claude-*` names during the transition. Set to `*` to allow all. |
| `OLLAMA_PI_URL` | `http://127.0.0.1:11434` | Ollama endpoint on Pi (local) |
| `OLLAMA_LAPTOP_URL` | — | Ollama endpoint on laptop (via Tailscale, empty = disabled) |
| `OLLAMA_DEFAULT_MODEL` | `qwen2.5:3b` | Default model for ollama tasks without explicit Model field |
| `HUGIN_INJECTION_POLICY` | `warn` | Prompt-injection policy for context-refs: `off` (no scan), `warn` (prepend warning banner), `block` (quarantine high-severity refs, task continues), `fail` (reject task). See `docs/security/prompt-injection-scanner.md`. |
| `HUGIN_EXFIL_POLICY` | `warn` | Exfiltration scanner policy for task results: `off` / `warn` / `flag` / `redact`. See `docs/security/exfiltration-scanner.md`. |
| `HUGIN_EXTERNAL_POLICY` | `warn` | Provenance policy for externally sourced context-refs (entries tagged `source:external` or under `signals/`): `allow` / `warn` / `block` / `fail`. See `docs/security/provenance-enforcement.md`. |
| `HUGIN_SIGNING_POLICY` | `off` | Task signature verification: `off` (skip), `warn` (log missing/invalid, never reject), `require` (reject unsigned/invalid). See `docs/security/task-signing.md`. |
| `HUGIN_SUBMITTER_KEYS` | — | Inline JSON keystore for task signing: `{"<keyId>": "<hex-secret>"}` (64-char hex preferred; base64 accepted). |
| `HUGIN_SUBMITTER_KEYS_FILE` | — | Path to a JSON keystore file. Takes precedence over `HUGIN_SUBMITTER_KEYS`. |
| `HUGIN_DELIVERY_POLICY` | `require` | Runtime-owned artefact delivery (issue #68): `off` (ignore `### Artifacts` manifests — rollback / old-skill compat; the `### Artifacts`-after-`### Prompt` grammar error is still rejected), `warn` (validate + report diagnostics, never fail a content-success task), `require` (missing/unsafe local content or an unrecoverable delivery failure → terminal `failed`, content preserved in the checkpoint so re-submission is free). |
| `HUGIN_DELIVERY_TARGETS` | (single NAS) | JSON array of allowed delivery target tuples `[{ "user", "host", "remotePathPrefix", "localStagingPrefix" }]`. Separate from the fetch egress allowlist. A manifest `remote`/`local` must match a tuple, and the local path's realpath must stay under the staging prefix, or the task is rejected at submit time. |
| `HUGIN_BROKER_HOST` | `127.0.0.1` | Bind address for the orchestrator-v1 broker (`/v1/delegate/*`). Set to the Tailscale interface IP in production. |
| `HUGIN_BROKER_PORT` | `3033` | Port for the broker endpoint. |
| `HUGIN_BROKER_KEYS` | — | Inline JSON keystore: `{"<principal>": "<token>"}`. Setting either this or `HUGIN_BROKER_KEYS_FILE` enables the broker. |
| `HUGIN_BROKER_KEYS_FILE` | — | Path to a JSON keystore file for the broker. Takes precedence over `HUGIN_BROKER_KEYS`. |
| `HUGIN_BROKER_RECONCILIATION_INTERVAL_MS` | `60000` | Interval between reconciliation sweeps (backfills journal events for orch-v1 tasks visible in Munin). |
| `OPENROUTER_API_KEY` | — | OpenRouter API key. When set on a Pi-side broker, the orch-worker is enabled and dispatches `runtime: openrouter, family: one-shot` tasks. |
| `OPENROUTER_REFERER` | `https://hugin.local` | `HTTP-Referer` header sent on OpenRouter requests (provider attribution). |
| `OPENROUTER_APP_TITLE` | `hugin-orch-v1` | `X-Title` header sent on OpenRouter requests. |
| `HUGIN_BROKER_URL` | — | hugin-mcp only (laptop side): URL of the Pi broker, e.g. `http://huginmunin.<tailnet>.ts.net:3033`. |
| `HUGIN_BROKER_TOKEN` | — | hugin-mcp only: bearer token registered in the Pi's `HUGIN_BROKER_KEYS`. |
| `HUGIN_MCP_SUBMITTER` | `claude-code` | hugin-mcp only: `orchestrator_submitter` principal stamped on each delegation envelope. |
| `HUGIN_MCP_REQUEST_TIMEOUT_MS` | `60000` | hugin-mcp only: per-request HTTP timeout against the broker. |
