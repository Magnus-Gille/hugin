Context loaded

## Tools Called

Munin requires `memory_orient` before other memory calls, so I oriented first, then ran the requested calls and stopped using memory tools:

1. `memory_read(namespace: 'projects/hugin', key: 'status')`
2. `memory_query(query: 'skills in munin portable skill derivative decision', tags: ['decision'], limit: 3)`

Model: Codex, GPT-5-based coding agent.

## Round1 -> Round2 Memory Drift

No material drift for this debate. Hugin is still in the same relevant state Round 1 depended on: Orch-v1 steps 1-7 complete, broker not enabled on Pi, #68 not fully green, and #77 crash-recovery liveness still gates the runtime lane. The skills query still surfaces the prior `decisions/skills-in-munin/round-2-verdict` result: the portable unit is not a raw Claude skill, but a rewritten derivative. The query also now ranks `meta/skills/policy` first, but that does not change the architecture conclusion.

# Rebuttal

Claude's response is materially better than the draft. The important concession is real: the design has moved from "promote a skill" to a versioned `RouteBinding` carrying policy and metrics (`debate/skill-distillation-claude-response-1.md:9` to `debate/skill-distillation-claude-response-1.md:13`). That directly fixes the biggest primitive error in the draft, where promotion was a `validatedSkills` field next to `parsesToolCalls` (`debate/skill-distillation-claude-draft.md:25` to `debate/skill-distillation-claude-draft.md:26`).

The portability concession is also genuine and adequate at the concept level. Claude explicitly adopts the prior memory decision that the portable unit is a rewritten derivative, not an existing Claude `SKILL.md` (`debate/skill-distillation-claude-response-1.md:15` to `debate/skill-distillation-claude-response-1.md:19`). That closes the specific abstraction leak I objected to in Round 1, where the draft mapped L2 directly to existing `~/.claude/skills/` (`debate/skill-distillation-claude-draft.md:17`).

The anti-Goodhart, retrieval, run-record, and fallback concessions are also directionally strong: independent oracle, negative/retrieval/mutation fixtures, procedural schema inside Munin, fail-closed retrieval, immutable validation evidence, and policy-aware fallback (`debate/skill-distillation-claude-response-1.md:21` to `debate/skill-distillation-claude-response-1.md:48`). These are not cosmetic concessions. They are the right contract family.

But several concessions are still shallow because they are stated as design vocabulary rather than buildable invariants.

## PC1: #77 Gates More Than `active`

Claude is right that #77 does not need to block every line of code in this project. A fixture-only offline harness can build procedure packages, eval suites, and local profiles while #77 remains open. That part of PC1 is valid (`debate/skill-distillation-claude-response-1.md:52` to `debate/skill-distillation-claude-response-1.md:56`).

The dodge is treating "shadow" as automatically safe and meaningful. There are two different things hiding under that word:

- Offline shadow: run the local cell against fixture repos outside production Hugin routing. Safe, useful for authoring evals, but not evidence that Hugin can route, recover, deliver, or fallback.
- Hugin-integrated shadow: let Hugin select the binding and run the local lane, but do not expose the result to real user tasks. This exercises the real state machine and therefore inherits #77's liveness problem.

Claude says #77 gates `active`, not shadow, and promises a kill-during-local-execution acceptance test (`debate/skill-distillation-claude-response-1.md:56` to `debate/skill-distillation-claude-response-1.md:58`). That test is exactly why the distinction matters. If the test goes through Hugin while #77 is open, a crash can still strand the run; if it bypasses Hugin, it is not testing the system the feature will rely on. In Round 1, the point was not "do not build." It was that a 10 minute to 3 hour local run can be left non-terminal, delaying fallback and corrupting telemetry (`debate/skill-distillation-codex-critique.md:40` to `debate/skill-distillation-codex-critique.md:53`).

So the corrected version is:

- #77 does not block offline package/profile/eval work.
- #77 blocks counting any Hugin-integrated shadow run as readiness evidence for `active`.
- #77 blocks the first real end-to-end claim that Hugin can retrieve, select, execute, deliver, fail, recover, demote, and escalate reproducibly.
- The kill/restart acceptance test should either be marked expected-failing until #77 is fixed, or be the first test that proves #77 is fixed.

Shadow mode is safe only if it is explicitly non-promoting, fixture-scoped, cleanup-bounded, and labeled "runtime recovery not yet proven." Otherwise "shadow" becomes a way to launder a known liveness bug into the evidence base.

## PC3: "One Row Now" Is Correct, But Not Enough

Claude's PC3 is partly adequate. It accepts that the data model must accommodate the full matrix: task class, profile, eval, harness, wrapper, model, context cap, hardware, and tool environment (`debate/skill-distillation-claude-response-1.md:66` to `debate/skill-distillation-claude-response-1.md:71`). That matches the Round 1 instruction to put the matrix in the model now, then populate one row (`debate/skill-distillation-codex-critique.md:197` to `debate/skill-distillation-codex-critique.md:205`).

The shallow part is the phrase "schema columns." If the first slice only adds nullable/defaulted fields while the router still behaves like a boolean promotion path, the concession has not landed. The first row must be consumed by the route decision and execution path.

Minimum commitment for the first row:

- `TaskClass` has a versioned classifier or deterministic predicate, hard negatives, and contraindications.
- `SkillPackageProfile` is content-addressed and distinct from raw `SKILL.md`.
- `CellManifest` records wrapper, model hash, context cap, thinking/tool-call behavior, hardware, and tool environment.
- `EvalSuite` is versioned and contains retrieval-negative, execution-positive, execution-negative, and mutation fixtures.
- `ValidationRun` is immutable evidence, not mutable registry state.
- `RouteBinding` is the only selectable object and cannot point at stale hashes.
- `RouteDecision` is recorded for every attempted selection, including abstentions.

"One row" is fine. "One row that exercises the full contract" is the bar. Otherwise the build will recreate `validatedSkills` with a nicer name.

## D1: Beats Cloud Is A Strategic Signal, Not A Gate

Claude's D1 is valid where it concedes the first slice gate: correctness, fail-closed behavior, reproducible promotion, crash recovery, and clean fallback come before cost/latency (`debate/skill-distillation-claude-response-1.md:75` to `debate/skill-distillation-claude-response-1.md:78`). That is the right ordering.

The defense becomes fuzzy when it says the capability must eventually win on "privacy/offline/egress-constrained tasks" and then phrases the strategic test as "required or cheaper" (`debate/skill-distillation-claude-response-1.md:78` to `debate/skill-distillation-claude-response-1.md:82`). Those are different gates:

- Privacy/offline/egress-required is categorical. Cloud cannot be used, so local capability can be worth maintaining even if it is slower.
- Cheaper/faster is economic. It only matters after reliability, scheduling, revalidation churn, and human review costs are included.

So yes: record cloud cost/latency from slice one. No: do not let that become the build's strategic framing. The better strategic criterion is: there is at least one recurring task class where a local route is policy-required or sustainably cheaper after maintenance cost, and that task class has a bounded route-binding matrix.

## D2: A Semaphore Is Necessary, Not Sufficient

Claude's D2 is partly valid. If Hugin already serializes the batch lane, then the first capacity control can indeed be "evals and production local jobs share the same single-heavy-job gate" (`debate/skill-distillation-claude-response-1.md:84` to `debate/skill-distillation-claude-response-1.md:86`). That is a sensible initial implementation.

But this dodges the actual scheduler concern by reducing it to concurrency. A semaphore prevents two 30B runs from competing at once. It does not specify:

- priority between production work and eval work
- cancellation behavior
- lease expiry and heartbeat semantics
- stale-run reconciliation
- starvation limits
- retry policy
- resource profiles for CPU/GPU/Metal memory
- whether evals can block cloud-eligible user work

This is not a demand for a new scheduler subsystem. It is a demand that the single semaphore be attached to a policy: priority, leases, timeouts, and reaper behavior. #77 is already proof that "only one worker" is not enough when a long-running task can be stranded.

## New Risk: RouteBinding Makes Task Classification Load-Bearing

The route-binding redesign fixes the wrong primitive, but it introduces a new load-bearing component neither side has named clearly enough: task classification.

The new route key starts with `taskClass` (`debate/skill-distillation-claude-response-1.md:9` to `debate/skill-distillation-claude-response-1.md:11`). PC3 repeats that the model must include task class as the first matrix dimension (`debate/skill-distillation-claude-response-1.md:66` to `debate/skill-distillation-claude-response-1.md:68`). But the system still has to decide that an incoming task belongs to that class before it can select a binding. That decision is now part of routing, policy, safety, and cost.

A bad classifier can:

- select the wrong local procedure even when retrieval works
- bypass a cloud/ZDR/egress policy by assigning the wrong class
- send an ambiguous task into the local lane instead of abstaining
- inflate shadow metrics by evaluating only easy in-class fixtures
- make demotion look like a model failure when the real bug was classification

Round 1 named retrieval-to-execution coupling as the highest-risk hidden coupling (`debate/skill-distillation-codex-critique.md:207` to `debate/skill-distillation-codex-critique.md:220`). RouteBinding sharpens that: retrieval is not enough. There must be a first-class `TaskClassifier` or route predicate artifact with versioned rules, examples, hard negatives, confidence thresholds, top-two margins, and recorded abstentions. It belongs in the eval suite too: every binding needs "should classify" and "should not classify" cases before execution is even attempted.

If this is left implicit, the project will have a precise binding record attached to an unexamined classification guess. That is worse than the original boolean flag because it will look rigorously versioned while the most important selection step remains opaque.

## Final Verdict

The single most important next step is to fix Hugin #77 and prove it with a kill-during-local-execution acceptance test wired through the same task lifecycle the skill lane will use.

Do not block offline package/eval/profile authoring on #77. But the first implementation step that matters for the actual architecture is runtime liveness: stable worker identity, lease-expiry reconciliation, startup recovery, terminal state correctness, and idempotent artifact delivery. Until that is green, Hugin-integrated shadow cannot safely produce promotion evidence, and the first vertical slice cannot honestly claim route -> execute -> fail -> recover -> fallback.
