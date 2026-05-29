# Self-Review

## Debate Type
Primary: architecture

## Universal checklist

- **Assumptions that might not hold:** A1 (eval-as-proxy) is the weakest. A frontier-written eval
  proves the skill *can* be executed on a curated input, not that retrieval will surface it on the
  right task or that real inputs match the eval distribution. A4 (Munin retrieval sufficiency) is
  asserted, not shown — procedural retrieval has a different precision requirement than the
  decision/context retrieval Munin is tuned for. Wrong playbook is worse than no playbook (F3).

- **Failure modes — exhaustive?** Missing: **versioning/provenance of the promotion record** (which
  Opus version authored skill + eval; reproducibility of the validation run). Missing: **eval
  environment parity** — the grader must run in the same tool/MCP environment the local model will
  have at execution time, or the gate tests a different system than it ships. Missing: **concurrency/
  resource contention** — the eval matrix and live batch tasks competing for the same ~21GB Metal cap.

- **Strongest argument against my position:** "eval-gated skill promotion" may be the wrong primitive.
  The real unit might be the **task class → (skill, cell) binding** with a measured success rate, not a
  binary promoted/not flag. A binary gate throws away the calibration signal (passed 24/27) that the
  prior eval work showed is the actual texture of local-model performance.

- **Missing baseline:** The slice's success criterion ("beats cloud on cost/latency") ignores that
  cloud is fast *and* cheap for many tasks now. The honest baseline may be "beats cloud on
  cost/latency *for tasks where data privacy or offline operation is required*" — otherwise the whole
  thing is dominated by just calling cloud.

- **Hidden operational burden:** Every skill change forces an eval re-run on every registered cell
  (combinatorial). The registry's `validatedSkills` becomes a matrix that must be invalidated
  correctly on three independent change axes (skill, wrapper, model). This is the real maintenance
  cost and the draft understates it (F5 names it but doesn't size it).

## Architecture-specific checklist

- **Scale assumptions:** Library assumed to stay small enough that re-validation is tractable. Unstated.
- **Coupling introduced:** Hugin routing now depends on Munin retrieval quality + eval matrix +
  wrapper capability flags. Three new coupling points; degradation in any silently degrades routing.
- **Degradation under partial failure:** If Munin retrieval is down, does Hugin fail-closed to cloud
  (safe, costs money) or skip the skill (risky)? Undecided in draft.
- **Reversibility:** High — it's additive to Hugin; can be turned off by clearing `validatedSkills`.
  This is a genuine strength worth stating.

## Points I expect Codex to raise (pre-registering to test self-review catch rate)
- Goodhart on self-authored evals (F1) needs a structural fix, not just naming.
- Binary promotion vs. calibrated success-rate routing.
- Eval/execution environment parity.
- Demotion lifecycle is under-specified (U2).
