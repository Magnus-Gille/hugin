# Context Loaded

## Memory Calls

Called the requested Munin tools in order, then stopped using memory tools:

1. `memory_read(namespace: 'projects/hugin', key: 'status')`
2. `memory_read(namespace: 'decisions/local-llm-harness', key: 'lessons')`
3. `memory_query(query: 'skill distillation local model eval Hugin routing', tags: ['decision'], limit: 5)`
4. `memory_read(namespace: 'research/qmd-analysis', key: 'architecture')`

Model: Codex, GPT-5-based coding agent.

## Notable Gaps Or Conflicts With Memory

- The draft assumes Hugin can already route batch work to the local executor (`debate/skill-distillation-claude-draft.md:18`, `debate/skill-distillation-claude-draft.md:27`, `debate/skill-distillation-claude-draft.md:80`), but Munin says the broker is not enabled on Pi and #77 crash-recovery liveness is still blocking completion of the current Pi e2e. That is not a reason to stop this build, but it is a build-order constraint the design currently hides.
- The draft says Munin is "superior to QMD's flat markdown" (`debate/skill-distillation-claude-draft.md:16`). The QMD architecture memory contradicts the "flat markdown" characterization: QMD has hybrid FTS/vector retrieval, query expansion, chunk reranking, context hierarchy, LLM caching, AST-aware chunking, and graceful degradation. Munin may still be the right substrate, but the argument in the draft is not supported.
- The draft maps L2 directly to existing `~/.claude/skills/` (`debate/skill-distillation-claude-draft.md:17`). The memory query surfaced a prior decision on `decisions/skills-in-munin/round-2-verdict`: the portable unit is not a Claude skill in the abstract, but at best a rewritten derivative. The draft needs to treat this as a first-class constraint.
- The local harness lessons strongly support the tuple instinct in A3 (`debate/skill-distillation-claude-draft.md:36`), but they also show the tuple is still underspecified. The actual unit is closer to `(task class, skill package, harness config, wrapper, model file, thinking format, context cap, hardware envelope, tool environment)`.
- The Hugin routing decision in memory includes provider, egress, `zdrRequired`, and `autoEligible` as orthogonal fields. The draft's "cloud fallback otherwise" path (`debate/skill-distillation-claude-draft.md:27`, `debate/skill-distillation-claude-draft.md:84`) does not yet respect those policy axes.

# Critique

## Strengths

The draft gets several important things right.

First, it scopes "distillation" to procedures, not weights (`debate/skill-distillation-claude-draft.md:8` to `debate/skill-distillation-claude-draft.md:12`). That preserves inspectability, reversibility, and per-skill gating.

Second, A3 is the right instinct: a skill is never validated in the abstract (`debate/skill-distillation-claude-draft.md:36` to `debate/skill-distillation-claude-draft.md:37`). This aligns directly with the local harness lessons: wrapper behavior, tool-call parsing, model family, thinking format, context cap, and harness behavior form one operational cell.

Third, batch-only routing is correctly treated as non-negotiable on current hardware (`debate/skill-distillation-claude-draft.md:67` to `debate/skill-distillation-claude-draft.md:68`). Munin's local harness lessons show 10 minutes to nearly 3 hours per task for Qwen3-Coder-30B on the 32 GB Air. The draft does not pretend that is interactive.

Fourth, the failure modes are not cosmetic. Eval overfit, cell drift, retrieval miss, late failure, and authoring burden are the right family of risks (`debate/skill-distillation-claude-draft.md:44` to `debate/skill-distillation-claude-draft.md:57`). The self-review also correctly identifies binary promotion and environment parity as missing depth (`debate/skill-distillation-claude-self-review.md:14` to `debate/skill-distillation-claude-self-review.md:23`).

The problem is not that the design is naive. The problem is that it compresses several hard contracts into labels like `validatedSkills`, "Munin retrieval", and "cloud fallback". Those need to become explicit build artifacts.

## Major Findings

### 1. Hugin's current runtime state is a build blocker for the proposed vertical slice

The proposed slice ends with "Hugin routes a batch task to it" (`debate/skill-distillation-claude-draft.md:83` to `debate/skill-distillation-claude-draft.md:84`). Munin says Hugin is not at that operational point yet: the broker is not enabled on Pi, and #77 crash-recovery liveness remains unresolved. The specific failure is highly relevant here: a delivery crash plus auto-restart can leave a task non-terminal until a second post-lease-expiry restart.

That matters more for skill distillation than for a toy dispatcher because this design is explicitly accepting 10 minute to 3 hour local runs (`debate/skill-distillation-claude-draft.md:40` to `debate/skill-distillation-claude-draft.md:42`, `debate/skill-distillation-claude-draft.md:67` to `debate/skill-distillation-claude-draft.md:68`). A liveness bug in that lane does not merely slow the run. It can strand a route decision, delay fallback, and make the system look "in progress" when it should have terminalized and escalated.

Concrete design change:

- Make #77-class crash recovery an explicit precondition for the e2e slice.
- Add a "kill during local skill execution" acceptance test to the slice, not just "cloud fallback on grader failure" (`debate/skill-distillation-claude-draft.md:84`).
- Require stable worker identity, lease expiry reconciliation, idempotent artifact delivery, and startup reconciliation before any promoted local route can be considered active.
- Treat local execution as a task state machine with terminal states, not as a best-effort subprocess behind the router.

This is not a "validate the premise first" objection. It is a sequencing requirement for building the premise without inheriting a known runtime failure.

### 2. "Eval-gated skill promotion" is the wrong primitive

The draft's proposed primitive is "promote a skill" by tagging it local-executable in Hugin's runtime registry (`debate/skill-distillation-claude-draft.md:20` to `debate/skill-distillation-claude-draft.md:27`). A3 partially corrects this by saying the promotion unit is `(skill, harness, wrapper, model)` (`debate/skill-distillation-claude-draft.md:36` to `debate/skill-distillation-claude-draft.md:37`). The self-review goes further and notes that the real unit may be `task class -> (skill, cell) binding` with a measured success rate (`debate/skill-distillation-claude-self-review.md:20` to `debate/skill-distillation-claude-self-review.md:23`).

The self-review is right. A binary `validatedSkills` flag throws away the signal the prior local eval work showed is decisive: partial pass rates, per-task durations, failure modes, context sensitivity, and wrapper-specific behavior. The local harness lessons did not say "Qwen3-Coder works" or "does not work"; they said specific cells produce specific score and latency profiles under specific wrapper and context settings.

Better decomposition:

- `SkillPackage`: portable procedure, tool contract, examples, safety constraints, eval suite references.
- `TaskClass`: the class of user/task inputs the skill claims to handle, with routing predicates and contraindications.
- `CellManifest`: harness, wrapper, model file/hash, quantization, context cap, thinking format, tool-call parsing behavior, hardware envelope, tool/MCP environment, and timeout budgets.
- `EvalSuite`: deterministic fixtures, negative fixtures, retrieval fixtures, mutation tests, grader code, expected artifacts, and allowed nondeterminism.
- `RouteBinding`: `(taskClass, skillPackageVersion, cellManifestVersion, evalSuiteVersion) -> policy`, with calibrated metrics and current state.

The thing Hugin should route on is the `RouteBinding`, not a skill-level flag. A route binding can be active, shadow, quarantined, stale, or disabled. It can carry thresholds and telemetry. A skill cannot.

### 3. The draft treats Claude `SKILL.md` as too portable

The draft maps L2 directly to existing `~/.claude/skills/` (`debate/skill-distillation-claude-draft.md:17`) and says Opus writes `SKILL.md` plus a deterministic grader (`debate/skill-distillation-claude-draft.md:22`). The memory query surfaced a prior decision that directly challenges this: the portable unit is not a Claude skill, but at best a rewritten derivative.

This is not academic. Claude skills often assume Claude-specific context loading, tool affordances, instruction-following ability, and interaction shape. A 30B local model executing through `pi` and LM Studio is a different runtime. The draft acknowledges granularity risk in A2 (`debate/skill-distillation-claude-draft.md:33` to `debate/skill-distillation-claude-draft.md:35`), but it still anchors the artifact on raw `SKILL.md`.

Concrete design change:

- Define a runtime-neutral "procedure package" as the source artifact.
- Generate or store target profiles from that package: `claude-skill`, `pi-local-30b`, perhaps `codex`.
- The `pi-local-30b` profile should be stricter than a Claude skill: bounded inputs, explicit allowed tools, short step list, checkpoint after each step, fixed output schema, examples, anti-examples, and abort conditions.
- Promotion should apply to a package profile, not to the human-facing Claude skill file.

This preserves compatibility with `~/.claude/skills/` while avoiding the false abstraction that an existing Claude skill is automatically the thing a local 30B model can execute.

### 4. The Munin vs QMD argument is underbuilt and partly false

The draft asserts that Munin is the procedural KB and is "superior to QMD's flat markdown" (`debate/skill-distillation-claude-draft.md:16`). It then assumes Munin retrieval is enough to fetch the right playbook (`debate/skill-distillation-claude-draft.md:38` to `debate/skill-distillation-claude-draft.md:39`) and tentatively rejects a dedicated procedural index as duplication (`debate/skill-distillation-claude-draft.md:65` to `debate/skill-distillation-claude-draft.md:66`).

That is too casual. The QMD memory describes a serious retrieval system, not flat markdown: content-addressed SQLite storage, FTS5, sqlite-vec, query expansion, RRF fusion, chunk reranking, hierarchical context, AST-aware chunking, and graceful fallback. The lesson is not "use QMD instead." The lesson is that procedural retrieval has a shape, and the draft does not specify that shape.

Munin can still be the substrate, but it needs a procedural index layer or procedural collection schema inside Munin. That is different from building a separate storage system.

Minimum procedural retrieval fields:

- skill id and profile id
- task class
- trigger phrases
- required inputs
- required tools
- contraindications
- privacy/egress constraints
- expected artifacts
- eval confidence and known failure modes
- examples and hard negatives
- version hashes

The retrieve-first contract should also be fail-closed:

- If no result clears a confidence threshold, route to cloud or ask for explicit route policy.
- If the top two skills are too close, abstain rather than letting the local model improvise.
- If Munin is unavailable, do not run local by default.
- If retrieval returns a skill whose route binding is stale or quarantined, do not run it.

Wrong playbook retrieval is already identified as worse than no skill (`debate/skill-distillation-claude-draft.md:51` to `debate/skill-distillation-claude-draft.md:52`). The architecture should reflect that, not simply trust hybrid search.

### 5. Versioning and provenance need to be immutable run records, not registry fields

Cell drift is correctly named (`debate/skill-distillation-claude-draft.md:49` to `debate/skill-distillation-claude-draft.md:50`), and U2 asks who triggers revalidation (`debate/skill-distillation-claude-draft.md:72` to `debate/skill-distillation-claude-draft.md:74`). But the proposed registry mechanism, `validatedSkills` alongside `parsesToolCalls` (`debate/skill-distillation-claude-draft.md:25` to `debate/skill-distillation-claude-draft.md:26`), is not enough to answer that question.

The local harness lessons show why. Tool-call parsing lives in the wrapper, thinking-format flags are silent foot-guns, LM Studio's context cap changes memory behavior, and model plus harness plus wrapper must be treated as a single operational unit. A promotion record that omits any of those is not reproducible.

Promotion records should be immutable and content-addressed. Store at least:

- skill package hash and profile hash
- eval suite hash and grader hash
- prompt/system instruction hash
- harness name and version
- wrapper name and version
- model id, file hash, quantization, and context cap
- thinking format and reasoning flags
- tool-call parser capability and observed parser test result
- OS, hardware class, memory cap, and concurrency budget
- tool/MCP environment manifest
- execution timeout and step budgets
- result metrics, logs, artifacts, and failure classifications

Then maintain a mutable pointer saying which route binding is currently active. The mutable pointer can be small. The evidence behind it cannot be.

### 6. The eval design needs a structural anti-Goodhart fix

F1 identifies the core problem: Opus writes both the skill and the grader (`debate/skill-distillation-claude-draft.md:46` to `debate/skill-distillation-claude-draft.md:48`). U1 leaves grading modality open (`debate/skill-distillation-claude-draft.md:72`). Naming the risk is not enough.

A deterministic grader is necessary but not sufficient. If the same frontier author creates the procedure and the only acceptance test, the system can converge on skills that pass stylized fixtures but fail real tasks.

Build-level fix:

- Split evals into positive fixtures, negative fixtures, retrieval fixtures, and mutation tests.
- Require at least one independent oracle per promoted route: test suite, schema validator, snapshot diff, static analyzer, or independent judge model.
- Treat LLM-judge as advisory unless paired with deterministic checks.
- Add "should abstain" cases where retrieval must not select the skill.
- Add adversarial inputs that look similar to the skill's trigger but require a different procedure.
- Record not just pass/fail, but the reason a failure was caught: retrieval, preflight, tool-call parser, schema, tests, timeout, or final grader.

This is still build design. It does not say "collect more data before deciding." It says the eval package has to test the route, not just the happy path execution.

### 7. Mid-loop cloud escalation is not yet a safe state transition

A5 assumes most failures are detectable mid-loop cheaply enough to avoid wasting the full local budget (`debate/skill-distillation-claude-draft.md:40` to `debate/skill-distillation-claude-draft.md:42`). F4 admits the opposite can happen (`debate/skill-distillation-claude-draft.md:53` to `debate/skill-distillation-claude-draft.md:55`). The vertical slice then says cloud fallback on grader failure (`debate/skill-distillation-claude-draft.md:84`).

That is not a complete failure model. Once a local coding skill has mutated a workspace, cloud fallback is not a clean retry unless the task ran in an isolated worktree or produced a patch artifact that can be discarded. Once a local process has held a lease for an hour and crashed, fallback is not clean unless Hugin can terminalize or reconcile the run. Once retrieval selected the wrong skill, the grader may fail only after the local model has done expensive or destructive work.

Concrete design change:

- Run local skill execution in an isolated worktree or sandbox.
- Treat local output as an artifact or patch, not as direct mutation of the user's live working tree.
- Add preflight checks before model execution: route binding active, tool environment present, wrapper parser smoke test, context budget, and input schema.
- Add step budgets: maximum tokens, maximum wall time, maximum tool calls, maximum no-op turns, maximum invalid tool calls.
- Add early abort detectors: no tool calls after N turns, invalid tool args twice, no file changes by checkpoint, repeated same observation, context near cap, wrapper content-only response when tool calls are required.
- Cloud fallback should consume the original task snapshot plus any validated intermediate artifact, not a dirty workspace.

Without these mechanics, "cloud escalation" is a phrase, not an architecture.

### 8. Cloud fallback must respect Hugin route policy

The draft says Hugin sends matching batch tasks to local and uses cloud fallback otherwise (`debate/skill-distillation-claude-draft.md:27`). The vertical slice also includes cloud fallback on grader failure (`debate/skill-distillation-claude-draft.md:84`).

The Hugin decision memory says routing has orthogonal provider, egress, `zdrRequired`, and `autoEligible` fields. That means fallback cannot be unconditional. Some tasks may be local-only because of privacy, offline constraints, egress rules, or ZDR requirements. Others may be cloud-eligible but not auto-eligible.

The route binding needs a fallback policy:

- `cloudAllowed`
- `autoEscalateAllowed`
- `requiresUserApproval`
- `zdrRequired`
- `egressClass`
- `maxCloudCost`
- `fallbackProviderSet`
- `fallbackOnFailureKinds`

This should be decided before execution, not after a local failure when the system is under pressure to recover.

## Additional Architecture Risks

### Scale and load assumptions

The draft says every skill needs a maintained eval (`debate/skill-distillation-claude-draft.md:56` to `debate/skill-distillation-claude-draft.md:57`), and the self-review notices combinatorial revalidation (`debate/skill-distillation-claude-self-review.md:30` to `debate/skill-distillation-claude-self-review.md:33`). The design still does not size the matrix.

The matrix is not just `skills x cells`. It is:

`task classes x skill profiles x eval suites x harness configs x wrappers x model versions x context caps x hardware envelopes x tool environments`.

The first build does not need to solve the full matrix, but it should avoid a schema that pretends the matrix is a list of strings. Put the matrix in the data model now, then start with one row.

Also, the local harness lessons show the 32 GB Air has a real Metal wired-memory ceiling. Eval runs and live batch jobs must not compete blindly. The scheduler needs a capacity model: one local heavy job at a time unless proven otherwise, queued evals, and no eval run starving production work.

### Coupling

The design couples Hugin routing to all of these:

- Munin retrieval quality
- skill package structure
- eval suite quality
- local wrapper behavior
- model context and memory behavior
- Hugin artifact delivery
- cloud fallback policy

That coupling is acceptable only if each boundary has an explicit contract. The current draft mostly names the components but does not define the contracts. The highest-risk hidden coupling is retrieval-to-execution: a retrieval miss can become a local execution decision.

### Partial failure and degradation

Define behavior for these cases:

- Munin unavailable
- Munin returns low-confidence or tied skills
- skill package found but route binding stale
- local wrapper up but tool-call parsing fails
- local model starts but context cap is exceeded
- local job exceeds duration budget
- local job mutates workspace but grader fails
- Hugin delivery crashes mid-run
- cloud fallback disallowed by policy
- eval runner unavailable during revalidation

Default should be fail-closed for local execution. That usually means cloud route if policy allows, queue for user approval if policy requires it, or mark blocked if neither is legal.

### Operational burden

This feature needs first-class telemetry from day one:

- route decision and alternatives considered
- retrieval query, top candidates, scores, and abstention reason
- route binding id and version hashes
- cell manifest id
- wrapper parser preflight result
- wall time, token count, tool-call count, invalid tool-call count
- checkpoint progress
- grader result
- fallback reason
- final artifact id
- cloud cost, if escalated

Without this, incident response will be guesswork. A bad promoted route will look like "local is flaky" rather than "skill profile v3 on LM Studio wrapper vX with context cap Y fails retrieval-negative case Z."

### Reversibility

The self-review says reversibility is high because this is additive and can be disabled by clearing `validatedSkills` (`debate/skill-distillation-claude-self-review.md:42` to `debate/skill-distillation-claude-self-review.md:43`). That is too optimistic if the system is built around a `validatedSkills` field.

Reversibility is high only if:

- route bindings are separate from skill packages
- local routing is behind a feature flag
- local execution writes only isolated artifacts until accepted
- disabling a route binding leaves cloud routing intact
- stale or quarantined bindings cannot be selected by retrieval
- schema migrations do not make existing tasks depend on local-only fields

Clearing a flag is not enough once retrieval, task classification, Hugin routing, and eval lifecycle have been coupled.

### Security and policy

The draft does not mention tool allowlists, sandboxing, secrets, egress, signing, or artifact trust. Munin's Hugin status lists HMAC signing secrets, signing policy, and exfil/external policies as carry-forward work. Skill distillation increases the importance of those policies because a frontier-authored procedure and grader can effectively grant operational permissions to a smaller local model.

Minimum policy controls:

- skill-level tool allowlist
- task-level egress policy
- no secret access unless explicitly required and audited
- sandboxed grader execution
- signed skill/eval packages or at least content-addressed manifests
- artifact provenance: which route binding produced this output
- cloud fallback policy checked before execution

## Unsupported Claims And Missing Baselines

- "Munin is superior to QMD's flat markdown" is unsupported and partly contradicted by the QMD memory (`debate/skill-distillation-claude-draft.md:16`).
- "The eval is a sufficient proxy for fitness" is the weakest load-bearing assumption (`debate/skill-distillation-claude-draft.md:31` to `debate/skill-distillation-claude-draft.md:32`). The design should not depend on a single frontier-written grader as the proxy.
- "Most failures are detectable mid-loop cheaply" is asserted, not established (`debate/skill-distillation-claude-draft.md:40` to `debate/skill-distillation-claude-draft.md:42`). Build detectors, budgets, and rollback around the assumption being false sometimes.
- The vertical slice's "beats cloud on cost/latency" criterion (`debate/skill-distillation-claude-draft.md:84` to `debate/skill-distillation-claude-draft.md:85`) is the wrong success criterion for a premise-fixed build. Track cloud cost/latency as a baseline, but do not make the architecture's first slice justify itself that way. The first slice should prove route correctness, fail-closed behavior, reproducible promotion, crash recovery, and clean fallback.
- The draft omits a baseline for "no skill retrieved" and "wrong skill retrieved." Retrieval baselines are part of the build, not a pre-build validation exercise.

## Direct Answers To The Six Debate Questions

### 1. Is "eval-gated skill promotion" the right primitive?

No. The right primitive is a versioned route binding:

`(task class, skill package profile, cell manifest, eval suite) -> active routing policy and calibrated metrics`.

Skill promotion is too broad. Cell promotion is too broad. A boolean gate is too lossy. The route binding should carry score distribution, latency, failure modes, stale status, fallback policy, and provenance.

### 2. How should skills be authored so a 30B local model executes them reliably?

Do not author them as general Claude skills and hope the local model follows them. Author a runtime-neutral procedure package, then compile or adapt a strict `pi-local-30b` profile.

The 30B-safe profile should have:

- short bounded procedure
- explicit input schema
- explicit output schema
- tool allowlist
- one-step-at-a-time checkpoints
- examples and anti-examples
- "do not proceed if" abort conditions
- maximum context budget
- expected artifacts
- local grader hooks after intermediate steps where possible

The local model should be treated less like a planner and more like a constrained operator executing a playbook with guardrails.

### 3. Where should evals live, and how should versioning/promotion/demotion work?

Evals should live adjacent to the skill package in the source repo, not inside Hugin's runtime registry as opaque metadata. Hugin should store or reference immutable validation run records and maintain only the active route pointer.

Suggested lifecycle:

- `draft`: package exists, no active route.
- `candidate`: eval suite exists and can run.
- `shadow`: route is evaluated but not selected for real work.
- `active`: route can be selected when policy allows.
- `stale`: one of the package, eval, cell, wrapper, model, tool environment, or policy hashes changed.
- `quarantined`: production failure or regression detected.
- `disabled`: manually turned off.

Demotion should be fail-closed on hash drift. Re-promotion should require a new immutable validation run.

### 4. Munin retrieval vs dedicated procedural index, and the retrieve-first contract

Use Munin as the storage and retrieval substrate, but add a procedural schema or collection. Do not rely on generic memory retrieval alone.

The retrieve-first contract should be:

- retrieve candidates from procedural metadata and examples
- require active route binding before execution
- require confidence threshold and top-result margin
- abstain on ambiguity
- include negative retrieval tests in the eval suite
- route to cloud or approval path when retrieval is unavailable or ambiguous, subject to policy

This gets the benefit of Munin without pretending procedural retrieval is the same as general project-context retrieval.

### 5. What is the mid-loop failure to cloud escalation path?

Make it a state transition, not an exception handler.

Required path:

1. Snapshot the task and workspace before local execution.
2. Run local in an isolated worktree or sandbox.
3. Preflight wrapper, parser, tool environment, route policy, and context budget.
4. Execute with step budgets and heartbeats.
5. Abort early on parser failure, repeated invalid tool calls, no progress, timeout, context cap, or checkpoint failure.
6. Run grader on isolated output.
7. If pass, publish artifact through Hugin.
8. If fail and policy allows, escalate cloud from the original snapshot plus any validated intermediate artifact.
9. If cloud is not allowed, terminalize as blocked with reason.

The important point is that fallback cannot depend on a dirty local workspace or an ambiguous in-progress Hugin task.

### 6. What is the smallest end-to-end vertical slice?

The proposed lint-fix slice is close, but still too broad if it spans arbitrary repos. Make the first slice narrower and more hostile to false confidence.

Better slice:

- one deterministic coding procedure, such as a single-file TypeScript import normalization or markdown frontmatter normalization
- one `pi-local-30b` skill profile
- one LM Studio/Qwen3-Coder cell manifest with exact wrapper/model/context/thinking settings
- one procedural Munin entry with hard-negative retrieval fixtures
- one isolated fixture repo
- one grader with deterministic tests and diff checks
- one Hugin route binding in shadow, then active
- one successful local run
- one forced local failure that falls back according to policy
- one kill/restart test that proves Hugin does not strand the task
- one stale-hash test that demotes the route

Success criterion for the first slice should be: the route can be retrieved, selected, executed, graded, delivered, failed, recovered, demoted, and escalated reproducibly. Cost/latency versus cloud should be recorded, but it should not be the first slice's justification gate.

## Bottom Line

Build this as a route-binding system, not a skill-promotion flag.

Keep Munin, but give procedural retrieval its own schema and abstention contract.

Keep Hugin, but make #77-class crash recovery, sandboxed execution, and policy-aware fallback part of the first vertical slice.

Keep frontier-authored evals, but make them adversarial, versioned, reproducible, and independent enough that they cannot become a rubber stamp.

The premise is sound enough to build. The current draft's main risk is that it would build the first version around convenient nouns - skill, eval, Munin, fallback - instead of the contracts that make those nouns safe to route production work through.
