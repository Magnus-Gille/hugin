# Phase 6 Engineering Plan: Router (`Runtime: auto`)

**Parent plan:** `docs/hugin-v2-engineering-plan.md`  
**Prerequisite:** Phase 5 sensitivity classification — complete (corpus evaluation passed 19/19, zero under-classifications)  
**Date:** 2026-04-06 (plan); 2026-04-07 (adopted)

## Context

Hugin currently requires every task and pipeline phase to declare an explicit runtime (`claude`, `codex`, `ollama`, or a pipeline runtime ID like `claude-sdk`, `ollama-pi`). Phase 5 gave every task an `effectiveSensitivity` that is already enforced as a hard ceiling on cloud runtimes. Phase 6 adds `Runtime: auto` so that Hugin can choose the runtime itself, using sensitivity as a trust filter and availability/capability as tiebreakers. Explicit runtimes remain the default — `auto` is opt-in only.

The design doc (`docs/hugin-v2-pipeline-orchestrator.md:285-325`) defines the router as a pure function: `(phase, sensitivity, available_runtimes) → runtime`. The research doc (`docs/research/agent-orchestration-experiments.md`) proposes pheromone-based adaptive routing, but the engineering plan here implements the **deterministic first pass** only. Pheromone/learning-based routing is a follow-on experiment after the deterministic router proves itself.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Task / Pipeline Phase                      │
│  Runtime: auto                                                │
│  effectiveSensitivity: internal                               │
└───────────────────────────┬──────────────────────────────────┘
                            │
                            ▼
               ┌────────────────────────┐
               │   1. FILTER: trust     │  sensitivity → allowed trust tiers
               │   private → ollama-*   │  internal → ollama-* + claude/codex
               │   public → all         │
               └───────────┬────────────┘
                           │
                           ▼
               ┌────────────────────────┐
               │  2. FILTER: available  │  ollama-hosts probe cache
               │  remove offline hosts  │  claude/codex assumed available
               └───────────┬────────────┘
                           │
                           ▼
               ┌────────────────────────┐
               │  3. FILTER: capability │  task hints: needs-tools,
               │  remove unfit runtimes │  needs-code, needs-structured
               └───────────┬────────────┘
                           │
                           ▼
               ┌────────────────────────┐
               │  4. RANK candidates    │  prefer subscription > per-token
               │                        │  prefer trusted > semi-trusted
               │                        │  prefer larger model for complex
               └───────────┬────────────┘
                           │
                           ▼
               ┌────────────────────────┐
               │  5. SELECT or FAIL     │  top candidate, or clear error
               └────────────────────────┘
```

## Design decisions

### 1. Router is a pure, synchronous function (after async probing)

The router takes a resolved `RouterInput` and returns a `RouterDecision`. Host probing happens *before* the router is called (reusing existing `ollama-hosts.ts` infrastructure). The router itself has no side effects — easy to test, easy to audit.

### 2. Capability hints are opt-in, not inferred

Task authors can declare `Capabilities: tools, code` (standalone) or per-phase `Capabilities:` (pipeline). If omitted, no capability filtering happens. Do not try to infer capabilities from prompt text in the first pass — that's a heuristic rat-hole.

### 3. No escalation-on-failure in the first pass

The design doc mentions `Escalate-on-failure: claude-sdk`. Defer this to a follow-on. The first router is a one-shot selection. If it fails, the task fails. This keeps the execution path simple.

### 4. Standalone tasks and pipeline phases share the same router

Both paths resolve to the same `routeTask()` call. For standalone tasks, the dispatcher resolves `Runtime: auto` before execution. For pipeline phases, the compiler resolves `Runtime: auto` at compile time, embedding the chosen runtime into the IR.

### 5. Runtime registry is formalized in a shared module

Currently, pipeline runtime definitions live in `pipeline-ir.ts` (`PIPELINE_RUNTIME_REGISTRY`) and standalone runtime knowledge is implicit in `index.ts`. Phase 6 creates `src/runtime-registry.ts` that owns the full registry — trust tiers, capability flags, availability probing, and the mapping between standalone and pipeline runtime IDs.

## File changes

### New files

#### `src/router.ts` — Router logic

Pure routing function. ~120 lines.

```typescript
export interface RouterInput {
  effectiveSensitivity: Sensitivity;
  capabilities?: RuntimeCapability[];  // optional hints
  preferredModel?: string;             // model affinity
  availableRuntimes: RuntimeCandidate[];
}

export interface RuntimeCandidate {
  id: string;                          // "claude-sdk", "ollama-pi", etc.
  dispatcherRuntime: DispatcherRuntime;
  trustTier: "trusted" | "semi-trusted";
  available: boolean;
  capabilities: RuntimeCapability[];
  costModel: "subscription" | "per-token" | "free";
  modelSize: "small" | "medium" | "large";
  ollamaHost?: string;
  models?: string[];
}

export type RuntimeCapability = "tools" | "code" | "structured-output";

export interface RouterDecision {
  selectedRuntime: RuntimeCandidate;
  reason: string;          // human-readable audit trail
  eliminated: Array<{
    id: string;
    reason: string;
  }>;
}

export function routeTask(input: RouterInput): RouterDecision { ... }
```

Filter chain:
1. **Trust**: `private` → `trusted` only; `internal` → `trusted` + `semi-trusted`; `public` → all
2. **Availability**: drop `available === false`
3. **Capability**: if `capabilities` specified, drop runtimes missing any
4. **Model affinity**: if `preferredModel` specified and an ollama host has it, boost that candidate
5. **Rank**: free > subscription > per-token; trusted > semi-trusted; larger model > smaller (tiebreaker)
6. **Select** top-ranked or throw with clear elimination reasons

#### `src/runtime-registry.ts` — Runtime registry

Owns the canonical list of runtimes with their properties. ~80 lines.

```typescript
export interface RuntimeDefinition {
  id: string;
  dispatcherRuntime: DispatcherRuntime;
  trustTier: "trusted" | "semi-trusted";
  costModel: "subscription" | "per-token" | "free";
  modelSize: "small" | "medium" | "large";
  capabilities: RuntimeCapability[];
  ollamaHost?: "pi" | "laptop";
  defaultModel?: string;
}

export const RUNTIME_REGISTRY: RuntimeDefinition[] = [
  {
    id: "claude-sdk",
    dispatcherRuntime: "claude",
    trustTier: "semi-trusted",
    costModel: "subscription",
    modelSize: "large",
    capabilities: ["tools", "code", "structured-output"],
  },
  {
    id: "codex-spawn",
    dispatcherRuntime: "codex",
    trustTier: "semi-trusted",
    costModel: "subscription",
    modelSize: "large",
    capabilities: ["tools", "code"],
  },
  {
    id: "ollama-pi",
    dispatcherRuntime: "ollama",
    trustTier: "trusted",
    costModel: "free",
    modelSize: "small",
    capabilities: [],
    ollamaHost: "pi",
    defaultModel: "qwen2.5:3b",
  },
  {
    id: "ollama-laptop",
    dispatcherRuntime: "ollama",
    trustTier: "trusted",
    costModel: "free",
    modelSize: "medium",
    capabilities: [],
    ollamaHost: "laptop",
    defaultModel: "qwen3.5:35b-a3b",
  },
];

export function buildRuntimeCandidates(
  ollamaHosts: OllamaHost[],
): RuntimeCandidate[] { ... }
```

Merges static registry with live host probe data from `ollama-hosts.ts`.

#### `tests/router.test.ts` — Router unit tests

#### `tests/runtime-registry.test.ts` — Registry tests

### Modified files

#### `src/sensitivity.ts`

- `getDispatcherRuntimeMaxSensitivity()` and `getPipelineRuntimeMaxSensitivity()` should delegate to the new registry instead of duplicating trust-tier knowledge. Keep the functions as thin wrappers for backwards compatibility.

#### `src/index.ts` — Standalone task dispatch

- `parseDeclaredRuntime()`: accept `"auto"` as a valid value → `DeclaredRuntime = "claude" | "codex" | "ollama" | "pipeline" | "auto"`
- `parseTask()`: when runtime is `"auto"`, don't assign a concrete runtime yet; set a flag like `autoRoute: true`
- `TaskConfig.runtime` stays as `"claude" | "codex" | "ollama"` (concrete). Add `TaskConfig.autoRouted?: boolean` and `TaskConfig.routingDecision?: RouterDecision`.
- Before execution (after `assessTaskSecurity()`), if `autoRoute`, call `routeTask()` with the task's effective sensitivity and available runtimes. Set the concrete `runtime` from the decision. Log the routing decision.
- The existing sensitivity enforcement (`getSecurityViolationForTask`) runs *after* routing, catching any bug in the router as defense-in-depth.
- Add `Capabilities:` field parsing to `parseTask()`.

#### `src/pipeline-compiler.ts` — Pipeline phase routing

- `validateRuntimeId()`: remove the `auto` error. When runtime is `"auto"`, call `routeTask()` using the phase's effective sensitivity and the live registry.
- Store the routing decision in the phase IR for auditability.
- The compile-time sensitivity check (`maxSensitivity(effectiveSensitivity, runtimeMaxSensitivity)`) still runs after routing — defense-in-depth.
- Add optional per-phase `Capabilities:` parsing.

#### `src/pipeline-ir.ts`

- Add `autoRouted?: boolean` and `routingReason?: string` to `PipelinePhaseIR` for audit trail.
- `PIPELINE_RUNTIME_REGISTRY` stays for now but the source of truth moves to `runtime-registry.ts`. Mark the old one as deprecated or re-export.

#### `src/task-result-schema.ts`

- Add `routingDecision` to `TaskExecutionRuntimeMetadata`:
  ```typescript
  autoRouted?: boolean;
  routingReason?: string;
  eliminatedRuntimes?: Array<{ id: string; reason: string }>;
  ```

#### `src/result-format.ts`

- Include routing decision in the markdown result when `autoRouted` is true.

#### `src/pipeline-dispatch.ts`

- No structural changes. Child task content already includes `Runtime:` from the IR, which is now a concrete runtime chosen by the router at compile time.

## Implementation slices

### Slice 1: Runtime registry (`src/runtime-registry.ts`)

- Extract registry from `pipeline-ir.ts` into the new module
- Add trust tier, cost model, model size, capabilities to each entry
- Add `buildRuntimeCandidates()` that merges live ollama-hosts probe data
- Wire `sensitivity.ts` helpers to delegate to the registry
- Tests: registry completeness, candidate building with mixed availability

### Slice 2: Router (`src/router.ts`)

- Implement `routeTask()` with the 5-step filter/rank chain
- Pure function, no I/O — all inputs are pre-resolved
- Tests: trust filtering, availability filtering, capability filtering, ranking, no-candidates error, model affinity

### Slice 3: Standalone task routing (`src/index.ts`)

- Accept `Runtime: auto` in task parsing
- Add `Capabilities:` field parsing
- Call router before execution when `auto`
- Log routing decision
- Populate structured result with routing metadata
- Tests: auto-routed task happy path, auto-route with private sensitivity (only ollama), auto-route with no available runtimes (clean error), explicit runtime unaffected

### Slice 4: Pipeline phase routing (`src/pipeline-compiler.ts`, `src/pipeline-ir.ts`)

- Accept `Runtime: auto` in pipeline phases
- Add per-phase `Capabilities:` parsing
- Call router at compile time
- Embed concrete runtime + audit trail in IR
- Tests: pipeline with mixed auto/explicit phases, private phase routes to ollama only, auto phase with capabilities filter

### Slice 5: Audit trail and result surface (`src/task-result-schema.ts`, `src/result-format.ts`)

- Add routing metadata to structured results
- Add routing info to markdown results
- Tests: structured result schema validation with routing fields

## Test plan

### Unit tests

**`tests/router.test.ts`** — core routing logic:
- Trust filtering: private → only trusted; internal → trusted + semi-trusted; public → all
- Availability filtering: offline hosts removed
- Capability filtering: needs-tools drops ollama
- Ranking: free preferred over subscription; trusted preferred over semi-trusted
- No candidates → clear error with elimination reasons
- Model affinity: preferred model on available host wins

**`tests/runtime-registry.test.ts`**:
- All registered runtimes have required fields
- `buildRuntimeCandidates()` marks ollama hosts as unavailable when offline
- Claude/codex always marked available

### Existing test expansions

**`tests/dispatcher.test.ts`**:
- `Runtime: auto` standalone task parses correctly
- Auto-routed task gets concrete runtime before execution
- Explicit runtime tasks unchanged

**`tests/pipeline-compiler.test.ts`**:
- Pipeline phase with `Runtime: auto` compiles to concrete runtime
- Private auto phase cannot route to cloud runtime
- Mixed auto + explicit phases compile correctly

**`tests/task-result-schema.test.ts`**:
- Structured result with routing metadata validates

### Live evaluation

**Bet 2 success gate** (from `docs/hugin-v2-engineering-plan.md`):

> Routed tasks must match or beat manually chosen runtimes with zero sensitivity violations.

Evaluation tasks:
1. `Runtime: auto` + `Sensitivity: internal` → should pick claude-sdk or codex (subscription, capable)
2. `Runtime: auto` + `Sensitivity: private` → must pick ollama-* only
3. `Runtime: auto` + `Capabilities: tools, code` → should pick claude-sdk or codex, not ollama
4. `Runtime: auto` + no capabilities + `Sensitivity: public` → should pick free/trusted ollama if available
5. Pipeline with 3 phases: 1 explicit `claude-sdk`, 1 `auto` internal, 1 `auto` private → verify mixed routing
6. `Runtime: auto` when all ollama hosts are offline + `Sensitivity: private` → clean failure, not a cloud leak
7. Verify every auto-routed structured result contains routing metadata

## Verification

1. `npm run build` — no type errors
2. `npm test` — all existing + new tests pass
3. Deploy to `huginmunin.local`
4. Submit the 7 evaluation tasks above
5. Verify: zero sensitivity violations, routing metadata in all results, explicit-runtime tasks unaffected
