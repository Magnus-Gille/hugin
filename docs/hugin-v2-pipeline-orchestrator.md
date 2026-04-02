# Hugin v2 — Pipeline Orchestrator

**Status:** Post-debate draft — 2026-04-02
**Author:** Magnus + Claude, reviewed by Codex
**Context:** [Step 1 spec](step1-parent-child-joins.md), [Grimnir Vision](https://github.com/Magnus-Gille/grimnir/blob/main/docs/vision.md), [Grimnir Architecture](https://github.com/Magnus-Gille/grimnir/blob/main/docs/architecture.md)
**Debate:** [Summary](https://github.com/Magnus-Gille/grimnir/blob/main/debate/hugin-v2-orchestrator-summary.md) — 2 rounds, 15 critique points

---

## Problem

Grimnir can execute single tasks. It cannot execute multi-phase workflows where agents explore, debate, implement, review, and correct — with each phase's output feeding the next, and the right runtime chosen per phase based on task type, cost, and data sensitivity.

The Munin memory improvement cycle proved this *working style* works when a human coordinates. The goal is to automate the coordination: submit a high-level intent, wake up to results.

**Caveat:** N=1 validates the pattern, not the automation. The orchestrator must prove its value incrementally before further investment.

## Design Principles

1. **Evolutionary, not revolutionary** — Hugin already has executors, leases, and a parent/child joins spec. Build on these.
2. **Munin is the bus** — all state flows through Munin. No new databases, no new protocols.
3. **Each piece must be useful alone** — the steps below are independently valuable. Don't build a cathedral.
4. **Privacy is a routing constraint, not an afterthought** — data classification happens before runtime selection.
5. **Trust nothing by default** — agents are semi-trusted, cloud APIs are untrusted, only local inference on owned hardware is trusted.
6. **Three sequential bets** — workflow engine, then routing policy, then methodology templates. Validate each before starting the next. *(Added by debate)*
7. **Authoring and execution are separate concerns** — markdown for humans, validated IR for machines. *(Added by debate)*

---

## Trust and Authority Model

### Confidentiality tiers

Three tiers based on where data is **processed**, not who processes it:

| Tier | Where data goes | Examples | Use for |
|------|----------------|----------|---------|
| **Trusted** | Never leaves owned hardware | Ollama on Pi, Ollama on Mac Studio, Ollama on laptop | Credentials, client financials, PII, personal data |
| **Semi-trusted** | Leaves HW but goes to a provider with data policies | Claude API (Anthropic), OpenAI API (Codex) | Internal code, project state, non-sensitive client work |
| **Untrusted** | Third-party routing, may be cached/logged | OpenRouter, smaller providers | Public code, open-source, general knowledge tasks |

The trust tier is a **hard constraint** on routing. A task classified as `private` can never be routed to a semi-trusted or untrusted runtime, regardless of cost or quality.

### Monotonic sensitivity propagation *(from debate)*

A phase's **effective sensitivity** is the maximum of:
- The pipeline's declared sensitivity
- The phase's own declared sensitivity (can only raise, never lower)
- The sensitivity of all upstream phase results it reads
- The sensitivity of any context refs or data sources it accesses

**No phase may downgrade below its inputs.** The pipeline compiler/decomposer enforces this at submission time. If a phase reads an `internal` upstream result, it cannot run on an `untrusted` runtime even if the phase itself says `Sensitivity: public`.

### Authority *(from debate — design incomplete)*

Confidentiality governs where data goes. Authority governs what agents can **do**. These are separate concerns.

Side-effecting actions (git push, PR creation, deploy, sending messages) require explicit authorization:

| Authority level | Meaning | Default for |
|----------------|---------|-------------|
| `gated` | Pause and wait for human approval via Telegram before executing | All side-effecting phases |
| `autonomous` | Execute without human approval | Non-side-effecting phases only (by default) |

**Open design questions** (must be resolved before Step 4):
- What is the typed list of side effects? (git push, PR, deploy, email, Telegram message, file write outside repo?)
- How is a gate represented in Munin? (A blocked task waiting on a human-approval tag?)
- How does resume work after approval? (Ratatoskr writes approval → Hugin promotes?)
- How are retries made idempotent for side effects? (Branch already exists, PR already open?)

---

## Runtime Registry

A runtime is anything Hugin can dispatch work to. Each runtime has known properties:

```typescript
interface Runtime {
  id: string;                          // e.g. "claude-sdk", "codex-spawn", "ollama-pi", "ollama-laptop"
  type: "claude" | "codex" | "ollama";
  trust: "trusted" | "semi-trusted" | "untrusted";
  location: "pi" | "laptop" | "mac-studio" | "cloud";
  available: boolean;                  // probed dynamically
  costModel: "subscription" | "free" | "per-token";
  capabilities: RuntimeCapabilities;
  models?: string[];                   // for ollama: which models are loaded
  qualityScores?: QualityScores;       // from eval framework (future)
}

interface RuntimeCapabilities {
  coding: boolean;          // can write/edit code in a repo
  tools: boolean;           // has MCP/tool access (file system, git, etc.)
  fileAccess: boolean;      // can read/write local files
  longContext: boolean;     // >32k context window
  structuredOutput: boolean; // reliable JSON/schema output
  maxTokens: number;        // output token limit
}
```

### Current runtimes (day 1)

| Runtime | Trust | Cost | Capabilities |
|---------|-------|------|-------------|
| `claude-sdk` | Semi-trusted | Subscription (flat) | Full coding, tools, MCP, file access |
| `codex-spawn` | Semi-trusted | Subscription (flat) | Full coding, YOLO mode, file access |
| `ollama-pi` | Trusted | Free | Small models (1-3B), classification, triage |
| `ollama-laptop` | Trusted | Free | Medium models (7-14B), when available |

### Future runtimes (not part of this roadmap)

| Runtime | Trust | Cost | Capabilities |
|---------|-------|------|-------------|
| `ollama-mac-studio` | Trusted | Free | Large models (70-120B), concurrent sessions |
| `openrouter` | Untrusted | Per-token | Any model, cheapest for bulk non-sensitive work |

### Availability probing

Extend the existing `ollama-hosts.ts` pattern: probe each runtime periodically (Tailscale ping for laptop/Mac Studio, HTTP health for ollama). Cache availability with positive/negative TTL. The registry is a live view, not static config.

---

## Data Sensitivity Classification

Every task (or pipeline phase) carries a sensitivity label. The label determines which trust tiers are allowed.

### Labels

| Label | Allowed tiers | Examples |
|-------|--------------|----------|
| `public` | Trusted, semi-trusted, untrusted | Open-source code, general knowledge |
| `internal` | Trusted, semi-trusted | Private repos, project state, Grimnir internals |
| `private` | Trusted only | Client data, financials, PII, credentials |

### How labels are assigned

1. **Explicit** — the task submitter sets `Sensitivity: private` in the task spec. This is the override (can only raise, not lower).
2. **Inherited** — a pipeline phase inherits the pipeline's label as a floor.
3. **Propagated** — effective sensitivity is the max of all inputs (see monotonic rule above).
4. **Inferred** — a lightweight local classifier (rule-based) scans the prompt and context refs for:
   - Known client names → `private`
   - Financial terms + numbers → `private`
   - PII patterns (personnummer, email, phone) → `private`
   - Repo names in the private org → `internal`
   - Default → `internal` (safe default; nothing is `public` unless explicitly marked)

The classifier runs locally on the Pi (trusted tier) before any routing decision.

---

## Pipeline Model

A pipeline is a set of phases with dependencies between them. It is submitted as a single task to Munin, and Hugin decomposes it into child tasks.

### Two-layer spec: authoring and execution *(from debate)*

**Authoring format** — markdown, submitted by humans or agents to Munin. Readable, consistent with existing task format. Example:

```markdown
## Task: Improve Munin UX

- **Runtime:** pipeline
- **Sensitivity:** internal
- **Submitted by:** claude-code
- **Submitted at:** 2026-04-02T22:00:00Z
- **Reply-to:** telegram:12345678

### Pipeline

Phase: explore
  Runtime: ollama-pi
  Prompt: |
    Use munin-memory tools. Try each tool. Note friction, missing features,
    and compare to 3 competing memory systems found online.

Phase: debate
  Depends-on: explore
  Runtime: claude-sdk
  Prompt: |
    Read the exploration findings. Run an adversarial debate:
    what should we build next? Produce a ranked list of improvements
    with effort estimates.

Phase: implement
  Depends-on: debate
  Runtime: codex-spawn
  Context: repo:munin-memory
  Prompt: |
    Read the debate output. Implement the top-ranked improvement.
    Run tests. Commit to a feature branch.

Phase: review
  Depends-on: implement
  Runtime: claude-sdk
  Context: repo:munin-memory
  Prompt: |
    Review the implementation branch. Check correctness, test coverage,
    and alignment with the debate's recommendation.
    If issues found, list them clearly.
```

**Note:** In the first version, runtimes are **explicit** (not hints). Conditions, optional dependencies, and `Runtime: auto` routing are deferred until structured results exist (Step 3+).

**Execution format (IR)** — validated JSON, compiled from markdown on submission. Hugin only executes the IR.

```typescript
interface PipelineIR {
  id: string;
  sensitivity: "public" | "internal" | "private";
  replyTo?: string;
  submittedBy: string;
  submittedAt: string;
  phases: PhaseIR[];
}

interface PhaseIR {
  name: string;
  runtime: string;              // explicit runtime ID, e.g. "claude-sdk"
  context?: string;             // e.g. "repo:munin-memory"
  dependsOn: string[];          // phase names
  prompt: string;
  timeout?: number;
  authority: "autonomous" | "gated";  // default: "autonomous" for non-side-effecting
  effectiveSensitivity: "public" | "internal" | "private";  // computed, not declared
}
```

The compiler validates:
- All `dependsOn` references resolve to existing phases
- No cycles in the dependency graph
- Effective sensitivity is monotonic (>= pipeline sensitivity, >= all upstream phases)
- Runtimes exist in the registry
- Runtime trust tier allows the effective sensitivity
- Fan-out limit (max 10 children per phase)

Anything that fails validation is rejected with a clear error — never executed.

### How Hugin processes it

1. **Compile** — parse markdown, validate, produce `PipelineIR`. Reject invalid specs.
2. **Store** — write the IR to `tasks/<pipeline-id>/spec` (immutable).
3. **Decompose** — create child tasks in Munin for each phase:
   - Phases with no dependencies → `pending`
   - Phases with dependencies → `blocked` with `depends-on:` tags
4. **Execute** — standard Hugin execution (existing code paths)
5. **Promote** — on completion, run `promoteDependents()` (from Step 1 spec)
6. **Report** — when all terminal phases complete, aggregate results and deliver via reply-to

### This builds directly on Step 1

The parent/child joins spec gives us: `blocked` → `pending` promotion, `depends-on:` tags, failure policies, reconciliation loop, fan-out limits. The pipeline model adds:

- A **compiler** that validates and transforms markdown into IR
- **Pipeline-level status** aggregation
- **Pipeline-level timeout and cancellation**

---

## Structured Phase Results *(from debate)*

Phases communicate via Munin results. For the pipeline to support future conditional execution and machine-readable aggregation, phase results need a defined contract.

### Result schema

Each phase writes its result to `tasks/<phase-id>/result` with this structure:

```markdown
## Result

- **Exit code:** 0
- **Runtime:** claude-sdk
- **Duration:** 145000ms
- **Cost:** $0.00 (subscription)

### Output
<the phase's actual output — human-readable>

### Structured
<optional JSON block for machine-readable data>
```

The `### Structured` block is optional in v1 (explicit runtimes, no conditions). It becomes required when conditional execution is introduced, because conditions need machine-readable fields to evaluate.

---

## Router *(deferred — Step 6)*

The router is a function: `(phase, sensitivity, available_runtimes) → runtime`.

It is introduced as **opt-in only** via `Runtime: auto` in the phase spec. Phases with explicit runtimes bypass the router entirely. Existing tasks are unaffected.

### Decision logic (when invoked)

```
1. FILTER by trust tier
   effective_sensitivity=private  → only trusted runtimes
   effective_sensitivity=internal → trusted + semi-trusted
   effective_sensitivity=public   → all runtimes

2. FILTER by availability
   Remove runtimes that are offline (probe cache)

3. FILTER by capability
   Phase needs coding + tools? → remove ollama (no tool access)
   Phase needs structured output? → remove runtimes that can't do it

4. RANK remaining candidates
   Initially: prefer subscription (flat cost) over per-token,
   prefer trusted over semi-trusted.
   Later: use eval framework quality scores per task category.

5. SELECT top-ranked candidate
   If no candidates remain after filtering → fail with clear error
```

### Escalation

If a phase fails on a cheaper runtime, the router can retry on a more capable one:

```
Phase: lint
  Runtime: auto
  Escalate-on-failure: claude-sdk
```

---

## Implementation Roadmap

**Three sequential bets.** Each bet is validated before the next starts.

### Bet 1: Workflow Engine

Does dependency-aware multi-phase execution produce better outcomes than monolithic tasks?

#### Step 1: Parent/Child Joins (already specced)

**What:** `blocked` → `pending` promotion, `depends-on:` tags, failure policies.
**Where:** `hugin/src/index.ts` (~100-150 lines)
**Unlocks:** Manual pipeline composition — agents or humans can submit pre-decomposed task graphs.
**Validates:** The dependency tracking and promotion mechanics work correctly.

#### Step 2: Pipeline IR + Compiler

**What:** Recognize `Runtime: pipeline` tasks. Compile markdown to validated `PipelineIR` (JSON with Zod schema). Decompose into child tasks using Step 1 primitives. Explicit runtimes only — no conditions, no `Runtime: auto`, no optional dependencies.
**Where:** New `hugin/src/pipeline-compiler.ts`, `hugin/src/pipeline-ir.ts`, update `pollOnce()`
**Unlocks:** Submit a single task, get a multi-phase workflow.
**Constraint:** Conditions are explicitly forbidden until Step 3 ships structured results.

#### Step 3: Structured Results + Pipeline Operations

**What:** Define phase result schema. Add pipeline-level timeout. Add pipeline cancellation (via Telegram `/cancel <pipeline-id>` or direct Munin tag). Add resume from failed phase. Add priority/preemption (urgent human task interrupts nightly pipeline).
**Where:** Update result writing in executors, new `hugin/src/pipeline-ops.ts`
**Unlocks:** Reliable overnight pipeline execution. Conditions become possible (but not yet required).

#### Step 4: Human Gates

**What:** `Authority: gated` phases pause and notify via Telegram (Ratatoskr). Magnus approves or rejects. Hugin resumes or fails the phase. Side-effecting actions (git push, PR, deploy) default to `gated`.
**Where:** New gate semantics in pipeline-ops, Ratatoskr integration
**Unlocks:** Pipelines that can touch shared state safely. Self-maintaining infrastructure becomes possible.
**Prerequisite:** Define typed side-effect list and idempotency rules.

**Bet 1 success gate:**

> One fixed, non-sensitive, 4-phase pipeline runs unattended end to end on the current system. It uses a validated structured IR. Cancellation and resume both work. Any side-effecting phase requires an explicit human gate. The pipeline produces a review-ready artifact that Magnus judges better or faster than the current manual process. The system records completion rate, manual interventions, runtime choice, and total wall-clock time.

If this gate is not met, do not proceed to Bet 2.

### Bet 2: Routing Policy *(starts only after Bet 1 gate is met)*

Does automatic runtime selection improve cost, quality, or privacy outcomes?

#### Step 5: Sensitivity Classification

**What:** Add `Sensitivity:` field to task schema. Build rule-based classifier (regex for PII, client names, financial patterns). Implement monotonic propagation in the pipeline compiler. Classify based on prompt + context refs + data sources (not just prompt text).
**Where:** New `hugin/src/sensitivity.ts`, update pipeline compiler
**Unlocks:** Hard constraint on where data can go.

#### Step 6: Router (opt-in)

**What:** Add `Runtime: auto` option. Router filters by trust, availability, capability. Ranks candidates. Explicit runtimes remain the default for all existing tasks.
**Where:** New `hugin/src/router.ts`, runtime registry formalization
**Unlocks:** Automatic runtime selection for pipeline phases that opt in.

**Bet 2 success gate:** Routed tasks achieve comparable or better outcomes than manually-specified runtimes, with no sensitivity violations.

### Bet 3: Methodology Platform *(starts only after Bet 2 gate is met)*

Do reusable pipeline templates with automatic scheduling produce sustained value?

This bet is deliberately underspecified. Its scope depends on what Bets 1-2 reveal.

### Deferred (documented, not committed)

| Item | Reason for deferral |
|------|-------------------|
| OpenRouter runtime | New billing/auth/provider surface; prove core orchestration first |
| Eval-driven routing table | Ranking formula underdefined; eval judges still missing |
| Mac Studio integration | Hardware enablement, not software architecture |
| Mutable templates in Munin | Need versioning and reproducibility first |
| Sub-pipeline nesting | Base pipeline contract must stabilize first |
| Nightly self-improvement scheduling | Requires Bets 1-2 to be validated |
| Dynamic re-planning | Start with static DAGs |

---

## Observability

### Pipeline status in Heimdall

Heimdall's scope is "is the system healthy?" Pipeline visibility should stay within that boundary:

- Pipeline count: running, completed, failed (aggregate health signal)
- Current pipeline: which phase is active, how long has it been running
- Pipeline failure rate over time

A full pipeline operations UI (phase graph, runtime choices, cost breakdown) is a separate concern — either a Hugin-specific dashboard or a Munin query pattern, not Heimdall.

### Munin schema for pipelines

```
tasks/<pipeline-id>/status     — pipeline-level status (lifecycle tags)
tasks/<pipeline-id>/spec       — compiled PipelineIR (immutable JSON)
tasks/<phase-id>/status        — per-phase status (standard task)
tasks/<phase-id>/result        — per-phase result (structured schema)
tasks/<pipeline-id>/summary    — aggregated report (written by final phase or Hugin)
```

Phase IDs are derived: `<pipeline-id>-<phase-name>` (e.g., `20260402-improve-munin-ux-explore`).

---

## What This Enables

### The overnight improvement cycle (original motivating use case)

```
22:00  Magnus submits: "Improve Munin UX" (pipeline with 4 phases)
22:01  Hugin compiles IR, validates, decomposes into child tasks
22:05  Phase 1 (explore) starts on ollama-pi
22:20  Phase 1 completes. Phase 2 (debate) promotes to pending.
22:25  Phase 2 starts on claude-sdk
23:00  Phase 2 completes. Phase 3 (implement) promotes.
23:05  Phase 3 starts on codex-spawn
00:30  Phase 3 completes. Phase 4 (review) promotes.
00:35  Phase 4 starts on claude-sdk
01:00  Phase 4 completes. Pipeline done.
01:01  Hugin writes summary to Munin. Ratatoskr delivers to Telegram.
07:00  Magnus reads the report with coffee.
```

**Note:** All phases execute serially on a single worker. Fan-out means queued branches in the graph, not parallel execution. Real parallelism arrives with a second worker (Mac Studio).

### Self-maintaining infrastructure (Vision Phase 2, requires human gates)

```
Nightly pipeline: "Check Grimnir health"
  Phase 1 (ollama-pi): Run health checks, check dependency versions
  Phase 2 (claude-sdk): Analyze findings, decide if action needed
  Phase 3 (codex-spawn, gated): Apply safe fixes, create PRs   ← waits for approval
  Phase 4 (claude-sdk): Review PRs
  Phase 5 (ollama-pi): Report
```

### Privacy-respecting client work (requires Mac Studio)

```
Pipeline: "Prepare invoice summary for Lofalk"
  Sensitivity: private
  Phase 1 (ollama-mac-studio): Read Fortnox data, aggregate
  Phase 2 (ollama-mac-studio): Draft summary
  → All phases forced to trusted tier. Nothing leaves Magnus's hardware.
```

This use case is not available until the Mac Studio arrives and `ollama-mac-studio` is a capable trusted runtime. Current trusted runtimes (Pi: 1-3B models) are insufficient for this quality of work.

---

## Pipeline Templates: Agent Development Methodology

The pipeline orchestrator encodes a **way of working** where agents develop, test, and improve tools designed for agents. The Munin memory improvement cycle is the reference workflow.

### Storage and versioning *(from debate)*

Templates are **versioned files in git** (`grimnir/templates/` or in the component repo), not mutable state in Munin. A template is expanded into a concrete pipeline spec at submission time by the submitting agent or human. Hugin does not do template expansion — it receives fully concrete pipeline specs.

Sub-pipeline nesting is deferred. Each pipeline is self-contained.

### Template: Agent UX Testing

Agents are the primary users of Grimnir's tools. This template runs agents through a structured "user testing" session.

```
Pipeline: "UX test {component}"
  Sensitivity: internal

Phase: use-claude
  Runtime: claude-sdk
  Prompt: |
    You are a user of {component}. Use every available tool/endpoint.
    Complete these real tasks: {task-list}.
    Document: what worked, what was confusing, what's missing,
    what error messages were unhelpful. Be honest and specific.
    Score each interaction 1-5 for friction.

Phase: use-codex
  Runtime: codex-spawn
  Prompt: |
    (same as above — independent test by a different model)

Phase: synthesize
  Depends-on: use-claude, use-codex
  Runtime: claude-sdk
  Prompt: |
    Read all UX test results.
    Produce a prioritized list of improvements.
    For each: what's the friction, what's the fix, what's the effort.
    Flag any findings where the two testers disagreed.
```

### Template: Sprint Demo + Review

After implementation, agents present what was built and other agents review it.

```
Pipeline: "Sprint demo for {branch} in {repo}"
  Sensitivity: internal

Phase: demo
  Runtime: codex-spawn
  Context: repo:{repo}
  Prompt: |
    You implemented changes on branch {branch}. Present a sprint demo:
    1. What was the goal?
    2. What did you build? (walk through the key changes)
    3. What design decisions did you make and why?
    4. What did you NOT do and why?
    5. What are the known limitations?

Phase: review
  Depends-on: demo
  Runtime: claude-sdk
  Context: repo:{repo}
  Prompt: |
    Read the sprint demo. Then independently review the actual code on
    branch {branch}. Check:
    - Does the code match what the demo claims?
    - Correctness, edge cases, error handling
    - Test coverage
    - Security (OWASP top 10 relevant items)
    - Does it align with project conventions?
    List issues as: critical (must fix), important (should fix), minor (nice to fix).

Phase: cross-review
  Depends-on: demo
  Runtime: codex-spawn
  Context: repo:{repo}
  Prompt: |
    Read the sprint demo. Review the code on branch {branch}.
    Focus on: did the implementer miss anything? Are there simpler approaches?
    Would you have made different design decisions?

Phase: report
  Depends-on: review, cross-review
  Runtime: ollama-pi
  Prompt: |
    Summarize: what was built, what the reviewers found,
    what remains. Ready for human review.
```

### Template: Explore, Debate, Build, Review (full cycle)

The complete agent development cycle, codified from the Munin improvement session.

```
Pipeline: "Improve {component}"
  Sensitivity: internal

Phase: explore
  Runtime: claude-sdk
  Prompt: |
    Use {component}. Scan for comparable projects online.
    Document gaps, friction, and ideas. Raw findings only.

Phase: debate
  Depends-on: explore
  Runtime: claude-sdk
  Prompt: |
    Read explore findings. Run adversarial debate (invoke Codex via
    the debate-codex skill or equivalent). Produce: agreed next step,
    rejected alternatives with reasons, risk assessment.

Phase: implement
  Depends-on: debate
  Runtime: codex-spawn
  Context: repo:{component}
  Prompt: |
    Implement the agreed next step from the debate.
    Work on a feature branch. Run tests. Commit.

Phase: review
  Depends-on: implement
  Runtime: claude-sdk
  Context: repo:{component}
  Prompt: |
    Review the implementation on the feature branch.
    Check correctness, tests, conventions.
    List issues by severity.

Phase: report
  Depends-on: review
  Runtime: ollama-pi
  Prompt: |
    Summarize the full cycle. What was explored, debated,
    built, and reviewed. Include the branch name
    and whether it's ready to merge.
```

### Why templates matter

These encode **institutional knowledge about how agents work well together**:

- Different models see different things. Claude and Codex reviewing the same code find different issues. This is a feature, not redundancy.
- The implementer shouldn't review their own work. Cross-model review catches blind spots.
- Sprint demos force the implementer to articulate *why*, not just *what*. This surfaces misunderstandings before review.
- Exploration should be cheap. Debate should be excellent. Implementation should be fast. Review should be thorough. The runtime choices encode this.
- The full cycle mirrors how the Munin improvement actually worked. It's a validated pattern, not a theoretical framework.

---

## Open Questions

1. **Dynamic re-planning** — can a phase modify the remaining pipeline? E.g., explore phase discovers 5 things to investigate, wants to fan out into 5 parallel sub-phases. Deferred — start with static DAGs.

2. **Cost tracking** — the SDK executor already tracks cost per task. Aggregate per-pipeline. Set budget limits? Define how subscription-flat and per-token costs are compared.

3. **Information-flow completeness** — the monotonic sensitivity rule covers declared inputs and upstream phases. How do we handle sensitivity of tool outputs? (A claude-sdk phase reads a Fortnox API — does that make its output `private`?) This is the biggest remaining risk per the debate.

4. **Pipeline spec stability** — the markdown authoring format and JSON IR are both new. Expect iteration. Keep backward compatibility in mind but don't over-invest in migration tooling until the format stabilizes.

---

## Debate Amendments

This plan was revised after a structured adversarial debate (Claude vs Codex, 2 rounds, 15 critique points). Key changes:

| What changed | Why |
|-------------|-----|
| Three sequential bets instead of one 8-step roadmap | Original plan validated too many abstractions at once against N=1 evidence |
| Markdown compiles to typed JSON IR | Markdown spec was a DSL pretending to be a format; internal inconsistencies proved this |
| Monotonic sensitivity propagation | Phase-level downgrades create confidentiality footguns |
| Authority model added | Confidentiality alone doesn't govern side effects |
| Router is opt-in (`Runtime: auto`) | Replacing all dispatch with immature routing logic was too invasive |
| Templates in git, not Munin | Mutable runtime state without versioning is unreproducible |
| No conditions until structured results | Conditions referencing undefined fields is a type error |
| No sub-pipeline nesting in v1 | Base pipeline contract must stabilize first |
| Success gates defined per bet | Original plan had steps but no proof obligations |
| Heimdall scope preserved | Pipeline operations UI is not health visibility |
| Fan-out is serial (documented) | Single worker means queued, not parallel |

Full debate artifacts: `debate/hugin-v2-orchestrator-*.md`

---

*This plan builds on the existing Hugin architecture and the Step 1 parent/child joins spec. Each bet is independently validated before the next starts.*
