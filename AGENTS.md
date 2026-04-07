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
   - `ollama`: Calls ollama's OpenAI-compatible API with streaming. Supports context injection via `Context-refs` and infra-only fallback to claude.
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
- `Fallback:` — `claude` to fall back to claude on infra failures (host unreachable, 5xx); `none` (default) to fail without fallback. Semantic failure (model responds but poorly) is never retried — that's experiment data.
- `Context-refs:` — comma-separated Munin references (`namespace/key`) to fetch and inject into the prompt. Hugin enforces Munin classification against the task/runtime trust boundary before injecting them.
- `Context-budget:` — max characters for injected context (default 8000). Truncated from end if exceeded.

**Type tags:** Tags matching `type:*` (e.g., `type:research`, `type:email`) are carried forward through the task lifecycle (pending → running → completed/failed).

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
│   └── munin-client.ts    # HTTP client for Munin JSON-RPC API
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
| `OLLAMA_DEFAULT_MODEL` | `qwen3.5:2b` | Default model for ollama tasks without explicit Model field |
