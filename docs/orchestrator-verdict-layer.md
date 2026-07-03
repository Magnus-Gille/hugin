# Orchestrator Verdict Layer (PR2) — Design / ADR

**Status:** Accepted (2026-07-03) · **Branch:** `feat/orchestrator-verdict-layer`
**Implements:** D5 + D6 of `docs/orchestrator-redesign.md` (PR2 in the build sequencing).

## Context

PR1 (#108) built the fanout engine; #137 added the `homeserver` sovereign provider, so
delegation volume now flows at $0. What's missing is the learning loop: per-worker
outcome data (`model`, `ok`, cost, verifier verdict) is computed in-engine but discarded
before persistence, verification is all-or-nothing and has zero control-flow effect, and
nothing accumulates per-(model × task-type) confidence.

The M5 gateway's `GET /ledger` (probed live 2026-07-03) already reports exactly the
aggregate we want, per `(taskType × modelId)`:
`{verdict: viable|marginal|not_viable|unknown, attempts, passes, partials, fails,
errors, successRate, frozen, recommendation: delegate-local|escalate-frontier|explore,
avgLatencyMs, avgTokPerSec}` over a 21-type task taxonomy (`classify`, `summarize`,
`code-implement`, `reason-math`, …).

## Decisions

### V1 — Adopt the gateway's shapes verbatim (convergence by construction)

Hugin's cloud-worker verdict store uses the **same task-type taxonomy** and the **same
aggregate row shape** as the gateway ledger. D5's "converge to a single KB later"
becomes a merge, not a migration. Task types: the 21 gateway values + `other` fallback.

### V2 — Task-type is planner-emitted per subtask

`SubTask` gains an optional `taskType` field; the planner prompt asks for it in the JSON
plan (one enum value per subtask, `other` when unsure). No extra model call, no separate
classifier. `parsePlan` validates against the taxonomy and falls back to `other` on any
unknown value. (The skill-lane's `classifyTask` is NOT reused — it classifies whole
prompts against Munin-loaded routes; this is a per-subtask label the planner already has
the context to assign.)

### V3 — Verdict events from worker + verifier outcomes; verifier infra-failure is UNKNOWN, not PASS

Per `SubtaskOutcome`, exactly one event: **pass** (`result.ok` and verdict absent-or-ok),
**fail** (`result.ok` and `verdict.ok === false`), **error** (`!result.ok`, infra).
Bug fix folded in: a failed verifier CALL (`verifyResp.ok === false`) currently flows
into `parseVerdict("")` which defaults `{ok: true}` — a verifier outage reads as PASS.
New behavior: verdict stays `undefined` and a warning is appended; the outcome counts as
a plain worker pass (verifier signal unknown), never as a verified pass.

### V4 — Store: single Munin doc, CAS read-modify-write

Namespace `tasks/_verdicts`, key `report` (follows `tasks/_heartbeat` /
`tasks/_auth_alarm` Hugin-owned-state precedent). Content: JSON
`{schemaVersion: 1, rows: {"<modelId>|<taskType>": {attempts, passes, fails, errors,
totalLatencyMs}}}` — small by design (counters only; success rate/verdict/
recommendation are DERIVED at read time by pure functions, mirroring gateway semantics:
`unknown` < 3 attempts; `viable` ≥ 0.8; `marginal` ≥ 0.5; else `not_viable`;
recommendation maps viable→delegate-local(trust), not_viable→escalate-frontier,
else→explore(verify)). Update via the task-claim CAS pattern: read `updated_at` → write
with `expected_updated_at` → on conflict re-read and retry once, then drop (verdicts are
statistics; losing one event is acceptable, corrupting the doc is not). Recording is
fire-and-forget: a Munin failure logs and never fails the task.

### V5 — Adaptive verify gate (selective, not global)

`HUGIN_ORCH_ADAPTIVE_VERIFY=on` (new, default off) makes the verifier pass selective per
subtask: consult confidence for `(worker model × subtask taskType)` — verify when the
derived recommendation is `explore`/`escalate-frontier` or `unknown`; skip (trust) when
`delegate-local`. `HUGIN_ORCH_VERIFY=on` retains its meaning: verify everything
(overrides adaptive). Confidence source: the Munin verdict store for cloud providers;
**the gateway ledger for `homeserver`-bound workers** (D5: local lane reads `/ledger`).
Escalation (re-running a failed subtask on a stronger tier) is OUT of this PR —
follow-up issue; the gate here decides verify-vs-trust only.

### V6 — Verified-fail outputs are excluded from synthesis

Today a `verdict.ok === false` output is synthesized anyway (verdicts have zero effect).
New: outcomes with an explicit failed verdict are excluded from the synthesizer input
and surfaced in `warnings[]`. If ALL outputs are excluded, fall back to including them
(with a warning) rather than synthesizing from nothing — degraded output beats none.

### V7 — Ledger client: cached, fail-open

New `src/orchestrator/ledger-client.ts`: `GET {gatewayRoot}/ledger` with the same bearer
auth + sovereign-host validation as the provider path (reuses `resolveProviderBaseUrl`
minus the `/v1`, i.e. a sibling resolver on the gateway root). In-process cache with TTL
(`HUGIN_ORCH_LEDGER_TTL_MS`, default 10 min). Any failure → empty signal (fail-open: the
gate degrades to `unknown` → verify, never blocks execution).

### V8 — Per-worker outcomes survive into `result-structured`

Additive optional field `orchestratorOutcomes` on the structured result (follows the
`skillRoute`/`artifactDelivery` precedent): per worker
`{subtaskId, taskType, provider, model, ok, verdictOk (bool|null), costUsd, latencyMs}`.
This is the raw material for PR3's savings tracker and closes the "rich data lost"
gap. The human-readable summary is unchanged except worker lines gain `model` and a
`✗ verdict` marker.

## Wiring (hook seam)

`engine.ts` stays pure: it gains an injected optional `confidence` lookup
(`(model, taskType) => Recommendation | null`) in `opts` for the adaptive gate, and
returns richer outcomes it already has. All I/O lives in `orchestrator-executor.ts`
(deps bag gains optional `verdictStore` + `ledgerSignal`) and `src/index.ts` (constructs
the store with the main `munin` client; hydrates nothing at boot — the store reads the
doc lazily per run, one read per task).

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `HUGIN_ORCH_ADAPTIVE_VERIFY` | `off` | Selective verification driven by confidence (V5). |
| `HUGIN_ORCH_VERDICT_STORE` | `on` | Record per-worker verdict events to `tasks/_verdicts` (V4). `off` = no reads/writes. |
| `HUGIN_ORCH_LEDGER_TTL_MS` | `600000` | Gateway ledger cache TTL (V7). |

## Non-goals (this PR)

- Escalation/re-run of low-confidence or failed subtasks (follow-up issue).
- Wiring the broker (orch-v1) rating events into this store (its `delegation_rated`
  events lack model/task-type at the event level; joining via the projection is a
  follow-up).
- Router (`Runtime: auto`) confidence ranking — the router serves the legacy dispatcher,
  not orchestrator roles.
- Single-KB convergence with the gateway ledger (D5's "later").
