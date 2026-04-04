# Security Engineering Plan: Critical Pre-Phase-5 Holes

**Parent plan:** [hugin-v2-engineering-plan.md](/Users/magnus/repos/hugin/docs/hugin-v2-engineering-plan.md)  
**Status:** Implemented first pass and live-validated  
**Date:** 2026-04-04  
**Source:** Pi-side `docs/security/lethal-trifecta-assessment.md`

## Goal

Close the three critical security holes identified in the lethal-trifecta assessment before normal Phase 5 work expands Hugin's trust and routing surface.

Those holes are:

- unrestricted or weakly restricted outbound network access from Hugin
- unclassified Munin `Context-refs` flowing directly into runtime prompts
- the legacy Claude spawn executor using `--dangerously-skip-permissions`

This plan is intentionally sequenced against the v2 roadmap:

- remove the legacy spawn path and tighten egress before new sensitivity features land
- implement context-ref classification enforcement as Phase 5 Step 0, because it depends on the same classification substrate Phase 5 is about to introduce

## Non-goals

- No general prompt-injection scanner in this slice.
- No cryptographic task signing in this slice.
- No exfiltration-pattern detection on model output in this slice.
- No redesign of Munin trust semantics beyond the minimum needed for classification-aware reads and writes.
- No routing decisions or `Runtime: auto`. That remains Phase 6.

## Current baseline

The current repo state leaves all three holes materially open:

- [src/index.ts](/Users/magnus/repos/hugin/src/index.ts) still accepts `HUGIN_CLAUDE_EXECUTOR=spawn` and invokes `claude -p --dangerously-skip-permissions --verbose`.
- [src/context-loader.ts](/Users/magnus/repos/hugin/src/context-loader.ts) fetches `Context-refs` mechanically and injects their content into prompts without considering Munin `classification`.
- [src/munin-client.ts](/Users/magnus/repos/hugin/src/munin-client.ts) does not expose or write Munin `classification`, so Hugin cannot currently enforce or persist classification at the storage boundary.
- [hugin.service](/Users/magnus/repos/hugin/hugin.service) has filesystem hardening, but no concrete outbound egress policy.

The risk called out by the assessment is not one isolated bug. It is the composition:

1. untrusted content can enter Munin
2. Hugin can treat that content as prompt context
3. the runtime can send that context back out to the network

This plan attacks that chain at each layer.

## Design decisions

### 1. Treat these fixes as a security gate in front of Phase 5, not a side quest

The classification-aware context-ref control is part of the same trust model as Phase 5 sensitivity classification. It should not be bolted on afterward.

The sequencing is:

1. remove the legacy spawn path
2. impose concrete egress controls
3. implement context-ref classification enforcement as the first executable slice of Phase 5

### 2. Munin classification is the canonical storage-level signal

Do not invent a parallel context-ref trust system for this hardening slice. Reuse Munin `classification` as the canonical stored signal and map it into Hugin sensitivity decisions.

This keeps one trust label flowing through:

- the stored Munin entry
- Hugin's task sensitivity assessment
- Hugin-written artifacts
- later router decisions

### 3. Fail closed on context-ref classification conflicts

The Phase 5 classifier is allowed to ratchet sensitivity upward and continue. Context-ref enforcement is stricter.

If a task's effective trust boundary does not permit a referenced entry, Hugin should:

- not inject the content
- fail the task or pipeline compile/decompose step with a direct policy error
- record which ref was denied and why

This is the right default because silently dropping sensitive refs would create ambiguous task behavior, and continuing with partially stripped context would be hard to reason about operationally.

### 4. Egress control must exist outside the model prompt

Prompt policy is not sufficient. The enforcement point must be host or service level so a compromised prompt or executor cannot bypass it.

The first pass should prefer system-level controls shipped with deployment:

- systemd service hardening where it is precise enough
- if needed, a dedicated outbound firewall or nftables/ipset allowlist managed by deploy

### 5. The Claude SDK becomes the only supported Claude execution path

Hugin already has a structured Claude path through the Agent SDK. The security plan should remove the legacy CLI spawn executor entirely instead of trying to harden an intentionally unconfined mode.

## Workstream A: Remove the Legacy Spawn Executor

### Goal

Remove the `claude -p --dangerously-skip-permissions` execution path so Hugin has one Claude runtime path with one security model.

### Scope

- [src/index.ts](/Users/magnus/repos/hugin/src/index.ts)
- [AGENTS.md](/Users/magnus/repos/hugin/AGENTS.md)
- [CLAUDE.md](/Users/magnus/repos/hugin/CLAUDE.md)
- tests that cover executor selection and user-facing config

### Changes

1. Remove `"spawn"` from the `HUGIN_CLAUDE_EXECUTOR` config type and runtime branching.
2. Delete the Claude spawn code path from `spawnRuntime()`.
3. Keep spawn only for runtimes that still require it, such as Codex.
4. Change startup logging and docs so Claude is always described as SDK-backed.
5. Fail fast on stale env usage:
   - if `HUGIN_CLAUDE_EXECUTOR=spawn` is set, log a clear startup error and refuse to boot, or normalize only to `sdk` with a loud warning during one transitional deploy

### Implementation notes

- Prefer full removal over hidden fallback.
- Keep the migration simple: one deploy, one runtime path, one doc contract.
- If there is any Pi-local systemd env still setting `HUGIN_CLAUDE_EXECUTOR=spawn`, clean that in the same deploy slice.

### Done when

- no code path invokes `claude -p`
- no docs advertise spawn mode
- startup no longer suggests the spawn executor exists

## Workstream B: Enforce Context-Ref Classification

### Goal

Stop Hugin from injecting Munin content into prompts when that content exceeds the task's allowed trust boundary.

### Why this is coupled to Phase 5

This is the first hard policy consumer of the sensitivity model. It depends on:

- a shared sensitivity type and lattice
- Munin classification plumbing
- task-level effective sensitivity assessment

Those are already the first building blocks in [phase5-sensitivity-classification-engineering-plan.md](/Users/magnus/repos/hugin/docs/phase5-sensitivity-classification-engineering-plan.md).

So this workstream should be implemented as **Phase 5 Step 0**, not as an unrelated patch afterward.

### Scope

- [src/sensitivity.ts](/Users/magnus/repos/hugin/src/sensitivity.ts) (new, shared)
- [src/munin-client.ts](/Users/magnus/repos/hugin/src/munin-client.ts)
- [src/context-loader.ts](/Users/magnus/repos/hugin/src/context-loader.ts)
- [src/index.ts](/Users/magnus/repos/hugin/src/index.ts)
- [src/pipeline-ir.ts](/Users/magnus/repos/hugin/src/pipeline-ir.ts)
- [src/pipeline-compiler.ts](/Users/magnus/repos/hugin/src/pipeline-compiler.ts)
- [src/task-result-schema.ts](/Users/magnus/repos/hugin/src/task-result-schema.ts)
- [src/pipeline-summary.ts](/Users/magnus/repos/hugin/src/pipeline-summary.ts)

### Policy model

Use the same lattice planned for Phase 5:

- `public < internal < private`

The task or phase gets an effective sensitivity from:

- explicit `Sensitivity:`
- context alias / working-directory heuristics
- Munin `classification` on resolved refs
- upstream dependency sensitivity for pipeline phases

Context-ref enforcement rule:

- a ref may only be injected when `ref.classification <= task.effectiveSensitivity`
- if the ref is stronger than the task, ratchet the task/phase effective sensitivity upward first when allowed by the classifier
- if the runtime trust boundary still cannot legally carry that stronger value, fail closed before execution

### Immediate first-pass rule for the critical hole

Before Phase 6 routing exists, the concrete first-pass enforcement should be:

- any task or phase that resolves a `private` context ref becomes effectively `private`
- private effective sensitivity is only allowed on runtimes and contexts explicitly marked safe for private data
- if the current task/runtime combination is not private-safe, fail before prompt construction

This keeps the first enforcement slice conservative and directly addresses the report's main seam.

### Data model changes

1. Extend `MuninEntry` reads to include optional `classification`.
2. Extend `memory_write` calls so Hugin-written artifacts can store `classification`.
3. Extend `resolveContextRefs()` to return per-ref classification and max sensitivity, not just concatenated content.
4. Extend task and pipeline parse/assessment code to compute:
   - `declaredSensitivity`
   - `effectiveSensitivity`
   - mismatch reasons
5. Surface sensitivity and any denied-context policy errors in:
   - parent `result`
   - `result-structured`
   - pipeline `summary`

### Enforcement points

- standalone tasks: before executor selection and before prompt construction
- pipeline compile/decompose: validate phase-level legality as soon as enough information exists
- phase execution: re-check right before prompt construction using actual resolved refs

### Failure contract

Denied context injection should write a clear structured failure, for example:

- `errorCode: "context_ref_classification_denied"`
- `deniedRef: "people/magnus/profile"`
- `refClassification: "private"`
- `taskEffectiveSensitivity: "internal"`

### Done when

- Hugin refuses to inject over-classified Munin refs
- denied refs are explicit and auditable
- Hugin-written artifacts carry effective classification into Munin

## Workstream C: Outbound Egress Filtering

### Goal

Constrain what Hugin can talk to on the network, so prompt compromise cannot automatically imply arbitrary exfiltration.

### Scope

- [hugin.service](/Users/magnus/repos/hugin/hugin.service)
- [scripts/deploy-pi.sh](/Users/magnus/repos/hugin/scripts/deploy-pi.sh)
- optional deploy-managed host firewall assets if systemd-only restrictions are not sufficient
- operational docs for allowed endpoints

### Required outbound destinations

The exact allowlist should be confirmed during implementation, but the first expected set is:

- `127.0.0.1` / localhost for Munin and local Ollama
- configured Tailscale or LAN address for laptop Ollama when enabled
- Anthropic endpoints needed by the Agent SDK
- GitHub endpoints needed by Codex or task payloads that invoke Git remotes

Everything else should be denied by default.

### Implementation approach

Phase this in rather than relying on one mechanism blindly.

#### Step 1: Service-level narrowing

Harden the unit with the network controls systemd can enforce safely, for example:

- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`
- `IPAddressDeny=any` plus explicit `IPAddressAllow=` if systemd semantics fit the actual endpoint set

This may be enough if the outbound set is small and IP-stable.

#### Step 2: Deploy-managed allowlist if needed

If endpoint hostnames or vendor IP ranges make raw systemd address rules too brittle, add a deploy-managed firewall layer:

- nftables/iptables allowlist owned by Hugin deploy
- optional owner or cgroup targeting so the rule only affects Hugin

The deploy script should manage this idempotently and verify it after rollout.

### Observability

Add a lightweight startup report that states:

- which egress mode is active
- which destinations are allowed
- whether laptop Ollama access is enabled

Do not rely on journal inspection alone for operator visibility.

### Failure contract

- if the egress profile cannot be applied during deploy, abort the deploy
- if the service starts without the expected egress mode, report degraded security explicitly

### Done when

- Hugin can still reach required dependencies
- arbitrary outbound destinations are blocked
- deploy verifies the active policy instead of assuming it

## Rollout order

### Slice 1: Legacy spawn removal

Smallest, lowest-risk independent fix. Land this first.

### Slice 2: Egress filtering

Land after spawn removal and validate against live dependencies:

- Munin
- Claude SDK
- local Ollama
- laptop Ollama if enabled
- GitHub push/fetch path used by tasks

### Slice 3: Context-ref classification enforcement

Land as the first implementation slice of Phase 5, not after it.

That lets the new sensitivity substrate solve a real security boundary immediately instead of existing only as future routing scaffolding.

## Test plan

### Workstream A

- config parsing tests reject or loudly normalize `HUGIN_CLAUDE_EXECUTOR=spawn`
- dispatcher tests confirm Claude always takes the SDK path
- no remaining source reference to `--dangerously-skip-permissions`

### Workstream B

- unit tests for sensitivity lattice helpers
- context-loader tests for classification-aware resolution
- standalone task tests for denied private refs on non-private-safe tasks
- pipeline compiler/execution tests for phase sensitivity propagation and denial
- artifact tests for structured policy failures and propagated classifications

### Workstream C

- deploy script dry-run or validation checks for the egress profile
- live smoke to each allowed destination
- negative test proving an arbitrary denied destination is unreachable from the service context

## Live evaluation gate

This security plan is complete only when all three are demonstrated live:

1. Hugin boots and runs with no legacy Claude spawn mode available.
2. A task with an over-classified context ref fails before prompt injection with a clear policy result.
3. Hugin can reach required dependencies but cannot reach an arbitrary unapproved outbound destination.

Do not call the security hardening closed on local tests alone.

## Exit criteria

This pre-Phase-5 hardening pass is done when:

- the legacy spawn executor is removed
- egress is restricted to an explicit allowlist
- context-ref classification enforcement is live
- the Phase 5 sensitivity work can proceed on top of a real trust boundary instead of an aspirational one

At that point the next normal roadmap item remains [phase5-sensitivity-classification-engineering-plan.md](/Users/magnus/repos/hugin/docs/phase5-sensitivity-classification-engineering-plan.md), starting with the context-ref enforcement slice above.
