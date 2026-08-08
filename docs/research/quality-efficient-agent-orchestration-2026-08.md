# Quality-efficient agent orchestration

**Discussion date:** 2026-08-08
**Recorded:** 2026-08-09
**Status:** Research hypothesis and provisional policy proposal; not evidence of current production performance
**Companion plan:** [Quality-efficient agent orchestration plan](../design/quality-efficient-agent-orchestration-plan.md)

## Question

How should Hugin allocate conductor, worker, verifier, and reviewer capability when Magnus has several differently constrained capacity pools and the objective is high-quality work with little human intervention—not merely low token count?

This note preserves the proposal, two rounds of adversarial debate, the resulting provisional policy, and the repository facts that bound implementation. It does not establish that the policy is better. The companion plan defines the tests required before any production routing authority changes.

## Dated operating context

As of 2026-08-08, Magnus commonly uses:

- OpenAI Sol at high effort as orchestrator;
- OpenAI Luna at xhigh effort as workers;
- OpenAI Sol at max effort for pull-request review; and
- sometimes Anthropic Fable at high or xhigh effort.

Available resources are one flat-rate OpenAI subscription, one flat-rate Anthropic subscription whose tiers can change over time, private M5 models, and occasional OpenRouter usage. These are dated observations, not durable product-tier guarantees.

The resource pools are economically different:

- Flat subscriptions are perishable quota buckets. The relevant cost is quota pressure, throttling risk, and displacement of later valuable work, not a fabricated per-call marginal bill.
- OpenRouter is marginal-dollar capacity and should be measured as such.
- M5 has no cloud-token bill but still consumes latency, electricity, hardware availability, and opportunity cost.
- Total tokens remain useful for capacity and context-efficiency diagnosis, but are not the top-level objective.

Accordingly, evaluation must keep **total tokens**, **subscription quota pressure**, **marginal dollar cost**, **latency**, **human intervention**, and **escaped-defect cost** as separate measures. Collapsing them prematurely into one dollar-like score hides the actual trade-offs.

## External guidance used in the discussion

The dated OpenAI model guidance positions Sol as the frontier option, Terra as the balanced option, and Luna for high-volume or cost-sensitive work. It supports treating high/xhigh effort as choices that need measured gains and reserving max for the hardest quality-first work. The same guide reports a directional internal coding-agent sample in which leaner prompts reduced total tokens by 41–66% and cost by 33–67% while scores improved by 10–15%. Those figures are **vendor-reported and workload-dependent**, not Hugin benchmarks or promised effects. See [OpenAI's latest model guide](https://developers.openai.com/api/docs/guides/latest-model).

OpenAI's multi-agent guidance says focused parallel agents can improve complex, decomposable work and reduce wall time, while also increasing token use. See [OpenAI's multi-agent guide](https://developers.openai.com/api/docs/guides/responses-multi-agent).

The useful inference is narrow: context discipline and selective parallelism deserve direct measurement. Vendor examples do not decide Hugin's conductor, fanout, or effort policy.

## Initial proposal

The opening policy proposal was:

1. Put a deterministic or cheap router before model-intensive orchestration.
2. Use Terra high as the default planner and synthesizer.
3. Give bounded, well-specified leaves to M5 or Luna workers.
4. Require deterministic checks wherever the task admits executable oracles.
5. Use independent cross-provider review selectively rather than universally.
6. Escalate to Sol under objective conditions.
7. Keep fanout sparse, bypass orchestration for a single leaf, and minimize repeated context and output.
8. Learn routing by model × task type only from accepted evidence.

Its intended shape was a cheap deterministic control plane around expensive model calls, with capability spent where uncertainty or consequence makes it useful.

## Adversarial debate record

Two tool-less, constrained adversarial rounds actually ran using canonical model `claude-opus-5` at high effort. Their usage is evidence about the overhead of these debate calls only. It is not a general benchmark of the model, provider, or future debate workload.

| Round | Cache-creation input | Cache-read input | Output | Duration | Reported cost |
|---|---:|---:|---:|---:|---:|
| 1 | 9,793 | not reported | 11,910 | about 176 s | $0.39569 |
| 2 | 7,535 | 2,463 | 4,976 | about 78 s | $0.2009915 |

### Round 1: strongest objections

Opus challenged the proposal's objective and its implied default topology.

- With flat subscriptions, total tokens is the wrong top-level objective. Optimize escaped defects and human attention subject to peak quota and latency constraints.
- “Cheap first” is safe only when gated on **risk × verifiability**, especially the probability of silent failure. A cheap visible failure is usually less dangerous than a plausible wrong answer that passes weak checks.
- Strong executable oracles legitimize cheap workers. Tests, type checks, schema validation, exact comparisons, reproducible builds, and constrained transformations can turn inexpensive attempts into earned candidates.
- Context quality and decomposition may dominate raw conductor strength. Once an explicit classifier and acceptance artifacts narrow and check the conductor's job, the strongest available model need not be the default.
- M5-produced compression must remain source-linked and retain a raw-source fallback. An unsupported brief can erase the exact fact a later role needs.
- Cross-provider review has plausible value for fresh independence, family-level error hedging, and quota arbitrage, but its incremental defect detection is not yet proven for this workload.
- Swarms are mainly justified for independent exploration or best-of-N generation with deterministic selection. Generic collaborative fanout adds correlation, coordination overhead, and context multiplication.
- Debate should be rare and normally one round, reserved for irreversible or consequential choices with weak oracles. Repeated debate is itself an expensive topology that needs evidence.

### Round 2: revision and remaining disagreement

The second round accepted the risk/verifiability correction and refined the control policy.

- Define the quality floor first; use quota state only to choose among configurations already expected to clear it.
- Require explicit acceptance criteria before dispatch, not a retrospective declaration that green tests meant success.
- Make the classifier deterministic where possible and give it an explicit abstain outcome. Abstention is a normal safety result, not a routing failure.
- Distinguish a verifier diagnosing a red or malformed diff from a fresh reviewer judging a green diff's semantic quality. These roles consume different evidence and answer different questions.
- Use cross-family review when independence has likely value, but measure it against a fresh same-family reviewer rather than assuming provider diversity is inherently superior.
- Do not dismiss Luna max. Treat it as a challenger conductor and test it against Terra high and Sol high on frozen arms.
- Keep strongest/max invocations for consequential moments, not as a habitual final pass that masks an unevaluated upstream policy.

The debate did not prove any model ordering. It produced a more falsifiable policy and a sharper evaluation design.

## Joint provisional recommendation

The resulting policy hypothesis is:

1. **Default conductor:** Terra high, provided the classifier does not abstain and the task is inside an evaluated cell.
2. **Deterministic admission:** classify task class, risk, verifiability, and sensitivity before dispatch; abstain on missing or conflicting evidence.
3. **Acceptance first:** produce explicit acceptance criteria and the available oracle plan before choosing workers.
4. **Single-leaf bypass:** direct eligible atomic work to one execution lane without paying for planner/synthesizer calls.
5. **Earned cheap cells:** admit M5 or Luna workers only for task cells whose evidence and oracle strength support them.
6. **Quality before quota:** enforce a quality floor, then use quota pressure, latency, and marginal cost as tie-breakers among eligible routes.
7. **Deterministic gates:** prefer executable checks and exact artifacts over model agreement.
8. **Two review modes:** use diagnostic verification for failed or suspect artifacts; use a fresh independent reviewer for semantic quality after deterministic checks pass.
9. **Selective cross-family review:** choose fresh cross-family review when risk, novelty, correlated-error concern, or quota state justifies it; retain fresh same-family review as an explicit comparator.
10. **Objective Sol escalation:** route to Sol high when the classifier abstains; the work is security-sensitive, irreversible, architectural, or multi-repository; failures repeat; or acceptance criteria are rejected or cannot be established. Reserve the strongest/max setting for consequential decisions shown to benefit from it.
11. **Sparse fanout:** use independent parallel exploration or oracle-selected best-of-N only when the task is decomposable or selection is reliable.
12. **Challenger status:** evaluate Luna max as a conductor rather than rejecting it categorically.

This is a candidate policy for evaluation, not an instruction to change current production defaults.

## Current Hugin baseline

Current code and focused contracts establish the following mechanics:

- `src/orchestrator/engine.ts` implements four roles: planner, worker, verifier, and synthesizer. The planner runs first and returns a `single` or `fanout` plan; workers may run concurrently within provider-specific caps.
- Every invocation records role, provider, model, success, input/output tokens, cost, and latency in a per-call ledger. Worker and verifier calls are attributed to a subtask.
- Verification can be universal or adaptive. Adaptive verification uses a model × task-type recommendation, sourced from Hugin's verdict store for non-homeserver workers or the M5 ledger for homeserver workers, and fails toward verification when evidence is unavailable.
- If the plan is `single`, or only one synthesis input survives, the engine returns that worker output without a synthesizer call. This is a **single-result synthesis bypass**, not a direct pre-planner lane: the planner has already run.
- The verdict layer stores model × task-type observations and supports adaptive verification. The M5 gateway remains authoritative for M5 capability evidence. See [Orchestrator verdict layer](../orchestrator-verdict-layer.md) and [Durable M5 lifecycle](../mcp-durable-m5-lifecycle.md).
- The savings tracker computes raw and quality-adjusted savings from the per-call ledger. Decision consumers are required to use the quality-adjusted series, while uncovered costs remain unknown rather than guessed. See [Orchestrator savings tracker](../orchestrator-savings-tracker.md).
- Structured results preserve orchestrator outcomes, savings, runtime provenance, and repository evidence. A terminal `completed` state is execution evidence, not semantic acceptance.
- Authenticated, exact-bound quality receipts preserve verdict and reviewer-independence evidence without auto-promotion. See [Quality receipts](../quality-receipts.md).
- The daily exam factory can identify reproducible managed-repository candidates and classify them as provisional holdout, regression, or quarantine. It does not create an oracle, run an evaluation, or promote a route. See [Daily-use exam factory](../daily-exam-factory.md).
- Existing M5 dogfood found useful bounded delegation alongside material failure modes, including invalid or incomplete artifacts and verification gaps. It argues for evidence-gated cells, not blanket local routing. See [M5 task-solver dogfood finding](m5-task-solver-dogfood-2026-07.md).

The older [orchestrator redesign](../orchestrator-redesign.md) and [agent orchestration experiments](agent-orchestration-experiments.md) provide architectural and experimental context, but current source and executable contracts control where they differ.

## Gaps between baseline and proposal

The following should not be described as implemented:

- a direct pre-planner lane for known single-leaf work;
- an explicit classifier contract with abstain, risk, and verifiability dimensions;
- a durable pre-dispatch acceptance artifact;
- per-role reasoning-effort control;
- task/class-specific planner, synthesizer, verifier, and reviewer routing (current task-type routing and confidence logic primarily govern worker/adaptive-verification behavior);
- context slicing with source-linked briefs and raw fallback;
- separate diagnostic-verifier and green-diff quality-review contracts;
- evidence for subscription quota pressure as a distinct resource signal;
- a fixed replay/evaluation harness with blinded semantic adjudication; and
- safe shadow, promotion, rollback, and drift-reprobe rules for orchestration policy.

Some existing contracts can be extended: repository evidence, exact-bound quality receipts, verdict observations, per-call ledgers, quality-adjusted savings, M5 provenance, and daily candidate classification. The classifier decision, acceptance artifact, resource-state observation, frozen experiment arm, adjudication record, and promotion decision need explicit new contracts rather than being inferred from `completed`, green tests, or a savings number.

## M5 drafting attempt

M5 delegation for a bounded drafting leaf was attempted before the constrained fallback. The installed `m5` v1.2.0 Codex profile returned redacted status `missing_credential`, with endpoints `not_checked`. No M5 model result was obtained. The leaf is rated **unavailable/redo due access**; this is operational evidence about access configuration, not evidence of M5 model quality. Drafting therefore fell back to the frontier model in the constrained session.

## Decision status

The recommendation is provisional. Promotion requires replay evidence that preserves or improves severity-weighted semantic quality and human time under realistic latency and quota constraints. The smallest useful next step is the observation-only, frozen-arm experiment defined in the [companion implementation plan](../design/quality-efficient-agent-orchestration-plan.md), with no production routing change.
