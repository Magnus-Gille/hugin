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
3. Executes via the configured runtime:
   - `claude` (default): Agent SDK `query()` for structured results
   - `codex`: `codex exec --full-auto` spawn
   - `ollama`: Calls ollama's OpenAI-compatible API with streaming. Supports context injection via `Context-refs` and infra-only fallback to Claude.
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

- **Runtime:** claude | codex | ollama | pipeline | auto
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
- **Sensitivity:** internal
- **Capabilities:** tools, code, structured-output
- **Group:** batch-20260323
- **Sequence:** 1

### Prompt
<the actual prompt for the AI runtime>
```

**Context resolution:** `Context:` takes priority over `Working dir:` for determining the working directory. Supported aliases:
- `repo:<name>` → `/home/magnus/repos/<name>`
- `scratch` → `/home/magnus/scratch` (non-code tasks)
- `files` → `/home/magnus/mimir`
- Raw absolute paths under `/home/magnus/` are passed through; paths outside this prefix are rejected and fall back to the default workspace

**Reply routing:** `Reply-to:` and `Reply-format:` are forwarded in the result for downstream consumers (e.g., Ratatoskr).

**Task groups:** `Group:` and `Sequence:` enable multi-step task orchestration. Both are forwarded in results and heartbeats.

**Ollama-specific fields:**
- `Ollama-host:` — prefer a specific host (`pi` for local, `laptop` for remote via Tailscale). Default: auto-select.
- `Reasoning:` — `true` to force `think:true` via native `/api/chat`, `false` to force `think:false`. Omit to auto: reasoning-model families (qwen3/3.5, deepseek-r1, magistral) default to `think:false` via `/api/chat`; other models use the OpenAI-compatible endpoint unchanged. `gpt-oss` uses level-based reasoning (`low`/`medium`/`high`) and is not auto-routed — set `Reasoning:` explicitly only once Hugin supports levels.
- `Fallback:` — `claude` to fall back to Claude on infra failures (host unreachable, 5xx); `none` (default) to fail without fallback. Semantic failure (model responds but poorly) is never retried — that's experiment data.
- `Context-refs:` — comma-separated Munin references (`namespace/key`) to fetch and inject into the prompt. Hugin enforces Munin classification against the task/runtime trust boundary before injecting them.
- `Context-budget:` — max characters for injected context (default 8000). Truncated from end if exceeded.

**Type tags:** Tags matching `type:*` (e.g., `type:research`, `type:email`) are carried forward through the task lifecycle (pending → running → completed/failed).

**Sensitivity:** Optional `Sensitivity: public | internal | private` field. If omitted, Hugin infers sensitivity from the prompt (keyword detection), context path, and any context-refs. Cloud runtimes (claude, codex) are capped at `internal`; local runtimes (ollama) allow `private`. Tasks that exceed their runtime's sensitivity ceiling are rejected.

**Auto-routing:** Use `Runtime: auto` to let Hugin select the runtime. The router filters by trust tier (sensitivity ceiling), availability (ollama host probes), and capabilities, then ranks by cost (free > subscription), trust (trusted > semi-trusted), and model size. Optional `Capabilities: tools, code, structured-output` narrows candidates. Explicit runtimes remain the default — `auto` is opt-in. Routing decisions are logged and included in structured results.

**Pipeline tasks:** Use `Runtime: pipeline` with a `### Pipeline` section instead of `### Prompt`. Pipeline phases use runtime IDs (`claude-sdk`, `codex-spawn`, `ollama-pi`, `ollama-laptop`, or `auto`) which differ from standalone runtime names. Per-phase `Capabilities:` is supported.

**Results:** Written to the same namespace under two keys:
- `result` — human-readable markdown with exit code, timestamps, duration, and response body
- `result-structured` — machine-readable JSON (Zod-validated) with schema version, lifecycle metadata, runtime metadata (requested vs effective model/host), sensitivity audit, and structured body. Prefer this for programmatic consumption.

## Project structure

```
hugin/
├── package.json
├── tsconfig.json
├── CLAUDE.md
├── hugin.service
├── src/
│   ├── index.ts                  # Dispatcher: poll loop, task execution, health endpoint
│   ├── sdk-executor.ts           # Agent SDK executor (query() based, default for claude runtime)
│   ├── ollama-executor.ts        # Ollama executor (streaming, OpenAI-compatible API)
│   ├── ollama-hosts.ts           # Lazy host resolution with negative caching
│   ├── context-loader.ts         # Context-refs resolver with classification metadata
│   ├── prompt-injection-scanner.ts # Regex scanner for adversarial patterns in context-ref content
│   ├── exfiltration-scanner.ts   # Regex scanner for data-leak patterns in task output
│   ├── provenance.ts             # External-vs-trusted provenance detection for context-refs
│   ├── task-signing.ts           # HMAC-SHA256 task submission signing/verification
│   ├── munin-client.ts           # HTTP client for Munin JSON-RPC API
│   ├── router.ts                 # Runtime auto-routing (pure function, filter/rank chain)
│   ├── runtime-registry.ts       # Canonical runtime definitions (trust, cost, capabilities)
│   ├── sensitivity.ts            # Shared sensitivity model (public/internal/private lattice)
│   ├── egress-policy.ts          # Fetch egress controls (host allowlist)
│   ├── pipeline-ir.ts            # Pipeline intermediate representation and schema
│   ├── pipeline-compiler.ts      # Pipeline compilation with sensitivity enforcement
│   ├── pipeline-dispatch.ts      # Pipeline phase dispatch to runtimes
│   ├── pipeline-control.ts       # Pipeline lifecycle control (cancel, resume)
│   ├── pipeline-ops.ts           # Pipeline CRUD operations
│   ├── pipeline-gates.ts         # Human gate approval/rejection
│   ├── pipeline-summary.ts       # Pipeline result summarization
│   ├── pipeline-summary-manager.ts # Pipeline summary lifecycle management
│   ├── task-result-schema.ts     # Structured task result with classification
│   ├── task-status-tags.ts       # Tag manipulation helpers for task lifecycle
│   ├── task-graph.ts             # Task dependency graph for pipelines
│   ├── result-format.ts          # Result formatting utilities
│   └── broker/                   # Orchestrator-v1 broker (Tailscale-only HTTP, /v1/delegate/*)
│       ├── server.ts             # Express app + opt-in startup (HUGIN_BROKER_KEYS)
│       ├── handlers.ts           # submit/await/rate/list/models endpoint handlers
│       ├── auth.ts               # Bearer-token middleware, constant-time compare
│       ├── idempotency.ts        # In-memory idempotency-key dedupe (§3.1)
│       ├── journal.ts            # Append-only delegation-events.jsonl + projection
│       ├── task-store.ts         # Munin operations: submit / read / two-phase complete
│       ├── alias-resolution.ts   # Alias → AliasResolved annotation + policy_version
│       ├── reconciliation.ts     # Periodic sweep: backfill journal events for orch-v1 tasks
│       └── types.ts              # Zod schemas for the wire contract
├── tests/                        # 19 test files mirroring src/
├── docs/                         # Engineering plans, evaluations, security docs
│   └── security/                 # Threat models and security assessments
└── scripts/
    ├── deploy-pi.sh
    ├── submit-daily-analysis.sh  # Submit daily journal analysis as ollama task
    ├── submit-stale-status-review.sh
    ├── sync-claude-config.sh     # Sync ~/.claude/ config to Pi
    ├── update-cli.sh             # Auto-update CLI tools (daily cron)
    ├── on-task-stop.mjs          # Task stop hook
    ├── sync-repos.sh             # Periodic git pull for all repos (15min timer)
    ├── sync-repos.service        # systemd user service for sync-repos
    └── sync-repos.timer          # systemd user timer (every 15 minutes)
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

## Security docs

Security assessments, threat models, and audit reports live in `docs/security/`. These are committed to the repo (private, so acceptable) to keep them version-controlled alongside the code they assess.

**Convention:**
- Filename: `<topic>.md` (e.g., `lethal-trifecta-assessment.md`)
- Open findings should be filed as GitHub Issues, not left as prose in the doc
- Hugin tasks that produce security reports should commit and push them, not leave them as untracked files

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
| `HUGIN_ALLOWED_EGRESS_HOSTS` | — | Comma-separated extra hosts to allow for outbound fetch (added to built-in allowlist) |
| `HUGIN_INJECTION_POLICY` | `warn` | Prompt-injection policy for context-refs: `off` (no scan), `warn` (prepend warning banner), `block` (quarantine high-severity refs, task continues), `fail` (reject task). See `docs/security/prompt-injection-scanner.md`. |
| `HUGIN_EXFIL_POLICY` | `warn` | Exfiltration scanner policy for task results: `off` (no scan), `warn` (log + append security-scan section), `flag` (warn + tag result `security:exfil-suspected`), `redact` (flag + replace matches with `[redacted: <pattern>]`). See `docs/security/exfiltration-scanner.md`. |
| `HUGIN_EXTERNAL_POLICY` | `warn` | Provenance policy for externally sourced context-refs (entries tagged `source:external` or in the `signals/` namespace): `allow` (inject with banner only), `warn` (banner + log, default), `block` (quarantine external refs, task continues), `fail` (reject task). See `docs/security/provenance-enforcement.md`. |
| `HUGIN_SIGNING_POLICY` | `off` | Task signature verification policy: `off` (skip), `warn` (log missing/invalid, never reject), `require` (reject tasks without a valid signature). See `docs/security/task-signing.md`. |
| `HUGIN_SUBMITTER_KEYS` | — | Inline JSON keystore: `{"<keyId>": "<hex-secret>"}` (64-char hex preferred; base64 accepted). |
| `HUGIN_SUBMITTER_KEYS_FILE` | — | Path to a JSON keystore file. Takes precedence over `HUGIN_SUBMITTER_KEYS`. |
| `HUGIN_BROKER_HOST` | `127.0.0.1` | Bind address for the orchestrator-v1 broker (`/v1/delegate/*`). Set to the Tailscale interface IP in production. |
| `HUGIN_BROKER_PORT` | `3033` | Port for the broker endpoint. |
| `HUGIN_BROKER_KEYS` | — | Inline JSON keystore: `{"<principal>": "<token>"}`. Setting either this or `HUGIN_BROKER_KEYS_FILE` enables the broker. |
| `HUGIN_BROKER_KEYS_FILE` | — | Path to a JSON keystore file for the broker. Takes precedence over `HUGIN_BROKER_KEYS`. |
| `HUGIN_BROKER_RECONCILIATION_INTERVAL_MS` | `60000` | Interval between reconciliation sweeps (backfills journal events for orch-v1 tasks visible in Munin). |
