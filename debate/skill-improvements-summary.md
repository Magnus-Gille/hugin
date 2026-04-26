# Debate Summary: /debate-codex Skill Improvements

**Date:** 2026-04-01
**Participants:** Claude (Opus 4.6) vs Codex (GPT-5.4)
**Rounds:** 2
**Debate type:** Docs/process

## Key Outcome

The debate dramatically narrowed the scope of proposed changes. Claude entered with 5 "adopt" proposals centered on a tier system; exited with 2 narrow "adopt" proposals and everything else deferred or dropped.

## Concessions accepted by Claude

1. **Tiers are not justified yet.** Only 2 debates on record, both completed quickly. The existing skill already has scope control (when to/not to debate) and variable depth (Step 7). Tiers solve a hypothetical problem.
2. **Quick tier is self-defeating.** Removing self-review and critique logs breaks the artifact model (Step 10/11) and fragments the dataset needed for historical learning.
3. **Phasing was backwards.** Starting with the most invasive, least validated change is wrong. Narrow, evidence-producing fixes first.
4. **Rejecting role inversion was overconfident.** Should be "defer and test," not "reject."
5. **SKILL.md size concern is about branching factor, not line count.** A linear 400-line skill is safer than a 320-line skill with three conditional modes.

## Defenses accepted by Codex

1. **Type-specific prompts address a real gap.** Step 3 has a literal placeholder for debate-specific questions. The type classification in Step 2 is already done but not used.
2. **Severity calibration addresses a real inconsistency.** The critique log records severity with no definition. Periodic synthesis depends on it.
3. **"Additive, not substitutive" resolves the type-anchoring risk.** Type-specific prompts should add domain attack vectors on top of universal framing, not replace it.
4. **The circularity argument is valid for narrow fixes.** Improving data collection (severity definitions, better prompts) is a prerequisite for gathering useful data, not something that requires data first.

## Unresolved issues from Round 2

1. **Step 6 symmetry:** If Round 1 becomes type-aware, Round 2 should too — otherwise domain-specific probing drops off in rebuttals.
2. **Severity semantic target:** Does severity measure the flaw itself, the consequence of ignoring it, or the reversibility? Needs definition before implementation.
3. **Mixed-type composition rule:** How to combine prompts for architecture+security debates. "Additive" is direction, not a rule.
4. **Prompt/checklist drift:** Type-specific prompts and checklists are two things to keep in sync. Need a source-of-truth strategy.

## Final agreed position

| Proposal | Status | Rationale |
|----------|--------|-----------|
| Type-specific Codex prompts (#2) | **Adopt first** | Real gap; additive to universal frame; apply to both Step 3 and Step 6 |
| Calibrated severity (#5) | **Adopt first** | Real inconsistency; prerequisite for useful synthesis data |
| Debate tiers (#7) | **Defer** | No evidence of heaviness problem; adds branching complexity |
| Steelman (#3) | **Defer** | Potentially useful but test experimentally |
| Dynamic rounds (#1) | **Defer** | Clarify Step 7 prose instead; no evidence current rule is failing |
| Role inversion (#4) | **Defer and test** | Interesting but untested; experiment in select debates |
| Pre-debate triage (#6) | **Defer** | Subsumed by better defaults |
| Historical learning (#8) | **Defer** | Need 15-20 debates with improved format first |

## Action items

1. **Patch SKILL.md Step 3 and Step 6:** Make debate-type classification shape the Codex prompt in both rounds, additively. Resolve the composition question for mixed-type debates.
2. **Define severity in Step 8:** Specify what severity measures (propose: consequence of ignoring the critique point, anchored to blast radius + reversibility of the underlying decision).
3. **Run 5-10 more debates** on the tightened baseline before reconsidering structural changes.
4. **Experiment with steelman and role inversion** in 2-3 select debates to gather evidence.

## Debate files

- `debate/skill-improvements-snapshot.md`
- `debate/skill-improvements-claude-draft.md`
- `debate/skill-improvements-claude-self-review.md`
- `debate/skill-improvements-codex-critique.md`
- `debate/skill-improvements-claude-response-1.md`
- `debate/skill-improvements-codex-rebuttal-1.md`
- `debate/skill-improvements-critique-log.json`
- `debate/skill-improvements-summary.md`

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~3m             | gpt-5.4       |
| Codex R2   | ~4m             | gpt-5.4       |
