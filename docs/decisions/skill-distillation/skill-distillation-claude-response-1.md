# Claude's Response — Round 1

The critique is mostly right and improves the design materially. The central move —
**route binding, not skill-promotion flag** — is correct and I adopt it. Below: concessions,
partial concessions, and the few places I push back.

## Concessions (adopted wholesale)

- **C1 — "eval-gated skill promotion" is the wrong primitive (Finding 2).** Conceded. The unit is a
  versioned `RouteBinding: (taskClass, skillPackageProfile, cellManifest, evalSuite) → policy + calibrated metrics`,
  with states `draft → candidate → shadow → active → stale → quarantined → disabled`. A boolean
  `validatedSkills` flag discards the partial-pass/latency signal the prior eval work proved is the
  actual texture of local performance (24/27, not "works"). This is the headline change.

- **C2 — `SKILL.md` is not portable; author a runtime-neutral procedure package (Finding 3).** Conceded,
  and strengthened by the `skills-in-munin` decision Codex surfaced that I failed to load: the portable
  unit is a *rewritten derivative*, not the Claude skill. Source artifact = runtime-neutral procedure
  package; compile a strict `pi-local-30b` profile (bounded inputs, explicit I/O schema, tool allowlist,
  one-step checkpoints, examples + anti-examples, abort conditions). Promotion applies to the *profile*.

- **C3 — Anti-Goodhart eval structure (Finding 6).** Conceded. Naming F1 wasn't a fix. Adopt: split into
  positive / negative / retrieval / mutation fixtures; require ≥1 *independent* oracle per route (test
  suite, schema validator, snapshot diff, static analyzer); LLM-judge is advisory only; record the
  *stage* a failure was caught at (retrieval / preflight / parser / schema / tests / timeout / grader).

- **C4 — Fail-closed retrieval contract + procedural schema in Munin (Finding 4).** Conceded. Munin stays
  the substrate, but procedural retrieval gets its own collection/schema (trigger phrases, required
  inputs/tools, contraindications, egress class, expected artifacts, eval confidence, version hashes,
  hard negatives). Contract: no result over threshold → cloud/approval; top-two too close → abstain;
  Munin down → do not run local; stale/quarantined binding → not selectable. My AR3 ("no dedicated
  index") survives — but only because the index becomes a *schema inside Munin*, not generic memory.

- **C5 — Escalation is a state transition, not an exception handler (Finding 7).** Conceded, and this is
  the most useful correction. Local execution runs in an **isolated worktree** (Hugin already has
  worktree isolation), output is a *patch/artifact* never a live-tree mutation, preflight gates
  (parser smoke test, tool env, route active, context budget), step budgets + early-abort detectors,
  cloud fallback consumes the *original snapshot + validated intermediate*, never a dirty workspace.

- **C6 — Immutable, content-addressed promotion records; mutable pointer to active binding (Finding 5).**
  Conceded. The registry stores a small "which binding is active" pointer; the evidence (all the hashes —
  package, profile, eval, grader, wrapper, model file, quantization, context cap, thinking format, parser
  test result, hardware envelope, tool-env manifest) is an immutable run record. Demotion fail-closes on
  any hash drift.

- **C7 — Policy-aware fallback (Finding 8).** Conceded. I missed that Hugin routing already carries
  `provider / egress / zdrRequired / autoEligible`. Fallback is not unconditional: the binding carries
  `cloudAllowed`, `autoEscalateAllowed`, `requiresUserApproval`, `zdrRequired`, `egressClass`,
  `maxCloudCost`, `fallbackOnFailureKinds`, decided *before* execution.

## Partial concessions

- **PC1 — #77 as precondition (Finding 1).** Partially accept. #77 (crash-recovery liveness) gates the
  **`active`** state for real-task routing — agreed, a stranded hour-long lease is exactly the lane this
  lives in. But it does *not* gate the whole build: the slice can be built and run end-to-end in
  **`shadow`** against a fixture repo while #77 is open, because shadow runs aren't load-bearing for user
  tasks. So: #77 is a precondition for **promotion to `active`**, not for building or shadow-validating.
  This keeps the build unblocked while honoring the real runtime constraint. I'll add a "kill-during-local-
  execution" acceptance test to the slice regardless.

- **PC2 — Munin-superior-to-QMD claim (Finding 4 / Unsupported Claims).** Concede the *argument* was
  sloppy — QMD is a serious retrieval system (FTS5, sqlite-vec, RRF, AST chunking, reranking), not "flat
  markdown." Correction: Munin is the right substrate because it's *already deployed, audited, and
  authenticated* in this stack, not because QMD is primitive. The procedural-schema work (C4) is
  effectively importing QMD's *shape* into Munin. Claim rewritten, conclusion unchanged.

- **PC3 — Full contract surface now (Findings 2/5/8, Scale).** Accept the *data model* must accommodate the
  full matrix (task class × profile × eval × harness × wrapper × model × context cap × hardware × tool env)
  — but the first slice populates **one row**. Codex agrees ("put the matrix in the data model now, then
  start with one row"), so this is alignment, not conflict. Guarding against over-engineering: the eight
  fallback-policy fields and thirteen run-record fields are *schema columns*, most defaulted, not eight
  subsystems to build in slice one.

## Defenses (push back)

- **D1 — "Beats cloud on cost/latency is the wrong success criterion" (Unsupported Claims).** Partial
  push-back. For *slice one* Codex is right: the gate is correctness, fail-closed behavior, reproducible
  promotion, crash recovery, clean fallback. I concede that. **But** for the *capability* to earn its
  maintenance burden (F5, combinatorial revalidation), it must eventually win on **privacy/offline/egress-
  constrained tasks** — the `zdrRequired`/`egressClass` lane Codex itself raised. So cost/latency-vs-cloud
  is not the architecture gate, but "is there a real task class where local is *required or cheaper*" is the
  strategic gate that decides whether the matrix is worth maintaining at all. Recorded as a non-slice-one
  success metric, not dropped.

- **D2 — Capacity model / scheduler.** Accept the need (one heavy local job at a time on the 32GB Air,
  queued evals, no eval starving production). Minor scope note: Hugin already serializes the batch lane;
  the new requirement is just "evals share the same single-heavy-job semaphore," not a new scheduler.

## Revised positions table

| # | Original | Revised |
|---|----------|---------|
| Primitive | eval-gated skill promotion (bool flag) | versioned `RouteBinding` with lifecycle states + calibrated metrics |
| Skill artifact | existing `SKILL.md` | runtime-neutral procedure package → compiled `pi-local-30b` profile |
| Eval | Opus writes skill + grader | split fixtures + ≥1 independent oracle + failure-stage recording |
| Retrieval | trust Munin hybrid search | procedural schema in Munin + fail-closed abstention contract |
| Promotion record | `validatedSkills` registry field | immutable content-addressed run record + mutable active pointer |
| Escalation | "cloud fallback otherwise" | worktree-isolated execution + preflight + budgets + snapshot-based state transition |
| Fallback | unconditional cloud | policy-gated (`zdrRequired`/`egressClass`/approval) decided pre-execution |
| #77 | ignored | precondition for `active` routing, not for build/shadow |
| Slice gate | beats cloud on cost/latency | route retrieved→executed→graded→delivered→failed→recovered→demoted→escalated reproducibly |
