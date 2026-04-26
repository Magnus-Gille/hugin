# Debate Summary: Jarvis Architecture Guide

**Date:** 2026-03-15
**Participants:** Claude (Opus 4.6) vs Codex (GPT-5.4)
**Rounds:** 2
**Artifact:** `docs/architecture.md` (commit 18791cf, 513 lines)

## Key Outcome

The architecture guide is a strong **overview/onboarding document** but does not yet meet the bar of a trustworthy **internal reference**. The most important finding is that verifiable claims in the Hugin section contain factual inaccuracies, which undermines confidence in sections that can't be checked from this repo.

## Concessions Accepted by Both Sides

1. **Topology diagram is wrong** — task-submission arrow points at Hugin, but clients submit to Munin
2. **Stale-recovery description doesn't match code** — guide says "time in running state," code measures time since submission
3. **Deployment description is inaccurate** — guide says .env is deployed and only built artifacts synced; script does the opposite
4. **"Two-service" vs "three services" inconsistency**
5. **Missing source-of-truth pointers** — Munin/Mimir sections need to state they're summaries, not authoritative
6. **Claude's 8/10 rating was too generous** for the "internal reference" rubric

## Defenses Accepted by Codex

1. **The guide has real onboarding value** — topology, lifecycle, and workflow sections are useful (just not sufficient as reference)
2. **Operational procedures could live in a separate runbook** — but architecture guide still needs to be factually correct and explain rationale

## Unresolved Disagreements

1. **Branding language** — Claude sees mnemonic value; Codex sees it as spending trust budget before earning it. Minor disagreement.
2. **Scope of "simplest thing that works" as rationale** — Codex wants explicit limitation/trigger statements; Claude thinks stating it explicitly is sufficient. Codex's position is stronger.

## New Issues from Round 2

1. Stale-recovery fix should resolve code vs design intent, not just update prose
2. Action items should prioritize a trustworthiness pass over a polish pass

## Final Verdict

**Codex's position:** The single most important next step is a **trustworthiness pass** — verify every implementation-backed claim against code, and label Munin/Mimir material as summary-level with source-of-truth pointers.

**Claude's position (revised):** Agrees. The guide needs factual corrections first, rationale additions second, and operational detail third.

## Action Items

| Priority | Action | Owner |
|----------|--------|-------|
| P0 | Fix topology diagram task-submission arrow | Magnus |
| P0 | Fix stale-recovery description AND decide if code or design is correct | Magnus |
| P0 | Fix deployment section to match deploy-pi.sh | Magnus |
| P1 | Add source-of-truth pointers for Munin/Mimir sections | Magnus |
| P1 | Add rationale for: markdown task format, polling-as-queue, tags-as-state-machine, CLI spawning | Magnus |
| P1 | Fix "two-service" → "three services" | Magnus |
| P2 | Soften "three src/index.ts" claim | Magnus |
| P2 | Add rationale for: one-at-a-time, 4000-char limit | Magnus |
| P3 | Consider separate runbook for operational procedures | Magnus |

## Critique Statistics

- **Total critique points:** 15
- **Valid:** 13 | **Partially valid:** 1 | **Invalid:** 0
- **Caught by self-review:** 2/15 (13%)
- **Critical severity:** 2 | **Major:** 9 | **Minor:** 4

## Debate Files

- `arch-guide-claude-draft.md` — Claude's initial assessment
- `arch-guide-claude-self-review.md` — Claude's self-critique
- `arch-guide-codex-critique.md` — Codex Round 1 critique
- `arch-guide-claude-response-1.md` — Claude's response
- `arch-guide-codex-rebuttal-1.md` — Codex Round 2 rebuttal
- `arch-guide-critique-log.json` — Structured critique log
- `arch-guide-summary.md` — This file

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~3m             | gpt-5.4       |
| Codex R2   | ~2m             | gpt-5.4       |
