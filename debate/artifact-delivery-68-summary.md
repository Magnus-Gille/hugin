# Debate Summary: Runtime-owned artefact delivery (issue #68, mitigation #3)

- **Date:** 2026-05-18
- **Participants:** Claude (Opus 4.7), Codex (gpt-5.5, xhigh)
- **Rounds:** 2 (converged)
- **Debate type:** architecture (primary) / protocol (secondary)
- **Artifact under review:** an operator-private planning document (not committed)

## Problem

A `/research-spike` task completed `exitCode 0`, reported cost, wrote Munin
index entries — but the entire $2.86 deliverable (two markdown reports) existed
on no disk; the agent **fabricated** the rsync-success message. Root cause is
structural: artefact delivery is delegated to the LLM via prompt and Hugin's
only success gate is `exitCode === 0`, which merely reflects the SDK emitting a
clean `result` event. Hallucination → silent total data loss.

## Concessions accepted by both sides

- **Exit-code consistency (critical):** Ratatoskr decides success by parsing
  `**Exit code:** (\d+)` from the human markdown, *not* the status tag. The
  first revision's `exitCode: "DELIVERY_FAILED"` marker is **wrong** —
  non-numeric no-matches the regex and defaults to **success**. Final: positive
  integer `- **Exit code:** 2` + `- **Failure kind:** DELIVERY_FAILED`.
- **Durable nonterminal checkpoint:** write the agent content first under
  `running + delivery:pending` with an **active lease**, never terminal and
  never `pending`. Deliver, then write the final result *before* flipping
  status terminal so Ratatoskr reads the final result, not the checkpoint.
- **Keep lease renewal + cancellation watch alive through delivery** (currently
  stopped before the post-exec site); bounded, abortable delivery timeout.
- **`delivery:*` tags must be made persistent** across claim-renewal and
  terminal tag construction (both currently drop them).
- **Single CAS ownership model** shared by active path / startup recovery /
  lease reaper / shutdown to prevent duplicate rsync/rename.
- **Submit-time manifest validation** pre-spike (malformed JSON, placeholder
  leak, disallowed target) — reject at parse/claim, not post-spike.
- **Grammar:** `### Artifacts` must precede `### Prompt` (prompt extraction is
  to-EOF); test asserts the SDK prompt excludes the manifest.
- **sha256 + temp `.partial` + atomic `ssh mv`** with per-artefact idempotent
  state, replacing the weak `wc -c` size check.
- **`HUGIN_DELIVERY_POLICY`** off/warn/require, mirroring `HUGIN_EXFIL_POLICY`.
- **Explicit `appendLog` dependency** (SDK log stream is closed before the
  deliverer runs).
- **Tuple allowlist** (user/host/remote-prefix/local-prefix), argv with no
  shell interpolation, separate from the fetch egress allowlist.
- **Deploy preflight** in `deploy-pi.sh` — necessary but not sufficient.
- **Optional `artifactDelivery` schema field** under schemaVersion 1 — no
  version/enum churn; state also carried in tags + markdown.

## Defenses accepted by Codex

- **No full `DeliveryTarget` plugin abstraction now** — one transport, one
  consumer; a tuple allowlist is the right-sized control. Codex accepted this,
  with the condition that the allowlist be a tuple (not host-only).
- **`defer` auto-retry scoped to Phase 2** — `require` + the durable checkpoint
  already eliminates silent loss and paid-rerun cost (the #68 ask); a periodic
  retry loop adds a reentrancy/retry-budget surface better designed on its own.

## Unresolved disagreements

None of substance. Codex's Round 2 verdict: "Once those are specified and the
live plan is updated to match the concessions, the implementation is reasonable
to proceed." The plan file has been updated to match the pinned protocol.

## New issues from Round 2

- The non-numeric exit-code mis-render (C13) — a correctness bug *introduced* by
  the first revision, caught and fixed.
- Adjacent existing bug (C19): recovery/shutdown write `- **Exit code:** -1`,
  which Ratatoskr also mis-renders as success (minus sign fails `(\d+)`). Filed
  as a separate follow-up; the new path must use positive codes.

## Final verdict

Both sides agree: Hugin (not the LLM agent) must own and verify artefact
delivery. The architecture direction was right from Round 1; the value of the
debate was pinning the **lifecycle protocol** — nonterminal claimed checkpoint,
positive numeric terminal failure code, source-owned reconciliation with single
CAS ownership, and strict tuple allowlisting. The plan is now safe to implement.

## Action items

- [ ] Implement per the revised plan (`imperative-wondering-sedgewick.md`),
      deploy ordering mandatory: Hugin → Pi **before** SKILL.md update.
- [ ] File Phase 2 follow-up: `defer` policy with periodic retry reconciler +
      retry budget + budget-exhaustion terminalization.
- [ ] File adjacent bug: recovery/shutdown `Exit code: -1` mis-renders as
      success in Ratatoskr.

## Debate files

- `artifact-delivery-68-claude-draft.md`
- `artifact-delivery-68-claude-self-review.md`
- `artifact-delivery-68-codex-critique.md`
- `artifact-delivery-68-claude-response-1.md`
- `artifact-delivery-68-codex-rebuttal-1.md`
- `artifact-delivery-68-critique-log.json`
- `artifact-delivery-68-summary.md`

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~6m             | gpt-5.5       |
| Codex R2   | ~5m             | gpt-5.5       |
