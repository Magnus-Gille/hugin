# Hugin document index

This file is exhaustive for `docs/**/*.md` in this repository. `AGENTS.md` keeps
behavioral rules, prohibitions, the Munin task-contract example, and
security/deployment invariants inline; use this index for lookup/reference
material only.

Contributor contract: whenever a change adds, removes, renames, or moves any
`docs/**/*.md` file, update this index in the same change so it remains
exhaustive.

Use this page only to route to the right document. After selecting an entry,
open the linked source document before relying on or answering with its
details. The summaries below are routing aids, not substitutes for source
content.

Descriptions name concrete Hugin entities and subsystems where that improves
retrieval: orchestrator, M5, Harbor, daily exams, task signing, scanners,
scheduling, and pipeline phases.

## Core contracts and operator docs

- [Architecture pointer](architecture.md): Notes that the system-level Grimnir
  architecture moved to the `grimnir` repo; use when a Hugin-local doc defers
  to the wider fleet topology.
- [Canonical task identity](canonical-task-identity.md): Canonical task IDs,
  producer projection, and Hugin's side of the direct homeserver `/delegate`
  handshake.
- [External task/outcome receipt intake](external-receipt-intake.md): Contract
  for owner-authenticated external receipts and the rule that intake must not
  rewrite task ownership or terminal state.
- [Friction reporting](friction-reporting.md): Schema-v1
  `signals/friction` events, severity semantics, and when Hugin records model,
  environment, or task-spec friction.
- [Operator approval decisions](operator-guide-approval-decisions.md): Runbook
  for `Authority: gated` pipeline phases, their approval artifacts, and valid
  accept/reject decisions.
- [Quality receipts](quality-receipts.md): `hugin_rate` /
  `POST /v1/delegate/rate`, exact-bound acceptance evidence, reviewer
  independence, and why `completed` is not the same as accepted.
- [Research-spike execution contract](research-spike-contract.md): Fail-closed
  two-artifact delivery and Hugin-owned three-record Munin indexing contract
  for `type:research` tasks.
- [Artifact delivery recovery runbook](testing/delivery-recovery-e2e.md):
  End-to-end acceptance/recovery procedure for declared artifacts and the
  `delivery:*` terminal states.
- [Workload contract v1](workload-contract.md): Owner-side requirement
  declaration for moving Hugin across nodes, including drain/verify/restore
  boundaries and the dependency map for Munin, Mimir, and M5.

## Security, trust, and provenance

- [Autonomy proposal receipts](autonomy-proposal-receipts.md): W4.1
  proposal-only receipt boundary for autonomy changes, Hugin-owned targets,
  canonical signed receipts, and Gille roster provenance binding.
- [Durable M5 lifecycle](mcp-durable-m5-lifecycle.md): Hugin-to-M5 delegation
  lifecycle, gateway authority, provenance sanitization, and the boundary that
  Hugin must not invent competing capability truth.
- [Security-critical holes plan](security-critical-holes-engineering-plan.md):
  First-pass engineering plan for legacy Claude spawn removal, outbound egress
  control, and context-ref enforcement.
- [Security-critical holes live evaluation](security-critical-holes-live-evaluation.md):
  Live `huginmunin` validation of the first security-hardening pass.
- [Exfiltration scanner](security/exfiltration-scanner.md): Result-output
  scanner that looks for secret or data exfiltration patterns in task results.
- [Lethal trifecta assessment](security/lethal-trifecta-assessment.md):
  Security research tying Munin/Hugin trust-boundary risks to the scanner and
  provenance roadmap.
- [Privacy filter evaluation](security/privacy-filter-evaluation.md): Empirical
  results for local PII redaction using the OpenAI privacy-filter lane.
- [Prompt-injection scanner](security/prompt-injection-scanner.md): Context-ref
  prompt-injection detector and its fail-closed behavior.
- [Provenance enforcement](security/provenance-enforcement.md): Rules for
  Context-refs, external-source provenance, and classification/policy
  enforcement before context injection.
- [Tailscale Orin ACL audit](security/tailscale-orin-acl-audit.md): Read-only
  audit of Orin SSH access and the YubiKey/FIDO2 bypass risk.
- [Task signing](security/task-signing.md): Cryptographic task signatures,
  `claimedSubmitter` vs `verifiedSubmitter`, key rollout, and `off`/`warn`/`require`
  policy behavior.

## Execution, orchestration, and scheduling

- [Autonomy R-exact mutation controller](autonomy-r-exact-controller.md):
  Disarmed ADR-008 controller for macro-routing, prompt, harness, and
  tool-policy, including authority checks, durable sequencing, and recovery
  requirements.
- [Hugin v2 engineering plan](hugin-v2-engineering-plan.md): Multi-phase
  rollout plan and status summary for the pipeline/orchestrator architecture.
- [Hugin v2 pipeline orchestrator](hugin-v2-pipeline-orchestrator.md):
  Post-debate design for pipeline phases, gated authority, and runtime
  envelopes.
- [Hugin R-exact configuration store](hugin-r-exact-config-store.md):
  Owner-installed durable macro-routing store, fail-closed selector behavior,
  closed bounds, Linux locking, and atomic rename semantics.
- [Orchestrator redesign](orchestrator-redesign.md): Accepted re-platforming
  ADR for synthesizer/worker orchestration.
- [Orchestrator savings tracker](orchestrator-savings-tracker.md): Saved-USD
  accounting against an all-Claude baseline for orchestrator runs.
- [Orchestrator v1 historical data model](orchestrator-v1-data-model.md):
  Superseded v1 delegation contract, still relevant when reading historical
  envelopes and JSONL events.
- [Orchestrator verdict layer](orchestrator-verdict-layer.md): Design for
  synthesizer verdict storage, worker-result separation, and D5/D6 execution
  accounting.
- [Phase 4 human gates plan](phase4-human-gates-engineering-plan.md):
  Engineering plan for approvals on side-effecting pipeline phases.
- [Phase 5 sensitivity classification plan](phase5-sensitivity-classification-engineering-plan.md):
  Sensitivity lattice, prompt/context/refs classification, and runtime ceilings.
- [Phase 6 router plan](phase6-router-engineering-plan.md): `Runtime: auto`
  routing plan after sensitivity classification.
- [Scheduling FIFO hardening](scheduling-fifo-hardening.md): Deterministic
  pending-task ordering, paginator handling, and tie-break rules.
- [Scheduling shadow lanes](scheduling-shadow-lanes.md): Shadow bounded-SEJF /
  work-minute admission and runtime-estimator behavior.
- [Step 1 parent/child joins](step1-parent-child-joins.md): Early pipeline
  spec for parent/child task joins in Hugin v2.

## Learning, evaluation, and evidence

- [Continuous Hugin/M5 learning loop](continuous-learning-loop.md): Live
  cadence, admitted-attempt capture, and the broader continuous-learning state.
- [Daily-use exam factory](daily-exam-factory.md): How completed
  managed-repository tasks become Harbor candidates with provisional holdout,
  regression, and quarantine lanes.
- [Harbor Gate D proof-of-fit](harbor-gate-d-pilot.md): Pilot constraints for
  Harbor as an isolated execution and verification lab.
- [Harness-lane standing sampler](harness-lane-standing-sampler.md): Managed
  Claude/Codex mutation-lane sampler and comparison reporting.
- [Learning registry](learning-registry.md): Durable append-only task/outcome
  learning registry and the current capture status.
- [LearningTaskContract producer handshake](learning-task-handshake.md):
  Producer-side handshake and joint live-smoke gate for learning evidence.
- [Organic micro-experiments](organic-micro-experiments.md): Default-off,
  content-blind plan/result seam for one bounded non-blocking M5 shadow,
  wired only for the narrow authenticated Broker homeserver envelope lane.
- [AI user testing review](ai-user-testing-review.md): Human-oriented review of
  the Hugin codebase and operator experience.
- [AI user testing review (Codex)](ai-user-testing-review-codex.md): Codex-led
  test review and findings snapshot for the same codebase.
- [Munin 429 hardening live evaluation](munin-429-hardening-live-evaluation.md):
  Live validation of Munin 429-handling hardening.
- [Munin hardening reviewer 2 fix validation](munin-hardening-reviewer2-fix-validation.md):
  Follow-up validation of reviewer-driven Munin hardening fixes.
- [Phase 5 corpus evaluation](phase5-corpus-evaluation.md): Corpus-based
  validation of sensitivity classification.

## Historical live validations and tickets

- [Step 1 live evaluation](step1-live-evaluation.md): Live dispatcher
  validation of the first Hugin v2 step on `huginmunin`.
- [Step 2 bug report](step2-bug-report.md): Pipeline-compiler defect report
  from Step 2 feature testing.
- [Step 2 live evaluation](step2-live-evaluation.md): Production validation of
  Step 2 behavior.
- [Step 3 bug report](step3-bug-report.md): Structured-artifact defect report
  from Step 3 feature testing.
- [Step 3 cancellation live evaluation](step3-cancellation-live-evaluation.md):
  Cancellation-path validation for Step 3 tasks.
- [Step 3 follow-up fix validation](step3-follow-up-fix-validation.md): Live
  verification of follow-up fixes from Step 3 findings.
- [Step 3 live evaluation](step3-live-evaluation.md): Step 3 live dispatcher
  evaluation before the follow-up fix pass.
- [Step 3 resume live evaluation](step3-resume-live-evaluation.md): Resume and
  recovery validation for Step 3 tasks.
- [Step 4 live evaluation](step4-live-evaluation.md): Live validation of
  human-gated side effects.
- [Pipeline parent drops type tags on success](ticket-pipeline-parent-drops-type-tags-on-success.md):
  Medium-severity ticket on parent lifecycle tag loss.
- [Pipeline parent result omits routing metadata](ticket-pipeline-parent-result-omits-routing-metadata.md):
  Medium-severity ticket on missing routing metadata in parent results.

## Design, research, and debate archives

- [Autonomous dependency-bump design](design/autonomous-dependency-bumps.md):
  Planned path from security-scan results to autonomous dependency PRs.
- [OpenAI privacy filter eval design](design/openai-privacy-filter-eval.md):
  Evaluation plan for local PII redaction using an OpenAI privacy-filter lane.
- [Quality-efficient agent orchestration plan](design/quality-efficient-agent-orchestration-plan.md):
  Evaluation and implementation plan for evidence-gated routing across
  conductor, worker, verifier, and reviewer roles.
- [Skill distillation implementation spec](design/skill-distillation-implementation.md):
  Planned RouteBinding/TaskClassifier implementation for eval-gated skill
  distillation.
- [Skill distillation debate index](decisions/skill-distillation/INDEX.md):
  Entry point for the skill-distillation cross-model debate record.
- [Skill distillation draft](decisions/skill-distillation/skill-distillation-claude-draft.md):
  Claude's initial architecture proposal for eval-gated skill distillation.
- [Skill distillation response round 1](decisions/skill-distillation/skill-distillation-claude-response-1.md):
  Claude's response to the first critique round.
- [Skill distillation self-review](decisions/skill-distillation/skill-distillation-claude-self-review.md):
  Claude's self-review of the proposal and critique handling.
- [Skill distillation critique](decisions/skill-distillation/skill-distillation-codex-critique.md):
  Codex critique of the original proposal.
- [Skill distillation rebuttal round 1](decisions/skill-distillation/skill-distillation-codex-rebuttal-1.md):
  Codex follow-up rebuttal after Claude's response.
- [Skill distillation summary](decisions/skill-distillation/skill-distillation-summary.md):
  Debate outcome, key decisions, and the accepted direction.
- [Agent orchestration experiments](research/agent-orchestration-experiments.md):
  Cross-disciplinary experiment ideas for multi-agent orchestration.
- [Journal analysis scoping](research/journal-analysis-scoping.md): Draft scope
  for a falsifiable go/no-go evaluation of the orchestrator stack.
- [M5 task-solver dogfood finding, July 2026](research/m5-task-solver-dogfood-2026-07.md):
  Evidence note from local M5 task-solver dogfooding.
- [Ollama performance spike](research/ollama-performance-spike.md): Early
  investigation into Pi-side timeout and model-selection performance issues.
- [Orchestrator stack v1 scope](research/orchestrator-stack-v1-scope.md):
  Historical scope doc superseded by the v1 data-model contract.
- [Orchestrator sweep](research/orchestrator-sweep.md): Adopt-vs-DIY research
  on multi-host placement for Hugin.
- [Quality-efficient agent orchestration](research/quality-efficient-agent-orchestration-2026-08.md):
  Dated research and adversarial debate on allocating differently constrained
  model capacity for quality with limited human intervention.
