# Quality-efficient agent orchestration plan

**Date:** 2026-08-09
**Status:** Evaluation and implementation plan only; no production policy change
**Research basis:** [Quality-efficient agent orchestration](../research/quality-efficient-agent-orchestration-2026-08.md)

## Objective and non-goals

Optimize semantic quality and human time subject to quota and latency constraints. Record tokens and monetary cost as secondary, separate metrics. The program must determine whether a cheaper or smaller topology earns use; it must not assume that it does.

Non-goals:

- minimizing total tokens as the primary objective;
- treating flat subscription use as zero cost or converting it to fictional marginal dollars;
- changing production routing before replay and shadow evidence exists;
- treating `completed`, a green test suite, model agreement, or a high savings figure as semantic acceptance;
- building a competing M5 capability ledger or weakening M5 provenance authority;
- allowing prompt/task content to select trust roots, sensitivity ceilings, reviewers, or promotion policy;
- changing signing, principal isolation, repository publication, deployment, or side-effect authority; or
- pinning undated product-tier, price, or quota assumptions into policy.

## Falsifiable hypotheses

H1. For eligible, non-abstained task cells, Terra high as conductor is non-inferior in severity-weighted semantic quality to Sol high while reducing at least one constrained resource: human intervention, peak quota pressure, or latency.

H2. Luna max is competitive with Terra high or Sol high in at least one task cell; if it is not, the evidence will bound rather than categorically dismiss it.

H3. A deterministic pre-planner bypass for truly atomic tasks preserves semantic quality while avoiding planner/synthesizer overhead.

H4. Explicit acceptance criteria plus strong deterministic oracles allow an earned M5 or Luna worker cell to match a single stronger execution with less frontier quota pressure and no increase in escaped severe defects.

H5. Oracle-selected M5 best-of-N improves accepted quality over one M5 attempt only where candidates are independent enough and selection is deterministic; outside those cells it merely adds latency and resource use.

H6. Fresh cross-family review detects additional material defects compared with fresh same-family review in some risk/task cells. If incremental yield is negligible after controlling for freshness and effort, provider diversity should not be mandatory.

H7. Source-linked context briefs with raw fallback reduce repeated context without increasing fact omission, citation error, or human correction.

H8. One-round debate improves decisions only for consequential, weak-oracle choices; routine or repeated debate has negative net value.

Each hypothesis can fail independently. No aggregate “agent score” may hide a severe-defect regression.

## Classification contract

Task class, verifiability, risk, sensitivity, and resource state are separate axes. They must not be compressed into one model-generated label.

### Coarse task classes

Use a small, versioned taxonomy initially:

- `atomic-transform`: bounded rewrite, extraction, classification, or mechanical code/doc change;
- `code-fix`: localized behavioral change with a reproducible failure and executable checks;
- `code-feature`: new behavior spanning contracts or modules;
- `review`: diagnosis or semantic review of an existing artifact/diff;
- `research-synthesis`: source-grounded comparison or durable research note;
- `architecture-decision`: cross-cutting design with long-lived consequences;
- `operations`: stateful or deployment-oriented work; and
- `other`: known but not safely specialized.

This taxonomy should align with existing task-type contracts where possible, but should not silently reinterpret them. Version and preserve the source of each classification.

### Verifiability dimensions

Record independent dimensions rather than a single confidence number:

- oracle availability: none, weak/model-judged, or deterministic/executable;
- oracle coverage: which acceptance criteria it proves and which remain semantic;
- reproduction quality: fixed input/base, seeded fault, and environment reproducibility;
- selection reliability: whether multiple candidates can be ranked without model taste;
- silent-failure likelihood: probability that a plausible wrong output passes available checks; and
- artifact observability: whether exact diff, test, schema, citations, and provenance can be retained.

### Risk dimensions

Record at least:

- reversibility and blast radius;
- security/privacy/sensitivity exposure;
- architecture and multi-repository coupling;
- external or privileged side effects;
- novelty and uncertainty;
- human-detection difficulty; and
- consequence severity if wrong.

Sensitivity and permission remain enforced by existing fail-closed contracts. A low task risk score never lowers effective sensitivity or expands runtime/provider authority.

### Deterministic abstain

The classifier must return `abstain` when required fields are missing, evidence conflicts, the taxonomy is unknown, risk or verifiability cannot be bounded, sensitivity/provider eligibility is ambiguous, acceptance criteria are absent, or the policy version has no evaluated cell. Abstention routes to the strong safe path; it must not be coerced into a cheap lane.

### Objective escalation triggers

Escalate to Sol high, within existing sensitivity/provider ceilings, when any of these apply:

- classifier abstention;
- security-sensitive, irreversible, architectural, or multi-repository work;
- rejected, contradictory, or unprovable acceptance criteria;
- repeated worker/oracle failure, verifier ambiguity, or degraded coverage;
- context brief cannot be traced to source or raw fallback is unavailable;
- a route is outside its evaluated cell or its evidence is stale; or
- a review identifies an unresolved severe defect.

Use strongest/max effort only for pre-registered consequential moments shown to benefit from it, such as final adjudication of a weak-oracle irreversible choice. Quota state may choose among quality-qualified routes; it cannot suppress an escalation required by quality or safety.

## Fixed replay evaluation

### Corpus

Freeze a versioned corpus manifest that binds:

- exact repository and base commits;
- exact task text or an owner-controlled reference and content hash;
- seeded regressions with known fault location and expected semantic property;
- representative real historical tasks, including successes, rejections, no-ops, and hard cases;
- deterministic oracle commands and expected artifacts where possible;
- task class, risk/verifiability annotations, sensitivity, provenance, and exclusion rules; and
- blinded adjudication IDs separate from arm/configuration identity.

Reuse content-blind repository evidence and the daily candidate concepts from [Daily-use exam factory](../daily-exam-factory.md): exact base/head, changed paths, diff digest, provisional/regression/quarantine status, and exposure checks. Extend these into a reviewed replay manifest; do not reinterpret the daily factory itself as an eval runner or holdout seal.

Include both seeded cases and representative historical work. Seeded cases provide known oracles; historical cases preserve realism. Deduplicate related tasks and prevent train/test leakage using recorded provenance and M5 exposure evidence. Private tasks stay within sovereign/local eligibility and must never enter cloud arms.

Executable replay is limited to cases whose effects are fully contained and reproducible. Reject operations and every other side-effecting case from executable replay unless the effect is represented by a deterministic simulation or fixture. Run replay under an explicit no-egress, read-only tool policy that permits only pre-declared deterministic local commands. An isolated worktree limits repository interference but is not, by itself, an isolation or side-effect guarantee.

### Exclusions and denominators

Pre-register the primary denominator as all eligible assigned cases for an arm (intention to evaluate). Report separately:

- valid completed attempts;
- infrastructure failures unrelated to model/policy quality;
- policy abstentions and safety refusals;
- timeouts and missing artifacts; and
- adjudication-unavailable cases.

Infrastructure failures may be excluded from the semantic-quality estimator only under pre-registered, arm-neutral rules, but remain in reliability/latency/resource denominators. Never remove model-induced malformed output, tool misuse, timeout from an overlong strategy, or failure to create required evidence as “infra.”

### Frozen arms

At minimum compare these conductor arms with identical task inputs and frozen role prompts, tool policy, context budget, max output, temperature/sampling policy, harness, timeout, and declared effort:

- Terra high;
- Sol high; and
- Luna max.

Do not adjust one arm after seeing another arm's failures. Record canonical model/provider identity and effective configuration for every call.

Run separate, randomized comparisons for:

- fresh same-family review versus fresh cross-family review, controlling for reviewer freshness, prompt, evidence, effort, and order;
- one strong execution versus one earned cheap worker plus deterministic oracle; and
- one M5 execution versus oracle-selected M5 best-of-N in eligible cells only.

“Fresh” means the reviewer receives the task, acceptance artifact, exact resulting artifact/diff, and deterministic evidence, but not the producing model's rationale, prior review, verdict, or conversational transcript. Cross-family is a treatment, not a proxy for independence; reviewer identity and relationship remain explicit.

### Acceptance and adjudication

Before dispatch, create a versioned acceptance artifact containing task intent, required outcomes, forbidden changes, oracle coverage, semantic questions, and evidence references. The artifact is immutable within a frozen arm.

Deterministic oracles decide only the properties they cover. Green checks do not establish semantic correctness, scope compliance, usability, security, or architectural fitness. Hugin `completed` establishes executor success only.

Use blinded human or independently governed adjudication for residual semantic quality. Score defects by pre-registered severity and record both count and worst severity. Adjudication and every later promotion record must bind canonical hashes of the acceptance artifact, frozen arm configuration, adjudication rubric, and the exact oracle commands plus their outputs/evidence set, in addition to the exact task/result/repository evidence. Reuse existing [quality receipts](../quality-receipts.md) where their bindings and reviewer-independence semantics apply, but add a binding contract for these evaluation-specific hashes; current receipts do not already establish that complete binding. Preserve reviewer independence, provenance, and correction-chain semantics. Do not expose arm identity until primary adjudication is locked.

### Metrics

Primary:

- severity-weighted escaped defects per assigned eligible case;
- probability of any severe escaped defect;
- human intervention minutes and intervention count per case; and
- semantic acceptance rate under exact-bound blinded adjudication.

Constraints and secondary metrics:

- end-to-end and model-call latency distributions;
- completion/reliability rate;
- total input, cache-read/cache-creation where available, and output tokens;
- subscription quota-state observations before/after the run, using provider-native coarse states where available;
- marginal dollar cost by paid pool;
- M5 latency, energy proxy if available, and opportunity/queue occupancy;
- planner, worker, verifier, reviewer, and synthesis call counts;
- raw and quality-adjusted savings, clearly secondary; and
- cross-family review incremental material-defect yield.

Do not combine these into one headline number until the utility weights are separately justified and sensitivity-tested.

### Statistical discipline

Pre-register hypotheses, primary estimands, eligible cells, arm configurations, randomization, stopping rules, exclusions, adjudication rubric, multiple-comparison handling, and analysis code before outcomes are inspected.

Determine sample size from the minimum quality difference worth detecting, baseline event uncertainty, desired confidence/power, paired/repeated-case design, and severe-defect safety requirements. Do not invent universal sample counts or pass percentages. Report effect sizes and uncertainty intervals, not only point estimates or binary significance.

Use paired cases where practical, hierarchical estimates across task classes, and sensitivity analyses for disputed adjudications and infra exclusions. Severe defects get explicit case review even when aggregate uncertainty is wide.

### Kill, hold, and promotion logic

Kill an arm or cell when credible evidence indicates worse severe-defect risk, a trust/sensitivity violation, unbounded human burden, or systematic acceptance-artifact/oracle gaming. Hold when evidence is insufficient, reviewer disagreement is unresolved, or reliability prevents estimation. Promote only when the quality floor is met with adequate uncertainty bounds and the route improves a constrained resource relevant to that cell.

Promotion is cell-specific, versioned, reversible, and never inferred from raw savings. New model revisions, prompt/harness changes, material quota-policy changes, or drift in task mix trigger shadow re-probing. Keep a strong control arm and periodic deterministic probes. Quota state is recorded during evaluation but cannot alter frozen arm assignment; quota-aware routing is evaluated later in shadow after the quality-qualified set is fixed.

## Implementation phases

Each phase is intended to fit a small issue/PR. File names below are likely integration points, not authorization to change them in this planning task.

### Phase 0 — Observation schema and corpus manifest

**Change:** Add versioned, content-minimized schemas for frozen arm configuration, classifier observation, resource-state observation, acceptance artifact reference, replay case, and adjudication binding. The additive adjudication binding canonically hashes the acceptance artifact, exact oracle commands and their outputs/evidence set, frozen arm configuration, and adjudication rubric, and those hashes survive into every later promotion record. Reuse compatible quality-receipt fields and semantics without claiming that the current receipt contract already covers the new bindings. Build a corpus-manifest validator and report generator; no runtime routing.

**Likely contracts/files:** new modules under `src/evaluation/` or `src/orchestrator/`; `src/task-result-schema.ts` only for additive references that must survive normal result/recovery paths; scripts/tests modeled on the daily exam factory; focused docs.

**Extend:** repository evidence, quality-receipt bindings, task-type provenance, daily candidate lanes.
**New contract:** frozen arm/case identity, acceptance artifact, resource observation, and an adjudication/promotion record with additive evaluation-specific bindings.

**Tests:** schema round-trips; canonical hashes; substitution of the acceptance artifact, oracle command, oracle output/evidence, frozen arm config, or rubric after execution invalidates adjudication and promotion; hostile paths/content; missing provenance; infra-exclusion taxonomy; blinded arm projection; old structured-result compatibility.

**Rollout/rollback:** offline generation only; removing the command/schema consumer restores baseline because dispatcher behavior is untouched.

**Dependencies:** reviewed taxonomy and rubric; owner-controlled corpus storage; exact commit availability.

**Acceptance gate:** two independent validators reproduce identical manifest and adjudication/promotion bindings from the exact artifacts, commands, evidence, configuration, and rubric; any post-execution substitution fails closed; fixtures prove no prompt/diff/private content enters content-blind summaries; and no runtime selector reads the new data.

### Phase 1 — Shadow classifier with abstention

**Change:** Implement a pure deterministic classifier that emits class, risk/verifiability dimensions, reasons, policy version, and abstain. Compare its shadow decision with the route actually taken; never actuate.

**Likely files:** new `src/orchestrator/task-classifier.ts`; observation plumbing near `src/orchestrator/orchestrator-executor.ts`; focused unit/property tests; additive structured-result metadata only if required.

**Tests:** boundary tables; missing/conflicting fields; sensitivity monotonicity; unknown taxonomy; acceptance-artifact absence; adversarial task metadata; deterministic output.

**Rollout/rollback:** default off, then observation-only; one flag removes all runtime effect.

**Dependencies:** Phase 0 schemas and taxonomy.

**Acceptance gate:** classifier is deterministic, abstains on every unsafe/unknown fixture, cannot lower sensitivity or permissions, and has no model/provider selection authority.

### Phase 2 — Acceptance artifact and context provenance

**Change:** Produce and validate immutable acceptance criteria before experimental dispatch. Add source-linked context slices with byte/character budgets and raw-source fallback references; do not replace authoritative source content.

**Likely files:** new acceptance/context modules; `src/orchestrator/prompts.ts`; context-ref handling; structured-result references; focused security/provenance tests.

**Tests:** canonical binding; source/reference mismatch; truncation; unavailable raw fallback; prompt-injection provenance; classification raising; no private-to-cloud leakage; recovery preservation.

**Rollout/rollback:** generate beside current prompts in shadow; consumers ignore it until a later evaluated arm. Disable generation to return to baseline.

**Dependencies:** Phase 0; existing context-ref classification and signing policy.

**Acceptance gate:** every brief statement is traceable to an allowed source range/reference, raw fallback remains available inside the same trust envelope, and ambiguity causes abstention.

### Phase 3 — Offline frozen-arm replay runner

**Change:** Execute the pre-registered Terra high, Sol high, and Luna max conductor arms plus review/worker comparisons under an explicit no-egress, read-only tool policy that allows only manifest-declared deterministic local commands. Use isolated replay worktrees as one containment layer, never as the isolation guarantee. Reject operations and all other side-effecting cases from executable replay unless a deterministic simulation or fixture represents the effect. Keep configuration frozen and emit exact-bound evidence.

**Likely files:** new replay runner and arm registry; reuse worker invocation abstractions without coupling evaluation state to live routing; fixtures and reports under the existing evaluation conventions.

**Tests:** randomization reproducibility; denial of egress, writes outside allowed replay outputs, and undeclared commands; rejection of operational/side-effecting cases without an approved simulation or fixture; deterministic fixture behavior; worktree containment without reliance on worktrees as the policy boundary; exact-commit checkout; seeded regression detection; timeout/infra classification; no arm mutation; blind projection; denominator reconciliation.

**Rollout/rollback:** offline only, no dispatcher import and no production config writes. A failed run is discarded/quarantined, not retried under a modified arm.

**Dependencies:** Phases 0–2; available exact commits; adjudication process; approved provider eligibility per sensitivity.

**Acceptance gate:** replay the same manifest twice with identical arm assignments and evidence identities; policy tests prove no egress, read-only tools, and execution of only pre-declared deterministic local commands; no side-effecting case executes without its simulation/fixture; every case reconciles to an explicit denominator state; and adjudicators remain blind.

### Phase 4 — Separate diagnostic verification from quality review

**Change:** Define two contracts. Diagnostic verification explains red/malformed artifacts and can feed retry/escalation. Fresh quality review judges a green candidate against the acceptance artifact and exact evidence. Compare same-family and cross-family reviewers.

**Likely files:** verifier/reviewer prompt builders, new result schemas, quality-receipt integration, `src/orchestrator/verdict-store.ts` only if its event taxonomy is deliberately extended.

**Tests:** red versus green routing; reviewer freshness; no producer rationale leakage; ambiguous verdict; exact binding; correction chains; independence labels; severe finding escalation.

**Rollout/rollback:** replay then shadow; current verifier behavior remains authoritative until promotion. Disable new reviewer invocation without altering normal completion.

**Dependencies:** acceptance artifact and replay runner.

**Acceptance gate:** diagnosis cannot count as independent acceptance, green quality review cannot mutate the artifact, and incremental defect yield is reported with uncertainty.

### Phase 5 — Direct lane and earned worker cells in shadow

**Change:** Add a non-actuating selector proposal for pre-planner direct execution, single strong execution, cheap worker plus oracle, and M5 best-of-N. Record the proposed route and compare selector decision and coverage agreement with the frozen evaluated policy. Because the proposed topology does not run, shadow cannot measure direct-bypass quality or counterfactual cost. Keep every quality and economic topology comparison in pre-registered offline paired replay.

**Likely files:** new policy/route-decision module; `src/orchestrator/engine.ts` and executor integration only after shadow contract is stable; M5 provenance sanitizer/ledger interfaces remain authoritative rather than copied.

**Tests:** single-leaf eligibility; oracle strength; best-of-N deterministic selection; repeated failure; degraded coverage; model × task-cell evidence expiry; no route outside sensitivity/capability ceilings; shadow reports only decision/coverage agreement and rejects quality or counterfactual-cost fields derived without paired replay evidence.

**Rollout/rollback:** shadow-only flag; no invocation is added solely because the shadow selector proposes it. Drop observations to roll back.

**Dependencies:** positive Phase 3 evidence for named cells; Phase 1 classifier; Phase 2 artifacts.

**Acceptance gate:** shadow decisions reproduce the frozen evaluated policy at the pre-registered decision/coverage agreement threshold, all unknown cells abstain, and every quality or economic topology claim used for promotion comes from the pre-registered offline paired replays rather than shadow observations.

### Phase 6 — Quota evidence and quality-qualified tie-breaking

**Change:** Record coarse, source-identified quota pressure separately from tokens/cost. Only after the eligible quality set is frozen, shadow a tie-breaker among qualified routes.

**Likely files:** new resource-observation adapter and policy input; per-call ledger extensions if additive and available; reports.

**Tests:** missing/stale quota state; flat versus marginal pools; no invented dollar conversion; frozen-eval noninterference; deterministic tie-break; quality escalation dominance.

**Rollout/rollback:** observation first, tie-break shadow second. Missing data leaves the quality route unchanged.

**Dependencies:** provider-supported observable state and Phase 3 quality-qualified cells.

**Acceptance gate:** quota evidence has provenance and freshness, cannot alter frozen replay arms, and cannot override quality/safety escalation.

### Phase 7 — Narrow canary and safe promotion

**Change:** Promote one evidence-qualified low-risk cell behind a versioned canary selector, shadow comparison, kill switch, and strong-path fallback. The selector accepts only an owner-signed policy verified against a fixed trust root. The signed policy binds the exact cell and policy version; route/config identities; a canonical immutable content hash of the exact route/config payload, including fallback behavior and every relevant execution permission; the acceptance-artifact hash; adjudication and evidence hashes; expiry; and rollback target. Missing, stale, conflicting, unverifiable, substituted, or content-hash-mismatched inputs force abstention to the strong fallback. Start with the direct atomic bypass or one worker-plus-oracle cell, whichever replay evidence supports.

**Likely files:** dispatcher/orchestrator route admission, config store/policy binding, result metadata, monitoring reports, rollback tests.

**Tests:** valid owner signature against the fixed trust root; wrong signer/trust root; tampered cell, policy version, route/config identity, canonical route/config content hash, acceptance artifact, adjudication/evidence hash, expiry, or rollback target; substitution or tampering of any exact route/config content, including fallback behavior and relevant execution permissions, without a matching owner-signed canonical immutable content hash; missing, stale, conflicting, and unverifiable inputs; every negative case abstains to the strong fallback; crash/recovery; concurrent config read; rollback; sensitivity and permission ceilings; no publication/deployment authority expansion.

**Rollout/rollback:** explicit opt-in canary with bounded cell and traffic; instant disable restores planner-first strong path; preserve evidence from both paths.

**Dependencies:** pre-registered successful evaluation, independent review, and owner approval of the exact policy artifact.

**Acceptance gate:** only an owner-signed, fixed-trust-root-verified policy with all required exact bindings, including the verified canonical immutable content hash of the exact route/config payload, fallback behavior, and relevant execution permissions, can actuate the canary; negative fixtures prove that missing, stale, conflicting, tampered, unverifiable, substituted, or content-hash-mismatched inputs demonstrably abstain to the strong fallback; the canary stays within pre-registered quality uncertainty and reliability bounds; no severe escaped defect or trust violation occurs; rollback to the bound target is exercised; and promotion is approved from exact-bound evidence—not savings alone.

### Phase 8 — Drift monitoring and additional cells

**Change:** Schedule content-blind drift reports and periodic replay/re-probes. Admit additional task cells, debate, cross-family review, or max-effort moments only through the same evidence path.

**Likely files:** evaluation scheduler/reporter, verdict/receipt consumers, policy registry; daily exam integration by reference rather than merging responsibilities.

**Tests:** model revision; taxonomy version; task-mix drift; expired evidence; conflicting receipts; re-probe failure; automatic demotion to shadow/abstain.

**Rollout/rollback:** one cell/version at a time; stale or failed cells return to strong-path fallback.

**Dependencies:** a stable canary and sufficient observation history.

**Acceptance gate:** drift or model/config change reliably suspends affected authority, and no automated observation can self-promote a route.

## Explicit implementation sequence

1. Freeze schemas, corpus rules, rubric, denominators, and arm configurations.
2. Build the observation-only classifier and acceptance artifact.
3. Assemble and independently validate the fixed corpus.
4. Run frozen conductor arms and blinded adjudication.
5. Run review-family and worker-topology comparisons only in eligible cells.
6. Analyze effect sizes, uncertainty, severe cases, human time, latency, quota state, tokens, and marginal cost separately.
7. Shadow the resulting cell-specific policy without extra calls or routing effects.
8. Promote at most one narrow reversible canary after exact-bound review and owner approval.
9. Re-probe on drift and expand only through another evidence gate.

## Smallest first experiment

Start with an **offline paired conductor replay**, not a production router:

1. Select a small pilot stratum from the future corpus containing reproducible, non-private tasks with exact commits, deterministic checks, and residual semantic adjudication.
2. Freeze identical Terra high, Sol high, and Luna max arm configurations before execution.
3. Run each eligible case under the replay no-egress/read-only policy with only pre-declared deterministic local commands; use isolated worktrees as an additional containment layer, reject unsimulated side-effecting cases, retain exact repository evidence and per-call ledgers, and classify infra failures without dropping them from reliability reporting.
4. Blind arm identity and obtain severity-weighted semantic adjudication using the additive contract that binds the acceptance artifact, exact oracle commands and outputs/evidence, frozen arm config, rubric, and task/result/repository evidence.
5. Use the pilot only to estimate variance, event frequency, rubric reliability, and the sample size needed for the registered main comparison. Do not use it to promote a route.

This first experiment answers whether the evaluation machinery is trustworthy and whether the proposed comparison is measurable. It leaves production policy unchanged.

## Existing evidence to reuse and boundaries to preserve

- Extend per-call token/cost/latency ledger records; do not replace them with a blended resource score.
- Extend quality-adjusted savings reporting only as a secondary view; never promote from raw or quality-adjusted savings alone. See [Orchestrator savings tracker](../orchestrator-savings-tracker.md).
- Reuse model × task-type verdict observations where their semantics match; add task-cell/version dimensions explicitly rather than overloading old keys. See [Orchestrator verdict layer](../orchestrator-verdict-layer.md).
- Reuse quality receipts for semantic adjudication bindings and reviewer independence where their current contract applies. Add the evaluation-specific binding contract for acceptance artifact, exact oracle commands and outputs/evidence, frozen arm config, and rubric; do not claim current receipts already cover it or equate acceptance with a golden oracle. See [Quality receipts](../quality-receipts.md).
- Reuse repository evidence and daily provisional/regression/quarantine concepts, while keeping the daily factory content-blind and non-promoting. See [Daily-use exam factory](../daily-exam-factory.md).
- Preserve M5's authority over model selection, verification, and capability evidence. Hugin may bind and evaluate returned provenance but must not invent a competing capability truth. See [Durable M5 lifecycle](../mcp-durable-m5-lifecycle.md).
- Preserve effective-sensitivity monotonicity, context-ref provenance, task-signing distinctions, principal isolation, managed-worktree rules, and existing side-effect/permission ceilings in every replay, shadow, and canary phase.

## Drafting provenance

M5 delegation for a bounded drafting leaf was attempted, but installed `m5` v1.2.0 under the Codex profile returned redacted status `missing_credential` and endpoints `not_checked`. No local-model output existed to verify. Rate the leaf **unavailable/redo due access**, not pass/partial/wrong and not as evidence about M5 model quality. Frontier-model drafting was the constrained fallback.

## Exit condition for this plan

The plan is complete when Hugin can produce reproducible, exact-bound evidence about conductor and topology choices, keep unsafe or unsupported cells in abstain/strong-path mode, shadow a frozen policy without authority, and promote or roll back one narrow cell through an owner-approved evidence gate. Until then, the research recommendation remains a hypothesis.
