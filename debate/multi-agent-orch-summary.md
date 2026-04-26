# Debate Summary: Multi-Agent Orchestration for Grimnir/Hugin

**Date:** 2026-04-01
**Participants:** Claude Opus 4.6, Codex (gpt-5.4)
**Rounds:** 2
**Debate type:** Architecture

## Concessions Accepted By Both Sides

1. **DAG-first was the wrong sequencing.** Adding `blocked`/`depends-on` to a single-worker system produces dependency-aware queueing, not multi-agent orchestration. Both sides agree on this.
2. **Worker identity and leases are the real first step.** Without explicit task ownership, stale recovery, parallel execution, and remote workers are all built on ambiguity.
3. **The security model needs enforcement, not just labels.** `security:local` vs `security:cloud` as routing hints is necessary but not sufficient. Real boundaries require authenticated submitters, env scrubbing, and privilege escalation rules.
4. **One scheduler, many workers** is the correct architectural invariant. Workers never run their own Hugin. The Pi is the coordinator; compute nodes are workers.
5. **Parent/child joins before general DAG.** Narrow the scope to one level of fan-out with capped children before enabling arbitrary dependency graphs.

## Defenses Accepted By Codex

- Learning from Temporal/Celery/K8s patterns without adopting the infrastructure is appropriate for a Pi-based system
- Munin doesn't need to be split into separate stores immediately — coordination semantics matter more than raw throughput
- "One scheduler, many workers" is a valid and explicit design constraint

## Unresolved Disagreements

- **Munin coordination efficiency**: Claude deferred the tag-scan/reread cost issue; Codex maintains it matters even at small scale for operational clarity
- **HMAC auth strength**: Codex correctly notes that if the signing secret is in the task's env, it doesn't create a real privilege boundary. No resolution proposed yet.
- **Failure policy granularity**: Per-task vs per-dependency-edge. Acknowledged but deferred.

## New Issues From Round 2

- Event-driven promotion needs a reconciliation loop (crash recovery)
- Worker boundary needs clear definition (host daemon vs execution slot vs endpoint label)
- `max_children` must be scheduler-enforced, not just declared metadata

## Final Verdict

**Both sides converged on the same next step:**

### Step 0: Worker/Lease State Machine
1. Introduce `worker_id` attached to task claims (`claimed_by`, `lease_expires`)
2. Lease renewal during execution (heartbeat extends lease)
3. Stale recovery becomes lease-based, not "all running = mine"
4. Define what a "worker" is: execution slot on a host, with explicit capabilities

### Then:
- Step 1: Parent/child joins with failure policy
- Step 2: Capability registry + security-aware routing
- Step 3: Remote worker protocol (assign, monitor lease, collect)
- Later: General DAG, agent messaging, dynamic graph construction

## Action Items

- [ ] Design the worker/lease state machine (schema + state transitions)
- [ ] Define worker boundary: is ollama-laptop a worker? Is Claude SDK a worker? Are they the same kind of thing?
- [ ] Write a concrete worked example: a multi-agent workflow (e.g., code review pipeline) showing how parent/child joins + workers would flow
- [ ] Decide on authenticated submitter mechanism that actually works given env inheritance

## All Debate Files

- [draft](multi-agent-orch-claude-draft.md)
- [self-review](multi-agent-orch-claude-self-review.md)
- [codex-critique](multi-agent-orch-codex-critique.md)
- [claude-response-1](multi-agent-orch-claude-response-1.md)
- [codex-rebuttal-1](multi-agent-orch-codex-rebuttal-1.md)
- [critique-log](multi-agent-orch-critique-log.json)
- [summary](multi-agent-orch-summary.md)

## Costs

| Invocation | Wall-clock time | Model version |
|------------|-----------------|---------------|
| Codex R1   | ~3m             | gpt-5.4       |
| Codex R2   | ~3m             | gpt-5.4       |
