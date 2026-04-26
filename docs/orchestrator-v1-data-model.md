# Orchestrator v1 — Delegation Data Model

**Status:** Draft contract spec, pending Magnus sign-off
**Date:** 2026-04-25 (updated 2026-04-26 — Option B locked in: `pi` harness on Pi enters v1)
**Scope:** v1 = one-shot inference **and** `pi` harness on Pi. Other harnesses (`aider`, `opencode`, `claude-code`) remain deferred.
**Purpose:** Lock the contracts that every other implementation step builds against. If this is right, broker/executor/MCP/skill are reversible. If this is wrong, everything downstream gets re-cut.

---

## 1. Scope

**Decision (2026-04-26):** Option B from §11 selected. `pi` harness on Pi enters v1, calling cloud models via OpenRouter. Driven by parallel-session eval data (5/6 strict, 6/6 lenient on the aider task set; see §11.1).

What v1 delegates:

**One-shot path** (single prompt → text output):
- Summarize this transcript
- Extract these fields as JSON
- Classify these items
- Draft this paragraph
- Rewrite this sentence
- Reason about this question

**Harness path** (prompt + working tree → diff):
- Refactor this file/symbol across the repo
- Add a small feature with edits to N files
- Apply a mechanical rename
- Anything pi can do in headless one-shot mode (`pi -p ... --no-session`)

What v1 does **not** cover:
- Other harnesses (`aider`, `opencode`, `claude-code` on Pi) — deferred to v1.5
- Multi-turn harness conversations — pi runs `--no-session` only
- Working trees on the laptop — v1 working trees live on the Pi (git worktrees against `origin/<branch>` HEAD at submission time)
- Auto-commit/push of harness output — Pi never pushes; diff is returned to Claude for review and laptop-side application

---

## 2. Aliases (v1 active set)

Aliases split into two families: one-shot aliases (`tiny`, `medium`, `large-reasoning`) and harness aliases (`pi-large-coder`).

| Alias | Family | Harness | Backing model | Host | Runtime | Notes |
|---|---|---|---|---|---|---|
| `tiny` | one-shot | — | `qwen2.5:3b` | Pi (huginmunin.local) | ollama | Only viable Pi model per ollama-performance-spike |
| `medium` | one-shot | — | `qwen3:14b` | MBA via Tailscale | ollama | Validated in aider eval. **Registry currently defaults laptop to `qwen3.5:35b-a3b`, which the eval found unreliable — registry default needs follow-up fix; alias pins to working model.** |
| `large-reasoning` | one-shot | — | `gpt-oss-120b` @ reasoning level `medium` | OpenRouter | openrouter | Studio proxy. Reasoning level pinned for v1; level routing deferred. |
| `pi-large-coder` | harness | `pi` | `qwen/qwen3-coder-next` | Pi (harness) → OpenRouter (model) | pi-harness | Validated 2026-04-26: 5/6 strict, 6/6 lenient on aider eval. Headless one-shot via `pi -p ... --no-session`. Pi reads files via tool calls; output is a unified diff. |

Alias governance rules:
- Manual promotion only. No silent retargeting.
- Each alias change bumps `alias_map_version` (monotonic integer).
- Journal records `alias_requested` AND `model_effective` per delegation.
- For harness aliases, journal also records `harness_version` (the `pi` CLI version at execution time).
- Cross-version corpus comparisons require explicit segmentation by `alias_map_version` and (for harness rows) `harness_version`.

**Out of v1, by name:**
- `medium-coder` (pi × MBA × ollama): pi's OpenAI-compatible adapter cannot disable thinking on `qwen3:14b`, making local pi+ollama unusable in eval. Revisit when pi adds native `/api/chat` or thinking-control support.
- `pi-tiny` (pi on Pi against local `qwen2.5:3b`): no eval signal yet; almost certainly under-powered for code edits.

Alias governance rules:
- Manual promotion only. No silent retargeting.
- Each alias change bumps `alias_map_version` (monotonic integer).
- Journal records `alias_requested` AND `model_effective` per delegation.
- Cross-version corpus comparisons require explicit segmentation by `alias_map_version`.

---

## 3. Request envelope

What the MCP submits via the broker. JSON over HTTP `POST /orchestrator/submit`.

```typescript
interface DelegationRequest {
  // Wire format
  envelope_version: 1;                  // Pinned at 1 for v1. Broker rejects unknown versions with `kind: "policy_rejected"`.

  // Identity & idempotency
  idempotency_key: string;              // UUID v4 from MCP. Broker dedupes within 24h window. See §3.1 for reuse rules.
  orchestrator_session_id: string;      // UUID per Claude Code session. NOT the Munin session ID.
  orchestrator_submitter: string;       // "claude-code-mcp" — the broker principal that authenticated.
  parent_task_id?: string;              // Reserved for v1.5 multi-step orchestration. Always null in v1.

  // What to do
  task_type: TaskType;                  // Claude's tag — see §4
  prompt: string;                       // Full prompt text. UTF-8. No length cap from envelope; runtime caps apply.

  // How to do it
  alias_requested: Alias;               // Required. See §2.
  alias_map_version: number;            // Read by MCP from /orchestrator/models at session start.

  // Harness-only fields (required iff alias_requested resolves to a harness family)
  worktree?: WorktreeSpec;              // Required for harness aliases. Rejected for one-shot aliases.

  // Constraints
  sensitivity?: "public" | "internal";  // Defaults to "internal". "private" rejected — local-only models can do private but v1 does not auto-route there.
  timeout_ms?: number;                  // Defaults to runtime default (currently 300_000 one-shot, 900_000 harness).
  max_output_tokens?: number;           // Optional cap. Ignored for harness aliases (pi controls its own context).
}

interface WorktreeSpec {
  repo: string;                         // Repo slug, e.g. "hugin". Resolves to /home/magnus/repos/<repo> on the Pi.
  base_ref: string;                     // Git ref the harness branches from, e.g. "origin/main". Broker resolves to a SHA at submission time and pins it.
  target_files?: string[];              // Optional advisory list; pi can read more via tool calls. Used only for the journal.
  copy_node_modules?: boolean;          // Default false. Set true per-call for Node repos that need installed deps available at run time. See §11.3 for cap/admission.
}

type TaskType =
  | "summarize"
  | "extract"
  | "classify"
  | "draft"
  | "reason"
  | "rewrite"
  | "code-edit"      // Harness only.
  | "other";

type Alias =
  | "tiny"
  | "medium"
  | "large-reasoning"
  | "pi-large-coder";
```

**Broker-added fields** (set by Hugin, not the MCP):

```typescript
interface BrokerAnnotations {
  task_id: string;                      // Hugin-generated task ID (existing scheme).
  broker_principal: string;             // Bearer-token identity; matches a key in HUGIN_BROKER_KEYS.
  received_at: string;                  // ISO timestamp.
  alias_resolved: {                     // Snapshot at submission time (immune to later registry edits).
    alias: Alias;
    family: "one-shot" | "harness";
    harness?: "pi";                     // Set iff family === "harness".
    harness_version?: string;           // pi CLI version, captured at submission.
    model_requested: string;
    runtime: "ollama" | "openrouter" | "pi-harness";
    runtime_row_id: string;             // REQUIRED. Stable registry row id (e.g. "ollama-pi", "pi-harness"). Threads through submit → execute → complete; the journal segments corpora by this even when "runtime" is coarse.
    host: "pi" | "mba" | "openrouter";
    reasoning_level?: "low" | "medium" | "high";
  };
  worktree_resolved?: {                 // Set iff family === "harness".
    repo: string;
    base_ref: string;
    base_sha: string;                   // Pinned SHA at submission time.
    worktree_path: string;              // Absolute path on Pi, e.g. /home/magnus/.hugin/worktrees/<task_id>.
  };
  policy_version: string;               // ZDR allowlist version + reasoning-level pinning version, e.g. "zdr-v1+rlv-v1".
}
```

The broker validates: `envelope_version === 1`, bearer token → known principal, idempotency key not seen (or seen with same prompt hash — see §3.1), alias is currently active, sensitivity ≤ runtime ceiling, prompt non-empty. Rejects with a typed error otherwise.

### 3.1 Idempotency-key reuse semantics

The `idempotency_key` is the client's commitment that two submissions are *the same logical task*. Rules:

1. **Same key, same payload (within 24h):** broker treats the second submission as a retry. It returns the existing `task_id` instead of creating a new one. This is the recovery path when the MCP didn't get an HTTP response (network drop, broker restart between accept and ack) and resubmits.
2. **Same key, different payload (within 24h):** broker rejects with `kind: "policy_rejected"`, message indicating idempotency-key collision. The client must rotate the key — generating a new key is treated as a new task.
3. **Same key, after 24h:** the dedupe window has expired. The broker treats it as a new task and accepts. Old retries against this key resolve to the new task; this is acceptable because 24h is a generous upper bound on real retry windows.
4. **New key, regardless of payload:** new logical task. Always accepted (subject to other policy gates).

Payload equality is computed as `sha256(canonicalized_envelope)` where canonicalization sorts keys and excludes broker-added fields. The client must hold the key stable across retries; the broker holds the hash.

---

## 4. Result/await state machine

`hugin_await(task_id, max_wait_s?)` returns one of these states. Idempotent — Claude can call repeatedly with the same `task_id`.

```typescript
type AwaitResponse =
  | { status: "completed"; result: DelegationResult }
  | { status: "failed"; error: DelegationError }
  | { status: "running"; lease: LeaseInfo; orphan_suspected: false }
  | { status: "stale"; lease: LeaseInfo; orphan_suspected: true }
  | { status: "unknown"; reason: "task_id_not_found" | "broker_unavailable" };

interface DelegationResult {
  result_schema_version: 1;            // Pinned at 1 for v1. Bumped only on breaking changes to this shape.
  task_id: string;
  alias_requested: Alias;
  model_effective: string;             // What actually ran (post-fallback if any).
  runtime_effective: "ollama" | "openrouter" | "pi-harness";
  runtime_row_id_effective: string;    // REQUIRED. Stable registry row id of the runtime that actually executed. Equals BrokerAnnotations.alias_resolved.runtime_row_id unless fallback fired.
  host_effective: "pi" | "mba" | "openrouter";
  result_kind: "text" | "diff";        // "diff" only for harness aliases.

  // For result_kind === "text": one-shot output.
  output?: string;                      // Scanned, post-finalization. Never raw provider bytes.

  // For result_kind === "diff": harness output.
  diff?: {
    base_sha: string;                   // Pinned at submission. Caller applies onto this.
    head_sha: string;                   // SHA of the harness's working-tree commit on Pi.
    files_touched: string[];            // Relative paths.
    unified_diff: string;               // Output of `git diff <base_sha> <head_sha>`. Scanned. Always intact in a `completed` result — see scanner contract below.
    stats: { files: number; insertions: number; deletions: number };
    worktree_path: string;              // Absolute Pi path; reaped after retention window.
  };

  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  duration_s: number;
  load_ms?: number;
  cost_usd: number;
  finalized_at: string;
  provenance: {
    source: "delegated";
    scanner_pass: "clean" | "warn" | "redact";
    policy_version: string;
    harness_version?: string;          // For harness results.
  };
}

interface DelegationError {
  task_id: string;
  kind:
    | "alias_unknown"
    | "alias_unavailable"        // Host down, MBA asleep, OR rate-limited
    | "policy_rejected"          // ZDR / sensitivity / timeout
    | "executor_failed"          // Model returned error or empty
    | "scanner_blocked"          // Exfil scanner under `redact` policy matched an executable artifact (e.g. a unified diff). See scanner contract below.
    | "timeout"
    | "internal";
  message: string;
  retryable: boolean;            // Hint for the skill's retry decision.
}

interface LeaseInfo {
  claimed_by: string | null;     // workerId or null if unclaimed.
  claimed_at: string | null;
  lease_expires_at: string | null;
  last_heartbeat_at: string | null;
  queue_depth_when_submitted: number;
}
```

State transitions:
- `pending` (in queue, not visible to await — counts as `running` to the caller with `claimed_by: null`)
- `running` → `completed` | `failed` (normal lifecycle)
- `running` → `stale` when `lease_expires_at < now()` and no heartbeat. **The reaper will eventually flip `stale` → `failed` (kind: `internal`, retryable: true) once it sweeps.** Until then, await reports `stale` so Claude knows the difference between "actually running" and "probably orphaned."

Important: `stale` is a *view* over the raw task state, not a stored status. Munin still says `running`; the broker computes `stale` by comparing `lease_expires_at` to now. This avoids a state-write race with the reaper.

### 4.1 Scanner contract (text vs diff asymmetry)

`finalizeDelegatedOutput` is the single seam where raw provider bytes become a `DelegationResult` or a `DelegationError`. Its contract is **asymmetric** by `result_kind`:

| Scanner outcome | Policy | `result_kind: "text"` | `result_kind: "diff"` |
|---|---|---|---|
| no match | any | `completed`, `scanner_pass: "clean"` | `completed`, `scanner_pass: "clean"` |
| match | `warn` (default) | `completed`, `scanner_pass: "warn"`, raw output | `completed`, `scanner_pass: "warn"`, raw diff |
| match | `redact` | `completed`, `scanner_pass: "redact"`, redacted output | **`failed`, `kind: "scanner_blocked"`, `retryable: false`** |

Why the asymmetry: a redacted human-readable string is still useful — the reader sees `[redacted: private-key]` where the secret was and can decide what to do. A redacted unified diff is no longer a valid patch; replacing the matched span with `[redacted: private-key]` breaks `git apply`. The contract therefore guarantees: **a `completed` result whose `result_kind` is `"diff"` always carries an intact, applyable `unified_diff`.** If redaction would corrupt the diff, the caller sees `failed/scanner_blocked` instead.

This rule generalises: any future executable-artifact result kind (e.g. `tool-call-trace`, `binary-patch`) must explicitly declare whether redaction preserves semantics. If not, it escalates to `scanner_blocked`.

`scanner_blocked` is `retryable: false` because retrying the same prompt against the same model is unlikely to produce different scanner output. Escalation to a different alias (e.g. a smaller model, or a one-shot path that produces text instead of a diff) is the recovery path; that's a Step 7 (skill) decision, not a broker retry.

---

## 5. Journal event model

**Decision:** append-only JSONL event log + read-time projection. No mutation. No new dependency.

File: `~/.hugin/delegation-events.jsonl` on the Pi. Separate from the main `invocation-journal.jsonl` because:
- Different cardinality (delegated calls likely 5–10× top-level Hugin tasks)
- Different schema (full prompts/outputs)
- Different retention story (full-text content has tighter blast radius)
- Different consumers (corpus analysis tools, not the existing journal scripts)

### Event types

Three event kinds, all append-only. Every event carries `event_schema_version` so future projection code can branch on shape changes without a migration. v1 pins all events at version 1.

```typescript
interface DelegationSubmittedEvent {
  event_schema_version: 1;
  event_type: "delegation_submitted";
  event_ts: string;                    // ISO
  task_id: string;
  // Full envelope at submission time:
  envelope: DelegationRequest & BrokerAnnotations;
  prompt_chars: number;
  prompt_sha256: string;               // For dedup analysis without storing twice.
}

interface DelegationCompletedEvent {
  event_schema_version: 1;
  event_type: "delegation_completed";
  event_ts: string;
  task_id: string;
  outcome: "completed" | "failed";
  // For completed:
  output?: string;                     // Full text. Post-scanner.
  output_chars?: number;
  output_sha256?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  duration_s?: number;
  load_ms?: number;
  cost_usd?: number;
  model_effective?: string;
  runtime_effective?: string;
  host_effective?: string;
  scanner_pass?: "clean" | "warn" | "redact";
  // For failed:
  error_kind?: DelegationError["kind"];
  error_message?: string;
}

interface DelegationRatedEvent {
  event_schema_version: 1;
  event_type: "delegation_rated";
  event_ts: string;
  task_id: string;
  rating: "pass" | "partial" | "redo" | "wrong";
  rating_reason: string;               // Required, non-empty.
  verification_outcome:                // Structured detail beyond the rating.
    | "accepted_unchanged"
    | "minor_edit"
    | "major_rewrite"
    | "discarded"
    | "escalated_to_claude";
  rated_by: string;                    // Always "claude-code-mcp" in v1; reserved for human audit later.
  retries_count?: number;              // How many times the parent session re-invoked the same task.
}
```

**Forward-compat rule:** projection code MUST tolerate unknown `event_schema_version` values by skipping the event (with a logged warning) rather than crashing. Producers MUST bump the version on any breaking shape change; additive field changes do not require a bump.

### Projection (read-time)

Reading the journal:

```typescript
function projectDelegations(events: Event[]): Map<string, DelegationRow> {
  const rows = new Map<string, DelegationRow>();
  for (const e of events) {
    const row = rows.get(e.task_id) ?? { task_id: e.task_id };
    if (e.event_type === "delegation_submitted") {
      row.envelope = e.envelope;
      row.submitted_at = e.event_ts;
      row.prompt_chars = e.prompt_chars;
    } else if (e.event_type === "delegation_completed") {
      row.outcome = e.outcome;
      row.completed_at = e.event_ts;
      // ...merge tokens/cost/model/etc.
    } else if (e.event_type === "delegation_rated") {
      row.rating = e.rating;
      row.rating_reason = e.rating_reason;
      row.verification_outcome = e.verification_outcome;
      row.rated_at = e.event_ts;
    }
    rows.set(e.task_id, row);
  }
  return rows;
}
```

Properties:
- Single writer: Hugin's broker process. Append-only. No locks.
- Multiple ratings allowed: only the latest `delegation_rated` event for a given `task_id` wins. Earlier ones become history.
- Unrated tasks visible: a row without a `delegation_rated` event projects with `rating: null`. The skill or a periodic check can flag these.
- Audit-friendly: the raw event log is the source of truth. Any projection is reproducible from the same events.

### Audit fields populated downstream (not in v1)

Reserved field names recorded but not written by v1, to avoid schema churn later:
- `external_audit_rating` (Magnus weekly spot-audit, future)
- `audit_disagrees_with_self_rating` (boolean, future)

---

## 6. Runtime registry extension

`src/runtime-registry.ts` gains:

```typescript
interface RuntimeDefinition {
  // ... existing fields ...
  provider: "anthropic" | "openai-spawn" | "ollama-local" | "openrouter" | "pi-harness";
  egress: "subscription" | "local" | "third-party";
  zdrRequired: boolean;                // true for "openrouter" and "pi-harness" (since pi-harness uses OR).
  autoEligible: boolean;               // false for "openrouter" and "pi-harness" — explicit-only routing.
  reasoningLevel?: "low" | "medium" | "high";  // Pinned per runtime row for gpt-oss family.
  family: "one-shot" | "harness";      // Selects executor path.
  harnessCmd?: string;                 // For family === "harness": the CLI binary, e.g. "pi".
  harnessFlags?: string[];             // Static flags, e.g. ["--no-session", "--provider", "openrouter"].
}

interface AliasMap {
  version: number;                     // Monotonic. Bumped on any retargeting.
  effective_at: string;                // ISO when this map became active.
  aliases: Record<Alias, AliasResolution>;
}

interface AliasResolution {
  model: string;
  runtime: string;
  host?: string;
  reasoningLevel?: "low" | "medium" | "high";
  family: "one-shot" | "harness";
  harness?: "pi";
  notes?: string;
}
```

The router (`src/router.ts`) gains one rule: skip runtimes with `autoEligible: false` from auto-routing. They can still be selected explicitly by alias.

### v1 runtime rows added

| Runtime ID | provider | egress | zdrRequired | autoEligible | family | harnessCmd | harnessFlags |
|---|---|---|---|---|---|---|---|
| `openrouter` | openrouter | third-party | true | false | one-shot | — | — |
| `pi-harness` | pi-harness | third-party | true | false | harness | `pi` | `["--no-session", "--provider", "openrouter"]` |

The existing `ollama-local` runtime is unchanged; `tiny` and `medium` aliases continue to point at it.

---

## 7. Provenance chain (end-to-end)

```
Claude Code session
  ↓ (intent: delegate sub-task)
Delegate skill (heuristic chooses alias)
  ↓
hugin-mcp tool call (laptop)
  ↓ (HTTPS over Tailscale, bearer token)
Hugin broker endpoint (Pi)
  ├─→ DelegationSubmittedEvent (journal)
  ├─→ Munin task entry (under tasks/<id>) with envelope encoded
  ↓
Hugin dispatcher (existing poll loop)
  ↓
Executor (ollama-executor or openrouter-executor)
  ↓
Raw provider output
  ↓
finalizeDelegatedOutput()  ← exfil scanner, structured-result builder, provenance tags
  ↓
Munin result-structured + DelegationCompletedEvent (journal)
  ↓
hugin_await returns to MCP
  ↓
MCP returns scanned result to Claude session
  ↓ (Claude verifies output, decides to use/redo)
Claude calls hugin_rate
  ↓
DelegationRatedEvent (journal)
```

Every transition logs an event. Every output crossing the broker→MCP boundary has been through `finalizeDelegatedOutput()`. Every task ID is traceable end-to-end.

---

## 8. Open questions Magnus must close before Step 2

These remain open. Each has a default the spec proceeds with absent a contrary answer.

1. **MBA medium model:** Default `qwen3:14b` for the `medium` alias (eval-validated). Registry's current laptop default of `qwen3.5:35b-a3b` is a separate fix tracked outside this spec.
2. **Tailscale ACL:** Default — broker accepts any tailnet device that presents a valid bearer token from `HUGIN_BROKER_KEYS`. Tag-pinning is an upgrade for later if the keystore alone proves insufficient.
3. **Idempotency window:** Default 24h. Affects how aggressive MCP retries can be without creating phantom duplicates.
4. **Reasoning-level pinning for `gpt-oss-120b`:** Default `medium`. Pinned per-alias for v1; per-call override is a v1.5 ask.
5. **Harness retention:** Default 7 days for `~/.hugin/worktrees/<task_id>` before reaping. See §11.3 for the disk cap and admission-control rules that pair with retention.

---

## 11. `pi` harness in v1 — decision and eval data

**Decision (2026-04-26): Option B selected.** `pi` enters v1 as a harness runtime running on the Pi, calling cloud models via OpenRouter. No multi-host dependency. Working trees are managed per-task on the Pi via `git worktree add`.

### 11.1 Eval data (the basis for the decision)

| Question | Answer |
|---|---|
| How many tasks "useful" (X/6) | 5✓ / 1~ / 0✗ — strict 5/6, lenient 6/6 |
| Against which models | Cloud only: `openrouter/qwen/qwen3-coder-next` (the 30B-A3B coder MoE) |
| Working tree / file scope | Fresh `git worktree add` from `aider-eval/base` (commit `929c6e8`). `cp -R node_modules` from main repo. No file pre-loading — pi reads files itself via tool calls (iterative loop, like opencode) |
| Invocation mode | Headless one-shot: `pi --provider openrouter --model qwen/qwen3-coder-next --no-session -p "<prompt>"`. No multi-turn, no interactive — just `-p` and exit |
| Wall time | 2 min 16 sec total (parallel cloud, longest task 129s) |
| The "~" task | Task 05 (rename `ModelSpec` → `ModelConfig` across files): rename done correctly across all 5 files, no test regressions, but also renamed `topModelSpec` → `topModelConfig` against an explicit "leave variables alone" instruction. Strict scorer ✗, lenient scorer ✓ |
| Local pi (Pi+ollama) | Tested ollama config — works but blocked: `qwen3:14b` takes 85s for "what is 2+2" because thinking can't be disabled via pi's OpenAI-compatible adapter. No local 6-task data yet |

Source artifacts: `data/aider-eval/pi-task-{01..06}-transcript.txt`, dispatch script `/tmp/aider-eval/dispatch-pi.sh`, runner `/tmp/aider-eval/run-pi-task.sh`. Munin log entry `da0c410d-afa6-41da-b804-e2f494acc0ec` posted at 2026-04-26T10:28 UTC.

### 11.2 Architectural rationale

Pi is the always-on orchestration host; Studio (future) and OpenRouter (now) are stateless model servers. Putting the harness *on the Pi* — not the laptop, not the Studio — means:

- Working trees live next to the orchestrator (no cross-machine sync).
- Harness invocation does not depend on the laptop being awake.
- Model choice is independent of harness placement (pi calls OR for the model; OR is just an HTTP endpoint).
- No multi-host sprint dependency — Hugin on Pi is sufficient.

The Pi RAM constraint that rules out local-Ollama for harness work does **not** apply here, because pi calls OR for the model; the Pi is only running the harness control loop (I/O bound, not compute bound).

### 11.3 Working-tree contract

Every `pi-large-coder` delegation creates and tears down a per-task worktree:

```
~/.hugin/worktrees/<task_id>/        # git worktree add <repo> <base_sha>
  node_modules/                      # only if copy_node_modules: true
  ...repo files at base_sha...
```

`copy_node_modules` defaults to `false`. The eval that validated `pi` used `cp -R node_modules` from a Node repo where the harness needed installed deps to run tests. That pattern doesn't generalise — Python venvs, Rust target dirs, Go module caches all behave differently — so v1 ships with no copy by default and the caller opts in per task. For non-Node repos, the harness must bootstrap its own deps (or the task must avoid commands that need them); per-toolchain dep-bootstrap support is deferred to v1.5.

Lifecycle:
1. **Submit:** broker resolves `worktree.base_ref` → `base_sha`, records both in `worktree_resolved`. Admission control runs here (see §11.3.1) — if the broker projects that the new worktree would exceed the disk cap, submission is rejected with `kind: "policy_rejected"` before any disk is touched.
2. **Claim:** dispatcher calls worktree-manager: `git worktree add <path> <base_sha>` + `cp -R ../<repo>/node_modules <path>/` iff `copy_node_modules: true`.
3. **Run:** `cd <path> && pi --no-session --provider openrouter --model <resolved> -p "<prompt>"`. pi makes file changes via its own tool calls.
4. **Capture:** `git -C <path> add -A && git -C <path> commit -m "harness: <task_id>"` to get a `head_sha`. Then `git -C <path> diff <base_sha> <head_sha>` is the diff returned.
5. **Finalize:** diff and stats run through `finalizeDelegatedOutput()` (exfil scanner). Worktree path is recorded in the result for retention/reaping.
6. **Reap:** worktrees older than 7 days (configurable) are removed by a periodic sweep. The Pi never pushes; never modifies the main worktree.

Hugin pushes nothing. Diffs cross the broker → MCP → Claude boundary; Claude applies on the laptop (or asks the user to).

### 11.3.1 Worktree disk admission control

The Pi has finite disk. Worktrees grow without bound if retention is the only mechanism, especially when `copy_node_modules: true` clones can be hundreds of megabytes each. v1 caps total worktree disk and admits new ones against the cap.

**Configuration:**
- `HUGIN_WORKTREE_BUDGET_BYTES` — cap on cumulative `~/.hugin/worktrees/` size. Default 20 GiB. Tunable per-host.
- `HUGIN_WORKTREE_RETENTION_DAYS` — soft retention. Default 7. Time-based reap runs daily.

**Admission rules (broker side, at submit):**
1. Read current `~/.hugin/worktrees/` size from a small cached value the worktree-manager refreshes after every add/reap. (No `du` on every submit — too expensive.)
2. Estimate the projected worktree size: repo size at `base_sha` (cheap to compute via `git -C <repo> rev-list --objects --count` or stat the existing worktree on disk) + `node_modules` size if `copy_node_modules: true`.
3. If `current + projected > budget`:
   a. **Eager reap:** delete worktrees older than `HUGIN_WORKTREE_RETENTION_DAYS / 2` (LRU among same-age ties). Recompute current. If still over budget, continue.
   b. **LRU eviction (above-cap path):** while `current + projected > budget`, delete the oldest fully-completed worktree (status: `completed | failed`, never `running`). Recompute current.
   c. If after a + b the projection still exceeds the budget, reject submission with `DelegationError { kind: "policy_rejected", message: "worktree_budget_exhausted", retryable: false }`. The skill's recovery path is to escalate the alias or wait.

**Mid-run failure (disk fills between claim and finalize):**
A claimed task that is `running` is never evicted by admission control. If the disk genuinely fills mid-run (e.g. the harness writes a huge file), the executor reports an OS error and the task fails with `kind: "executor_failed"`. The reaper then sweeps it like any other failed task. We do not pre-allocate or quota individual worktrees in v1; the budget is a coarse cap, not a per-task reservation.

**Operational telemetry:**
The broker emits `delegation_admission_evaluated` log lines (size projection, budget, decision) so disk pressure becomes observable before it becomes a rejection rate. Promotion to a journal event kind is deferred to v1.5.

### 11.4 What is **not** locked yet

These are deferred to implementation time and do not block Step 2:

- Per-toolchain dep bootstrap beyond `copy_node_modules` (Python venvs, Rust target dirs, Go module caches). **Tentative:** v1 supports Node repos with explicit opt-in; non-Node repos run with no copied deps and the harness bootstraps as needed (or the task avoids commands that need them). Promotion to first-class spec is a v1.5 ask.
- Concurrency limit on harness runs (eval ran 6 in parallel; v1 dispatcher serializes, so this is not a v1 issue).
- Auto-application of diffs by the skill vs. always-review. **Tentative:** always-review for v1 — Claude shows the diff, the user (or Claude itself within session) applies it.

---

## 12. Durability and recovery contract

The Step 1 spec (as originally drafted) named the writes that happen on submit and complete but did not lock which write is the durable record, which is the derived view, or how the system recovers when a write succeeds and the next one fails. The recent #57 fix (status-first ordering for legacy task results) does not transplant directly: in the orchestrator, the structured `DelegationResult` *is* the payload `hugin_await` returns, so a "completed status with no durable result" is not an acceptable state.

This section locks the durability model.

### 12.1 Sources of truth (per phase)

| Phase | Durable record | Derived views |
|---|---|---|
| Submission | The Munin task entry under `tasks/<task_id>` (status + envelope) | `delegation_submitted` journal event; broker in-memory index |
| Execution | The lease state on the Munin entry (`claimed_by`, `lease_expires_at`, `last_heartbeat_at`) | `running` / `stale` views computed by the broker |
| Completion (success) | The Munin entry under `tasks/<task_id>/result-structured` (the full `DelegationResult` JSON) plus the terminal-status flip on `tasks/<task_id>` | `delegation_completed` journal event; `output` in the Munin human-readable result key |
| Completion (failure) | The Munin terminal-status flip (`tasks/<task_id>` tags include the failure marker) plus a stored `DelegationError` JSON | `delegation_completed { outcome: "failed" }` journal event |
| Rating | The latest `delegation_rated` journal event | (none — the journal is canonical for ratings) |

**Rule:** Munin holds the durable records for submission, execution, and completion. The journal is the canonical record for rating, and a derived/auditable view of the other phases. The broker in-memory index is purely a cache and must be reconstructible from Munin alone.

### 12.2 Submit ordering

The broker's `POST /orchestrator/submit` performs writes in this order:

1. **Acquire dedupe lock** on the `idempotency_key` (in-memory; non-durable). If another submission with the same key is in-flight, queue this one or reject.
2. **Munin write:** create `tasks/<task_id>` with the full envelope (request + `BrokerAnnotations`) and tags `["pending", "runtime:<runtime>", "orch-v1"]`. This write must succeed before the broker returns `200 OK` to the MCP. *This is the durability boundary — once Munin acks, the submission is durable.*
3. **Journal append:** write `delegation_submitted` to `~/.hugin/delegation-events.jsonl`. If this fails, log a warning but do not roll back the Munin write — the event is reconstructible from the Munin envelope. Periodic reconciliation (§12.5) will detect and backfill missing journal entries.
4. **Acknowledge** to the MCP with `{ task_id }`.

**Crash between (2) and (3):** Munin has the task; journal is missing the submitted event. Reconciliation backfills it on next broker startup (or on-demand). The MCP retry path (same `idempotency_key`) finds the existing Munin entry and returns the same `task_id`.

**Crash between (1) and (2):** No durable state. The MCP retry creates the task fresh.

**Crash between (2) and (4):** Munin has the task; the MCP did not receive an ack. The MCP retry with the same `idempotency_key` and same payload returns the existing `task_id` (per §3.1 rule 1).

### 12.3 Complete ordering

When the executor finishes a task, the broker performs:

1. **Compute** the `DelegationResult` (or `DelegationError`) by running the executor output through `finalizeDelegatedOutput`. This is in-memory; nothing is durable yet.
2. **Munin write:** atomic CAS on `tasks/<task_id>` flips the lifecycle tag to terminal (`completed` or `failed`) AND writes `tasks/<task_id>/result-structured` with the full result JSON in a single Munin operation. Munin's substrate does not support multi-key CAS, so this is implemented as: (a) write `result-structured` first; (b) CAS the status tag from `running` → terminal, gated on the lease still being valid. If (a) succeeds and (b) fails, the result is orphaned in `result-structured` but the task is still `running`. The reaper detects this on its next sweep and either re-completes (if the worker is gone) or escalates.
3. **Journal append:** `delegation_completed`. Same recovery posture as submit (§12.2 step 3) — backfill on reconciliation if the append fails.

**Why result-first inside Munin:** `hugin_await` reads `tasks/<task_id>` for status and `tasks/<task_id>/result-structured` for the payload. If status is terminal but the payload key is missing, `await` would have to invent a result — unacceptable. Writing the payload first guarantees that any caller who sees terminal status can read a durable result.

**Crash between (1) and (2a):** No durable completion; the lease eventually expires; the reaper re-queues the task as `failed` with `kind: "internal"` (existing legacy behavior).

**Crash between (2a) and (2b):** Result is durable but status is still `running`. The reaper sweep checks for an existing `result-structured` key and, if found and the lease has expired, completes the CAS itself. If the CAS fails (another worker claimed it), the recovery path is to delete the orphaned result and re-run.

**Crash between (2b) and (3):** Task is terminal in Munin; journal is missing the completed event. Reconciliation backfills.

### 12.4 `hugin_await` semantics

`hugin_await(task_id)` is implemented as a pure read against Munin:

1. Read `tasks/<task_id>` (status + tags + lease).
2. If terminal status:
   - `completed` → read `tasks/<task_id>/result-structured`. If missing, return `{ status: "failed", error: { kind: "internal", message: "result-structured key missing for terminal task; reconciliation pending", retryable: true } }` (recoverable by next reaper pass).
   - `failed` → read the stored `DelegationError`. Return `{ status: "failed", error }`.
3. If `running` and `lease_expires_at` is in the future → return `{ status: "running", lease, orphan_suspected: false }`.
4. If `running` and `lease_expires_at` is past → return `{ status: "stale", lease, orphan_suspected: true }`.
5. If task does not exist → return `{ status: "unknown", reason: "task_id_not_found" }`.

The earlier proposal of a `submitted_not_indexed` await branch is dropped: Munin is the canonical submit record, so there is no separate index to lag behind. The broker's in-memory index is purely a performance optimisation; await reads Munin directly.

### 12.5 Reconciliation sweep

A periodic reconciliation pass (default every 60s, configurable via `HUGIN_RECONCILIATION_INTERVAL_MS`) does:

1. Scan Munin for `tasks/*` entries with the `orch-v1` tag and a status that disagrees with the broker's in-memory cache.
2. For each Munin task without a matching `delegation_submitted` event in the journal: append the event from the stored envelope (idempotent — the journal append checks if the event already exists before writing).
3. For each terminal Munin task without a matching `delegation_completed` event: append the event from the stored result/error.
4. For each Munin task in `running` with an expired lease and an existing `result-structured` key: complete the CAS (per §12.3 crash recovery).
5. For each Munin task in `running` with an expired lease and no result: flip to `failed { kind: "internal", message: "lease expired without result" }`.

Reconciliation is designed to be idempotent — running it twice produces the same state. It is the recovery path for every "crash between writes" scenario in §12.2 and §12.3.

### 12.6 Runtime-row identity through the chain

Every persisted record carries `runtime_row_id` (the registry row id, e.g. `"ollama-pi"`, `"pi-harness"`):

- `BrokerAnnotations.alias_resolved.runtime_row_id` — captured at submit time.
- `DelegationResult.runtime_row_id_effective` — the row that actually ran (post-fallback).
- `DelegationSubmittedEvent.envelope.alias_resolved.runtime_row_id` — derived from the envelope.
- `DelegationCompletedEvent.runtime_row_id_effective` — derived from the result.

Sensitivity policy and routing decisions resolve through `runtime_row_id` (registry-row scope) rather than the coarse `dispatcherRuntime` field. This is what unblocks future cases like a second OpenRouter row with different cost/ZDR/reasoning profiles. The `runtime` and `host` fields remain in the envelope/result for human readability and for consumers that don't need row-level precision.

The dispatcher's legacy in-process executor continues to key off `dispatcherRuntime` (`claude` / `codex` / `ollama`) — that's the `LegacyDispatcherRuntime` boundary in `runtime-registry.ts`. Orchestrator-only runtimes (`openrouter`, `pi-harness`) never flow through the legacy dispatcher; they go through the broker → executor path that uses `runtime_row_id` end-to-end.

---

## 9. What this spec deliberately does NOT cover

- Other harness runtimes (`aider`, `opencode`, `claude-code-on-pi`) — out of scope for v1, deferred to v1.5. Only `pi` ships in v1.
- Multi-turn harness sessions — `pi` is invoked `--no-session` only; multi-turn would require persistent state across `await` calls, deferred.
- Multi-step orchestration (`parent_task_id` chaining) — reserved field, not used.
- Auto-apply of harness diffs — Claude reviews and applies; Pi never pushes.
- Cost caps per call — addressed in Step 5 (executor) via env config.
- Skill heuristics (when to delegate code-edit vs. handle in session) — addressed in Step 7.
- MCP server lifecycle (Claude Code restart, reconnect) — addressed in Step 6.
- Multi-host orchestration (Hugin running on MBA too) — separate sprint.

---

## 10. Acceptance criteria for Step 1

This spec is approved when:
- [x] Pi-harness scope decision (Option B) recorded with eval data (§11).
- [ ] Magnus signs off on the alias set including `pi-large-coder` (§2).
- [ ] Magnus confirms the worktree contract: per-task `git worktree add` from pinned base SHA, no auto-push, 7-day retention (§11.3).
- [ ] Magnus confirms the journal event model (append-only, projection at read time, no mutation, no new dependency).
- [ ] Magnus confirms the broker is Tailscale-only with bearer-token auth.
- [ ] Defaults for §8 questions accepted (or contrary answers given).

After acceptance: Step 2 (runtime registry extension) is unblocked. Each subsequent step has its own acceptance gate before code is written.
