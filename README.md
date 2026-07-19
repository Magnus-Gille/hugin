# Hugin

Hugin is a self-hosted task dispatcher for the
[Grimnir](https://github.com/Magnus-Gille/grimnir) personal-AI ecosystem. It
turns durable tasks stored in
[Munin Memory](https://github.com/magnusgille/munin-memory) into bounded runs on
cloud or local agent runtimes, then stores human-readable and structured results
back in Munin.

This dispatcher is unrelated to the Hugin panorama-stitching project.

Hugin is infrastructure, not a chat application. A client or adapter submits a
task; Hugin owns claiming, policy checks, execution, cancellation, repository
isolation, optional artifact delivery, and result finalization.

## Architecture

```text
client / adapter
      │ memory_write(tasks/<id>/status)
      ▼
 Munin Memory  ◀──── lifecycle, results, receipts, context refs
      ▲
      │ poll + compare-and-swap claim
      ▼
    Hugin ── policy / sensitivity / provenance / egress checks
      │
      ├── Claude Agent SDK or Codex CLI
      ├── Ollama-compatible local models
      ├── OpenCode via an OpenAI-compatible local gateway
      ├── an explicit multi-model orchestrator
      └── declarative, human-gated pipelines
```

For `Context: repo:<name>`, Hugin operates inside `HUGIN_REPOS_ROOT`, which must
be an isolated collection of task workspaces rather than a production checkout.
It fetches the remote default branch and creates `hugin/<task-id>` before the
executor starts. If that isolation step fails, the task fails before model
execution. Successful changes can be committed, pushed, and proposed as a pull
request with content-blind repository evidence attached to the structured
result.

## What is in this repository

- `src/index.ts` — dispatcher lifecycle, policy gates, and HTTP health surface.
- `src/task-helpers.ts` — task parsing helpers and managed-repository workflow.
- `src/broker/` and `src/mcp/` — authenticated delegation Broker and MCP client.
- `src/orchestrator/` — optional multi-provider fan-out with verdict storage.
- `src/learning/` — evidence collection and experiment gates; it does not
  autonomously promote production routes.
- `docs/` — design, security contracts, evaluation notes, and operator guides.
- `systemd/` — example units which must be adapted to your service user and
  installation paths.

## Requirements

- Node.js 20 or newer (Node.js 22 is used for release verification).
- A reachable Munin Memory server and bearer token.
- At least one configured executor. Local-only deployments can omit cloud keys.
- Git and GitHub CLI only when managed-repository publication is enabled.

## Quick start

```bash
git clone https://github.com/Magnus-Gille/hugin.git
cd hugin
npm ci
cp .env.example .env
# Edit MUNIN_API_KEY and the executor settings you actually use.
npm run build
npm start
```

The default HTTP listener is `127.0.0.1:3032`. Check it with:

```bash
curl http://127.0.0.1:3032/health
```

Development mode uses `tsx`:

```bash
npm run dev
```

## Minimal configuration

`.env.example` contains safe, installation-neutral examples. The important
settings are:

| Variable | Purpose |
|---|---|
| `MUNIN_URL` | Munin Memory HTTP endpoint. |
| `MUNIN_API_KEY` | Munin bearer token; never commit a real value. |
| `HUGIN_REPOS_ROOT` | Isolated managed repositories used by `repo:<name>`. |
| `HUGIN_WORKSPACE` | Fallback working directory for non-repository tasks. |
| `HUGIN_ALLOWED_SUBMITTERS` | Claimed submitters accepted before signature checks. |
| `HUGIN_SIGNING_POLICY` | `off`, `warn`, or `require`; use `require` across trust boundaries. |
| `OLLAMA_PI_URL` | Optional local Ollama endpoint. |
| `HOMESERVER_GATEWAY_URL` | Optional operator-controlled OpenAI-compatible gateway root. |
| `HUGIN_DELIVERY_TARGETS` | Explicit JSON tuple allowlist for artifact delivery. No target is implied. |

The empty target list is intentionally fail-closed: ordinary tasks without an
artifact manifest still run, but a task that declares artifacts is rejected
before execution until at least one explicit target is configured. The
`require` default then makes any delivery failure terminal. A configured tuple
binds the SSH user, host, remote path prefix, and local staging prefix:

```dotenv
HUGIN_DELIVERY_TARGETS=[{"user":"hugin","host":"files.internal.example","remotePathPrefix":"/srv/mimir/inbox/","localStagingPrefix":"/var/lib/hugin/staging/"}]
```

## Submit and read a task

Using a Munin MCP client:

```text
memory_write(
  namespace: "tasks/example-task",
  key: "status",
  content: "## Task: Hello\n\n- **Runtime:** ollama\n- **Context:** scratch\n- **Timeout:** 60000\n- **Submitted by:** local-client\n\n### Prompt\nReturn the word hello.",
  tags: ["pending", "runtime:ollama"]
)
```

Read `tasks/example-task/result` for Markdown or
`tasks/example-task/result-structured` for the schema-validated JSON record.
The metadata field `Submitted by` is only a claim unless task signing verifies
it; see [task signing](docs/security/task-signing.md).

## Security model

Hugin executes models and tools, so treat it as privileged automation:

- bind HTTP and Broker surfaces to loopback unless you add authenticated,
  network-level access controls;
- use an isolated service account and isolated repository workspaces;
- require signed tasks when more than one trust domain can write to Munin;
- keep bearer tokens, signing keys, executor credentials, and delivery keys in
  environment or credential files outside Git;
- review egress and delivery allowlists before enabling mutation-capable tasks;
- treat repository instructions, context references, task text, and model output
  as untrusted input.

See [SECURITY.md](SECURITY.md), the
[prompt-injection scanner](docs/security/prompt-injection-scanner.md), and the
[exfiltration scanner](docs/security/exfiltration-scanner.md) for the current
controls and their limits.

## Ecosystem

Hugin can run independently with Munin Memory. In a larger Grimnir installation:

- **Munin Memory** is the durable task and memory store.
- **Mimir** is an authenticated file/archive service and optional delivery sink.
- **gille-inference** provides a local inference gateway and evaluation ledger.
- **Heimdall** observes health and task-state summaries.
- **Brokkr** documents the hardware, storage, backup, and OS substrate.
- **Ratatoskr** and **Skuld** are optional adapters/producers, not required to
  understand or run Hugin.

The Grimnir repository is the authority for the cross-project architecture and
component inventory. This repository is authoritative only for dispatch behavior.

## Current limitations

- Hugin is pre-1.0 and optimized for a small, trusted self-hosted installation.
- There is no bundled web UI, installer, or hosted control plane.
- The polling queue processes one outer task at a time; some runtimes fan out
  internally.
- `Submitted by` is not identity without signatures.
- Completion proves executor success, not semantic correctness or acceptance.
- Example systemd and deployment scripts are reference material and assume
  Linux; review paths, user IDs, network policy, and service ownership first.
- Sanitizing the current tree does not remove sensitive data from Git history or
  GitHub metadata. Audit both before making an existing repository public.

## Development

```bash
npm ci
npm run build
npm test
npm audit --omit=dev
```

Contributions are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md). Security
reports should follow [SECURITY.md](SECURITY.md), not a public issue.

## License

Hugin's own source code is available under [MIT](LICENSE). Dependencies retain
their own terms; in particular, the Claude executor uses Anthropic's separately
licensed Agent SDK. See [third-party notices](THIRD_PARTY_NOTICES.md).
