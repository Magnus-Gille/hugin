# Design: Autonomous dependency-bump PRs from security-scan results (#26)

**Status:** Design / plan (not yet implemented)
**Issue:** [#26](https://github.com/Magnus-Gille/hugin/issues/26)
**Phase:** 2 — self-maintaining Grimnir

## Goal

When the weekly Grimnir security scan (`grimnir-security-scan.timer`) finds **fixable**
`npm audit` vulnerabilities in a repo, Hugin should open a PR with the fix automatically.
Never auto-merge — always leave for human review.

## Existing substrate

- `grimnir-security-scan.timer` already runs `npm audit` across all Grimnir repos and writes
  results to Munin under `security/repos/<repo>`.
- Hugin already runs tasks per-repo, has branch-per-task git flow (`checkoutTaskBranch` /
  `finalizeTaskBranch` in `src/task-helpers.ts`, issue #47) that creates a branch, commits,
  pushes, and opens a PR via the configured bot.
- Result delivery + structured results + reply routing already exist.

So #26 is mostly **orchestration glue**: read scan results → for each repo with fixable
findings, synthesize a task whose prompt is "run `npm audit fix`, verify, summarize", and let
the existing branch-per-task flow open the PR.

## Recommended answers to the issue's open questions

| Question | Recommendation | Rationale |
|----------|---------------|-----------|
| **Scope: patch / minor / major?** | Auto-fix **patch + minor** (i.e. plain `npm audit fix`, no `--force`). **Major** bumps (`--force`) are **flagged**, never auto-applied — they go into the PR body as "manual review needed", not the diff. | `npm audit fix` without `--force` is semver-safe by definition; `--force` pulls breaking majors and is exactly what needs a human. |
| **Test gate** | Hard gate: the task runs the repo's `npm test` (and `npm run build` if present) AFTER `npm audit fix`. **If tests fail, do not open a PR** — write a `failed` result describing the regression so a human sees it. Repos with **no** test script: open the PR but label it `needs-manual-verification` and say so in the body. | A green PR a human can trust; a red one is noise. |
| **Push access** | Pre-flight: verify the bot principal has push access to each target repo before attempting; skip + warn on repos it can't push to. Verified once at task build time via `gh repo view --json viewerPermission`. | Avoids half-done tasks that fail at push. |
| **Rate limiting** | **One PR per repo per scan.** Batch all fixable advisories for a repo into a single `npm audit fix` + single PR. Skip a repo if it already has an open Hugin-authored dep-bump PR (idempotency by branch name `chore/audit-fix-<scan-date>`). | Prevents PR spam; one reviewable unit per repo. |
| **Trigger** | **Scheduled**, chained after the weekly scan completes (a follow-on step in the scan timer, or a Hugin task-group submitted by the scan). Also expose an **on-demand** entry point (a Hugin task `type:dep-bump`) for manual kicks. | Matches the "after weekly scan" cadence; on-demand helps testing. |

## Proposed mechanism

1. **Trigger** (after weekly scan): a small driver (cron step, or a `type:dep-bump` Hugin task
   group) reads `security/repos/*` from Munin.
2. **Per-repo gate:** for each repo with `fixable > 0` advisories and push access and no
   existing open audit-fix PR, submit one Hugin task:
   - `Context: repo:<name>`, `type:dep-bump`, autonomous authority, `Sensitivity: internal`.
   - Prompt: run `npm audit fix` (no `--force`), then `npm run build` (if present) and
     `npm test` (if present); summarize what changed (packages, versions, advisories closed)
     and list any remaining advisories that need `--force`/major bumps.
3. **PR via existing flow:** the branch-per-task flow (#47) commits the lockfile/package.json
   changes on `chore/audit-fix-<date>`, pushes, opens a PR with the synthesized body. **Never
   auto-merge** (Hugin already never merges).
4. **Test-failure handling:** if build/test fails, the task finalizes `failed`, no PR; the
   structured result records the regression. A human triages.

## New surface in Hugin

- A `type:dep-bump` task convention (carried through the lifecycle via the existing `type:*`
  tag plumbing).
- A driver script `scripts/submit-dep-bumps.sh` (mirrors `scripts/submit-stale-status-review.sh`)
  that queries Munin scan results and submits one task per eligible repo. Idempotent: skips
  repos with an open `chore/audit-fix-*` PR.
- PR body template: advisories closed, packages bumped (old→new), test/build status, and a
  "remaining (needs major bump)" section for `--force`-only fixes.

## Security considerations

- The task runs `npm audit fix` + tests inside the repo working dir — standard task sandbox.
  No new egress beyond the npm registry the build already uses.
- `--force` is **never** run autonomously (breaking-change blast radius).
- Bot push access is verified pre-flight; the bot must not have merge rights used automatically.
- Lockfile integrity: the PR diff is the audit; a human reviews before merge.

## Rough effort

- Driver script + `type:dep-bump` convention + PR body template: ~0.5 day.
- Wiring the post-scan trigger (in grimnir-security-scan) + idempotency check: ~0.5 day.
- Tests (eligibility filter, idempotency, no-test-repo path): ~0.5 day.

## Out of scope (follow-ups)

- Auto-bumping non-`npm` ecosystems.
- Auto-merge on green (explicitly excluded — human-in-the-loop is the point).
- Grouping/deduping advisories across repos into a single dashboard PR.
