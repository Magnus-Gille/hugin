# Agent Orchestration: Cross-Disciplinary Research & Experiment Designs

> **Generated:** 2026-04-05 · **System:** Hugin task dispatcher on Raspberry Pi 4 · **State store:** Munin

---

## Executive Summary

This report surveys agent orchestration through five lenses — agentic AI frameworks, biological swarm intelligence, economics & mechanism design, distributed systems, and organizational/military theory — to identify non-obvious patterns applicable to Hugin's single-node, sequential task dispatcher. The most fertile cross-pollination occurs at three intersections: (1) ant colony stigmergy maps naturally onto Munin-as-environment for indirect task coordination, (2) the blackboard architecture from 1970s AI solves a concrete limitation in Hugin's pipeline system where phases cannot observe each other's intermediate work, and (3) Boyd's OODA loop combined with Auftragstaktik (mission command) offers a framework for intent-based delegation that could make pipelines adaptive rather than rigid. Three experiments are designed at small, medium, and large scope, each grounded in Hugin's actual codebase and hardware constraints.

---

## Research Findings

### 1. Agentic AI Orchestration

The multi-agent framework landscape in 2025–2026 has consolidated around several distinct orchestration philosophies:

**Framework Landscape:**
- **LangGraph** uses directed graphs with conditional edges, emphasizing durability and statefulness. Its graph-based runtime supports human-in-the-loop and agent-agent collaboration through explicit state machines. ([LangGraph docs](https://langchain-ai.github.io/langgraph/))
- **CrewAI** takes a role-based approach where "crews" of agents with defined roles collaborate on tasks. Process types (sequential, hierarchical, consensual) determine coordination pattern. ([CrewAI](https://www.crewai.com/))
- **AutoGen/AG2** implements conversational agent teams via GroupChat, with the v0.4 rewrite introducing an event-driven core and pluggable orchestration strategies. ([AutoGen](https://github.com/microsoft/autogen))
- **OpenAI Swarm** (now evolved into the Agents SDK) demonstrated that two primitives — agents and handoffs — are sufficient for rich multi-agent dynamics. Swarm is deliberately stateless between calls, trading autonomy for observability. ([OpenAI Swarm](https://github.com/openai/swarm))
- **Google ADK** introduced a hierarchical agent tree with native A2A (Agent-to-Agent) protocol support, enabling cross-framework agent communication.

**Key Orchestration Patterns:**
- **Supervisor:** Central agent routes tasks to specialists. Simple but creates a bottleneck. (LangGraph, CrewAI hierarchical)
- **Round-robin/GroupChat:** Agents take turns contributing. Good for brainstorming, poor for efficiency. (AutoGen)
- **Market-based allocation:** Agents bid on tasks based on capability and cost. Consensus-Based Auction Algorithm (CBAA) has 10+ years of robotics research behind it. ([DEV Community](https://dev.to/slythefox/the-5th-agent-orchestration-pattern-market-based-task-allocation-db0))
- **Blackboard systems:** Shared workspace where agents post and read findings. Born at CMU in the 1970s (HEARSAY-II), now seeing renaissance for LLM multi-agent systems. ([arxiv](https://arxiv.org/html/2507.01701v1))
- **Stigmergic coordination:** Agents communicate indirectly through environment modifications rather than direct messages. Emerging pattern in multi-agent deep RL. ([Nature](https://www.nature.com/articles/s44172-024-00175-7))

**Failure Modes** (critical for experiment design):
- **Echo chambers / hallucination consensus:** Agents recursively validate each other's incorrect conclusions. Multiple agents agreeing makes the system *more* confident in wrong answers. ([Medium](https://medium.com/@rakesh.sheshadri44/the-dark-psychology-of-multi-agent-ai-30-failure-modes-that-can-break-your-entire-system-023bcdfffe46))
- **Goal drift:** Intent mutates through delegation chains like a game of telephone. ([Galileo](https://galileo.ai/blog/multi-agent-ai-failures-prevention))
- **Cascading failures:** One agent's hallucination enters shared memory, subsequent agents treat it as verified fact. ([TDS](https://towardsdatascience.com/why-your-multi-agent-system-is-failing-escaping-the-17x-error-trap-of-the-bag-of-agents/))
- **Coordination tax:** Accuracy gains saturate beyond ~4 agents. Adding more agents without structured topology degrades performance. ([Cogent](https://cogentinfo.com/resources/when-ai-agents-collide-multi-agent-orchestration-failure-playbook-for-2026))

**Insight for Hugin:** Hugin's single-concurrency model is actually a *feature* for avoiding many multi-agent failure modes. The question isn't "how do we run agents in parallel" but "how do we make sequential agents smarter through accumulated environmental signals."

---

### 2. Biological Swarm Intelligence

**Ant Colony Optimization (ACO):**
Marco Dorigo's 1992 algorithm formalized how ants find shortest paths through pheromone trail reinforcement. Key mechanism: ants deposit pheromone on paths proportional to path quality. Pheromone evaporates over time (exploration/exploitation balance). No ant knows the global optimum; the colony converges through positive feedback loops. ([Wikipedia](https://en.wikipedia.org/wiki/Ant_colony_optimization_algorithms))

Digital pheromones extend this: virtual traces with attributes (value, timestamp, location) left by agents in a shared medium. Three pheromone "flavors" in polyagent systems: execution pheromone (what was done), attraction pheromone (what looks promising), repulsion pheromone (what failed). ([ResearchGate](https://www.researchgate.net/publication/282862646_Stigmergy_and_Implicit_Coordination_in_Software_Development))

**Slime Mold (Physarum polycephalum):**
A brainless organism that recreated the Tokyo rail network when food sources were placed at station locations. Mechanism: the plasmodium extends tendrils in all directions, reinforces tubes that find nutrients, prunes tubes that don't. The result is a near-optimal transport network. ([PubMed](https://pubmed.ncbi.nlm.nih.gov/21620930/))

Key insight: Physarum doesn't plan — it grows, tests, and prunes. This is structurally identical to how a task dispatcher could explore runtime/model combinations and reinforce what works.

**Bee Colony Decision-Making:**
Scout bees perform waggle dances to recruit foragers to food sources. Dance duration is proportional to source quality. This creates a decentralized information market where the colony allocates foragers optimally without any bee knowing total demand. Quorum sensing (threshold of scouts visiting a site) provides collective decision-making for nest selection. ([ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0022283615003873))

**Immune System (Danger Theory):**
Unlike classical immunology's self/non-self model, danger theory (Polly Matzinger, 1994) proposes that the immune system responds to *danger signals* from damaged tissue, not merely foreignness. Applied to computing: don't classify operations as permitted/forbidden — react to signals of actual harm. This challenges Hugin's current sensitivity model, which is classification-based.

**Insight for Hugin:** Stigmergy is the most directly applicable biological pattern. Munin already serves as a shared environment; task results already leave traces. The gap is that these traces aren't structured for consumption by future tasks, and there's no evaporation/reinforcement mechanism.

---

### 3. Economics & Mechanism Design

**Vickrey-Clarke-Groves (VCG) Mechanism:**
The only mechanism family that simultaneously achieves truthful reporting, efficient allocation, and individual rationality. In a VCG auction, each agent reports their valuation honestly because the payment structure makes honesty a dominant strategy — you pay the externality you impose on others. ([Grokipedia](https://grokipedia.com/page/Vickrey%E2%80%93Clarke%E2%80%93Groves_auction))

**Hayek's Knowledge Problem:**
Friedrich Hayek argued that no central planner can aggregate the dispersed knowledge held by individuals across an economy. Prices emerge as "signals wrapped in incentives" — they compress vast local knowledge into a single number that coordinates behavior. ([Stanford](https://web.stanford.edu/~jacksonm/mechtheo.pdf))

Applied to task dispatch: a central dispatcher making runtime/model decisions is a central planner. If tasks could signal their own resource needs (through "prices" like estimated cost, urgency, complexity), the system could allocate more efficiently than top-down rules.

**Ostrom's 8 Principles for Commons Governance:**
Elinor Ostrom (Nobel 2009) showed that communities can self-govern shared resources without privatization or central authority, given:
1. Clear boundaries (who can use the resource)
2. Rules matching local conditions
3. Collective decision-making
4. Monitoring by the community
5. Graduated sanctions for violations
6. Accessible conflict resolution
7. Recognition by higher authorities
8. Nested enterprises for large systems

([Agrarian Trust](https://www.agrariantrust.org/ostroms-eight-design-principles-for-a-successfully-managed-commons/))

**Insight for Hugin:** Ostrom's principles map remarkably well to managing shared resources on a single-node system — API budget, memory, CPU time, Ollama inference slots. The "community" is the stream of tasks; "sanctions" could be timeout reductions or runtime downgrades for tasks that exceed budgets.

---

### 4. Distributed Systems

**Work-Stealing:**
Idle processors steal tasks from busy processors' queues. The "power-of-two-choices" variant: instead of random stealing, sample two queues and steal from the longer one. This achieves near-optimal load balancing with minimal coordination. Not directly applicable to single-concurrency Hugin, but the principle of adaptive routing based on queue state is.

**Backpressure:**
When a downstream component can't keep up, it signals upstream to slow down. Prevents cascading overload. In Hugin's context: if Ollama is slow (Pi thermal throttling), the dispatcher should adaptively increase timeouts or route to Claude instead. Currently, Hugin has Ollama→Claude fallback on HTTP failure, but not on *slowness*. ([Tedinski](https://www.tedinski.com/2019/03/05/backpressure.html))

**Circuit Breakers:**
After N consecutive failures, stop trying and fail fast for a cooldown period. Prevents wasting resources on a known-broken path. Hugin's `ollama-hosts.ts` has negative caching (5-minute backoff after failure) — this is effectively a circuit breaker, but only for host availability, not for model-level failures.

**CRDTs (Conflict-Free Replicated Data Types):**
Data structures that merge automatically without coordination. State-based CRDTs send full state; operation-based CRDTs send operations. Relevant insight: Munin entries are effectively last-writer-wins registers. A CRDT-inspired approach to accumulating task metadata (counters, sets, max-values) could enable richer coordination without race conditions. ([crdt.tech](https://crdt.tech/))

**Insight for Hugin:** The most actionable pattern is circuit breakers extended beyond host-level to model-level and task-type-level. Combined with pheromone-style signals, this becomes adaptive routing that learns from the system's own history.

---

### 5. Organizational Theory & Military C2

**Boyd's OODA Loop (Observe-Orient-Decide-Act):**
John Boyd's decision cycle emphasizes that the Orient phase — where you update your mental model — is the most important. The goal isn't faster cycling but better orientation. In multi-agent terms: agents that can observe the environment, update their model, and adapt their approach mid-execution will outperform agents following rigid plans. ([Wikipedia](https://en.wikipedia.org/wiki/OODA_loop))

**Auftragstaktik (Mission Command):**
Developed by the Prussian military after their defeat at Jena (1806). Key principle: commanders communicate *intent* and *constraints*, subordinates decide *how* to achieve the objective. This pushes decision-making to the level closest to the action and compresses the OODA loop by eliminating the delay of waiting for orders. Boyd's German acronym EBFAS: Einheit (unity), Behendigkeit (agility), Fingerspitzengefühl (intuition), Auftragstaktik (mission tactics), Schwerpunkt (focus). ([MCA Marines](https://www.mca-marines.org/gazette/ooda-loop-for-strategy/))

**Cynefin Framework:**
Dave Snowden's sense-making framework maps problems to domains: Simple (best practice), Complicated (good practice, requires expertise), Complex (emergent practice, probe-sense-respond), Chaotic (novel practice, act-sense-respond). Different orchestration patterns suit different domains:
- Simple tasks → sequential pipeline (current Hugin)
- Complicated tasks → expert routing (model selection)
- Complex tasks → probe-sense-respond (experimental execution with observation)
- Chaotic tasks → act first, make sense later

([The Cynefin Co](https://thecynefin.co/the-ooda-loop-cynefin/))

**Ashby's Law of Requisite Variety:**
"Only variety can absorb variety." A controller must be at least as complex as the system it regulates: V(C) ≥ V(D). For Hugin: as tasks become more varied (research, coding, analysis, creative), the dispatch system needs corresponding variety in its routing, timeout, and context decisions. A one-size-fits-all dispatcher will fail as task diversity increases. ([Systems Thinking Alliance](https://systemsthinkingalliance.org/ashbys-law-of-requisite-variety/))

**Stigmergy in Open Source:**
Research on FLOSS projects shows that Linux kernel development uses stigmergic coordination: the code itself is the shared environment, patches are "traces" left by developers, and maintainers provide graduated quality control. Three coordination mechanisms: standardization (coding conventions), loose coupling (module boundaries), and partisan mutual adjustment (maintainer review). ([ResearchGate](https://www.researchgate.net/publication/287329946_Self-Organized_Development_in_Libre_Software_a_Model_based_on_the_Stigmergy_Concept))

**Insight for Hugin:** Mission command is the most powerful organizational pattern for pipelines. Currently, pipeline phases get rigid prompts. An Auftragstaktik-style pipeline would give phases *intent* ("ensure the codebase compiles and tests pass") rather than *instructions* ("run `npm test`"), with freedom to adapt approach based on what they observe.

---

## Cross-Pollination Map

```
                    BIOLOGY                 ECONOMICS              DISTRIBUTED         MILITARY/ORG
                    ───────                 ─────────              ───────────         ────────────
Indirect coord.    Stigmergy ←──────────→ Price signals ←──────→ Gossip protocols ←→ Mission command
                    (pheromones)            (Hayek)                (epidemic spread)   (commander's intent)
                        │                      │                       │                    │
                        ▼                      ▼                       ▼                    ▼
Shared workspace   Ant trails on        ──→ Order books ←──────→ Shared logs /     ──→ Common operating
                    the ground               (market                CRDTs                  picture (COP)
                        │                    microstructure)          │                    │
                        ▼                      │                     ▼                    ▼
Adaptive routing   Physarum tube        ──→ Auction-based    ──→ Work-stealing /  ──→ Schwerpunkt
                    reinforcement            allocation            load balancing        (main effort)
                        │                      │                     │                    │
                        ▼                      ▼                     ▼                    ▼
Failure handling   Immune danger        ──→ Graduated        ──→ Circuit breakers ──→ OODA loop
                    theory                   sanctions              / backpressure       (reorient on
                        │                    (Ostrom)               │                    failure)
                        ▼                      ▼                     ▼                    ▼
Self-organization  Quorum sensing       ──→ Invisible hand   ──→ Emergent         ──→ Requisite
                    (bees)                   (Smith)               consensus             variety (Ashby)

                    ╔══════════════════════════════════════════════════════╗
                    ║              HUGIN INTEGRATION POINTS               ║
                    ║                                                      ║
                    ║  Munin = shared environment (stigmergy substrate)    ║
                    ║  Pipeline phases = agents with dependency DAG        ║
                    ║  Task tags = lightweight signals (pheromone-like)    ║
                    ║  Sensitivity lattice = trust boundary (immune-like)  ║
                    ║  Single-concurrency = sequential OODA loop           ║
                    ╚══════════════════════════════════════════════════════╝
```

The deepest connection: **stigmergy, price signals, gossip, and mission command are all forms of indirect coordination through a shared medium**. Munin is already that medium. The experiments below make this latent capability explicit.

---

## Experiment 1: Pheromone Trails — Stigmergic Task Routing

### 1. Overview

- **Title:** Pheromone Trails — Stigmergic Task Routing via Munin
- **Inspiration:** Ant colony optimization. Ants don't have a central dispatcher choosing paths — they leave pheromone on trails they've walked, and subsequent ants probabilistically follow stronger trails. The trail *is* the memory. Munin is Hugin's trail.
- **Purpose ("Why try this?"):** Currently, runtime and model selection in Hugin is static — the task submitter specifies `runtime: claude` or `runtime: ollama-pi`, or it's hardcoded. There's no learning from past execution. A research task that succeeded on `ollama-laptop` with `qwen3.5:35b-a3b` in 45 seconds leaves no trace that helps future similar tasks. This experiment asks: **can accumulated execution metadata ("pheromones") improve dispatch decisions without any explicit ML?**
- **Expected benefit if successful:** Automatic runtime/model routing that improves over time. Tasks without explicit runtime preferences get routed to the runtime that has historically performed best for similar task types. Timeout estimates become data-driven rather than static defaults.
- **Risk / what could go wrong:**
  - Cold start: no pheromones initially, so early routing is random
  - Overfitting: system converges on one runtime and stops exploring
  - Munin write overhead: extra writes after each task add latency
  - Pheromone staleness: old signals from a different system state mislead routing
- **Estimated effort:** **S** — ~2-3 days. Mostly additive code (new module + hooks in index.ts), no structural changes.

### 2. Architecture & Design

**How it fits:** New module `src/pheromone.ts` that:
1. After task completion, writes a "pheromone deposit" to Munin
2. Before task dispatch, reads accumulated pheromones to suggest runtime/timeout

**Files to create or modify:**

| File | Change |
|------|--------|
| `src/pheromone.ts` | **NEW** — pheromone deposit/read/decay logic |
| `src/index.ts` | Add pheromone deposit after result write (~line 2534); add pheromone read before dispatch (~line 2240) |

**Munin namespace:** `pheromones/hugin`

**Data structure — Pheromone deposit (written to Munin):**
```typescript
interface PheromoneDeposit {
  taskType: string;        // extracted from task tags or prompt classification
  runtime: string;         // "claude" | "ollama-pi" | "ollama-laptop" | "codex"
  model?: string;          // specific model used
  outcome: "success" | "failure" | "timeout";
  durationMs: number;
  costUsd?: number;
  outputQuality?: number;  // if structured result available, 0-1 score
  depositedAt: string;     // ISO timestamp
  strength: number;        // initial strength (1.0), decays over time
}
```

**Pheromone trail (aggregated, read before dispatch):**
```typescript
interface PheromoneTrail {
  taskType: string;
  runtimeScores: Record<string, {
    successRate: number;
    avgDurationMs: number;
    avgCostUsd: number;
    sampleCount: number;
    lastDeposit: string;
    decayedStrength: number;  // sum of deposits * decay factor
  }>;
  suggestedRuntime: string;
  suggestedTimeout: number;
  confidence: number;  // 0-1 based on sample count
}
```

**Evaporation mechanism:** Each pheromone deposit has a `depositedAt` timestamp. When reading trails, strength is multiplied by `e^(-λt)` where `t` is age in hours and `λ` is the decay rate (tunable, default ~0.01 = half-life of ~69 hours ≈ 3 days). This ensures recent experience dominates while preserving some long-term memory.

**Exploration/exploitation:** With probability `ε` (default 0.1), ignore pheromone trail and choose a random runtime. This prevents convergence on a local optimum. Inspired by ε-greedy strategy but also directly analogous to ant scouts that occasionally ignore pheromone trails.

**Interaction with pipeline system:** Pipeline phases with explicit `Runtime:` declarations are unaffected. Pheromone routing only activates when runtime is unspecified or set to "auto" (a new option).

### 3. Implementation Plan

1. **Phase 1: Deposit infrastructure** (1 day)
   - Create `src/pheromone.ts` with `depositPheromone()` and `readTrail()`
   - Add task type classification (extract from tags: `type:research`, `type:code`, `type:analysis`, etc.)
   - Hook deposit into post-execution flow in `index.ts`
   - Write deposits to `pheromones/hugin/<task-type>` in Munin

2. **Phase 2: Trail reading and suggestion** (1 day)
   - Implement `suggestRuntime()` that reads trail, applies decay, computes scores
   - Add `runtime: auto` support in task parsing
   - Wire suggestion into dispatch decision (before runtime selection in `pollOnce()`)
   - Log suggestion vs. actual choice for observability

3. **Phase 3: Tuning and observation** (0.5 day)
   - Add `HUGIN_PHEROMONE_DECAY_RATE` and `HUGIN_PHEROMONE_EPSILON` env vars
   - Create a simple trail visualization (Munin query that summarizes accumulated trails)
   - Run 10-20 tasks with `runtime: auto` and observe routing decisions

### 4. Evaluation & Success Criteria

| Metric | Success | Failure |
|--------|---------|---------|
| Pheromone deposits accumulate | Deposits visible in Munin after each task | Writes fail or are empty |
| Trail influences routing | `runtime: auto` tasks route to historically-best runtime | Always routes to same runtime or random |
| Evaporation works | Old deposits have lower influence than recent ones | System over-indexes on stale data |
| Exploration happens | ~10% of tasks try non-dominant runtime | System locks onto single runtime immediately |

**Minimum viable experiment:** Just the deposit phase. Write pheromones after every task for 1 week, then manually inspect the accumulated data to see if patterns emerge that *would have* improved routing.

### 5. Example Scenario

```
# Task submitted without runtime preference:
memory_write("tasks/20260410-120000-analyze-logs", "spec",
  "Analyze the last 24h of Hugin logs and summarize errors.",
  tags: ["pending", "type:analysis", "runtime:auto"])

# Hugin reads pheromone trail for "analysis" tasks:
# → claude: 5 deposits, 80% success, avg 120s, avg $0.45
# → ollama-laptop: 3 deposits, 100% success, avg 45s, $0.00
# → ollama-pi: 2 deposits, 50% success (1 timeout), avg 180s, $0.00

# Decayed scores (recent ollama-laptop successes weighted heavily):
# → ollama-laptop: 0.82
# → claude: 0.71
# → ollama-pi: 0.23

# ε-greedy: roll 0.73 > 0.1, so follow pheromone → dispatch to ollama-laptop
# (If roll were 0.05, would randomly try ollama-pi or claude)

# Task completes successfully on ollama-laptop in 38s
# → New pheromone deposit: {taskType: "analysis", runtime: "ollama-laptop", outcome: "success", durationMs: 38000}
# → Trail for "analysis" now even more strongly favors ollama-laptop
```

---

## Experiment 2: Blackboard Pipeline — Shared Workspace for Phase Coordination

### 1. Overview

- **Title:** Blackboard Pipeline — Shared Workspace for Adaptive Phase Coordination
- **Inspiration:** The blackboard architecture from HEARSAY-II (CMU, 1970s), where multiple knowledge sources (phonetics, syntax, semantics) cooperated by reading/writing a shared workspace. Also inspired by Physarum's tube network: tendrils that find nutrients are reinforced, others are pruned. A pipeline where later phases can *see* and *react to* earlier phases' findings is a tube network that reinforces productive paths.
- **Purpose ("Why try this?"):** Hugin's pipeline system has a real limitation: phases are isolated. Phase B depends on Phase A completing, but Phase B's prompt is written at pipeline submission time — it can't incorporate what Phase A actually found. If Phase A discovers "the tests are failing because of a dependency update," Phase B (which was supposed to "review and merge the PR") should adapt its behavior. Currently it can't. This experiment asks: **can we create a shared workspace within a pipeline that enables adaptive phase behavior?**
- **Expected benefit if successful:** Pipelines that adapt mid-execution. Later phases receive richer context from earlier phases, reducing the "telephone game" problem of intent degradation through prompt chains. Complex workflows (research → design → implement → test) become genuinely iterative rather than rigidly sequential.
- **Risk / what could go wrong:**
  - Context window bloat: accumulated blackboard contents could overwhelm smaller models
  - Garbage in, garbage out: if Phase A writes low-quality findings, Phase B is misled
  - Complexity: the blackboard adds a new coordination surface that must be maintained
  - Ordering issues: what if two phases write conflicting findings?
- **Estimated effort:** **M** — ~5-7 days. Requires changes to pipeline dispatch, context loading, and a new blackboard module.

### 2. Architecture & Design

**How it fits:** Each pipeline gets a blackboard namespace in Munin. Phases can write structured findings to the blackboard (via MCP tools already available to Claude SDK tasks). A new context specifier `blackboard:` in pipeline phase definitions loads accumulated blackboard content into the phase's prompt.

**Files to create or modify:**

| File | Change |
|------|--------|
| `src/pipeline-blackboard.ts` | **NEW** — blackboard creation, reading, summarization |
| `src/pipeline-dispatch.ts` | Create blackboard namespace when pipeline is dispatched (~line where child tasks are written) |
| `src/pipeline-compiler.ts` | Support `Context: blackboard` directive in phase definitions |
| `src/context-loader.ts` | Add blackboard resolution alongside existing Munin context-ref resolution |
| `src/index.ts` | Inject blackboard context before phase execution (~line 2240) |
| `src/pipeline-ir.ts` | Add optional `blackboardAccess: "read" \| "write" \| "readwrite"` to phase schema |

**Munin namespace structure:**
```
pipelines/<pipeline-id>/blackboard/findings      — structured findings from phases
pipelines/<pipeline-id>/blackboard/index          — registry of what's on the blackboard
pipelines/<pipeline-id>/blackboard/phase-<slug>   — per-phase scratchpad
```

**Blackboard entry schema:**
```typescript
interface BlackboardEntry {
  phaseSlug: string;
  phaseName: string;
  entryType: "finding" | "question" | "decision" | "artifact" | "warning";
  title: string;
  content: string;
  confidence: "high" | "medium" | "low";
  tags: string[];
  writtenAt: string;
}
```

**Context injection:** When a phase declares `Context: blackboard`, the dispatcher:
1. Reads `pipelines/<pipeline-id>/blackboard/findings`
2. Formats entries as a structured context block (title + content, sorted by phase order)
3. Prepends to the phase's prompt within the context budget
4. Adds a system instruction: "The following findings were produced by earlier pipeline phases. Use them to inform your work."

**Write mechanism:** Claude SDK tasks already have MCP access to Munin. Phases with `blackboardAccess: write` or `readwrite` receive an additional system instruction explaining the blackboard namespace and encouraging them to write findings. No new MCP tools needed — standard `memory_write` to the blackboard namespace.

**Interaction with existing pipeline system:**
- Dependency DAG is unchanged — blackboard is *additional* coordination, not a replacement for `depends-on`
- Phases without blackboard access behave exactly as today
- The blackboard is scoped to a single pipeline execution (no cross-pipeline leakage)

### 3. Implementation Plan

1. **Phase 1: Blackboard infrastructure** (2 days)
   - Create `src/pipeline-blackboard.ts` with `createBlackboard()`, `readBlackboard()`, `formatBlackboardContext()`
   - Modify `pipeline-dispatch.ts` to create blackboard namespace on pipeline dispatch
   - Define the `BlackboardEntry` schema with Zod validation

2. **Phase 2: Context injection** (2 days)
   - Add `blackboardAccess` to pipeline phase IR schema
   - Modify `pipeline-compiler.ts` to parse `Context: blackboard` and `Blackboard-access: read|write|readwrite`
   - Modify context loading to resolve blackboard content alongside existing context-refs
   - Add system instruction injection for phases with blackboard access

3. **Phase 3: Write enablement** (1 day)
   - Add system instructions to write-enabled phases explaining how to use the blackboard
   - Add the blackboard namespace to the phase's prompt preamble
   - Test with a simple 2-phase pipeline: Phase A researches, Phase B uses findings

4. **Phase 4: Summarization** (1-2 days)
   - Build `summarizeBlackboard()` that compresses accumulated findings for late-pipeline phases
   - Implement budget management: if blackboard exceeds context budget, summarize older entries
   - Optional: use Ollama (Pi) to generate summaries cheaply

### 4. Evaluation & Success Criteria

| Metric | Success | Failure |
|--------|---------|---------|
| Blackboard entries created | Phases write structured findings to blackboard | Phases ignore blackboard or write garbage |
| Later phases reference findings | Phase B's output references specific findings from Phase A | Phase B produces same output with or without blackboard |
| Adaptive behavior | Phase B changes its approach based on Phase A's warnings | Rigid execution regardless of blackboard content |
| Context budget respected | Blackboard content fits within budget, summarized if needed | Context overflow or truncation of important findings |

**Minimum viable experiment:** A 2-phase pipeline where Phase 1 researches a topic and writes 3 findings to the blackboard, and Phase 2 produces a design that explicitly references those findings. Compare Phase 2's output with and without blackboard access.

### 5. Example Scenario

```markdown
## Task: Fix failing CI
**Runtime:** pipeline
**Sensitivity:** internal

### Pipeline

Phase: Diagnose
  Runtime: claude-sdk
  Blackboard-access: write
  Authority: autonomous
  Prompt: |
    Investigate why the CI pipeline is failing in the hugin repo.
    Write your key findings to the pipeline blackboard, including:
    - Root cause identification
    - Affected files
    - Any related issues you discover

Phase: Fix
  Depends-on: Diagnose
  Runtime: claude-sdk
  Context: blackboard
  Blackboard-access: readwrite
  Authority: autonomous
  Prompt: |
    Based on the diagnostic findings from the previous phase,
    implement a fix for the CI failure. If the diagnosis suggests
    multiple possible causes, address them in priority order.

Phase: Verify
  Depends-on: Fix
  Runtime: claude-sdk
  Context: blackboard
  Blackboard-access: read
  Authority: autonomous
  Prompt: |
    Review the diagnostic findings and the fix that was applied.
    Verify the fix is correct and complete. Run tests if applicable.
    Flag any concerns.
```

**Execution flow:**
1. Diagnose phase runs, discovers: "Root cause: zod v4 breaking change in schema validation. File: src/pipeline-compiler.ts line 147. Secondary issue: test fixture uses deprecated API."
2. Writes to blackboard: `{entryType: "finding", title: "Root cause: zod v4 breaking change", content: "...", confidence: "high"}`
3. Fix phase receives blackboard context: "Earlier findings: Root cause: zod v4 breaking change..." → goes directly to fixing `pipeline-compiler.ts` instead of re-diagnosing
4. Fix phase writes to blackboard: `{entryType: "artifact", title: "Applied fix to pipeline-compiler.ts", content: "Changed schema validation to use new zod v4 API..."}`
5. Verify phase reads full blackboard: diagnosis + fix → can verify the fix addresses the actual root cause

---

## Experiment 3: OODA Pipelines — Intent-Based Adaptive Execution

### 1. Overview

- **Title:** OODA Pipelines — Intent-Based Delegation with Adaptive Execution Loops
- **Inspiration:** Boyd's OODA loop + Prussian Auftragstaktik + Cynefin framework. In mission command, a commander communicates *intent* ("secure the bridge by dawn") and *constraints* ("minimize civilian casualties"), not *instructions* ("move squad A to coordinates X, Y at 0300"). The subordinate adapts their approach based on ground conditions. Combined with OODA: the executing agent continuously observes the environment, orients (updates its model), decides, and acts — with the freedom to deviate from the original plan if conditions change.
- **Purpose ("Why try this?"):** Current pipelines are rigid scripts — every phase's prompt is written at submission time and cannot adapt. A research pipeline that discovers "this topic has no English-language sources" can't pivot to searching in other languages. A code pipeline that discovers "this function doesn't exist yet" can't spawn an additional phase to create it. This experiment asks: **can we build pipelines where phases execute against intent rather than instructions, with OODA-loop-style observation and adaptation?**
- **Expected benefit if successful:** Pipelines that handle unexpected situations gracefully. Complex multi-phase workflows that don't require the submitter to anticipate every contingency. A foundation for genuinely autonomous long-running tasks.
- **Risk / what could go wrong:**
  - Goal drift: agents reinterpret intent too liberally and go off-track
  - Infinite loops: OODA cycles that never converge
  - Cost explosion: adaptive execution takes more turns/tokens than rigid pipelines
  - Complexity: significantly more moving parts than current pipeline system
  - Evaluation difficulty: hard to know if "adaptive" behavior is actually better
- **Estimated effort:** **L** — ~10-15 days. Requires new pipeline mode, OODA state machine, intent schema, and observation infrastructure.

### 2. Architecture & Design

**How it fits:** A new pipeline compilation mode (`authority: ooda`) that transforms a phase from "execute this prompt" to "achieve this intent, adapting as needed." The OODA loop is implemented as a state machine within the existing task execution framework.

**Files to create or modify:**

| File | Change |
|------|--------|
| `src/ooda.ts` | **NEW** — OODA state machine, intent schema, observation system |
| `src/ooda-prompts.ts` | **NEW** — system prompts for each OODA phase |
| `src/pipeline-ir.ts` | Add `ooda` authority type; add intent/constraints fields to phase schema |
| `src/pipeline-compiler.ts` | Parse OODA-mode phases with Intent/Constraints/Boundaries directives |
| `src/index.ts` | Add OODA execution loop alongside existing dispatch logic |
| `src/sdk-executor.ts` | Support multi-turn OODA execution within a single task |

**Intent schema:**
```typescript
interface OODAIntent {
  objective: string;         // "What should be achieved"
  constraints: string[];     // "What must not happen"
  boundaries: string[];      // Hard limits (time, cost, scope)
  successCriteria: string[]; // How to know when you're done
  contextRefs: string[];     // Munin refs for orientation
}

interface OODAState {
  phase: "observe" | "orient" | "decide" | "act" | "complete" | "abort";
  cycle: number;
  maxCycles: number;
  observations: string[];
  orientation: string;       // Current mental model
  decision: string;          // Chosen action
  actions: OODAAction[];     // History of actions taken
  confidence: number;        // 0-1, agent's self-assessed progress
}

interface OODAAction {
  cycle: number;
  description: string;
  outcome: "success" | "failure" | "partial" | "unexpected";
  findings: string;
  nextObservation: string;   // What to look at next
}
```

**OODA execution loop (within a single SDK task):**

```
┌────────────────────────────────────────────────────┐
│              OODA Execution Loop                    │
├────────────────────────────────────────────────────┤
│                                                      │
│  ┌──────────┐   System reads Munin state,           │
│  │ OBSERVE  │   workspace state, previous results    │
│  └────┬─────┘                                        │
│       ▼                                              │
│  ┌──────────┐   Agent updates mental model:          │
│  │ ORIENT   │   "Given what I see, what does this    │
│  │          │    mean for my objective?"              │
│  └────┬─────┘                                        │
│       ▼                                              │
│  ┌──────────┐   Agent chooses next action:           │
│  │ DECIDE   │   - Continue on current path           │
│  │          │   - Pivot approach                      │
│  │          │   - Request help (write to blackboard)  │
│  │          │   - Declare complete/abort              │
│  └────┬─────┘                                        │
│       ▼                                              │
│  ┌──────────┐   Agent executes chosen action         │
│  │  ACT     │   using available tools                │
│  └────┬─────┘                                        │
│       │                                              │
│       ▼                                              │
│  ┌──────────┐   Check: success criteria met?         │
│  │ EVALUATE │   Check: cycle < maxCycles?            │
│  │          │   Check: within time/cost boundaries?  │
│  └────┬─────┘                                        │
│       │                                              │
│       ├── criteria met ──→ COMPLETE                  │
│       ├── boundary hit ──→ ABORT (with findings)     │
│       └── continue ──────→ back to OBSERVE           │
│                                                      │
└────────────────────────────────────────────────────┘
```

**Key design decision — OODA within a single SDK session:** Rather than spawning separate tasks for each OODA phase, the entire loop runs within one `executeSdkTask()` call. The OODA structure is enforced through system prompts that guide the agent through observe→orient→decide→act cycles. The agent writes its state to Munin after each cycle (enabling external monitoring and cancellation). This avoids the overhead of task creation/teardown per cycle and leverages the SDK's conversation memory.

**System prompt structure:**
```
You are executing an OODA (Observe-Orient-Decide-Act) loop.

INTENT: {objective}
CONSTRAINTS: {constraints}
BOUNDARIES: {boundaries}
SUCCESS CRITERIA: {successCriteria}

You must cycle through these phases:
1. OBSERVE: Read the current state of the environment (files, Munin, test results)
2. ORIENT: Analyze what you've observed against your intent. Update your mental model.
3. DECIDE: Choose your next action. You may pivot if conditions have changed.
4. ACT: Execute your decision using available tools.

After each ACT, evaluate whether success criteria are met.
Write your OODA state to {muninNamespace} after each cycle.

Current cycle: {cycle}/{maxCycles}
Previous observations: {previousObservations}
Previous actions: {previousActions}
```

**Interaction with pipeline system:**
- OODA phases participate in the normal dependency DAG
- They can read from/write to the blackboard (Experiment 2 synergy)
- The `maxCycles` boundary prevents runaway execution
- A time boundary (`Boundary: max-time 300s`) provides a hard stop
- OODA state written to Munin enables the cancellation-watch system to intervene

**Pipeline syntax:**
```markdown
Phase: Investigate and Fix
  Runtime: claude-sdk
  Authority: ooda
  Max-cycles: 5
  Intent: |
    Ensure all tests in the hugin repo pass.
  Constraints: |
    - Do not modify test expectations unless the test is clearly wrong
    - Do not introduce new dependencies
    - Prefer minimal changes
  Boundaries: |
    - Maximum 5 OODA cycles
    - Maximum 300 seconds total
    - Maximum $2.00 API cost
  Success-criteria: |
    - All tests pass (`npm test` exits 0)
    - No new linting errors
  Context: repo:hugin, blackboard
```

### 3. Implementation Plan

1. **Phase 1: Intent schema and OODA state machine** (3 days)
   - Define `OODAIntent`, `OODAState`, `OODAAction` types in `src/ooda.ts`
   - Implement state transitions with validation
   - Build OODA system prompt templates in `src/ooda-prompts.ts`
   - Add cycle counting and boundary checking

2. **Phase 2: Pipeline integration** (3 days)
   - Extend `pipeline-ir.ts` with OODA-specific fields
   - Modify `pipeline-compiler.ts` to parse `Authority: ooda` phases with Intent/Constraints/Boundaries/Success-criteria directives
   - Add OODA execution path in `index.ts` — when a phase has `authority: ooda`, wrap the SDK execution in the OODA state machine

3. **Phase 3: Observation infrastructure** (2 days)
   - OODA state writing to Munin after each cycle
   - Integration with cancellation-watch (abort OODA loop on cancel-requested)
   - Boundary enforcement: time tracking, cycle counting, cost accumulation
   - Optional: integrate with pheromone system (Experiment 1) — OODA phases deposit richer pheromones

4. **Phase 4: Testing and tuning** (3-5 days)
   - Run simple OODA pipeline: "make tests pass" on a repo with a known bug
   - Compare with rigid pipeline that has explicit fix instructions
   - Tune system prompts to balance adaptation vs. focus
   - Test boundary enforcement (cycles, time, cost)
   - Test failure modes: what happens when the agent pivots repeatedly without progress?

### 4. Evaluation & Success Criteria

| Metric | Success | Failure |
|--------|---------|---------|
| OODA cycles executed | Agent goes through observe→orient→decide→act | Agent ignores OODA structure, just acts |
| Adaptation observed | Agent pivots approach after finding unexpected state | Agent follows initial plan regardless |
| Success criteria met | Agent achieves intent within boundaries | Agent runs out of cycles or hits boundary |
| State persisted | OODA state readable in Munin during execution | State not written or corrupted |
| No goal drift | Final action aligns with original intent | Agent wanders into unrelated work |
| Cost bounded | Stays within declared cost boundary | Exceeds boundary before abort triggers |

**Minimum viable experiment:** A single OODA phase (not embedded in a pipeline) that tries to make a deliberately broken test suite pass. Give it a repo with 3 failing tests, an intent ("make all tests pass"), constraints ("don't change test files"), and 3 cycles. See if it observes, adapts, and succeeds compared to a single-shot prompt.

### 5. Example Scenario

```markdown
## Task: Harden the Hugin error handling
**Runtime:** pipeline
**Sensitivity:** internal

### Pipeline

Phase: Audit
  Runtime: claude-sdk
  Authority: ooda
  Max-cycles: 3
  Blackboard-access: write
  Intent: |
    Identify the top 3 most impactful error handling gaps in the Hugin codebase.
  Constraints: |
    - Focus on runtime failures, not type errors
    - Consider the Raspberry Pi deployment context (memory limits, thermal throttling)
  Boundaries: |
    - Maximum 3 OODA cycles
    - Maximum 180 seconds
  Success-criteria: |
    - At least 3 specific error handling gaps identified with file:line references
    - Each gap has a severity rating and proposed fix approach
    - Findings written to pipeline blackboard
  Context: repo:hugin
```

**Execution flow:**

**Cycle 1 — OBSERVE:** Agent reads `src/index.ts`, `src/sdk-executor.ts`, `src/ollama-executor.ts`. Notes the codebase structure.
**Cycle 1 — ORIENT:** "The main execution loop has try/catch blocks but several async operations (Munin writes, git push) could throw without adequate error handling. The Ollama executor has streaming timeout logic that might not handle partial response corruption."
**Cycle 1 — DECIDE:** "Focus first on the dispatch loop's error handling, as it's the most critical path."
**Cycle 1 — ACT:** Deep-reads `index.ts` focusing on error paths. Writes finding to blackboard: "Gap 1: Lease renewal failure in pollOnce() silently swallowed — if Munin is unreachable during lease renewal, the task continues but may be claimed by a stale-task recovery, causing double execution. File: src/index.ts:1130."

**Cycle 2 — OBSERVE:** Agent reads `ollama-executor.ts` streaming logic and `pipeline-dispatch.ts`.
**Cycle 2 — ORIENT:** "The Ollama streaming has good timeout handling but the SSE parser doesn't handle malformed JSON in individual chunks. Pipeline dispatch has a partial-write cancellation path but it's best-effort."
**Cycle 2 — DECIDE:** "These are the next two gaps. I have 3 findings now — check success criteria."
**Cycle 2 — ACT:** Writes findings 2 and 3 to blackboard. Self-evaluates: criteria met (3 gaps, all with file:line, all rated). Sets state to COMPLETE.

*Agent completed in 2 of 3 allowed cycles, with findings that a rigid single-prompt task might have produced — but the OODA structure ensured systematic coverage and allowed the agent to adapt its investigation path based on what it found in cycle 1.*

---

## Comparison Matrix

| Dimension | Exp 1: Pheromone Trails | Exp 2: Blackboard Pipeline | Exp 3: OODA Pipelines |
|-----------|------------------------|---------------------------|----------------------|
| **Size** | S (2-3 days) | M (5-7 days) | L (10-15 days) |
| **Inspiration** | Ant colony optimization (biology) | HEARSAY-II blackboard + Physarum (AI + biology) | Boyd's OODA + Auftragstaktik (military) |
| **Problem addressed** | Static runtime selection | Phase isolation in pipelines | Rigid pipeline execution |
| **Code changes** | 1 new file + hooks | 1 new file + 4 modified | 2 new files + 4 modified |
| **Munin usage** | New `pheromones/` namespace | New `pipelines/*/blackboard/` namespace | OODA state persisted to task namespace |
| **Pipeline changes** | None (pre-dispatch only) | New context source + phase attribute | New authority type + execution mode |
| **Builds on existing** | Task result metadata | Pipeline system, context-loader | Pipeline system, SDK executor |
| **Novelty** | Medium (ACO is well-studied) | Medium (blackboard is classic but unexplored in this context) | High (OODA + Auftragstaktik for LLM agents) |
| **Risk** | Low (purely additive) | Medium (changes context injection) | High (new execution paradigm) |
| **Synergy** | Standalone | Works alone, better with Exp 1 | Best with Exp 2 (blackboard for observations) |
| **Hardware impact** | Minimal (extra Munin writes) | Moderate (larger prompts) | Significant (multi-cycle execution) |
| **Failure mode** | Cold start, overfitting | Context bloat, garbage propagation | Goal drift, infinite loops, cost explosion |

---

## Recommended Execution Order

### 1. Start with Experiment 1 (Pheromone Trails) — Week 1

**Why first:**
- Smallest scope, lowest risk, fully additive
- Produces immediately useful data (execution metadata) even if routing logic is never activated
- Establishes the pattern of using Munin as a coordination medium (shared environment)
- Creates the telemetry foundation that Experiments 2 and 3 can build on
- Can be deployed and observed passively before activating routing

**Quick win:** Just implementing pheromone deposits (without the routing logic) provides a dataset of task execution patterns that informs the design of the other experiments.

### 2. Then Experiment 2 (Blackboard Pipeline) — Weeks 2-3

**Why second:**
- Medium scope, addresses a concrete and felt limitation
- The blackboard infrastructure becomes the "shared workspace" that OODA phases use for observations
- Can be tested incrementally: start with read-only blackboard (inject previous phase results), then add write access
- Validates the key hypothesis (inter-phase information flow improves pipeline outcomes) before investing in OODA

**Dependency:** Benefits from pheromone data showing which pipeline patterns succeed/fail.

### 3. Finally Experiment 3 (OODA Pipelines) — Weeks 4-6

**Why last:**
- Largest scope, highest risk, most novel
- Builds on both previous experiments: uses blackboard for OODA observations, pheromones for cycle-level telemetry
- Requires the most tuning and observation to get right
- The "minimum viable experiment" (single OODA phase, no pipeline integration) can be attempted earlier as a spike

**Dependency:** Strongly benefits from blackboard infrastructure. Can run without pheromones but richer with them.

---

## Further Reading

1. **[Swarm Intelligence: From Natural to Artificial Systems](https://www.researchgate.net/publication/300084006)** — Bonabeau, Dorigo & Theraulaz. The foundational text on ACO and swarm intelligence applied to computing.

2. **[Stigmergy and Implicit Coordination in Software Development](https://www.researchgate.net/publication/282862646)** — Bolici, Howison & Crowston. Research on stigmergic coordination in open source, directly applicable to multi-agent systems.

3. **[The 5th Agent Orchestration Pattern: Market-Based Task Allocation](https://dev.to/slythefox/the-5th-agent-orchestration-pattern-market-based-task-allocation-db0)** — Practical guide to auction-based agent routing with code examples.

4. **[Exploring Advanced LLM Multi-Agent Systems Based on Blackboard Architecture](https://arxiv.org/html/2507.01701v1)** — Recent (2025) paper applying blackboard systems to LLM multi-agent coordination.

5. **[Building Intelligent Multi-Agent Systems with MCPs and the Blackboard Pattern](https://medium.com/@dp2580/building-intelligent-multi-agent-systems-with-mcps-and-the-blackboard-pattern-to-build-systems-a454705d5672)** — Practical MCP + blackboard integration guide.

6. **[The Dark Psychology of Multi-Agent AI: 30 Failure Modes](https://medium.com/@rakesh.sheshadri44/the-dark-psychology-of-multi-agent-ai-30-failure-modes-that-can-break-your-entire-system-023bcdfffe46)** — Comprehensive catalog of what goes wrong in multi-agent systems.

7. **[Why Your Multi-Agent System is Failing: The 17x Error Trap](https://towardsdatascience.com/why-your-multi-agent-system-is-failing-escaping-the-17x-error-trap-of-the-bag-of-agents/)** — Quantitative analysis of error amplification in multi-agent systems.

8. **[Elinor Ostrom's 8 Design Principles for Managing the Commons](https://www.agrariantrust.org/ostroms-eight-design-principles-for-a-successfully-managed-commons/)** — Nobel Prize-winning framework for self-governed resource management.

9. **[The OODA Loop & Cynefin](https://thecynefin.co/the-ooda-loop-cynefin/)** — Dave Snowden on matching decision loops to problem domains.

10. **[Evolving the OODA Loop for Strategy](https://www.mca-marines.org/gazette/ooda-loop-for-strategy/)** — Marine Corps Gazette on applying Boyd's concepts to modern operations.

11. **[Ashby's Law of Requisite Variety](https://systemsthinkingalliance.org/ashbys-law-of-requisite-variety/)** — Clear explanation of why controller complexity must match system complexity.

12. **[Physarum-Inspired Network Optimization: A Review](https://arxiv.org/pdf/1712.02910)** — Survey of slime mold algorithms for network optimization.

13. **[Decentralized Adaptive Task Allocation for Dynamic Multi-Agent Systems](https://www.nature.com/articles/s41598-025-21709-9)** — Scientific Reports (2025) on adaptive allocation without central control.

14. **[Backpressure in Distributed Systems](https://www.tedinski.com/2019/03/05/backpressure.html)** — Foundational explanation of backpressure as a coordination mechanism.

15. **[OpenAI Swarm: Routines and Handoffs](https://github.com/openai/swarm)** — The minimalist multi-agent framework that proved two primitives suffice.
