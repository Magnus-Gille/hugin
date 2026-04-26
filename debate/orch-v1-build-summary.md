# Orchestrator Stack v1 — How To Build It (Debate Summary)

**Date:** 2026-04-25
**Topic:** HOW to build the Hugin orchestrator stack v1 (IF settled — Magnus is building this)
**Participants:** Claude (proposer), Codex gpt-5.4 xhigh (adversarial reviewer)
**Rounds:** 2

---

## Starting Position

Six-step build, ~1,000 LOC, ~2 days: (1) MCP skeleton (`hugin-mcp` with 5 tools `submit/await/run/rate/list`), (2) OpenRouter executor in Hugin reusing `semi-trusted` tier, (3) separate orchestrator journal at `~/.hugin/orchestrator-journal.jsonl`, (4) wire MCP→Hugin, (5) `delegate` skill at `~/.claude/skills/delegate/`, (6) dogfood. ZDR enforcement at MCP startup. Hard fail on errors, no auto-Claude-fallback.

---

## Concessions Accepted by Claude

| Finding | Substance |
|---|---|
| **F1 — `hugin_run` not credible** | Submit+await over a 30s poll + single-task dispatcher cannot deliver real sync. **Drop `run` from v1.** Defer until/unless a separate inline-execution path is built post-dogfood. |
| **F2 — Journal ownership** | Laptop MCP cannot own a Pi-side journal; `parent_session_id` and `task_type` had no carrier. **Hugin is sole writer.** MCP carries `orchestrator_session_id` + `task_type` as task metadata; `rate` and `list` become Hugin endpoints. |
| **F3 — OR trust primitive** | Reusing `semi-trusted` collapses Anthropic-subscription and third-party-relay into one bucket. **Add orthogonal fields:** `provider`, `egress`, `zdrRequired`, `autoEligible`. Keeps trust binary; OR is explicit-only. |
| **F4 — ZDR enforcement host** | MCP-side enforcement leaks if other submitters bypass it. **Hugin owns enforcement** with a pinned dogfood allowlist + cached catalog metadata + per-task fail-closed rejection. |
| **F5 — Output finalization bypass** | Existing exfil scanner runs in dispatcher completion; raw provider output via MCP would regress. **Single shared `finalizeDelegatedOutput()` helper** used by every output-return surface. MCP returns scanned structured results, never raw bytes. |
| **F6 — MCP auth/secrets (partial)** | Conceded direction (Pi-side broker over laptop signing keys). Detailed design still owed. |
| **F7 — `await` semantics (partial)** | Conceded resumability and idempotent state response. Stale/orphan distinction owed. |
| **F8 — Model/skill drift (partial)** | Conceded stable aliases (`local-small`, `studio-proxy-coder`, etc.) over literal model names. Alias governance still owed. |
| **F9 — Telemetry overlap (partial)** | Conceded overlay over shadow journal. Append-only-vs-mutation problem still owed. |

---

## Defenses Accepted by Codex

- **MCP boundary shape (no `run`).** Codex agreed the thin-MCP approach centralizing Munin/signing/await mechanics is the right abstraction once `run` is dropped.
- **Skill-not-router orchestration.** The static filter/rank router is correctly distinct from a semantic planner; orchestration logic belongs in a skill.
- **Hard-fail over auto-fallback.** Preserves the failure signal that's load-bearing for the learning loop.
- **Verification-required protocol.** Skill rule that Claude must verify delegated output before reuse stands.
- **Finalization centralization (F5 fix).** Codex marked this "adequately fixed in principle" once routed through a single helper.

---

## Unresolved (deferred to implementation)

### 1. Append-only journal vs post-hoc rating updates
**Status:** Acknowledged, design owed. Need either an event-log + projection model or a different store. The current proposal mutates JSONL by `task_id`, which the existing `appendFileSync` primitive doesn't support. Decision before code: separate rating-event JSONL with projection at read time, or move journal to SQLite/Munin entries.

### 2. Broker endpoint exposure
**Status:** Acknowledged, design owed. Hugin currently binds `127.0.0.1` and serves `/health` only. Broker requires network reachability (Tailscale-only acceptable), bearer-token auth, idempotency keys, rate limiting, and explicit caller-identity preservation (`broker_principal` + `orchestrator_submitter` distinct).

### 3. Lease reaper + reboot UX
**Status:** Acknowledged. `workerId` is PID-based; reboot leaves tasks tagged `running` for up to ~3 minutes (60s reaper sweep + 120s lease). `await` must surface `lease_expires_at`, `claimed_by`, `last_status_at`, and `orphan_suspected` — not just `running`.

### 4. Alias governance
**Status:** Acknowledged. Manual promotion only; never silent retargeting. Journal must record `model_alias_requested`, `model_effective`, and `alias_map_version` so corpus regime changes are detectable.

### 5. Self-rating bias mitigation
**Status:** Pair `verification_outcome` with weekly Magnus spot-audit + objective behavioral traces (retries, discards, escalations). Self-report alone is not enough.

---

## Final Verdict (Codex)

> The single most important thing to get right before any code is written is **the Pi-side delegation contract as an authority boundary**: the request envelope, the append-only journal event model, the result/await state machine, and the provenance chain from broker principal to task record to rating.
>
> If that contract is right, broker-vs-signing, OpenRouter, aliases, and the skill are all reversible implementation details. If that contract is wrong, you will hard-code the most expensive failures first: ambiguous identity, misleading `await` semantics, silent alias regime shifts, and a journal model that cannot represent rating updates cleanly.

---

## Revised Build Order (post-debate)

Codex's reorder, accepted:

1. **Delegation data model first (no code, just types/schema):**
   - Request envelope: `orchestrator_session_id`, `task_type`, alias/model/runtime/host/sensitivity, idempotency key, provenance fields
   - Result/state machine including `running / completed / failed / stale / unknown` with `orphan_suspected` flag
   - Journal event model: submission event, completion event, rating event, alias-map version, policy version (decide: append-only events with read-time projection vs mutable store)
2. **Runtime registry extension:** alias resolution + `provider/egress/zdrRequired/autoEligible` fields + reasoning-level pinning for gpt-oss.
3. **Shared `finalizeDelegatedOutput()` helper** + provenance tags on structured results.
4. **Broker endpoint** (`POST /orchestrator/submit`, `/await`, `/rate`, `/list`, `/models`) with bearer auth, idempotency, Tailscale-only exposure, audit fields.
5. **OpenRouter executor** behind the contracts with pinned ZDR allowlist + cached catalog metadata.
6. **MCP server** (`submit/await/rate/list/models`) talking only to broker.
7. **Delegate skill** at `~/.claude/skills/delegate/` against stable aliases.
8. **Dogfood + weekly spot-audit.**

---

## Action Items

| # | Item | Owner | Blocks |
|---|---|---|---|
| 1 | Decide journal storage model (append-only events + projection, vs SQLite, vs Munin entries) | Magnus | All journal-write code |
| 2 | Decide broker exposure model (Tailscale-only? localhost + SSH tunnel? mTLS?) | Magnus | Broker skeleton |
| 3 | Write delegation data model spec (envelope, state machine, event types) as `docs/orchestrator-v1-data-model.md` | Claude | All other steps |
| 4 | Curate initial alias map: `local-small=qwen2.5:3b`, `local-medium=qwen3.5:35b-a3b`, `studio-proxy-large=gpt-oss-120b@medium`, `studio-proxy-coder=qwen3-coder` | Magnus | Skill |
| 5 | Update STATUS.md to reflect build decision (supersede "evaluation gate" framing) | Claude | None (paperwork) |
| 6 | Multi-host sprint stays parallel priority (not blocked by orchestrator) | Magnus | — |

---

## Estimate (revised)

| Piece | LOC | Wall-clock |
|---|---|---|
| Data-model spec doc | 0 | half-day |
| Hugin contracts (envelope, state machine, event journal, registry extension, finalize helper, alias resolver) | ~700 | 1.5 days |
| Broker endpoint + auth | ~250 | half-day |
| OpenRouter executor + ZDR allowlist | ~300 | half-day |
| MCP server (5 tools) | ~400 | half-day |
| Delegate skill | ~300 markdown | half-day |
| Tests | ~400 | 1 day |
| **Total** | **~2,000 LOC + 300 markdown** | **~5 focused days** |

Up from the original 1k LOC / 2 days. Codex's 1.8–2.6k / 4–6 day estimate was correct.

---

## Files

- `debate/orch-v1-build-snapshot.md`
- `debate/orch-v1-build-claude-draft.md`
- `debate/orch-v1-build-claude-self-review.md`
- `debate/orch-v1-build-codex-critique.md`
- `debate/orch-v1-build-claude-response-1.md`
- `debate/orch-v1-build-codex-rebuttal-1.md`
- `debate/orch-v1-build-summary.md`
- `debate/orch-v1-build-critique-log.json`

---

## Costs

| Invocation | Wall-clock time | Model version |
|---|---|---|
| Codex R1 | ~7m | gpt-5.4 xhigh |
| Codex R2 | ~6m | gpt-5.4 xhigh |
