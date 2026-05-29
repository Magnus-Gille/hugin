# Eval-Gated Skill Distillation — Implementation Spec (A2–A7, #79–#84)

**Status:** design / plan only. No feature code in this doc.
**Date:** 2026-05-29
**Source of truth:** the cross-model debate at `docs/decisions/skill-distillation/*` (branch `docs/skill-distillation-debate`), summarised in `skill-distillation-summary.md`.

## 0. Architecture in one line

Build a **versioned `RouteBinding` system with a load-bearing `TaskClassifier`** — *not* an "eval-gated skill-promotion boolean flag". A `RouteBinding` is `(taskClass, skillPackageProfile, cellManifest, evalSuite) → policy + calibrated metrics`, with lifecycle `draft → candidate → shadow → active → stale → quarantined → disabled`. Real-task (`active`) routing is gated on Hugin **#77** (crash-recovery liveness). Offline package/eval/profile authoring proceeds in parallel.

### What "distillation" means here
Transfer of **procedures** (retrievable, inspectable text), not weights. No fine-tune / LoRA (rejected: loses inspectability, versionability, per-route gating).

### The five new artifact types (all versioned, content-addressed)
| Artifact | Issue | Selectable? | Mutable? |
|----------|-------|-------------|----------|
| `TaskClassifier` | #82 (A5) | decides `taskClass` | immutable version + small active pointer |
| `SkillPackage` → `SkillPackageProfile` | #80 (A3) | no (referenced) | immutable, content-addressed |
| `CellManifest` | #79 (A2) | no (referenced) | immutable, content-addressed |
| `EvalSuite` + `ValidationRun` | #83 (A6) | no (evidence) | immutable, content-addressed |
| `RouteBinding` | #79 (A2) | **yes — only selectable object** | immutable rows + mutable active pointer |

### Hard rule restated from the debate
The router must consume a `RouteBinding` end-to-end for the first row. If the first slice only adds nullable columns while the router still behaves like a boolean promotion path, the redesign has *not* landed — it has recreated `validatedSkills` with a nicer name (critique C13).

### Naming / placement conventions used throughout
- **Munin namespaces:** `skills/<id>/...` (procedural KB + retrieval), `routes/<id>/...` (bindings + classifier + validation runs). `routes/` is internal/runtime; `skills/` is the procedural KB the local lane retrieves from.
- **Git (source of truth for authored artifacts):** new repo dir `skills/` (procedure packages, profiles, eval fixtures, graders). Munin holds *projections* (retrieval rows, active pointers, immutable run records); git holds the authored source. Content hashes tie the two together.
- **New Hugin source files** live under `src/skill/` (data model, classifier, retrieval, binding store) to keep the existing flat `src/` surface readable.

---

## A2 / #79 — `RouteBinding` data model

### Goal
Replace the boolean-promotion primitive with a versioned binding carrying policy + calibrated metrics, an explicit lifecycle, immutable validation evidence, and a small mutable active pointer that fail-closes on hash drift.

### Where it lives
- **Authored source (git):** `skills/<skill-id>/route-bindings/<binding-id>.json` — declares the tuple references (by content hash) + fallback policy. Reviewable in PRs.
- **Munin (runtime projection):**
  - `routes/<binding-id>/binding` — current binding doc + lifecycle state in tags (`route-state:active` etc.). The **active pointer** is the tag set + an `activeValidationRunHash` field; mutable.
  - `routes/<binding-id>/validation-run/<runHash>` — **immutable** content-addressed `ValidationRun` records. Never overwritten; demotion writes a *new* run, never edits an old one.
- Rationale for Munin (not just git): the router runs on the Pi and already reads Munin every poll; bindings must be selectable at runtime with CAS semantics that `munin-client` already provides (`expected_updated_at`).

### Data model (zod-style)
```ts
// src/skill/route-binding-schema.ts
export const lifecycleStateSchema = z.enum([
  "draft", "candidate", "shadow", "active", "stale", "quarantined", "disabled",
]);

export const tupleRefSchema = z.object({
  // content-addressed references; the binding never inlines the artifacts
  taskClassId: z.string().min(1),
  taskClassVersion: z.number().int().nonnegative(),
  taskClassHash: z.string().regex(/^[0-9a-f]{64}$/),
  skillProfileId: z.string().min(1),
  skillProfileHash: z.string().regex(/^[0-9a-f]{64}$/),
  cellManifestId: z.string().min(1),
  cellManifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  evalSuiteId: z.string().min(1),
  evalSuiteHash: z.string().regex(/^[0-9a-f]{64}$/),
});

// Decided PRE-execution; reuses existing registry policy axes (egress/zdr).
export const fallbackPolicySchema = z.object({
  cloudAllowed: z.boolean(),
  autoEscalateAllowed: z.boolean(),
  requiresUserApproval: z.boolean(),
  zdrRequired: z.boolean(),                       // mirrors RuntimeDefinition.zdrRequired
  egressClass: z.enum(["local", "subscription", "third-party"]), // mirrors Egress
  maxCloudCostUsd: z.number().nonnegative().optional(),
  fallbackProviderSet: z.array(z.string().min(1)).default([]),    // runtime ids
  fallbackOnFailureKinds: z.array(failureKindSchema).default([]),
});

// Calibrated metrics from the binding's active ValidationRun (not live telemetry).
export const calibratedMetricsSchema = z.object({
  passRate: z.number().min(0).max(1),             // e.g. 24/27 = 0.889, NOT a bool
  sampleSize: z.number().int().positive(),
  p50DurationSeconds: z.number().nonnegative(),
  p95DurationSeconds: z.number().nonnegative(),
  failureKindHistogram: z.record(failureKindSchema, z.number().int().nonnegative()),
  abstentionRate: z.number().min(0).max(1),
});

export const routeBindingSchema = z.object({
  schemaVersion: z.literal(1),
  bindingId: z.string().min(1),
  version: z.number().int().nonnegative(),
  state: lifecycleStateSchema,
  tuple: tupleRefSchema,
  fallbackPolicy: fallbackPolicySchema,
  metrics: calibratedMetricsSchema.optional(),    // absent until >= shadow
  activeValidationRunHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  effectiveSensitivityCeiling: sensitivitySchema, // min of cell trust + classifier confidence floor
  createdAt: z.string(),
  updatedAt: z.string(),
  notes: z.string().optional(),
});

export const validationRunSchema = z.object({
  schemaVersion: z.literal(1),
  runHash: z.string().regex(/^[0-9a-f]{64}$/),     // hash of everything below
  bindingId: z.string().min(1),
  tuple: tupleRefSchema,                            // hashes pinned at run time
  // full reproducibility envelope (critique C05)
  graderHash: z.string(), promptHash: z.string(),
  harnessName: z.string(), harnessVersion: z.string(),
  wrapperName: z.string(), wrapperVersion: z.string(),
  modelId: z.string(), modelFileHash: z.string(), quantization: z.string(),
  contextCap: z.number().int().positive(), thinkingFormat: z.string(),
  toolCallParserResult: z.enum(["pass", "fail", "skipped"]),
  os: z.string(), hardwareClass: z.string(), memoryCapMb: z.number().int(),
  toolEnvManifestHash: z.string(),
  executionTimeoutMs: z.number().int(), stepBudget: z.number().int(),
  // results
  metrics: calibratedMetricsSchema,
  perFixtureResults: z.array(z.object({
    fixtureId: z.string(),
    outcome: z.enum(["pass", "fail", "abstain"]),
    caughtAtStage: failureStageSchema.optional(),  // see A6
    oracleId: z.string(),
  })),
  ranAt: z.string(),
  immutable: z.literal(true),
});

export const failureKindSchema = z.enum([
  "retrieval-miss", "classification-wrong", "preflight", "parser",
  "schema", "tests", "timeout", "grader", "delivery", "infra",
]);
```

### How the router consumes it
`src/router.ts` today is a pure filter/rank over `RuntimeCandidate`. Extend, do not rewrite:
1. **New pre-step (before existing Step 1):** a *local-lane gate*. Given a resolved `taskClass` (from A5) + the abstention contract (A4), look up an `active` `RouteBinding` for that class. If one exists and is selectable, the selected "runtime" becomes a synthetic local-skill route (`dispatcherRuntime: pi-harness`/`ollama` with the bound cell + profile). Otherwise fall through to the existing auto-router unchanged.
2. **Selectability predicate (fail-closed):** a binding is selectable only if `state === "active"` AND its `tuple` hashes still match the current content hashes of the referenced artifacts (no drift) AND `effectiveSensitivityCeiling >= task.effectiveSensitivity`. Any mismatch ⇒ not selectable ⇒ demote to `stale` and fall through to cloud per `fallbackPolicy`.
3. **`RouteDecision` recorded for every attempt**, including abstentions and the alternatives considered. Persisted in `result-structured` (extend `taskExecutionRuntimeMetadataSchema` with an optional `skillRoute` object: bindingId, version, classId, classConfidence, abstained, abstainReason).

### Signatures
```ts
// src/skill/route-binding-store.ts
loadActiveBinding(taskClassId: string, munin: MuninClient): Promise<RouteBinding | null>;
isSelectable(b: RouteBinding, currentHashes: TupleRef, taskSens: Sensitivity): { ok: boolean; reason?: string };
transition(b: RouteBinding, to: LifecycleState, evidence?: { runHash: string }): RouteBinding; // pure
recordValidationRun(run: ValidationRun, munin: MuninClient): Promise<void>; // write-once, rejects overwrite
demoteOnDrift(b: RouteBinding, munin: MuninClient): Promise<RouteBinding>;   // → stale, CAS write
```

### Files touched
- New: `src/skill/route-binding-schema.ts`, `src/skill/route-binding-store.ts`.
- Modify: `src/router.ts` (pre-step + selectability), `src/task-result-schema.ts` (add optional `skillRoute` to runtime metadata — additive, no schemaVersion bump, same pattern as `artifactDelivery` #68).
- New tests: `tests/route-binding-store.test.ts`, `tests/router-skill-lane.test.ts`.

### Lifecycle transition rules
`draft→candidate` (eval suite attached + runnable) → `candidate→shadow` (≥1 offline ValidationRun, fixture-scoped) → `shadow→active` (**requires #77 green** + a Hugin-integrated kill/restart acceptance test passing) → `active→stale` (any tuple-hash drift, fail-closed, automatic) → `active/shadow→quarantined` (production regression / failure) → `*→disabled` (manual). Re-promotion from `stale`/`quarantined` requires a **new** immutable `ValidationRun`.

### Dependencies / ordering
Schema is the foundation for A4/A5/A6/A7. Can be authored first (offline). Router pre-step integration is gated by A5 (need `taskClass`) and #77 (for `active`).

### Open questions
- Where does the active pointer's CAS authority live — single writer (the Pi dispatcher) or also the orchestrator broker? Recommend Pi-only writes to `routes/` to avoid split-brain.
- Do we keep one `RouteBinding` per `taskClass` (1:1) or allow multiple competing bindings ranked by metrics? Recommend 1 active per class for slice-one; schema already allows N rows.

### Effort
~4–5 days (schema + store + router pre-step + drift detection + tests). The router change is small; the discipline (immutability, CAS, drift fail-close) is the work.

---

## A3 / #80 — runtime-neutral procedure-package format + `pi-local-30b` profile compiler

### Goal
A portable, inspectable procedure package (the authored source) and a strict `pi-local-30b` *profile* compiled from it. The promoted unit is the **profile**, never a raw `~/.claude/skills/SKILL.md` (prior `skills-in-munin` verdict: the portable unit is at best a rewritten derivative).

### Where it lives
- Git: `skills/<skill-id>/package.yaml` (source), `skills/<skill-id>/profiles/pi-local-30b.json` (compiled, content-addressed, committed).
- Munin: a retrieval projection only (see A4). The profile body is referenced by hash, not stored as a selectable object.

### Procedure package (source) schema
```ts
// skills/<id>/package.yaml  (validated by src/skill/procedure-package-schema.ts)
export const procedurePackageSchema = z.object({
  schemaVersion: z.literal(1),
  skillId: z.string().min(1),
  title: z.string(),
  taskClassId: z.string().min(1),          // which class this serves
  inputSchema: z.record(z.unknown()),      // JSON-schema for bounded inputs
  outputSchema: z.record(z.unknown()),     // JSON-schema for the artifact
  toolAllowlist: z.array(z.string().min(1)),   // EXACT tool names; nothing else permitted
  steps: z.array(z.object({
    id: z.string(),
    instruction: z.string(),
    checkpoint: z.string(),                // observable post-condition after this step
  })).min(1),
  examples: z.array(z.object({ input: z.unknown(), output: z.unknown() })).min(1),
  antiExamples: z.array(z.object({         // look-alike inputs that MUST NOT use this skill
    input: z.unknown(), why: z.string(),
  })).min(1),
  abortConditions: z.array(z.string()).min(1),  // "do not proceed if ..."
  contraindications: z.array(z.string()).default([]),
  egressClass: z.enum(["local", "subscription", "third-party"]),
  evalSuiteId: z.string().min(1),
});
```

### `pi-local-30b` profile (compiled) — stricter than a Claude skill
The compiler lowers the package into a profile tuned for a constrained 30B operator: bounded I/O schema, explicit tool allowlist, **one-step-at-a-time checkpoints**, examples + anti-examples, abort conditions, max context budget, expected artifacts, optional per-step grader hooks.
```ts
export const piLocal30bProfileSchema = z.object({
  schemaVersion: z.literal(1),
  skillId: z.string(), profileId: z.string(),
  sourcePackageHash: z.string().regex(/^[0-9a-f]{64}$/),
  profileHash: z.string().regex(/^[0-9a-f]{64}$/),  // content address of this profile
  systemPreamble: z.string(),              // operator framing, not planner framing
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()),
  toolAllowlist: z.array(z.string()),
  stepList: z.array(z.object({ id: z.string(), prompt: z.string(), checkpointAssertion: z.string() })),
  examples: z.array(z.unknown()), antiExamples: z.array(z.unknown()),
  abortConditions: z.array(z.string()),
  maxContextChars: z.number().int().positive(),
  expectedArtifacts: z.array(z.string()),
  perStepGraderHooks: z.array(z.object({ stepId: z.string(), graderRef: z.string() })).default([]),
});
```

### Signatures
```ts
// src/skill/profile-compiler.ts
compileProfile(pkg: ProcedurePackage, target: "pi-local-30b"): PiLocal30bProfile; // pure, deterministic
profileHash(profile: PiLocal30bProfile): string;          // sha256 over canonical JSON
validatePackage(raw: unknown): ProcedurePackage;          // zod parse + structural checks
```
Compiler is **pure and deterministic** so `profileHash` is stable (drift detection in A2 depends on this).

### Files touched
- New: `src/skill/procedure-package-schema.ts`, `src/skill/profile-compiler.ts`, `skills/` repo dir (authored content).
- New tests: `tests/profile-compiler.test.ts` (determinism: same package ⇒ same hash; anti-example presence enforced).

### Dependencies / ordering
Independent of #77; fully offline. Depends on A2's `tupleRef` hash conventions (must agree on canonical-JSON hashing). Feeds A4 (retrieval rows reference profile hash) and A6 (eval runs reference profile hash).

### Open questions
- Do we also emit a `claude-skill` profile for parity, or only `pi-local-30b` for slice-one? Recommend `pi-local-30b` only now; keep the `target` param so other profiles are additive.
- Canonical JSON hashing library — recommend a small in-repo canonicaliser (sorted keys, no whitespace) shared with A2 to avoid hash disagreement.

### Effort
~3–4 days (two schemas + deterministic compiler + golden-hash tests + one authored package for slice-one).

---

## A4 / #81 — procedural-retrieval schema in Munin + fail-closed abstention contract

### Goal
Give procedural retrieval its **own schema/collection inside Munin** (not generic memory search) plus a fail-closed abstention contract. Munin stays the substrate (already deployed/authenticated), but retrieval gets QMD-shaped structure.

### Munin retrieval row schema
Stored at `skills/<skill-id>/retrieval` (one row per skill profile), tagged `procedural-retrieval`, `skill:<id>`, `task-class:<classId>`, the binding state tag, and a sensitivity tag.
```ts
// src/skill/retrieval-schema.ts
export const proceduralRetrievalRowSchema = z.object({
  schemaVersion: z.literal(1),
  skillId: z.string(), profileId: z.string(), profileHash: z.string(),
  taskClassId: z.string(),
  triggerPhrases: z.array(z.string()).min(1),
  requiredInputs: z.array(z.string()),
  requiredTools: z.array(z.string()),
  contraindications: z.array(z.string()),
  hardNegatives: z.array(z.string()).min(1),   // look-alikes that must NOT match
  egressClass: z.enum(["local", "subscription", "third-party"]),
  expectedArtifacts: z.array(z.string()),
  evalConfidence: z.number().min(0).max(1),     // from active ValidationRun
  knownFailureModes: z.array(z.string()),
  bindingId: z.string(),                        // back-reference for selectability
  bindingState: lifecycleStateSchema,           // mirror for fast fail-close
});
```

### Fail-closed abstention contract (the load-bearing part)
```ts
// src/skill/retrieval.ts
export interface RetrievalConfig {
  confidenceThreshold: number;   // below ⇒ no local route
  topTwoMarginThreshold: number; // top1 - top2 below ⇒ abstain
}
export type RetrievalOutcome =
  | { kind: "selected"; row: ProceduralRetrievalRow; score: number }
  | { kind: "abstain"; reason: "below-threshold" | "ambiguous-top-two" }
  | { kind: "unavailable"; reason: "munin-down" }
  | { kind: "not-selectable"; reason: "stale-or-quarantined" };

retrieveProcedure(
  task: { promptDigest: string; taskClassId: string; sensitivity: Sensitivity },
  munin: MuninClient,
  cfg: RetrievalConfig,
): Promise<RetrievalOutcome>;
```
Contract (all fail-closed; default is *never run local*):
- No candidate clears `confidenceThreshold` → `below-threshold` → route cloud/approval per policy.
- Top-two scores within `topTwoMarginThreshold` → `ambiguous-top-two` → **abstain** (do not let the local model improvise).
- Munin unreachable (`munin.health()` false or read throws) → `munin-down` → **do not run local**.
- Retrieved row's `bindingState` is `stale`/`quarantined`/anything but `active` → `not-selectable`.
- Every outcome (including abstain) is recorded in the `RouteDecision`.

### Files touched
- New: `src/skill/retrieval-schema.ts`, `src/skill/retrieval.ts`.
- Modify: `src/router.ts` (the local-lane pre-step calls `retrieveProcedure` before `loadActiveBinding`). Reuse `munin-client.ts` `query`/`read`/`health` — no new client methods needed.
- New tests: `tests/retrieval.test.ts` (each abstention branch; hard-negative must not match; stale binding rejected).

### Dependencies / ordering
Depends on A2 (binding state) + A3 (profile hash) + A5 (taskClassId is the primary key into retrieval). Offline-testable with fixture Munin. Not gated by #77.

### Open questions
- Retrieval scoring: reuse Munin hybrid `query` score directly, or compute a procedural-specific score from trigger-phrase + input-schema match? Recommend starting with `query` score gated by hard-negative exclusion, calibrate thresholds against retrieval fixtures (A6).
- Should `taskClassId` filtering happen in Munin (`namespace`/`tags`) or post-fetch? Recommend tag filter `task-class:<id>` server-side to keep the candidate set small.

### Effort
~3 days (schema + retrieval fn + threshold calibration harness + tests).

---

## A5 / #82 — first-class `TaskClassifier` artifact

### Why it is load-bearing (security-critical)
Once the route key starts with `taskClass`, **deciding an incoming task's class is part of routing, policy, safety, and cost**. A bad classifier can: pick the wrong procedure even when retrieval works; **bypass ZDR/egress/sensitivity policy by assigning the wrong class**; send an ambiguous task into the local lane instead of abstaining; inflate shadow metrics by only evaluating easy in-class fixtures; make demotion look like a model failure when the real bug was classification. Without a first-class versioned classifier, the system "looks rigorously versioned while its most important selection step stays opaque — worse than the original flag" (critique C11).

### Where it lives
- Git: `skills/_classifier/<classId>.yaml` (predicate + cases). Reviewable.
- Munin: `routes/_classifier/<classId>/active` — active version pointer + content hash, fail-closed on drift like a `RouteBinding`.

### Data model
```ts
// src/skill/task-classifier-schema.ts
export const taskClassifierSchema = z.object({
  schemaVersion: z.literal(1),
  classId: z.string().min(1),
  version: z.number().int().nonnegative(),
  classifierHash: z.string().regex(/^[0-9a-f]{64}$/),
  // predicate: deterministic-first. A rule predicate (regex/keyword/structured)
  // is preferred; an LLM-judge predicate is advisory and must be paired with a
  // deterministic floor (mirrors the A6 oracle rule).
  predicate: z.object({
    kind: z.enum(["rule", "llm-advisory+rule-floor"]),
    rules: z.array(z.object({ match: z.string(), weight: z.number() })),
    confidenceThreshold: z.number().min(0).max(1),   // below ⇒ abstain (no class)
    topTwoMargin: z.number().min(0).max(1),          // classes too close ⇒ abstain
  }),
  hardNegatives: z.array(z.object({ input: z.string(), why: z.string() })).min(1),
  contraindications: z.array(z.string()),
  // eval cases REQUIRED before any execution attempt
  shouldClassify: z.array(z.object({ input: z.string() })).min(1),
  shouldNotClassify: z.array(z.object({ input: z.string() })).min(1),
  sensitivityCeiling: sensitivitySchema,   // max sensitivity this class may carry to local
});

export type ClassifyResult =
  | { kind: "classified"; classId: string; confidence: number }
  | { kind: "abstain"; reason: "below-threshold" | "ambiguous-top-two" };
```

### Signatures
```ts
// src/skill/task-classifier.ts
classifyTask(prompt: string, classifiers: TaskClassifier[]): ClassifyResult; // pure, deterministic-first
classifierHash(c: TaskClassifier): string;
loadActiveClassifiers(munin: MuninClient): Promise<TaskClassifier[]>;
recordAbstention(decision: RouteDecision, munin: MuninClient): Promise<void>; // append to abstention log
```

### Security interaction (must hold)
- The classifier's `sensitivityCeiling` is an **upper bound on what the bound cell may receive**. The router takes `min(classifier ceiling, cell trust ceiling, declared/effective sensitivity ceiling)`. The classifier can never *raise* allowed sensitivity — only constrain. This is enforced in the same code path as `getRuntimeMaxSensitivity` in `router.ts`.
- Classification `abstain` is fail-closed: no class ⇒ no local route ⇒ existing cloud auto-router.
- A misclassification that *lowers* apparent sensitivity must not be able to route private data to a cloud cell: sensitivity is computed independently (`sensitivity.ts`, unchanged) and ANDed with the class ceiling. The classifier selects *which* procedure; it does not get to override the sensitivity lattice.

### Files touched
- New: `src/skill/task-classifier-schema.ts`, `src/skill/task-classifier.ts`.
- Modify: `src/router.ts` (classify before retrieve; AND ceilings into the existing trust filter).
- New tests: `tests/task-classifier.test.ts` (should/should-not cases, abstention margins, ceiling AND-ing cannot raise sensitivity).

### Dependencies / ordering
Blocks A2 router integration and A4 retrieval (both key on `classId`). Schema authorable offline. **Highest design risk** — recommend writing its eval cases (should/should-not) before its predicate.

### Open questions
- Rule-only vs LLM-advisory for slice-one. Recommend **rule-only** for the first coding slice (deterministic, auditable). LLM-advisory deferred.
- Multi-label tasks (a task that fits two classes) — handled by `topTwoMargin` abstain for now.

### Effort
~4 days (schema + deterministic predicate engine + ceiling AND-ing + adversarial eval cases). Treat the eval cases as the deliverable, not the predicate.

---

## A6 / #83 — eval-suite format with independent oracle (anti-Goodhart) + immutable validation runs

### Goal
Make evals adversarial, versioned, reproducible, and independent enough that a frontier-authored skill+grader cannot become a rubber stamp. Naming the Goodhart risk is not a fix (critique C06).

### Eval suite structure
Four fixture kinds, ≥1 **independent oracle** per route, LLM-judge advisory only, record the *stage* a failure was caught at.
```ts
// skills/<id>/eval/suite.yaml  → src/skill/eval-suite-schema.ts
export const failureStageSchema = z.enum([
  "retrieval", "classification", "preflight", "parser", "schema", "tests", "timeout", "grader",
]);

export const oracleSchema = z.object({
  id: z.string(),
  kind: z.enum(["test-suite", "schema-validator", "snapshot-diff", "static-analyzer", "judge-model"]),
  independent: z.boolean(),   // true = not authored by the skill author / not the skill's own grader
  ref: z.string(),            // path/command/module
});

export const evalSuiteSchema = z.object({
  schemaVersion: z.literal(1),
  evalSuiteId: z.string(), evalSuiteHash: z.string().regex(/^[0-9a-f]{64}$/),
  skillId: z.string(), taskClassId: z.string(),
  oracles: z.array(oracleSchema).refine(o => o.some(x => x.independent), {
    message: "at least one independent oracle required",
  }),
  judgeIsAdvisoryOnly: z.literal(true),
  fixtures: z.object({
    positive: z.array(fixtureSchema).min(1),   // in-class, must pass
    negative: z.array(fixtureSchema).min(1),   // in-class but skill should fail/abort cleanly
    retrieval: z.array(retrievalFixtureSchema).min(1), // should/should-not be SELECTED
    mutation: z.array(fixtureSchema).min(1),   // perturbed inputs; catch overfit graders
  }),
});

export const fixtureSchema = z.object({
  id: z.string(), input: z.unknown(), expected: z.unknown(),
  allowedNondeterminism: z.array(z.string()).default([]),
});
export const retrievalFixtureSchema = z.object({
  id: z.string(), input: z.string(),
  shouldSelect: z.boolean(),   // false = hard-negative retrieval case
});
```

### Anti-Goodhart rules (enforced, not advisory)
- A `ValidationRun` (schema in A2) is **rejected** if no oracle has `independent: true`.
- LLM-judge results are recorded but never decide pass/fail alone (`judgeIsAdvisoryOnly`).
- Retrieval-negative + mutation fixtures are mandatory (`.min(1)`).
- `perFixtureResults[].caughtAtStage` records *where* a failure surfaced — turns "local is flaky" into "profile v3 on wrapper vX fails retrieval-negative Z" (the operational-burden fix from the critique).

### Signatures
```ts
// src/skill/eval-runner.ts  (offline harness; no production routing)
runEvalSuite(suite: EvalSuite, profile: PiLocal30bProfile, cell: CellManifest): Promise<ValidationRun>;
gradeFixture(f: Fixture, output: unknown, oracles: Oracle[]): { outcome; caughtAtStage?; oracleId };
```

### Files touched
- New: `src/skill/eval-suite-schema.ts`, `src/skill/eval-runner.ts`, `skills/<id>/eval/` fixtures + graders.
- New tests: `tests/eval-suite-schema.test.ts` (independent-oracle refinement; judge-advisory invariant), `tests/eval-runner.test.ts` (failure-stage recording).

### Dependencies / ordering
Depends on A3 (profile), A2 (`ValidationRun`), A5 (classification/retrieval fixtures). Fully offline; **not gated by #77**. This is the core of "offline-fixture shadow" that can proceed in parallel.

### Open questions
- Grading modality per skill class (U1) — deferred to per-skill design; slice-one uses a deterministic test-suite oracle.
- Sandboxing grader execution (security): graders run code — must run in the isolated worktree, never the live tree. See Security section.

### Effort
~4–5 days (schemas + runner + independent-oracle enforcement + slice-one fixtures). Fixture authoring dominates.

---

## A7 / #84 — slice-one vertical

### Goal
Prove the full contract on **one row**: one procedure, one cell manifest, one fixture repo, offline-fixture shadow → (post-#77) Hugin-integrated active, with policy-aware escalation.

### Slice-one success criterion (NOT cost/latency)
The route can be **retrieved → classified → selected → executed → graded → delivered → failed → recovered → demoted → escalated** reproducibly. Cost/latency vs cloud is *recorded as baseline only*, never the gate (critique C10).

### The two distinct gates (do not conflate — debate D1)
- **Policy-required (categorical):** privacy/offline/egress-required tasks. Local can be worth maintaining even if slower because cloud is *not permitted*. This is the strategic justification for the matrix.
- **Cheaper-after-maintenance (economic):** local wins only after reliability + revalidation churn + human-review cost are included. Tracked, not assumed.

### Recommendation: slice-one should be a **coding (test-graded) skill**
Reasons: (1) gives a **deterministic independent oracle** for free (run the test suite / diff) — directly satisfies A6's anti-Goodhart requirement without inventing a judge; (2) the artifact is a **patch**, which fits the worktree-isolation + artifact-delivery (#68) model already in `artifact-delivery.ts` — clean fallback consumes the original snapshot, never a dirty tree; (3) it is the most hostile-to-false-confidence option (a wrong patch fails tests loudly). Concrete candidate: **single-file import normalization** or **markdown frontmatter normalization** in an isolated fixture repo — bounded, deterministic, one tool family.

### Slice-one components (one row of the matrix)
- 1 `TaskClass` (rule predicate + hard negatives + should/should-not cases).
- 1 `SkillPackage` → 1 `pi-local-30b` profile.
- 1 `CellManifest` (e.g. `pi-harness` + `qwen/qwen3-coder-next`, or `ollama` Qwen3-Coder-30B — exact wrapper/model-hash/context-cap/thinking/tool-call settings pinned; reuse the validated `pi-large-coder` alias from `runtime-registry.ts` as the starting cell).
- 1 `EvalSuite` (positive/negative/retrieval-negative/mutation + deterministic test oracle).
- 1 `RouteBinding` driven `draft→candidate→shadow` offline, then `→active` post-#77.

### Acceptance tests for the slice
1. Author → compile profile → run eval suite → produce a `ValidationRun` (offline shadow).
2. Retrieval selects the right skill; a **hard-negative** input abstains.
3. Classification abstains on an ambiguous input.
4. Successful local run on a fixture repo (worktree-isolated, output = patch).
5. **Forced local failure** falls back to cloud *per `fallbackPolicy`* (respects zdr/egress/approval).
6. **Kill-during-local-execution** test wired through the *same task lifecycle the skill lane uses* — must prove Hugin terminalizes/reconciles without a paid rerun (this is the #77 acceptance test).
7. Stale-hash test: mutate the profile → binding auto-demotes to `stale` → not selectable → cloud.

### #77 split (critique C12 — do not launder the liveness bug)
- **Offline-fixture shadow** (eval runner against fixture repos, outside production routing): **safe, not gated by #77.** Builds packages/profiles/evals/classifiers/bindings in parallel.
- **Hugin-integrated shadow** (Hugin selects the binding and runs the local lane, result not exposed to real tasks): **inherits #77.** Cannot count as readiness evidence for `active` until #77 is green.
- The kill/restart test (acceptance #6) is either marked expected-failing until #77 lands, or is the first test that *proves* #77 fixed.

### Files touched
- New: `skills/slice-one-*/` (package, profile, eval, fixtures), `tests/slice-one-e2e.test.ts` (offline portions), `tests/skill-lane-kill-recovery.test.ts` (the #77 acceptance test).
- Modify: `src/index.ts` (wire the local-skill lane into the dispatcher execution path, worktree-isolated, behind a feature flag `HUGIN_SKILL_LANE=off|shadow|active`).
- Reuse: `src/artifact-delivery.ts` (patch delivery), existing worktree isolation.

### Dependencies / ordering
Depends on A2–A6 all landing at least in offline form. The `active` step depends on #77. Last to build.

### Open questions
- Cell choice: `pi-harness`/OpenRouter-backed coder vs truly-local `ollama` 30B. The debate's premise is *local* (privacy/offline), so a truly-local cell is the honest target; `pi-harness` is third-party egress and would undercut the policy-required justification. Recommend a truly-local ollama Qwen3-Coder cell for slice-one, accepting the 10min–3h latency.
- Feature-flag default — recommend `off` until #77 + acceptance tests are green.

### Effort
~5–6 days *after* A2–A6 (mostly integration + the kill/recovery test + fixture repo). Blocked on #77 for the `active` half.

---

## Cross-cutting: sequencing & dependencies

```
#77 (crash-recovery liveness) ──────────────┐  (gates ACTIVE + Hugin-integrated shadow only)
                                             ▼
A3 (#80 package/profile) ─┐                  │
A5 (#82 classifier) ──────┼─► A4 (#81 retrieval) ─┐
A2 (#79 binding schema) ──┘                       ├─► A6 (#83 eval/validation runs)
                                                   │        │
                                                   ▼        ▼
                                              A7 (#84 slice-one)
                                          offline shadow ──(#77)──► active
```

**Build order (recommended):**
1. **A2 schema + A3 + A5 (offline, parallel)** — foundational artifacts and hashing convention. No #77 dependency.
2. **A4 retrieval + A6 eval runner** — depend on 1; offline-testable.
3. **A2 router integration** — wires classify → retrieve → select binding into `router.ts`; behind flag.
4. **A7 offline shadow** — end-to-end on fixtures; produces honest `ValidationRun`s.
5. **#77 fix + kill/recovery acceptance test** — the single most important runtime step (debate final verdict). Gates `active`.
6. **A7 active** — flip the slice-one binding to `active`.

**Critical-path note:** everything except step 6 (and the Hugin-integrated shadow portion) is unblocked today. The honest end-to-end claim (route→execute→fail→recover→fallback) is gated by #77.

**Discrepancy flagged:** the task brief states #77 is "now fixed," but `gh issue view 77` shows it **OPEN** with no closing commit in recent history. This spec treats #77 as the `active`/Hugin-integrated-shadow gate per the debate. **Verify #77's actual state before scheduling step 6.** If genuinely fixed, confirm the kill-during-local-execution acceptance test exists and passes through the skill-lane task lifecycle; if not, steps 1–4 proceed regardless.

---

## Cross-cutting: security & safety considerations

The `TaskClassifier` (A5) and the fail-closed abstention contract (A4) are **security-load-bearing**. A frontier-authored skill+grader effectively grants operational permissions to a smaller local model; the controls below are not optional.

1. **Classifier cannot raise privilege.** Sensitivity is computed independently (`sensitivity.ts`) and ANDed with the class ceiling and cell trust ceiling. The classifier selects *which* procedure, never *what sensitivity* is permitted. A misclassification can only ever be *more* restrictive or trigger abstain — never route private data to a cloud/third-party cell. Test this explicitly (A5 tests).
2. **Fail-closed everywhere.** Retrieval below threshold, ambiguous top-two, Munin down, stale/quarantined binding, classification abstain → **never run local**. Default routes to the existing cloud auto-router subject to `fallbackPolicy`.
3. **Drift fail-close.** Any tuple-hash mismatch (package/profile/eval/cell/classifier) auto-demotes the binding to `stale`; stale is not selectable. Re-promotion requires a new immutable `ValidationRun`.
4. **Tool allowlist + sandboxing.** The `pi-local-30b` profile carries an exact tool allowlist; the executor must reject any tool call outside it. Local execution and grader execution run **worktree-isolated** (reuse existing isolation) — output is a patch/artifact, never a live-tree mutation. Graders run code and must never touch the user's live tree or have network egress beyond the declared `egressClass`.
5. **Policy-aware fallback decided pre-execution.** `fallbackPolicy` (cloudAllowed/autoEscalateAllowed/requiresUserApproval/zdrRequired/egressClass/maxCloudCost) is resolved before the local run, not after a failure under recovery pressure. Reuses the existing `provider/egress/zdrRequired/autoEligible` axes in `runtime-registry.ts`.
6. **Immutable provenance.** Every output carries the `bindingId` + `runHash` that produced it (in `result-structured.skillRoute`). `ValidationRun`s are write-once; `recordValidationRun` rejects overwrites.
7. **Content-addressed packages.** Profiles, eval suites, graders, cell manifests are hashed; bindings reference by hash. This is the minimum signing posture for slice-one (the existing `task-signing.ts` HMAC posture can be layered later).
8. **Capacity/liveness as a safety property.** A 10min–3h local run that is stranded non-terminal (the #77 failure) delays fallback and corrupts shadow telemetry. The single-heavy-job semaphore must carry a policy (priority, leases, heartbeat, timeout, reaper, no eval starving cloud-eligible user work) — a bare mutex is insufficient (critique C14). This is why #77 gates `active`.
9. **No secret access** unless a skill explicitly requires it and the access is audited; default deny via the tool allowlist.

---

## "Done" checklist

Offline (not gated by #77):
- [ ] A2 `route-binding-schema.ts` + `route-binding-store.ts` with immutable `ValidationRun` write-once + CAS active pointer + drift fail-close.
- [ ] A3 `procedure-package-schema.ts` + deterministic `profile-compiler.ts` (golden-hash test).
- [ ] A5 `task-classifier-schema.ts` + `task-classifier.ts` with should/should-not cases + ceiling AND-ing test (cannot raise sensitivity).
- [ ] A4 `retrieval-schema.ts` + `retrieval.ts` with all four fail-closed branches tested.
- [ ] A6 `eval-suite-schema.ts` + `eval-runner.ts` with independent-oracle enforcement + judge-advisory invariant + failure-stage recording.
- [ ] `router.ts` pre-step: classify → retrieve → select binding → record `RouteDecision`; falls through to existing auto-router on any abstain/unavailable.
- [ ] `task-result-schema.ts` extended with optional `skillRoute` (additive, no schemaVersion bump).
- [ ] A7 slice-one authored artifacts (one coding skill) + offline-shadow e2e producing a real `ValidationRun`.

Runtime (gated by #77):
- [ ] #77 verified fixed (state + commit) — **flagged discrepancy: currently OPEN.**
- [ ] Kill-during-local-execution acceptance test passing through the skill-lane task lifecycle.
- [ ] Stale-hash demotion test passing end-to-end.
- [ ] Forced-failure cloud fallback respects `fallbackPolicy` (zdr/egress/approval).
- [ ] slice-one `RouteBinding` flipped to `active` behind `HUGIN_SKILL_LANE=active`.

Docs/ops:
- [ ] New env vars documented in `CLAUDE.md` (`HUGIN_SKILL_LANE`, retrieval thresholds, semaphore policy).
- [ ] Open findings filed as GitHub issues, not left as prose.
