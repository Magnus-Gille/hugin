# orch-v1-impl-review — Debate Summary

**Date:** 2026-04-26
**Participants:** Claude (Opus 4.7), Codex (gpt-5.4 @ xhigh)
**Rounds:** 2
**Topic type:** Architecture (primary) + Protocol (secondary)
**Under review:** Step 1-3 of orchestrator v1 — `docs/orchestrator-v1-data-model.md`, `src/runtime-registry.ts`, `src/router.ts`, `src/task-result-schema.ts`, `src/finalize-delegated-output.ts`.

## Bottom line

The chosen seams (alias indirection, `autoEligible: false` as explicit-only firewall, single shared finalizer, append-only JSONL journal) are correct. **The contract surface is not yet locked enough for Step 4 (Pi-side broker) to start.** Two contract-level bugs and a missing durability model must close first.

## Concessions accepted (Claude → Codex)

- **C02 (critical, changed):** Scanner contract is internally inconsistent. `DelegationError.kind` includes `scanner_blocked` ("redact mode triggered"), but `finalizeDelegatedOutput` returns `scanner_pass: "redact"` as a successful result. For diffs this is worse than aesthetic — a redacted unified diff is no longer a valid patch. **Fix:** text-mode redact stays on the success branch; diff-mode (and future executable-artifact result kinds) escalates to `scanner_blocked` failure.
- **C04 (major, changed):** Worktree defaults bake in Pi disk model and Node-repo assumption with no baseline. **Fix:** flip `copy_node_modules` default to `false`; replace "short enough to not fill the Pi disk" with a measured budget (cap + admission-control semantics).
- **C05 (major, changed):** Protocol versioning is too thin. **Fix:** add `envelope_version: 1` on `DelegationRequest`, `result_schema_version: 1` on `DelegationResult`, and define idempotency-key reuse semantics (same key for the same logical task; new key = new task).
- **C01 (major, partially_changed):** Step 2 widened `DispatcherRuntime` for orchestrator-only runtimes the dispatcher cannot yet parse or execute. **Partial fix:** add `runtime_row_id?: string` to `DelegationResult` for posterior attribution. **Acknowledged-but-deferred:** the deeper rework (split `LegacyDispatcherRuntime`, carry runtime-row identity through submit/execute/complete, move sensitivity lookup to registry-row scope) is a Step 4 prerequisite, not a Step 3 fix.
- **C03 (critical, partially_changed):** Partial-failure ordering is unspecified. The proposed §12 invariants (Munin first, journal append after) are a sketch but rely on a Munin atomic-CAS primitive that does not exist (status and result are separate keys — see C12) and import the wrong lesson from #57 (see C07). **Acknowledged-but-deferred:** the right shape is a source-of-truth contract, not an ordering list.

## Defenses Codex accepted

- Centralizing finalization in a single `finalizeDelegatedOutput` is the right seam. The objection was "one finalizer with contradictory semantics," not "multiple finalizers."
- `autoEligible: false` as the explicit-only firewall is a hard contract, not a soft preference. The router test suite locks this in.
- Keeping `model_effective` + `runtime_effective` + `host_effective` alongside any new row identifier is correct; replacing them would make operator queries harder.
- Option B (pi-harness in v1) was not contested. The eval data (5/6 strict, 6/6 lenient) supports it.

## Unresolved disagreements

None substantive. Codex's Round 2 evasion-flags (C06, C07, C12) all converged with Claude's "acknowledged-but-deferred" position: the underlying issues are real, the proposed remedies are necessary but insufficient, and the deeper rework belongs in Step 4 prep rather than retroactive Step 3 patches.

## New issues from Round 2

- **C06:** `runtime_row_id?: string` is necessary but not sufficient — the control-plane problems happen earlier (schema accepts runtimes the dispatcher rejects; sensitivity keys by coarse runtime).
- **C07:** Status-first ordering fits #57's bug but does not fit orchestrator `await`, where the structured result *is* the payload.
- **C09:** Proposed `submitted_not_indexed` await branch leaks an internal indexing gap into the public contract.
- **C12:** Munin CAS is per-key; "atomic structured-result + status flip" is not a real operation on this substrate.

## Final verdict

**Codex (Round 2):** "Define the authoritative delegated-task durability model — which persisted record makes a delegated submission real, which persisted record makes a delegated completion real, how `await` resolves from that record after crash/restart, and how stable runtime-row identity is threaded through submit → execute → complete. Until that is locked, Step 4 will hard-code the most expensive class of bug first: a control plane that can say 'completed' without a durable result, or 'known task' without a durable identity."

**Claude (post-Round-2):** Agreed. Step 4 (Pi-side broker) requires a Step 3.5 deliverable: a durability + runtime-row-identity addendum to `docs/orchestrator-v1-data-model.md`. Until that lands, broker code would hard-code the wrong shape.

## Action items (in priority order)

1. **Resolve C02 (scanner contract).** Update spec §4 to make redact-on-diff escalate to `scanner_blocked`; update test at `tests/finalize-delegated-output.test.ts:138-168` to expect failure rather than success on redacted diff. Owner: Claude (next session).
2. **Write Step 3.5: durability + runtime-row-identity addendum.** Define source-of-truth records for submit and complete, what `await` reads, what can be backfilled, how idempotency-after-crash recovers. Carry stable `runtime_row_id` (required, not optional) through `BrokerAnnotations.alias_resolved`. Move sensitivity policy from `DispatcherRuntime` to registry-row scope. Owner: Claude (next session).
3. **Apply C04 (worktree defaults).** Flip `copy_node_modules` to default `false`. Add admission-control semantics for the worktree disk cap. Owner: Claude (next session).
4. **Apply C05 (versioning).** Add `envelope_version`, `result_schema_version`, journal event `event_schema_version`. Define idempotency-key reuse semantics. Owner: Claude (next session).
5. **C01 deeper rework (LegacyDispatcherRuntime split).** Schedule for the start of Step 4 — broker code should be the first consumer of the corrected boundary. Owner: Claude (Step 4 entry).
6. **Defer:** the journal projection benchmark, scanner runtime baseline on large diffs, and concurrent-broker single-writer enforcement remain open but do not block Step 4.

## Files

- `debate/orch-v1-impl-review-claude-draft.md` — Claude's position (pre-debate)
- `debate/orch-v1-impl-review-claude-self-review.md` — self-review with debate type
- `debate/orch-v1-impl-review-codex-critique.md` — Codex Round 1
- `debate/orch-v1-impl-review-claude-response-1.md` — Claude Round 1 response
- `debate/orch-v1-impl-review-codex-rebuttal-1.md` — Codex Round 2 rebuttal
- `debate/orch-v1-impl-review-critique-log.json` — structured critique log
- `debate/orch-v1-impl-review-snapshot/` — frozen artifacts under review
- `debate/orch-v1-impl-review-summary.md` — this file

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~2m             | gpt-5.4 @ xhigh |
| Codex R2   | ~2m             | gpt-5.4 @ xhigh |

## Notes on Munin context loading

In Round 1 all four Munin calls (`memory_read synthesis`, `memory_read status`, `memory_query decisions`, `memory_narrative`) returned `user cancelled MCP tool call`. In Round 2 `memory_orient` succeeded but the four item-level reads still failed the same way. Codex grounded both rounds in local state (STATUS.md, snapshot files, live src/) instead. This is a session-level Munin connectivity issue worth flagging for follow-up — not a debate finding.
