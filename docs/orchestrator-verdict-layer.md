# Orchestrator Verdict Layer (PR2) — Design / ADR

**Status:** Accepted (2026-07-03) · **Branch:** `feat/orchestrator-verdict-layer`
**Implements:** D5 + D6 of `docs/orchestrator-redesign.md` (PR2 in the build sequencing).

**Updated 2026-07-03** (post-review fixes, Codex gpt-5.5 + adversarial review): V1's
taxonomy count and source of truth, V3's verified/unverified event separation (the
critical fix — the original design recorded every unverified success as quality signal,
a confidence-poisoning bug), V4's batching/fire-and-forget/dedicated-client/streak-reset
semantics, and V5's re-probe gate + fail-direction guarantee below reflect the FINAL
(fixed) behavior, not the original design. See the fix numbers inline.

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
avgLatencyMs, avgTokPerSec}`. The live probe's `report` array only showed 21 distinct
task types that day — it's data-dependent, listing only types actually attempted so
far — but the gateway's own `taxonomy.ts` (the authoritative full enumeration, see V1
below) defines 22, including `claim-verify`, which simply hadn't been exercised yet.

## Decisions

### V1 — Adopt the gateway's shapes verbatim (convergence by construction)

Hugin's cloud-worker verdict store uses the **same task-type taxonomy** and the **same
aggregate row shape** as the gateway ledger. D5's "converge to a single KB later"
becomes a merge, not a migration. Task types: **22 values including `other`**
(`TASK_TYPES` in `plan.ts`, includes `claim-verify`). The gateway's **`taxonomy.ts`** —
not the data-dependent `/ledger` report, which only lists task types that have actually
been attempted at least once — is the authoritative source of truth for the full
enumeration; Hugin's `TASK_TYPES` mirrors it 1:1 (Fix #6).

### V2 — Task-type is planner-emitted per subtask

`SubTask` gains an optional `taskType` field; the planner prompt asks for it in the JSON
plan (one enum value per subtask, `other` when unsure). No extra model call, no separate
classifier. `parsePlan` validates against the taxonomy and falls back to `other` on any
unknown value. (The skill-lane's `classifyTask` is NOT reused — it classifies whole
prompts against Munin-loaded routes; this is a per-subtask label the planner already has
the context to assign.) A planner-emitted empty/whitespace `id` is normalized to
`subtask-<index+1>` (post-cap index) at parse time (Fix #7) — otherwise it would pass
`SubTaskSchema` but fail `orchestratorOutcomeSchema`'s `subtaskId.min(1)` at
structured-result write time, AFTER a run (possibly a paid one) already completed.

### V3 — Verdict events from worker + verifier outcomes; ONLY a VERIFIED outcome is quality signal

Per `SubtaskOutcome`, exactly one event, checked in this order: **error**
(`!result.ok`, infra), **pass** (`result.ok` and an explicit VERIFIED `verdict.ok ===
true`), **fail** (`result.ok` and an explicit VERIFIED `verdict.ok === false`),
**unverified** (`result.ok` but no verdict was ever produced — the adaptive gate skipped
verification, the verifier CALL failed, or its output was unparseable). Only `pass`/
`fail` count toward the derived quality rate; `unverified` increments a per-row streak
counter (`unverifiedPasses`, Fix #1) but never the pass counter.

This closes a real confidence-poisoning bug in the original design: it recorded EVERY
unverified success as a `pass`, so as few as 3 unverified runs on the default
(unverified) path made a row "viable" → `delegate-local` → skip-verification — and once
verification is skipped, that row could never again generate the verified event needed
to re-examine it (an absorbing state; `delegate-local` was permanent and unearned).

**V3a — `parseVerdict` is strict about ambiguity (Fix #4).** The verifier is asked to
lead with `PASS` or `FAIL` (`prompts.ts`). `parseVerdict` matches that leading token on
the first non-empty line FIRST — a substring search for `FAIL` anywhere in the text (the
original implementation) misreads `PASS — would otherwise FAIL on X` as a fail. Only
when no leading token is found does it fall back to a substring search, and only trusts
that fallback when EXACTLY ONE of PASS/FAIL appears anywhere (word-boundary). Empty
output, gibberish, or text containing both tokens all return `undefined` — never the
original's default `{ok: true}`, which silently promoted an unparseable verdict to a
fake pass. A verifier CALL failure and an unparseable/ambiguous OUTPUT both leave
`verdict` `undefined`, so both count as `unverified` per V3 above, never a fake pass.

### V4 — Store: single Munin doc, BATCHED CAS read-modify-write, fire-and-forget

Namespace `tasks/_verdicts`, key `report` (follows `tasks/_heartbeat` /
`tasks/_auth_alarm` Hugin-owned-state precedent). Content: JSON
`{schemaVersion: 1, rows: {"<modelId>|<taskType>": {attempts, passes, fails, errors,
totalLatencyMs, unverifiedPasses}}}` — small by design (counters only; success rate/
verdict/recommendation are DERIVED at read time by pure functions, mirroring gateway
semantics: `unknown` when `passes+fails < 3`; `viable` ≥ 0.8; `marginal` ≥ 0.5; else
`not_viable` — the rate is **`passes/(passes+fails)`, EXCLUDING infra errors** (and the
raw `attempts` counter, which also includes unverified passes) — matching gateway
semantics; recommendation maps viable→delegate-local(trust), not_viable→
escalate-frontier, else→explore(verify)). `unverifiedPasses` is a streak counter:
incremented by an `unverified` event, reset to 0 by a VERIFIED `pass` or `fail`,
untouched by `error` — it feeds the V5 re-probe gate below (Fix #1).

**Batched, single round-trip (Fix #2).** Recording folds an ENTIRE run's worth of
outcomes into ONE read-modify-write (`VerdictStore.recordBatch`) rather than one CAS
round-trip per outcome — bounding worst-case Munin traffic per task to a single read +
single write regardless of subtask count (the original per-outcome loop could, on a
degraded Munin with serial CAS retries, stall on the order of minutes on a many-subtask
run). Update via the task-claim CAS pattern: read `updated_at` → write with
`expected_updated_at` → on conflict re-read and retry the WHOLE batch once, then drop
(verdicts are statistics; losing one batch is acceptable, corrupting the doc is not). A
doc with an unrecognized `schemaVersion` is treated read-only for the run (no write
attempted, logged once) rather than blindly overwritten or misread (Fix #8); a malformed
individual row (wrong types, `null`, an array) is dropped rather than corrupting
arithmetic downstream — except a MISSING `unverifiedPasses` (the newest field), which
sanitize-defaults to 0 so an otherwise-valid row isn't discarded.

**Truly fire-and-forget, dedicated client (Fix #2).** The call site never `await`s
recording (`void recordVerdictEvents(...).catch(() => {})`) — task completion must never
wait on Munin traffic, batched or not (worst case with a degraded Munin was previously
~12 minutes of sequential per-outcome CAS retries sitting between engine completion and
the task being reported done). The store also uses a DEDICATED `MuninClient` instance
in `src/index.ts` (mirroring the `leaseMunin`/`cancelWatchMunin` precedent), so verdict
traffic never queues behind — or is queued behind by — the main client's serial request
slot.

### V5 — Adaptive verify gate (selective, not global)

`HUGIN_ORCH_ADAPTIVE_VERIFY=on` (new, default off) makes the verifier pass selective per
subtask: consult confidence for `(worker model × subtask taskType)` — verify when the
derived recommendation is `explore`/`escalate-frontier` or `unknown`; skip (trust) when
`delegate-local`. `HUGIN_ORCH_VERIFY=on` retains its meaning: verify everything
(overrides adaptive). Confidence source: the Munin verdict store for cloud providers;
**the gateway ledger for `homeserver`-bound workers** (D5: local lane reads `/ledger`).
Escalation (re-running a failed subtask on a stronger tier) is OUT of this PR —
follow-up issue; the gate here decides verify-vs-trust only.

**Re-probe breaks the `delegate-local` absorbing state (Fix #1).** For verdict-store-
backed rows (non-`homeserver` workers), a `delegate-local` recommendation whose
`unverifiedPasses` streak has crossed `HUGIN_ORCH_REPROBE_UNVERIFIED` (default 10) is
downgraded to `explore` — forcing one more verify, whose VERIFIED event resets the
streak. The M5 `/ledger` path has no `unverifiedPasses` concept and isn't subject to
this gate.

**Fail direction — always toward verify, never toward silent skip (Fix #9).** When
adaptive verify is on but the applicable dependency (`verdictStore` or `ledgerClient`)
is missing, its load times out (bounded to `CONFIDENCE_SOURCE_TIMEOUT_MS`, 5s — Fix #3),
or it otherwise fails, the confidence function ALWAYS resolves to `null` for every
lookup — never `undefined` (which would have silently disabled the gate and defaulted to
skip-verification instead of verify-everything). `null` is read by the engine as "no
signal" → verify. Both provider branches (verdict-store and ledger) are consistent on
this point.

**Abort-safety (Fix #3).** The task-abort forwarding listener is wired up BEFORE the
confidence-source load's internal `await` (not after) — otherwise an operator/shutdown
abort that fires WHILE that load is in flight would be lost (the signal already flipped
to aborted before the listener existed to catch it), leaving the engine to keep running
on a stale, unaborted internal signal.

### V6 — Verified-fail outputs are excluded from synthesis

Today a `verdict.ok === false` output is synthesized anyway (verdicts have zero effect).
New: outcomes with an explicit failed verdict are excluded from the synthesizer input
and surfaced in `warnings[]`. If ALL outputs are excluded, fall back to including them
(with a warning) rather than synthesizing from nothing — degraded output beats none.

### V7 — Ledger client: cached, fail-open, row-validated

New `src/orchestrator/ledger-client.ts`: `GET {gatewayRoot}/ledger` with the same bearer
auth + sovereign-host validation as the provider path (reuses `resolveProviderBaseUrl`
minus the `/v1`, i.e. a sibling resolver on the gateway root). In-process positive cache
with TTL (`HUGIN_ORCH_LEDGER_TTL_MS`, default 10 min). Any failure → empty signal
(fail-open: the gate degrades to `unknown` → verify, never blocks execution).

**Row validation + negative cache (Fix #5).** Each row in the response is validated
(non-null object, string `modelId`/`taskType`, `recommendation` ∈ `{delegate-local,
escalate-frontier, explore}`) and invalid rows are DROPPED rather than trusted — the
original shape check only verified `report` was an array, so e.g. `{"report":[null]}`
passed and was cached for the full 10-minute positive TTL, then dereferenced downstream.
A non-2xx response or thrown fetch is negative-cached for a separate, much shorter 60s
window so a down gateway doesn't add a request-timeout stall (10s) to every task while
it's unreachable; on a non-2xx response the body is drained (`res.text().catch(() =>
{})`) before negative-caching, to release the keep-alive socket.

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
(deps bag gains optional `verdictStore` + `ledgerClient`) and `src/index.ts`, which
constructs the store with its OWN dedicated `MuninClient` instance (Fix #2 — not the
main `munin` client used for task-completion writes, mirroring the
`leaseMunin`/`cancelWatchMunin` precedent) and hydrates nothing at boot — the store
reads the doc lazily per run, one read + one write (batched, Fix #2) per task.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `HUGIN_ORCH_ADAPTIVE_VERIFY` | `off` | Selective verification driven by confidence (V5). |
| `HUGIN_ORCH_VERDICT_STORE` | `on` | Record per-worker verdict events to `tasks/_verdicts` (V4). `off` = no reads/writes. |
| `HUGIN_ORCH_LEDGER_TTL_MS` | `600000` | Gateway ledger positive-cache TTL (V7). A separate, shorter negative-cache TTL (60s, not env-configurable) applies to fetch/HTTP failures (Fix #5) so a down gateway doesn't add a request-timeout stall to every task. |
| `HUGIN_ORCH_REPROBE_UNVERIFIED` | `10` | Re-probe threshold (V5, Fix #1): a `delegate-local` row whose `unverifiedPasses` streak reaches this count is downgraded to `explore` for one more verify. Verdict-store-backed (non-`homeserver`) workers only. |

## Non-goals (this PR)

- Escalation/re-run of low-confidence or failed subtasks (follow-up issue).
- Wiring the broker (orch-v1) rating events into this store (its `delegation_rated`
  events lack model/task-type at the event level; joining via the projection is a
  follow-up).
- Router (`Runtime: auto`) confidence ranking — the router serves the legacy dispatcher,
  not orchestrator roles.
- Single-KB convergence with the gateway ledger (D5's "later").
