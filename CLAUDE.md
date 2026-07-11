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
   - `orchestrator`: Hugin's native fanout engine — planner decomposes into subtasks, workers fan out concurrently, optional verifier pass, synthesizer merges into the final answer. See **Orchestrator runtime** below.
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

- **Runtime:** claude | codex | ollama | opencode | pipeline | auto | orchestrator
- **Context:** repo:heimdall
- **Working dir:** /home/magnus/workspace
- **Timeout:** 300000
- **Submitted by:** Codex-desktop
- **Submitted at:** 2026-03-14T10:00:00Z
- **Reply-to:** telegram:12345678
- **Reply-format:** summary
- **Model:** qwen2.5:7b
- **Ollama-host:** pi | laptop | orin
- **Reasoning:** true | false
- **Fallback:** claude | none
- **Context-refs:** meta/conventions/status, projects/heimdall/status
- **Context-budget:** 8000
- **Sensitivity:** internal
- **Capabilities:** tools, code, structured-output
- **Permission profile:** read-only | trusted-code
- **Group:** batch-20260323
- **Sequence:** 1

### Prompt
<the actual prompt for the AI runtime>
```

**Context resolution:** `Context:` takes priority over `Working dir:` for determining the working directory. Supported aliases:
- `repo:<name>` → `<HUGIN_REPOS_ROOT>/<name>` (default `/home/magnus/repos/<name>`; see `HUGIN_REPOS_ROOT` in the env table — point it at an isolated tree to keep tasks off production checkouts, #139)
- `scratch` → `/home/magnus/scratch` (non-code tasks)
- `files` → `/home/magnus/mimir`
- Raw absolute paths under `/home/magnus/` are passed through; paths outside this prefix are rejected and fall back to the default workspace

**Reply routing:** `Reply-to:` and `Reply-format:` are forwarded in the result for downstream consumers (e.g., Ratatoskr).

**Task groups:** `Group:` and `Sequence:` enable multi-step task orchestration. Both are forwarded in results and heartbeats.

**Ollama-specific fields:**
- `Ollama-host:` — prefer a specific host (`pi` for local, `laptop` for remote via Tailscale, `orin` for the Jetson Orin Nano GPU cell via Tailscale). Default: auto-select.
- `Reasoning:` — `true` to force `think:true` via native `/api/chat`, `false` to force `think:false`. Omit to auto: reasoning-model families (qwen3/3.5, deepseek-r1, magistral) default to `think:false` via `/api/chat`; other models use the OpenAI-compatible endpoint unchanged. `gpt-oss` uses level-based reasoning (`low`/`medium`/`high`) and is not auto-routed — set `Reasoning:` explicitly only once Hugin supports levels.
- `Fallback:` — `claude` to fall back to Claude on infra failures (host unreachable, 5xx); `none` (default) to fail without fallback. Semantic failure (model responds but poorly) is never retried — that's experiment data.
- `Context-refs:` — comma-separated Munin references (`namespace/key`) to fetch and inject into the prompt. Hugin enforces Munin classification against the task/runtime trust boundary before injecting them.
- `Context-budget:` — max characters for injected context (default 8000). Truncated from end if exceeded.

**Type tags:** Tags matching `type:*` (e.g., `type:research`, `type:email`) are carried forward through the task lifecycle (pending → running → completed/failed).

**Sensitivity:** Optional `Sensitivity: public | internal | private` field. If omitted, Hugin infers sensitivity from the prompt (keyword detection), context path, and any context-refs. Cloud runtimes (claude, codex) are capped at `internal`; local runtimes (ollama) allow `private`. Tasks that exceed their runtime's sensitivity ceiling are rejected.

**Auto-routing:** Use `Runtime: auto` to let Hugin select the runtime. The router filters by trust tier (sensitivity ceiling), availability (ollama host probes), and capabilities, then ranks by cost (free > subscription), trust (trusted > semi-trusted), and model size. Optional `Capabilities: tools, code, structured-output` narrows candidates. Explicit runtimes remain the default — `auto` is opt-in. Routing decisions are logged and included in structured results.

**Claude SDK permission profiles:** `Runtime: claude` defaults to
`Permission profile: read-only`, which runs Claude Code in `dontAsk` mode with
only read-only local tools plus read-only Munin MCP tools pre-approved.
`Permission profile: trusted-code` takes effect only when the task also declares
`Capabilities: code`; use that pair only when the prompt/context is trusted
enough to allow filesystem edits, shell commands, and outbound tool use. It
preserves the historical full-bypass Claude Code lane for explicitly trusted
code tasks.

**OpenCode harness runtime:** `Runtime: opencode` is an explicit, M5-backed
coding harness lane. It writes a temporary OpenCode config pointing at the
OpenAI-compatible M5 gateway, runs `opencode run --format json`, captures
normalized tool/test/diff events, and removes the temp config directory after
the run. It is explicit-only (`opencode-m5`, not auto-routed) and capped at
`internal` sensitivity until the harness/audit path has production evidence.
`Permission profile: read-only` maps to the OpenCode `plan` agent with
`edit`/`bash` denied; `Capabilities: code` + `Permission profile: trusted-code`
maps to the `build` agent with `edit`/`bash` allowed.

**Pipeline tasks:** Use `Runtime: pipeline` with a `### Pipeline` section instead of `### Prompt`. Pipeline phases use runtime IDs (`claude-sdk`, `codex-spawn`, `ollama-pi`, `ollama-laptop`, `ollama-orin`, or `auto`) which differ from standalone runtime names. Per-phase `Capabilities:` is supported.

**Orchestrator runtime (`Runtime: orchestrator`):** Hugin's native, vendor-neutral fanout engine — its own ultracode/Workflow equivalent, with no Claude Code harness or vendor lock-in.

- **How it works:** A planner model decomposes the prompt into subtasks → workers fan out concurrently on cheap models → an optional verifier pass checks each worker output → a synthesizer merges survivors into the final answer. Each role is independently configurable.
- **Role bindings:** Every role (planner, worker, verifier, synthesizer) is a `provider|model` binding. Defaults: workers on DeepSeek Flash via OpenRouter; planner and synthesizer on a stronger model. Override any role via the `HUGIN_ORCH_*_MODEL` env vars below.
- **Resilience:** A planner-JSON parse failure falls back to single-worker mode. Individual worker failures do not sink the run — the synthesizer operates on surviving outputs.
- **Sensitivity guard (fail-closed):** A task with `Sensitivity: private` is **rejected before any model call** unless every role is bound to a sovereign/local provider (currently `berget` and `homeserver`). The dispatcher does not apply a fixed cloud ceiling to `orchestrator` — it treats the runtime as max-private and defers the decision to the role guard (`assertProvidersAllowSensitivity`, #111), which runs at the very start of execution before any model call. So an all-Berget (or all-homeserver) private task is admitted, while a default-OpenRouter private task is rejected fail-closed (zero model calls). Default OpenRouter workers cannot hold private data.
- **Homeserver provider:** `homeserver` is the M5 local-inference gateway (ADR-004) as an orchestrator provider — reached over the tailnet, bearer-auth, sovereign/local, and priced at explicit $0 in `model-pricing.ts`. Non-worker roles and direct executor calls use the raw OpenAI-compatible `/v1/chat/completions` surface; orchestrator **worker** leaves route through `/delegate` so M5 can ledger-gate the local model and record `taskType` + `delegatorModelId` for savings attribution. `HOMESERVER_GATEWAY_URL` holds the gateway ROOT (no `/v1`), `HOMESERVER_GATEWAY_API_KEY` the bearer token (same env vars as `homeserver-executor.ts`). The gateway host is automatically added to the egress allowlist. Bind workers via env (`HUGIN_ORCH_WORKER_MODEL=homeserver\|qwen3-30b-instruct`) or per task via `Model:`; set `HUGIN_ORCH_DELEGATOR_MODEL_ID` when the true upstream cloud conductor differs from Hugin's planner model.
- **Orin macro route (issue #160):** Hugin, not the gateway, explicitly selects `nodeId:"orin"` + `qwen2.5-coder:3b` for homeserver-backed `classify` and `extract` worker leaves at `public`/`internal` sensitivity. Private, broad, and unclassified leaves retain their configured route. The delegated path records node choice on the M5 ledger; a gateway `502`/`503`/`504` triggers one bounded re-route to the configured M5 worker model, surfaced in task logs and structured worker outcomes. Raw OpenAI chat also accepts the explicit `node:"orin"` pin for non-verified callers.
- **Task fields:** No additional task-level fields beyond the standard set. Use the `HUGIN_ORCH_*` env vars to tune role bindings and concurrency globally, or set `Model:` to select a non-default worker (the planner/synth retain their defaults). `Model:` accepts the same `provider|model` format as the env vars (e.g. `Model: homeserver|qwen3-30b-instruct`); a bare model string keeps the default worker provider.
- **Verdict layer (PR2, docs/orchestrator-verdict-layer.md):** the planner emits a per-subtask `taskType` (a 22-value taxonomy — the M5 gateway's `taxonomy.ts` is the source of truth, not the data-dependent `/ledger` report — shared verbatim, `other` fallback). Every worker/verifier outcome derives exactly one event — `pass`/`fail` ONLY for an actually-VERIFIED outcome, `error` for an infra failure, `unverified` for a successful-but-never-checked outcome (never recorded as a fake `pass` — that was the confidence-poisoning bug) — batched into ONE Munin read-modify-write per run (`tasks/_verdicts`/`report`, CAS, retry-once-then-drop) keyed by `modelId|taskType`, on a dedicated Munin client, and recorded truly fire-and-forget (never awaited — task completion cannot wait on it). Quality rate is `passes/(passes+fails)`, excluding infra errors; a row also tracks an `unverifiedPasses` streak, reset on any verified pass/fail, that feeds a re-probe: once it crosses `HUGIN_ORCH_REPROBE_UNVERIFIED`, an otherwise-trusted (`delegate-local`) row is verified once anyway so it can never become a permanently-unverified absorbing state. `HUGIN_ORCH_ADAPTIVE_VERIFY=on` makes verification selective: skip (trust) when the derived recommendation is `delegate-local`, verify otherwise — confidence comes from the verdict store for cloud providers and from the M5 `/ledger` for `homeserver`-bound workers, both time-bounded and fail-open to "verify" (never to "skip") on any missing dependency, timeout, or lookup failure. A subtask with an explicit failed verdict is excluded from synthesis (falls back to including everyone if that would exclude all survivors). Per-worker outcomes (`subtaskId`, `taskType`, `provider`, `model`, `ok`, `verdictOk`, `costUsd`, `latencyMs`, plus PR3's `inputTokens`/`outputTokens`) are additive/optional on `result-structured` as `orchestratorOutcomes`.
- **Savings tracker (PR3, docs/orchestrator-savings-tracker.md):** the engine records a per-call ledger (`ModelCallRecord`: role/provider/model/ok/tokens/cost/latency) for every planner/worker/verifier/synthesizer invocation. `computeSavings` (`src/orchestrator/savings.ts`, pure) prices each call with both token counts known against the `HUGIN_SAVINGS_BASELINE_MODEL` counterfactual (same token volume — a conservative, honest comparison) and sums `baseline − actual` only over those "covered" calls; a call missing tokens or a resolvable price is counted as "uncovered", never guessed, and savings are NEVER derived from `totalCostUsd` (which is all-or-nothing-null on any failed call). The per-task summary (`baselineModelId`, `coveredCalls`, `uncoveredCalls`, `actualCostUsd`, `baselineCostUsd`, `savedUsd`, plus #144's `qaBaselineCreditUsd`/`qualityAdjustedSavedUsd`/`byOutcome`) is additive/optional on `result-structured` as `savings` and appears as two human-readable lines in the summary (raw + quality-adjusted). Cross-task aggregate counters (totals + per-model and per-outcome buckets, no per-task rows) accumulate in the Munin doc `tasks/_savings`/`report` via `src/orchestrator/savings-store.ts`, mirroring the verdict store's CAS/retry-once-then-drop/fire-and-forget mechanics verbatim and sharing its dedicated background Munin client. **Quality-adjusted savings (issue #144, `src/orchestrator/README.md`):** worker/verifier `ModelCallRecord`s carry `subtaskId`; savings are computed post-run (verdicts final — single write-time join, no two-phase write) with each call joined to its subtask's verdict outcome (`pass`/`fail`/`unknown`/`error`/`escalated`, the verdict layer's `unverified` mapping to `unknown`). Credit rules: failed/errored/escalated subtasks earn ZERO baseline credit (their worker+verifier spend books as a loss), verifier calls NEVER earn credit (verification cost is attributed back to the local attempt that caused it, not booked as neutral frontier spend), planner/synth keep raw treatment, `unknown` keeps credit but is bucketed separately. Headline `qualityAdjustedSavedUsd = qaBaselineCreditUsd − actualCostUsd` (can be negative); lifetime equivalent derives at read time as `totals.qaBaselineCreditUsd − totals.actualCostUsd`. Any consumer using savings data for DECISIONS must read the quality-adjusted series, never raw `savedUsd`.

**Artefact delivery (`### Artifacts` manifest, issue #68):** A task may declare an `### Artifacts` section so that **Hugin (not the agent)** owns and verifies delivery of the deliverables. The agent only writes content to the declared local staging paths and must make no delivery claims.

- **Grammar (load-bearing):** `### Artifacts` MUST appear *before* `### Prompt`. Prompt extraction reads from `### Prompt` to EOF, so a manifest placed after it would leak into the agent prompt — Hugin rejects that ordering at submit time.
- **Shape:** a single fenced ```json array; each entry `{ "id", "local", "remote": "user@host:/abs/path", "required": true|false }`. `local` must be an absolute path under an allowed staging prefix; `remote` must match an allowed target tuple. Un-substituted `<placeholder>`s, `..`, NUL, newlines, shell metacharacters, and disallowed targets are rejected **before** the (paid) run — no spend on a malformed manifest.
- **Lifecycle:** after the agent finishes, Hugin writes a durable nonterminal `running + delivery:pending` checkpoint (agent content preserved in `result`), then `statSync` → `rsync` to `<remote>.partial` → remote `sha256sum` match → atomic `ssh mv`. The final `result` is written before the terminal status flip. A terminal delivery failure renders **`- **Exit code:** 2`** + `- **Failure kind:** DELIVERY_FAILED` (positive integer — Ratatoskr treats a non-numeric/negative code as success). Status carries `delivery:verified` / `delivery:failed`; the structured result carries an optional `artifactDelivery` object. A crash mid-delivery is reconciled on restart without a paid rerun.

**Results:** Written to the same namespace under two keys:
- `result` — human-readable markdown with exit code, timestamps, duration, and response body
- `result-structured` — machine-readable JSON (Zod-validated) with schema version, lifecycle metadata, runtime metadata (requested vs effective model/host), sensitivity audit, honest submission provenance (`claimedSubmitter`, nullable `verifiedSubmitter`, signing policy/status/keyId), and structured body. Prefer this for programmatic consumption.

## Project structure

```
hugin/
├── package.json
├── tsconfig.json
├── CLAUDE.md
├── hugin.service
├── src/
│   ├── index.ts                  # Dispatcher: poll loop, task execution, health endpoint
│   ├── heimdall-descriptor.ts    # GET /heimdall.json self-describe descriptor. Hugin OWNS its Heimdall page content: Tier-1 services' panels come from this descriptor only (Heimdall's known-panels fallback is not consulted), so the Tasks/Task-history panels MUST stay declared here (#116/#135)
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
│   ├── artifact-delivery.ts      # Runtime-owned artefact delivery (#68): manifest parse/validate, target allowlist, rsync→sha256→mv deliver+verify
│   ├── model-pricing.ts          # Vendor-neutral $/M-token table for cost-aware routing and result metadata
│   ├── orchestrator/             # Native fanout engine (Runtime: orchestrator)
│   │   ├── engine.ts             # Top-level fanout loop: plan → fan-out workers → optional verify → synthesize
│   │   ├── model-invoker.ts      # Role→provider+model dispatch; wraps OpenRouter/Berget/etc. behind a single interface
│   │   ├── worker-executor.ts    # Per-subtask worker: pi-harness + direct-model paths
│   │   ├── plan.ts               # Plan IR + planner-output parsing (JSON → subtask list, fallback to single-worker)
│   │   ├── prompts.ts            # Role prompt templates (planner, worker, verifier, synthesizer)
│   │   ├── config.ts             # DEFAULT_ORCHESTRATOR_CONFIG + env-var overrides for all roles
│   │   ├── sensitivity-guard.ts  # Pre-flight: reject private tasks unless all roles are sovereign providers
│   │   ├── provider-config.ts    # Provider registry (openrouter, berget, …) with base URLs and sovereignty flags
│   │   ├── verdict-store.ts      # Verdict layer (V4): Munin-backed CAS store (tasks/_verdicts/report) + deriveVerdict/deriveRecommendation
│   │   ├── ledger-client.ts      # Verdict layer (V7): cached, fail-open client for the M5 gateway's GET /ledger
│   │   ├── savings.ts            # Savings tracker (PR3, S2): pure computeSavings — per-call covered/uncovered classification vs a baseline model
│   │   ├── savings-store.ts      # Savings tracker (PR3, S3): Munin-backed CAS store (tasks/_savings/report), mirrors verdict-store.ts mechanics
│   │   └── orchestrator-executor.ts # Dispatcher adapter: TaskContent → engine → structured result; verdict + savings recording, adaptive-confidence wiring
│   ├── mcp-server.ts             # hugin-mcp stdio entrypoint (orchestrator-side, on the laptop)
│   ├── friction-mcp.ts           # friction-mcp stdio entrypoint (report_friction tool for AI self-reporting)
│   ├── friction/                 # friction-mcp internals
│   │   ├── schema.ts             # Zod taxonomy: 11 friction types, severity, resource_assessment
│   │   ├── munin-key.ts          # Pure builders: namespace/key/tags/content for signals/friction
│   │   └── tool.ts               # buildFrictionTool — 2s hard timeout, lossy fire-and-forget write
│   ├── mcp/                      # hugin-mcp internals (broker client + tool definitions)
│   │   ├── broker-client.ts      # HTTP client for /v1/delegate/* (bearer auth, AbortController timeout)
│   │   └── tools.ts              # 5 MCP tools (hugin_submit/await/rate/list/models) with envelope autofill
│   └── broker/                   # Orchestrator-v1 broker (Tailscale-only HTTP, /v1/delegate/*)
│       ├── server.ts             # Express app + opt-in startup (HUGIN_BROKER_KEYS)
│       ├── executor-capabilities.ts # Live executor truth shared by submit/models/worker
│       ├── handlers.ts           # submit/await/rate/list/models endpoint handlers
│       ├── auth.ts               # Bearer-token middleware, constant-time compare
│       ├── idempotency.ts        # In-memory idempotency-key dedupe (§3.1)
│       ├── journal.ts            # Append-only delegation-events.jsonl + projection
│       ├── task-store.ts         # Munin operations: submit / read / two-phase complete
│       ├── alias-resolution.ts   # Alias → AliasResolved annotation + policy_version
│       ├── reconciliation.ts     # Periodic sweep: backfill journal events for orch-v1 tasks
│       ├── orch-worker.ts        # Poll loop: claims orch-v1 pending tasks → OpenRouter executor → two-phase complete
│       └── types.ts              # Zod schemas for the wire contract
├── tests/                        # 19 test files mirroring src/
├── docs/                         # Engineering plans, evaluations, security docs
│   └── security/                 # Threat models and security assessments
└── scripts/
    ├── deploy-pi.sh
    ├── enable-broker.sh          # One-shot: generate broker token on Pi, write to .env, restart, register hugin-mcp locally
    ├── submit-daily-analysis.sh  # Submit daily journal analysis as ollama task
    ├── submit-stale-status-review.sh
    ├── submit-dep-bumps.sh       # Autonomous dep-bump tasks from security-scan results (#26)
    ├── sync-claude-config.sh     # DEPRECATED — config now lives in the claude-config repo (bootstrap.sh)
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

For substantive code changes, default to red/green TDD: write the failing test first, confirm it fails, then implement until it passes. Skip for refactors with no behavior change, config tweaks, and trivial fixes.

## How to run locally

```bash
MUNIN_API_KEY=<key> MUNIN_URL=http://localhost:3030 npm run dev
```

## Deployment

```bash
./scripts/deploy-pi.sh [hostname]
```

Default host: `huginmunin.local` (or Tailscale IP `100.97.117.37` if mDNS unavailable).

The Pi needs a `.env` file at `/home/magnus/repos/hugin/.env`:
```
MUNIN_API_KEY=<same key Munin uses>
```

## Security docs

Security assessments, threat models, and audit reports live in `docs/security/`. These are committed to the repo (private, so acceptable) to keep them version-controlled alongside the code they assess.

**Convention:**
- Filename: `<topic>.md` (e.g., `lethal-trifecta-assessment.md`)
- Open findings should be filed as GitHub Issues, not left as prose in the doc
- Hugin tasks that produce security reports should commit and push them, not leave them as untracked files

## hugin-mcp (laptop side)

`hugin-mcp` is a stdio MCP server that exposes the Pi-side broker's `/v1/delegate/*` endpoints to a local Claude Code or Claude Desktop session. It runs on the *orchestrator* laptop, not on the Pi.

```
Claude Code  ⟷  hugin-mcp (stdio)  ⟶  HTTP /v1/delegate/* (Tailscale)  ⟶  Pi broker
```

**Tools exposed:**
- `hugin_submit` — submit a delegation task; its alias enum is built from the live Broker discovery result and is disabled when discovery finds no enabled executor
- `hugin_await` — read current task state
- `hugin_rate` — append a rating event for a completed task
- `hugin_list` — list recent delegated tasks
- `hugin_models` — read only aliases with enabled executors and their backing runtime rows

The MCP layer fills in protocol envelope fields (`envelope_version`, `alias_map_version`, `idempotency_key`, `orchestrator_session_id`, `orchestrator_submitter`) so callers only think about the task itself.

The four v1 aliases remain the historical wire catalogue. They are not all
live routes: as of 2026-07-11 only `large-reasoning` has a Broker executor, and
only when the Pi has `OPENROUTER_API_KEY`. Never infer executability from the
compiled alias map; `/v1/delegate/models` is authoritative. The Broker rejects
an unavailable alias before idempotency reservation or durable writes.

**Required env (orchestrator side):**
- `HUGIN_BROKER_URL` — e.g. `http://huginmunin.<tailnet>.ts.net:3033`
- `HUGIN_BROKER_TOKEN` — bearer token registered in the Pi's `HUGIN_BROKER_KEYS`

**Optional env:**
- `HUGIN_MCP_SUBMITTER` — `orchestrator_submitter` principal (default: `claude-code`)
- `HUGIN_MCP_REQUEST_TIMEOUT_MS` — per-request HTTP timeout (default: `60000`)

**Wire it into Claude Code:**
```bash
npm run build  # produces dist/mcp-server.js
claude mcp add-json hugin '{"command":"node","args":["/Users/magnus/repos/hugin/dist/mcp-server.js"],"env":{"HUGIN_BROKER_URL":"http://huginmunin:3033","HUGIN_BROKER_TOKEN":"..."}}' -s user
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
| `HUGIN_REPOS_ROOT` | `/home/magnus/repos` | Root under which `repo:<name>` context aliases resolve and task branches are cut (issue #139). Point it at an isolated tree (e.g. `/home/magnus/hugin-workspace`) that is disjoint from the production deploy checkouts under `/home/magnus/repos`, so a hugin task can never re-point a production checkout onto its task branch (grimnir#44 / grimnir#33). Only directories under this root are treated as managed/branchable by `checkoutTaskBranch` (the working dir is canonicalized first, so `..` traversal cannot string-match its way onto a checkout outside the root); the traversal guard on `repo:` aliases is relative to it. Default preserves the historical hardcoded behavior. Trailing slashes are normalized. |
| `HUGIN_MAX_OUTPUT_CHARS` | `50000` | Max output chars to capture |
| `HUGIN_ALLOWED_SUBMITTERS` | `Codex,Codex-desktop,ratatoskr,Codex-web,Codex-mobile,claude-code,claude-desktop,claude-web,claude-mobile,hugin` | Comma-separated list of allowed `Submitted by:` values. Includes both current Codex-facing names and legacy `claude-*` names during the transition. Set to `*` to allow all. |
| `OLLAMA_PI_URL` | `http://127.0.0.1:11434` | Ollama endpoint on Pi (local) |
| `OLLAMA_LAPTOP_URL` | — | Ollama endpoint on laptop (via Tailscale, empty = disabled) |
| `OLLAMA_ORIN_URL` | — | Ollama endpoint on Jetson Orin Nano GPU cell (via Tailscale IP 100.127.176.78, empty = disabled) |
| `OLLAMA_DEFAULT_MODEL` | `qwen2.5:3b` | Default model for ollama tasks without explicit Model field |
| `HUGIN_ALLOWED_EGRESS_HOSTS` | — | Comma-separated extra hosts to allow for outbound fetch (added to built-in allowlist) |
| `HUGIN_INJECTION_POLICY` | `warn` | Prompt-injection policy for context-refs: `off` (no scan), `warn` (prepend warning banner), `block` (quarantine high-severity refs, task continues), `fail` (reject task). See `docs/security/prompt-injection-scanner.md`. |
| `HUGIN_EXFIL_POLICY` | `warn` | Exfiltration scanner policy for task results: `off` (no scan), `warn` (log + append security-scan section), `flag` (warn + tag result `security:exfil-suspected`), `redact` (flag + replace matches with `[redacted: <pattern>]`). See `docs/security/exfiltration-scanner.md`. |
| `HUGIN_EXTERNAL_POLICY` | `warn` | Provenance policy for externally sourced context-refs (entries tagged `source:external` or in the `signals/` namespace): `allow` (inject with banner only), `warn` (banner + log, default), `block` (quarantine external refs, task continues), `fail` (reject task). See `docs/security/provenance-enforcement.md`. |
| `HUGIN_SIGNING_POLICY` | `off` | Task signature verification policy: `off` (do not verify; record explicitly `unverified`), `warn` (log missing/invalid, never reject), `require` (reject tasks without a valid signature). See `docs/security/task-signing.md`. |
| `HUGIN_SIGNING_MAX_AGE_S` | `900` | Maximum accepted age of an otherwise-valid signature. `0` disables the age window; future timestamps still use the verifier's bounded skew tolerance when the window is enabled. |
| `HUGIN_SUBMITTER_KEYS` | — | Inline JSON keystore: `{"<keyId>": "<hex-secret>"}` (64-char hex preferred; base64 accepted). |
| `HUGIN_SUBMITTER_KEYS_FILE` | — | Path to a JSON keystore file. Takes precedence over `HUGIN_SUBMITTER_KEYS`. |
| `HUGIN_BROKER_HOST` | `127.0.0.1` | Bind address for the orchestrator-v1 broker (`/v1/delegate/*`). Set to the Tailscale interface IP in production. |
| `HUGIN_BROKER_PORT` | `3033` | Port for the broker endpoint. |
| `HUGIN_BROKER_KEYS` | — | Inline JSON keystore: `{"<principal>": "<token>"}`. Setting either this or `HUGIN_BROKER_KEYS_FILE` enables the broker. |
| `HUGIN_BROKER_KEYS_FILE` | — | Path to a JSON keystore file for the broker. Takes precedence over `HUGIN_BROKER_KEYS`. |
| `HUGIN_BROKER_RECONCILIATION_INTERVAL_MS` | `60000` | Interval between reconciliation sweeps (backfills journal events for orch-v1 tasks visible in Munin). |
| `OPENROUTER_API_KEY` | — | Enables the orch-v1 OpenRouter worker. With it, `large-reasoning` is advertised as executable; without it the Broker advertises no executable aliases and rejects submissions before durable state is created. |
| `OPENROUTER_REFERER` | `https://hugin.local` | `HTTP-Referer` header value sent to OpenRouter (used for ranking/attribution). |
| `OPENROUTER_APP_TITLE` | `hugin-orch-v1` | `X-Title` header value sent to OpenRouter. |
| `HUGIN_FRICTION_INJECTION` | `off` | Set to `on` to inject `friction-mcp` into Claude SDK tasks. Each task gets `report_friction` available as an MCP tool. Default off — opt-in until signal quality is established. |
| `HUGIN_FRICTION_TASK_ID` | — | Auto-tag friction events with the current task ID (injected by sdk-executor). |
| `HUGIN_FRICTION_MODEL_ID` | `unknown` | Model identifier for friction tags (injected by sdk-executor). |
| `HUGIN_FRICTION_WRITE_TIMEOUT_MS` | `2000` | Munin write timeout for friction-mcp. Lossy by design — keep short. |
| `HUGIN_ARXIV_MCP` | `off` | Set to `on` to inject `arxiv-mcp-server` into Claude SDK tasks via `uvx`. Provides `mcp__arxiv__search_papers`, `read_paper`, `download_paper`, etc. Requires `uvx` (astral.sh/uv) on PATH. Useful for research spikes involving academic papers. |
| `HUGIN_UVX_PATH` | `uvx` | Full path to the `uvx` binary when it is not on the default PATH (e.g. `/home/magnus/.local/bin/uvx`). |
| `HUGIN_DELIVERY_POLICY` | `require` | Runtime-owned artefact delivery (issue #68): `off` (ignore `### Artifacts` manifests — rollback / old-skill compat), `warn` (validate + report diagnostics, never fail a content-success task), `require` (missing local content or an unrecoverable delivery failure → terminal `failed`, content preserved in the checkpoint so re-submission is free), `defer` (issue #72: an **infra** delivery failure — NAS unreachable, rsync/verify timeout — leaves the task `running + delivery:pending` and a periodic retry reaper re-attempts under a budget; `missing-local`/`unsafe-local` are still always terminal). |
| `HUGIN_DELIVERY_TARGETS` | (single NAS) | JSON array of allowed delivery target tuples `[{ "user", "host", "remotePathPrefix", "localStagingPrefix" }]`. Separate from the fetch egress allowlist. A manifest `remote`/`local` must match a tuple (user + host + remote-prefix; local under the staging prefix) or the task is rejected at submit time. |
| `HUGIN_DELIVERY_RETRY_MAX_ATTEMPTS` | `10` | Deferred-delivery (`defer`) retry budget: max delivery attempts before terminalizing `failed` + `Exit code: 2`. |
| `HUGIN_DELIVERY_RETRY_MAX_AGE_MS` | `86400000` (24h) | Deferred-delivery retry budget: max age from the first attempt before terminalizing. Whichever of attempts/age trips first wins, so a permanently-unreachable NAS still reaches a terminal state. |
| `HUGIN_DELIVERY_RETRY_INTERVAL_MS` | `300000` (5min) | Cadence of the deferred-delivery retry reaper (separate timer, armed only under `defer`). |
| `HUGIN_SKILL_LANE` | `off` | Local-skill lane master switch (issues #79–#84). `on` enables the fail-closed local-skill route pre-step (`src/skill/skill-lane.ts`: classify → retrieve → select an `active` RouteBinding), wired into the dispatcher via `src/skill/skill-lane-dispatch.ts#consultSkillLane`. Slice-one artifacts are now authored (`skills/markdown-frontmatter-normalization/`, `src/skill/slice-one/`) but the committed RouteBinding is `draft`, the cell manifest is a placeholder, and no local executor is wired — so the lane still fails closed to the cloud auto-router even when `on`. Driving the binding to `active` against a real local cell is a deliberate human go-live step (see `skills/README.md`). |
| `HUGIN_CLAUDE_AUTH_PREFLIGHT` | `on` | Pre-flight Claude auth check (issue #129). `on` probes the Pi's Claude credential against the OAuth usage endpoint *before* a `claude`-runtime SDK run (and before an ollama→claude fallback), and short-circuits to a distinctly-classified `AUTH_FAILED` failure if the credential is definitively invalid (HTTP 401) — instead of a silent ~9s paid burn that reads as a generic `failed`. Fail-open: any non-401 probe outcome (network error, missing creds, endpoint down) runs the task normally. Set to `off` to disable. Independently, an *actual* runtime 401 is always classified: a Claude task that fails to authenticate is tagged `failure:auth`, renders `- **Failure kind:** AUTH_FAILED` in its result, and carries the reason in the structured result — regardless of this flag. |
| `HUGIN_AUTH_ALARM` | `on` | Pi Claude credential alarm (issue #131). `on` pushes an **edge-triggered** alert to the user via Ratatoskr's Alert Bus (`POST /api/send` → Telegram + Heimdall echo) when the Claude credential goes bad — fires once on `→unauthorized`, once on recovery, never every tick. Two feeds drive one shared, deduped edge state: (1) **reactive** — a real runtime `AUTH_FAILED` task outcome (#130), the *reliable* dead-credential signal, since a normal OAuth credential auto-refreshes and a probe against its stale access token can't judge it; (2) **proactive probe** — the periodic OAuth-usage check, which fires `unauthorized` only for a credential with no `refreshToken` (else fail-open `unknown`) and warns on impending hard expiry (also refresh-token-gated — see below). State persists to Munin (`tasks/_auth_alarm`) so a restart doesn't re-fire. Inert (logs, no push) unless the Ratatoskr send target below is configured. `off` disables. See `src/auth-alarm.ts`. |
| `HUGIN_AUTH_ALARM_INTERVAL_MS` | `3600000` (1h) | Cadence of the auth-alarm probe. |
| `HUGIN_AUTH_ALARM_EXPIRY_WARN_MS` | `43200000` (12h) | Warn this far ahead of the credential's hard expiry. **Only applies to credentials with no `refreshToken`** — a normal Claude Code OAuth credential auto-refreshes its short-lived (~8h) access token, so its `expiresAt` is not when tasks break (that surfaces as an `unauthorized` transition instead). This warning therefore stays silent for the usual OAuth credential and never fires an ~8h false-alarm loop. |
| `HUGIN_RATATOSKR_SEND_URL` | — | Ratatoskr Alert Bus endpoint (e.g. `http://huginmunin:3034/api/send` or the Pi Tailscale IP). Empty = alarm logs but does not push Telegram. |
| `HUGIN_RATATOSKR_SEND_API_KEY` | — | Bearer token for Ratatoskr `POST /api/send` (matches Ratatoskr's `RATATOSKR_SEND_API_KEY`). |
| `HUGIN_AUTH_ALARM_CHAT_ID` | — | Telegram chat id (integer) the auth alarm is delivered to. Must be in Ratatoskr's allowed-users list. |
| `ARXIV_STORAGE_PATH` | — | Directory where arxiv-mcp-server caches downloaded papers. Forwarded into the arxiv MCP subprocess environment. |
| `HUGIN_ACTIVE_SUBSCRIPTIONS` | (all active) | Comma-separated runtime IDs of subscriptions you actually pay for (e.g. `claude-sdk`). Subscription-cost runtimes are auto-eligible only if listed here; unset = all active subscription runtimes are eligible. Vendor-neutral — Claude today, Berget Code / ChatGPT later. |
| `BERGET_API_KEY` | — | API key for the Berget.ai EU-sovereign provider (OpenAI-compatible, base URL `https://api.berget.ai/v1`). Required for any orchestrator role bound to the `berget` provider. One of the two recognized sovereign providers for `Sensitivity: private` orchestrator tasks (the other is `homeserver`). |
| `HOMESERVER_GATEWAY_URL` | — | Root URL of the M5 local-inference gateway (e.g. `http://100.76.72.59:8080`, no `/v1` — no path/credentials/query at all). Enables the orchestrator's `homeserver` provider, the standalone `homeserver-executor.ts`, and the default `Runtime: opencode` M5 provider config. Non-worker homeserver calls append/use `/v1`; orchestrator worker leaves post to `/delegate` for ledger-gated routing and savings attribution. The host MUST be loopback/private-LAN/tailnet (`100.64/10`, `.ts.net`, `.local`, single-label); a public host is rejected before any model call and is never egress-allowlisted — sovereignty must not hinge on a typo'd env var. A sovereign host is auto-added to the egress allowlist. |
| `HOMESERVER_GATEWAY_API_KEY` | — | Bearer token for the M5 gateway. Required for any orchestrator role bound to `homeserver` (the orchestrator path has no keyless-loopback carve-out — over the tailnet a key is always required). |
| `HOMESERVER_BUSY_MAX_RETRIES` | `6` | Busy-backpressure retries (issue #157) for orchestrator worker `/delegate` calls: a `503 server_busy` / `429` from the M5 gateway is a queue signal, not a failure — the worker waits (honoring `Retry-After`; exponential backoff otherwise, each wait capped at 30s) and retries up to this many times. `0` disables retrying (the busy answer becomes terminal immediately). |
| `HOMESERVER_BUSY_RETRY_BUDGET_MS` | `240000` | Total wall-clock cap for one worker's busy waiting + retrying. When the next wait would exceed the remaining budget, the worker gives up with the exact gateway reason (e.g. `HTTP 503 server_busy retryAfterS=5`) instead of sleeping pointlessly. The task-level AbortSignal still cancels a queued worker at any moment. |
| `HOMESERVER_BUSY_RETRY_BASE_DELAY_MS` | `1000` | Base delay for the exponential backoff (`base × 2^attempt`) used when the gateway sends no `Retry-After` header. |
| `HUGIN_OPENCODE_BASE_URL` | `HOMESERVER_GATEWAY_URL` | Optional override for the OpenCode runtime's OpenAI-compatible base URL. May be a gateway root URL or `/v1`; Hugin normalizes it to `/v1` and rejects public hosts or extra paths. A keyless non-loopback URL is refused. |
| `HUGIN_OPENCODE_API_KEY` | `HOMESERVER_GATEWAY_API_KEY` | Optional override for the OpenCode runtime provider API key. Passed to the child process as `HUGIN_OPENCODE_PROVIDER_API_KEY`; never written into the temp config. |
| `HUGIN_OPENCODE_PROVIDER` | `m5` | Provider id written into the temp OpenCode config and used in `--model <provider>/<model>`. |
| `HUGIN_OPENCODE_MODEL` | `qwen3-coder-next-80b` | Default model for `Runtime: opencode` tasks without a `Model:` field. |
| `HUGIN_OPENCODE_CMD` | `opencode` | OpenCode executable path. Override on the Pi if the binary is not on the service PATH. |
| `HUGIN_ORCH_PLANNER_MODEL` | (see `DEFAULT_ORCHESTRATOR_CONFIG`) | Override the planner role model. Format: `provider\|model` (e.g. `openrouter\|anthropic/claude-3.5-sonnet`). Omit the `provider\|` prefix to keep the role's default provider. |
| `HUGIN_ORCH_WORKER_MODEL` | (see `DEFAULT_ORCHESTRATOR_CONFIG`) | Override the worker role model. Default: DeepSeek Flash via OpenRouter. |
| `HUGIN_ORCH_VERIFIER_MODEL` | (see `DEFAULT_ORCHESTRATOR_CONFIG`) | Override the verifier role model. Verifier pass only runs when `HUGIN_ORCH_VERIFY=on`. |
| `HUGIN_ORCH_SYNTH_MODEL` | (see `DEFAULT_ORCHESTRATOR_CONFIG`) | Override the synthesizer role model. |
| `HUGIN_ORCH_MAX_CONCURRENCY` | `4` | Max concurrent worker fan-out in the orchestrator engine. |
| `HUGIN_ORCH_HOMESERVER_MAX_CONCURRENCY` | `2` | Fan-out cap for `homeserver`-bound workers (issue #157), applied as `min(maxConcurrency, homeserverMaxConcurrency)`. The M5 gateway has ONE serial GPU and 503s concurrent `/delegate` calls beyond the admitted ones — workers beyond this cap queue in Hugin instead of slamming the gateway. Set to `1` for fully serial local fan-out. |
| `HUGIN_ORCH_VERIFY` | `off` | Set to `on` or `true` to run a verifier pass on each successful worker output before synthesis. |
| `HUGIN_ORCH_PER_CALL_TIMEOUT_MS` | `120000` | Per-model-call timeout (ms) inside the orchestrator engine, applied to planner, each worker, each verifier, and the synthesizer. |
| `HUGIN_ORCH_MAX_SUBTASKS` | `12` | Cap on the number of subtasks the planner may produce. Plans exceeding this are truncated before fan-out. |
| `HUGIN_ORCH_MAX_TOKENS` | `4096` | Default completion-token cap (`max_tokens`) sent on every orchestrator model call (planner/worker/verifier/synth). Raise it when workers or the synthesizer produce long output that would otherwise be silently truncated. A per-role `RoleBinding.maxTokens` overrides this for that role. When a response hits the cap (`finish_reason=length`), the result is flagged and a `### Warnings` entry + log line surface the truncation instead of reporting clean success. |
| `HUGIN_ORCH_DELEGATOR_MODEL_ID` | planner role model | Cloud/conductor model id forwarded on homeserver worker `/delegate` calls as `delegatorModelId`, letting the M5 ledger/dashboard attribute actual savings to the responsible smart model. Use this when Hugin is itself being driven by Codex/Claude or another outer conductor whose model differs from the orchestrator planner. Compatibility alias: `HUGIN_ORCH_DELEGATOR_MODEL`. |
| `HUGIN_ORCH_ADAPTIVE_VERIFY` | `off` | Verdict layer (docs/orchestrator-verdict-layer.md V5): selective verification driven by confidence. `on` skips (trusts) the verifier for a subtask when the derived recommendation for its (worker model × task-type) is `delegate-local`; anything else (`escalate-frontier`, `explore`, or no signal) still verifies. `HUGIN_ORCH_VERIFY=on` always wins (verify everything) regardless of this flag. |
| `HUGIN_ORCH_VERDICT_STORE` | `on` | Verdict layer master switch (V4): record per-worker pass/fail/error events to the Munin doc `tasks/_verdicts`/`report` (CAS read-modify-write) and make that store (or, for `homeserver`-bound workers, the M5 `/ledger`) available as the confidence source for `HUGIN_ORCH_ADAPTIVE_VERIFY`. `off` disables both recording and confidence lookups — the engine falls back to its unchanged default. |
| `HUGIN_ORCH_LEDGER_TTL_MS` | `600000` (10min) | Verdict layer (V7): in-process cache TTL for the M5 gateway `/ledger` read, consulted as the adaptive-verify confidence source for `homeserver`-bound workers. Any ledger failure (bad gateway URL, missing key, network error, non-2xx, bad shape) fails open to "no signal" (still verifies); non-2xx/network failures are additionally negative-cached for 60s so a down gateway doesn't add a request-timeout stall to every task. |
| `HUGIN_ORCH_REPROBE_UNVERIFIED` | `10` | Verdict layer re-probe gate (V5/V1): once a (worker model × task-type) row's streak of consecutive VERIFIED-never-checked successes (`unverifiedPasses`) reaches this count, `HUGIN_ORCH_ADAPTIVE_VERIFY` forces one more verify even though the row's recommendation is `delegate-local` — otherwise a trusted row could never generate the verified pass/fail that refreshes its own confidence. Only applies to Hugin's own verdict store (non-`homeserver` workers); the M5 `/ledger` has no `unverifiedPasses` concept. |
| `HUGIN_ORCH_SAVINGS` | `on` | Savings tracker master switch (PR3, docs/orchestrator-savings-tracker.md S5): record per-run savings to the Munin doc `tasks/_savings`/`report` and surface the per-task `savings` field + human-readable summary line. `off` disables both — no reads/writes, no result field. |
| `HUGIN_SAVINGS_BASELINE_MODEL` | `CLAUDE_BASELINE_MODEL_ID` (`claude-sonnet-4-6`) | Counterfactual model id the savings tracker prices each covered call against. Must exist in `MODEL_PRICING` (`src/model-pricing.ts`) — an unpriced override disables savings for the run (logged once), never guesses. |
