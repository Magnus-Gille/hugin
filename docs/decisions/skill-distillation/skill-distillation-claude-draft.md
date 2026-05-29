# Eval-Gated Skill Distillation as a Hugin Sub-Capability

**Debate type:** architecture
**Premise (fixed, not up for debate):** We are building this. Do not argue "gather data first" or "validate the premise." Argue *how* to build it well.

## The concept

From Tunguz's "Pi agent skill distillation": frontier models author atomic `SKILL.md`
procedures *and* the evals that grade them; a smaller local model executes the
Plan→Tool→Observe→Refine loop using those skills; a local markdown KB is retrieved
first to fetch the right playbook. Distillation here means transferring *procedures*
(retrievable text), not compressing weights.

## Grimnir mapping (established)

- **L1 procedural KB** → Munin (SQLite + FTS5 + sqlite-vec + CAS). Superior to QMD's flat markdown.
- **L2 skills + evals** → existing `~/.claude/skills/`. The frontier-authored **eval loop** is the gap.
- **L3 agent loop / local executor** → Hugin (Pi task dispatcher) in its **fire-and-forget batch lane**.

## Proposed design: "eval-gated skill promotion"

1. **Author** — Opus writes `SKILL.md` + a deterministic grader (the eval).
2. **Validate** — run the grader against a specific local `(harness, wrapper, model)` cell
   using the existing eval matrix from `home-server-inference-evaluation`.
3. **Promote** — on pass, tag the skill local-executable in Hugin's runtime registry
   (`validatedSkills` field alongside the proposed `parsesToolCalls` flag).
4. **Route** — Hugin sends matching *batch* tasks to the local cell; cloud fallback otherwise.

## Assumptions (load-bearing)

- A1. A skill that passes a frontier-written eval *on the target local cell* will generalize
  to real batch tasks of the same class. (The eval is a sufficient proxy for fitness.)
- A2. Skills can be authored at a granularity a 30B local model executes reliably — i.e. the
  procedure carries enough of the reasoning that the small model is mostly doing
  pattern-following, not open-ended planning.
- A3. The promotion unit is the `(skill, harness, wrapper, model)` tuple, not the skill alone.
  A skill is never "validated" in the abstract.
- A4. Munin retrieval (hybrid FTS5 + vector) is good enough to fetch the right playbook with
  high precision; we do not need a separate procedural index.
- A5. Most failures are detectable mid-loop (tool-call parse failure, schema violation, eval
  assertion failure) cheaply enough to trigger cloud escalation before wasting the full
  10min–3h batch budget.

## Failure modes

- **F1 — Eval overfit / Goodhart.** Opus writes both skill and grader; it can author a grader
  the skill trivially passes. The eval becomes a rubber stamp, not a gate. Blast radius: every
  promoted skill is suspect; silent quality rot in the batch lane.
- **F2 — Cell drift.** A skill validated on `(pi, LM Studio, Qwen3-Coder-30B-4bit)` is silently
  reused after the wrapper updates or the model is requantized. Promotion outlives its validity.
- **F3 — Retrieval miss.** Wrong playbook retrieved → local model executes a plausible-but-wrong
  procedure confidently. Worse than no skill, because it looks authoritative.
- **F4 — Mid-loop botch with no cheap detector.** Local model drifts off-procedure in a way the
  grader can't catch until the end; we burn hours then escalate to cloud anyway → distillation
  is net-negative on cost and latency.
- **F5 — Authoring burden.** Every skill now needs a maintained eval. If the eval cost dominates,
  the library stops growing and the capability rots.

## Alternatives rejected

- **AR1 — Fine-tune / LoRA the local model on the skills** (true weight distillation). Rejected:
  loses inspectability/versionability, re-trains on every skill change, no per-skill gating.
- **AR2 — No eval gate; promote skills by hand.** Rejected: that's the status quo and gives no
  confidence the local cell can actually run the skill. The eval *is* the contribution.
- **AR3 — Dedicated procedural index separate from Munin.** Rejected (tentatively): duplicates
  Munin's retrieval substrate; Munin is already superior to QMD. Open to challenge.
- **AR4 — Interactive local execution.** Rejected by hardware reality: 10min–3h/task on 32GB Air.
  Batch-only is non-negotiable on current hardware.

## Unknowns

- U1. Right grading modality: exact-match assertions, LLM-judge, or hybrid? Determinism vs. coverage.
- U2. Promotion/demotion lifecycle when *either* the skill *or* the cell changes — who triggers
  re-validation, and is a stale promotion fail-closed (demote on any change) or fail-open?
- U3. Whether the smallest viable slice should be a coding skill (verifiable by tests) or a
  non-coding skill (email triage, file ops) where the grader is harder but the value is clearer.
- U4. How much of the "skill" should be procedure text vs. embedded few-shot exemplars for a
  30B model to be reliable.

## Smallest vertical slice (proposed)

One skill (a coding skill with a test-suite grader, e.g. "apply a lint-fix across a repo"),
one local cell `(pi, LM Studio, Qwen3-Coder-30B)`, one eval. Prove: author → grade → promote →
Hugin routes a batch task to it → cloud fallback on grader failure. If this slice's *total*
cost/latency beats just running the task on cloud, the architecture is justified.
