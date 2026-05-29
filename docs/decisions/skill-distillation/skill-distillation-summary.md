# Debate Summary — Eval-Gated Skill Distillation as a Hugin Sub-Capability

**Date:** 2026-05-29
**Participants:** Claude (Opus 4.8) vs. Reviewer: codex / gpt-5.5 (xhigh effort)
**Rounds:** 2
**Premise (fixed):** the capability *will* be built; debate was about *how*, not *whether*.

## Outcome in one line

The draft's primitive was wrong. Build it as a **versioned `RouteBinding` system with a
load-bearing task classifier**, not an "eval-gated skill promotion" flag — and gate real-task
routing on Hugin #77 (crash-recovery liveness).

## Concessions accepted by both sides

1. **Primitive = `RouteBinding`, not a boolean flag.** `(taskClass, skillPackageProfile, cellManifest, evalSuite) → policy + calibrated metrics`, lifecycle `draft → candidate → shadow → active → stale → quarantined → disabled`. A boolean discards the partial-pass/latency texture the prior local-eval work proved is decisive.
2. **Skill artifact = runtime-neutral procedure package → compiled `pi-local-30b` profile.** Not a raw `~/.claude/skills/` `SKILL.md` (confirmed by prior `decisions/skills-in-munin` verdict). The 30B profile is stricter: bounded I/O schema, tool allowlist, one-step checkpoints, examples + anti-examples, abort conditions.
3. **Anti-Goodhart eval structure.** Split positive / negative / retrieval / mutation fixtures; ≥1 *independent* oracle per route; LLM-judge advisory only; record the *stage* a failure was caught at.
4. **Procedural retrieval schema inside Munin + fail-closed contract.** Below threshold → cloud/approval; top-two too close → abstain; Munin down → no local; stale/quarantined binding → not selectable.
5. **Immutable, content-addressed validation run records** + small mutable "active binding" pointer. Demotion fail-closes on any hash drift.
6. **Escalation as a state transition:** worktree-isolated execution, output as patch/artifact, preflight gates, step budgets + early-abort detectors, fallback consumes the original snapshot — never a dirty workspace.
7. **Policy-aware fallback** respecting Hugin's `provider/egress/zdrRequired/autoEligible`, decided pre-execution.

## Defenses accepted by the reviewer

- **D1 (partial):** cost/latency-vs-cloud is *not* the slice-one gate (correctness/fail-closed/recovery/fallback are) — accepted. Claude's "strategic gate" reframed by Codex into two distinct gates: **policy-required** (categorical, local can be worth it even if slower) vs. **cheaper-after-maintenance** (economic). Adopted.
- **D2 (partial):** a shared single-heavy-job semaphore is the right *first* capacity control — accepted, with the caveat that the semaphore must carry a policy (priority, leases, timeouts, reaper), since #77 already proves "one worker" is insufficient.
- **PC1 (partial):** #77 does not block *offline* package/eval/profile authoring — accepted. But "shadow" must be split: offline-fixture shadow is safe; **Hugin-integrated shadow inherits #77** and cannot count as readiness evidence until #77 is fixed.

## New issue from Round 2

- **Task classification is now load-bearing and was unnamed by both sides.** Moving the route key to start with `taskClass` means *deciding an incoming task's class* becomes part of routing, policy, safety, and cost. A bad classifier can bypass ZDR/egress policy, pick the wrong procedure, fail to abstain, or inflate shadow metrics. Requires a first-class versioned `TaskClassifier`/route-predicate artifact with hard negatives, thresholds, top-two margins, recorded abstentions, and "should / should-not classify" eval cases. **Without it, the system looks rigorously versioned while its most important selection step stays opaque — worse than the original flag.**

## Unresolved / preference-level

- Exact grading modality per skill class (deterministic vs. LLM-judge mix) — deferred to per-skill design (U1).
- Whether slice-one skill should be coding (test-graded) or non-coding — leaning coding for a deterministic grader; not contested.

## Final verdict

- **Claude:** primitive corrected to `RouteBinding`; #77 gates `active` and any Hugin-integrated shadow evidence, but not offline authoring; task classifier added as a first-class artifact.
- **Codex:** *the single most important next step is to fix Hugin #77 and prove it with a kill-during-local-execution acceptance test wired through the same task lifecycle the skill lane will use.* Offline package/eval/profile authoring may proceed in parallel, but runtime liveness (stable worker identity, lease-expiry reconciliation, startup recovery, terminal-state correctness, idempotent delivery) is the gating build step for any honest end-to-end claim.

## Action items

| # | Action | Owner |
|---|--------|-------|
| A1 | Land Hugin #77 (crash-recovery liveness) + kill-during-local-execution acceptance test | Hugin |
| A2 | Design `RouteBinding` data model (full matrix as schema; consume one row end-to-end) | Hugin |
| A3 | Define runtime-neutral procedure-package format + `pi-local-30b` profile compiler | skills |
| A4 | Add procedural-retrieval schema + fail-closed abstention contract to Munin | Munin |
| A5 | Spec first-class `TaskClassifier` artifact (predicate, hard negatives, thresholds, abstention log) | Hugin |
| A6 | Eval suite format: positive/negative/retrieval/mutation fixtures + independent oracle + failure-stage recording | skills |
| A7 | Slice-one: one procedure, one cell manifest, fixture repo, offline shadow → (post-#77) Hugin-integrated active | Hugin |

## Debate files

- `skill-distillation-claude-draft.md`
- `skill-distillation-claude-self-review.md`
- `skill-distillation-codex-critique.md`
- `skill-distillation-claude-response-1.md`
- `skill-distillation-codex-rebuttal-1.md`
- `skill-distillation-critique-log.json`
- `skill-distillation-summary.md`

## Costs

| Invocation   | Wall-clock time | Model    |
|--------------|-----------------|----------|
| codex R1     | ~5 min          | gpt-5.5  |
| codex R2     | ~5 min          | gpt-5.5  |
