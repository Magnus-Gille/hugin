# M5 task-solver dogfood finding — July 2026

Status: evidence note, not a production routing policy.

## Finding

M5/OpenCode is a promising lane for bounded coding tasks whose result can be
checked cheaply and mechanically. The current evidence does not justify sending
complex repair or review-convergence work to it autonomously.

This is deliberately narrower than “M5 can solve coding tasks.” The observed
unit is one attempt under one harness, prompt, repository state, model route,
and verifier—not an enduring property of the machine or model family.

## Observed runs

| Task | Lane | Result | Independent quality gate | Interpretation |
|---|---|---|---|---|
| Archived Heimdall panel read-back task | M5/OpenCode | Private-history PR, later superseded by the existing service-filtered API | 45 focused tests, 943 full Node tests, 29 Python tests, and lint passed | Positive evidence for bounded, well-specified, mechanically verifiable work; not a patch to port onto the public history |
| Munin #170 repair, attempt 1 | M5/OpenCode | Exit 0 after operating in the wrong path; no repository change | Rejected | Harness completion is not semantic completion |
| Munin #170 repair, attempt 2 | M5/OpenCode | Unsafe partial result after about 19 minutes | Rejected | Negative evidence for complex transactional repair/review convergence |
| Munin #170 continuation | cloud Claude | PR [#206](https://github.com/Magnus-Gille/munin-memory/pull/206) | Implementation worked under an added adversarial test, but the submitted PR still lacked required regression coverage and needed cleanup | Even cloud completion requires an independent quality gate |
| Cassette #3 | Codex under Hugin | No commands could run because the service sandbox blocked `AF_NETLINK` | Invalid capability evidence | Infrastructure failure must be excluded from model-quality conclusions; tracked by Hugin [#218](https://github.com/Magnus-Gille/hugin/issues/218) |

## Provisional routing hypothesis

Admit an M5 coding attempt when all of these are observable before execution:

- the requested outcome and repository scope are explicit;
- the likely change is bounded rather than an open-ended architectural repair;
- deterministic tests, type checks, lint, or another cheap verifier can reject a bad result;
- the harness has a clean, isolated worktree and passes an infrastructure preflight;
- a cloud/human quality gate remains responsible for acceptance while the lane is being evaluated.

Abstain or route to the stronger harness when any of these apply:

- correctness depends on concurrency, transactions, migrations, security
  boundaries, or other adversarial invariants not covered by a mechanical test;
- the task is primarily diagnosis plus iterative review convergence;
- no independent verifier can cheaply distinguish a plausible answer from a
  correct one;
- repository path, base branch, tool permissions, or sandbox readiness is
  ambiguous;
- a prior attempt produced a no-op, unsafe partial result, or repeated review
  rejection and the new attempt does not materially change the harness or
  acceptance contract.

Confidence is **low**. There are only two valid M5/OpenCode coding observations
in this dogfood slice: one accepted bounded task and one complex task with two
rejected attempts. The Cassette run is infrastructure evidence, not model
evidence.

## What should enter the learning loop

Record these dimensions separately:

1. **Execution lifecycle:** did the harness start and finish? Hugin's
   `completed` state currently answers only this question.
2. **Repository evidence:** did the attempt produce the expected diff in the
   correct repository and base state?
3. **Mechanical verification:** which declared checks ran, and did they pass?
4. **Independent acceptance:** `pass | partial | redo | wrong`, with reviewer
   provenance and binding to the exact result/diff.
5. **Friction:** did infrastructure, tooling, model capability, or task
   specification interfere with the attempt?

Do not train routing from exit code, PR existence, or green repository tests
alone. Hugin [#216](https://github.com/Magnus-Gille/hugin/issues/216) tracks the
missing general semantic-acceptance contract.

### CI on task-output branches

Hugin's automatic task-output commits intentionally do not contain `[skip ci]`.
The resulting pull request must run the repository's normal CI because those
checks are independent mechanical evidence for the quality gate and future
exam record. Hugin does not auto-merge the PR or enqueue a follow-up Hugin task
from CI, so the dispatcher itself does not create a commit → CI → task loop.
Repositories that add such automation must provide their own actor, branch, or
event guard to prevent recursion. CI success still does not replace independent
semantic acceptance.

## M5 meta-check of this finding

A bounded M5 `mellum` classification call was run against the evidence summary
on 2026-07-15 (ledger `e2ca23ad-9f0f-43ff-84c5-e8e2ddd1961f`). It returned in
8.28 seconds using 600 tokens and proposed essentially the same
eligible/abstain split. The gateway correctly marked it `unverified` and its
delegate policy remained `shadow` because no verifier-backed lane existed.

The quality-gate rating for that draft is **partial**: the condition lists were
useful, but its one-sentence hypothesis said “reliably” and assigned medium
confidence from this tiny sample, and one proposed falsifier incorrectly treated
the infrastructure-blocked Cassette run as valid model evidence. The edits in
this note narrow those claims and downgrade confidence.

## Next falsifiable evaluation

Build a stratified corpus of fresh managed-repository tasks, preclassify each as
bounded/mechanically-verifiable or complex/review-heavy, and run matched M5 and
cloud attempts from the same base commit. A reviewer who does not know the lane
should rate the exact diffs. Promote a routing rule only through the existing
champion/challenger gate with predeclared sample, verifier-coverage, quality,
latency, and regression thresholds.
