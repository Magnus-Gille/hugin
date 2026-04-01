# Step 1: Parent/Child Task Joins

**Status:** Spec — not yet implemented
**Prerequisite:** Step 0 (Worker/Lease Model) — completed 2026-04-01
**Context:** [Multi-agent orchestration debate](../debate/multi-agent-orch-summary.md)

## Problem

Agents can't compose work. A Claude task that wants "lint with a local model, then review with Opus" must be one monolithic prompt. There's no way for a running agent to spawn sub-tasks, wait for results, and continue with them.

## Goal

Enable one level of fan-out/fan-in: a parent task spawns N child tasks and a continuation task that activates when all children complete.

**Not in scope:** general DAGs, arbitrary dependency depth, cycles, dynamic re-planning mid-graph. Those come later if needed.

## Worked Example: Code Review Pipeline

```
Parent task (claude, submitted by user):
  "Review the heimdall auth refactor"

  Agent decomposes into:
  ├── child-1 (ollama, laptop): "Lint src/auth/ — report issues as JSON"
  ├── child-2 (codex): "Review the diff on branch auth-refactor for correctness"
  └── continuation (claude, blocked):
      depends-on: child-1, child-2
      "Read child results, synthesize a review summary, post to PR"

Execution:
  child-1 → pending → running → completed (lint output in result)
  child-2 → pending → running → completed (review in result)
  Hugin sees both deps satisfied → promotes continuation → pending → running
  continuation reads tasks/child-1/result and tasks/child-2/result
  continuation writes final review → completed
```

## Design

### New lifecycle state: `blocked`

A task with tag `blocked` is waiting for dependencies. Hugin never picks up `blocked` tasks for execution — they can only become `pending` via promotion.

### Dependency tag: `depends-on:<task-id>`

A blocked task declares its dependencies as tags:
```
tags: ["blocked", "runtime:claude", "depends-on:20260401-120000-lint", "depends-on:20260401-120000-review"]
```

Task IDs are the short form (without `tasks/` prefix), matching the existing `extractTaskId()` convention.

### Promotion logic

On every task completion (in `pollOnce`, after writing result and updating status to `completed`/`failed`):

```typescript
async function promoteDependents(completedTaskId: string): Promise<void> {
  // Find blocked tasks that depend on the completed task
  const { results } = await munin.query({
    query: "task",
    tags: ["blocked", `depends-on:${completedTaskId}`],
    namespace: "tasks/",
    entry_type: "state",
    limit: 20,
  });

  for (const result of results) {
    if (result.key !== "status") continue;
    const entry = await munin.read(result.namespace, "status");
    if (!entry || !entry.tags.includes("blocked")) continue;

    // Check if ALL dependencies are satisfied
    const depTags = entry.tags.filter(t => t.startsWith("depends-on:"));
    const allSatisfied = await checkAllDependenciesMet(depTags);

    if (allSatisfied) {
      // Promote: blocked → pending (strip depends-on tags, keep others)
      const promotedTags = entry.tags
        .filter(t => t !== "blocked" && !t.startsWith("depends-on:"))
        .concat(["pending"]);
      await munin.write(result.namespace, "status", entry.content, promotedTags, entry.updated_at);
      await munin.log(result.namespace, `Promoted from blocked → pending (all ${depTags.length} dependencies met)`);
      console.log(`Promoted ${result.namespace} → pending (deps satisfied)`);
    }
  }
}

async function checkAllDependenciesMet(depTags: string[]): Promise<boolean> {
  for (const tag of depTags) {
    const depId = tag.slice("depends-on:".length);
    const depEntry = await munin.read(`tasks/${depId}`, "status");
    if (!depEntry) return false; // dependency doesn't exist
    if (!depEntry.tags.includes("completed")) return false; // not yet done
  }
  return true;
}
```

### Failure policy

A task declares how to handle failed dependencies via a tag:

- `on-dep-failure:fail` (default) — if any dependency fails, the blocked task is also marked `failed` with an error explaining which dep failed
- `on-dep-failure:continue` — promote even if some deps failed; continuation reads results and decides

On task failure, the promotion scan also runs, but checks the policy:

```typescript
// In the failure path of promoteDependents:
if (depFailed && failurePolicy === "fail") {
  // Mark the blocked task as failed too
  await munin.write(ns, "status", content, ["failed", ...keepTags], updatedAt);
  await munin.write(ns, "result",
    `## Result\n\n- **Exit code:** -1\n- **Error:** Dependency ${failedDepId} failed\n`);
} else if (depFailed && failurePolicy === "continue") {
  // Still check if all deps are terminal (completed or failed)
  // Promote if so — let the continuation handle partial results
}
```

### Fan-out limits

The coordinator enforces a maximum of **10 child tasks per parent**. This is a Hugin-side check, not a task metadata field (per Codex's critique that declarative limits without enforcement are useless).

When promoting, if Hugin encounters a blocked task with >10 `depends-on` tags, it fails the task immediately with an error.

### Reconciliation loop

Event-driven promotion (on completion) handles the happy path. But if Hugin crashes between writing `completed` on a child and running the promotion scan, dependents stay blocked forever.

Fix: on each poll cycle, after checking for `pending` tasks, also check for `blocked` tasks that might be promotable:

```typescript
// In pollLoop, every N cycles (e.g., every 5th poll = every 2.5 minutes):
if (pollCount % 5 === 0) {
  await reconcileBlockedTasks();
}
```

`reconcileBlockedTasks()` scans all `blocked` tasks and runs the same promotion logic. This is the "crashing between completion and promotion" safety net.

### Observability

- Heartbeat gains `blocked_tasks: <count>` field
- Health endpoint gains `blocked_tasks: <count>`
- Task logs record dependency events: "Promoted from blocked → pending", "Failed due to dependency X failing"
- `promoteDependents` logs which task was promoted and how many deps were checked

## Implementation Plan

All changes in `src/index.ts` (~100-150 lines):

1. **Add `promoteDependents()` function** — called after every task completion (both success and failure)
2. **Add `checkAllDependenciesMet()` helper**
3. **Add `reconcileBlockedTasks()` function** — periodic safety net
4. **Update `pollLoop()`** — call reconciliation every 5th cycle
5. **Update heartbeat/health** — add blocked task count
6. **Add fan-out limit check** — fail tasks with >10 deps

### Test plan

Add to `tests/dispatcher.test.ts`:

- Parse `depends-on:*` tags from a blocked task
- Validate `on-dep-failure:fail` vs `on-dep-failure:continue` tag parsing
- Unit test `checkAllDependenciesMet` logic (mock Munin reads)

Integration test (manual or scripted):

1. Submit 2 child tasks as `pending` + 1 continuation as `blocked` with `depends-on` pointing to both
2. Verify continuation stays `blocked` while children run
3. Verify continuation promotes to `pending` when both children complete
4. Verify continuation fails if a child fails (with `on-dep-failure:fail`)
5. Verify continuation promotes with partial results (with `on-dep-failure:continue`)

## What This Enables

With parent/child joins + the worker/lease model from Step 0:

- **Code review pipeline**: lint (local) → review (cloud) → synthesize
- **Research + synthesis**: 3 parallel research tasks (ollama) → merge findings (claude)
- **Deploy verification**: deploy (codex) → smoke test (ollama) → report (claude)

Even with single-worker sequential execution, this is useful — it's dependency tracking and failure propagation. When a second worker arrives (Mac Studio), the same mechanics enable true parallel fan-out with no code changes.

## Open Questions (deferred)

- **Authenticated submitters** — agents spawning sub-tasks aren't authenticated. Deferred to Step 2 (capability registry) where trust boundaries are defined.
- **Per-edge failure policy** — current design is per-task. If a continuation has 3 deps and only 1 is critical, there's no way to express "fail if dep-1 fails, continue if dep-2 or dep-3 fail." Deferred until there's a real use case.
- **Nested fan-out** — a child task spawning its own children. Not prohibited, but the reconciliation loop only checks one level. Deeper nesting works but with higher promotion latency (one reconciliation cycle per level). Acceptable for now.
