# Hugin — CLAUDE.md

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
3. Spawns the configured runtime (`claude -p` or `codex exec --full-auto`)
4. Captures stdout/stderr (last 50k chars) + streams to per-task log file
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

- **Runtime:** claude
- **Working dir:** /home/magnus/workspace
- **Timeout:** 300000
- **Submitted by:** claude-desktop
- **Submitted at:** 2026-03-14T10:00:00Z

### Prompt
<the actual prompt for the AI runtime>
```

Results are written to the same namespace under key `result`.

## Project structure

```
hugin/
├── package.json
├── tsconfig.json
├── CLAUDE.md
├── hugin.service
├── src/
│   ├── index.ts           # Dispatcher: poll loop, task execution, health endpoint
│   └── munin-client.ts    # HTTP client for Munin JSON-RPC API
├── tests/
│   └── dispatcher.test.ts
└── scripts/
    ├── deploy-pi.sh
    ├── sync-claude-config.sh  # Sync ~/.claude/ config to Pi
    └── update-cli.sh          # Auto-update CLI tools (daily cron)
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
