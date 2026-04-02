# Step 2 Bug Report — Pipeline Compiler Feature Testing

**Date:** 2026-04-02  
**Tested by:** Claude Code (claude-sonnet-4-6)  
**Branch:** codex/step1-live-eval  
**Test tasks:** `tasks/20260402-093100-*` through `tasks/20260402-093104-*`

---

## Test Matrix

| Task | Scenario | Expected | Result |
|------|----------|----------|--------|
| `test-valid-linear` | 2-phase linear pipeline (ollama-pi) | compile + execute | pass |
| `test-auto-runtime` | `Runtime: auto` | compile error | pass |
| `test-gated-authority` | `Authority: gated` | compile error | pass |
| `test-missing-runtime` | no Runtime field on phase | compile error | pass (misleading message) |
| `test-on-dep-failure` | `On-dep-failure: continue` | compile + execute | pass (tag issue) |

---

## Bug 1 — `on-dep-failure:continue` tag is dropped on task completion

**Severity:** Medium  
**Location:** `src/index.ts:1339-1346`

The completion write preserves only `runtime:*` and `type:*` tags:

```typescript
// Update status tags — strip lease metadata, keep runtime/type tags
const finalRuntimeTag = entry.tags.find((t) => t.startsWith("runtime:")) || ...;
const finalTypeTags = entry.tags.filter((t) => t.startsWith("type:"));
await munin.write(taskNs, "status", entry.content, [
  ok ? "completed" : "failed",
  finalRuntimeTag,
  ...finalTypeTags,
]);
```

`on-dep-failure:continue` matches neither prefix, so it is silently dropped when the task reaches a terminal state.

**Observed:** The `test-on-dep-failure-summarize` task was created with `on-dep-failure:continue` in its initial `blocked` tag set. After completion, the tag is gone:
```
blocked state:  ["blocked","runtime:ollama","type:pipeline","type:pipeline-phase","on-dep-failure:continue","depends-on:..."]
completed state: ["completed","runtime:ollama","type:pipeline","type:pipeline-phase"]
```

**Impact:** Any post-hoc query for tasks that ran with the continue policy (e.g. auditing, debugging a cascade failure) will return zero results for completed tasks. The tag is only visible while the task is blocked.

**Fix:** Preserve `on-dep-failure:*` tags in the same way `type:*` tags are preserved:
```typescript
const finalPolicyTags = entry.tags.filter((t) => t.startsWith("on-dep-failure:"));
await munin.write(taskNs, "status", entry.content, [
  ok ? "completed" : "failed",
  finalRuntimeTag,
  ...finalTypeTags,
  ...finalPolicyTags,
]);
```

---

## Bug 2 — Successful pipeline parent drops submitter-defined type tags

**Severity:** Low  
**Location:** `src/index.ts:880-886`

On successful compilation the parent task is written with a hardcoded tag list:

```typescript
await munin.write(
  taskNs, "status", entry.content,
  ["completed", "runtime:pipeline", "type:pipeline"],  // ← hardcoded
  entry.updated_at
);
```

The failure path (`failTaskWithMessage`, line 829-830) correctly reads and re-uses `type:*` tags from the original entry. The success path does not, creating an inconsistency.

**Observed:**
```
submitted with:  ["pending", "runtime:pipeline", "type:test"]
failed parent:   ["failed",  "runtime:pipeline", "type:test"]   ← type:test preserved
success parent:  ["completed","runtime:pipeline","type:pipeline"] ← type:test lost
```

**Impact:** Submitter-added type tags (e.g. `type:test`, `type:research`, `type:scheduled`) are silently dropped on compilation success. Queries relying on those tags will miss the task.

**Fix:** Mirror the pattern used in `failTaskWithMessage`:
```typescript
const originalTypeTags = entry.tags.filter((t) => t.startsWith("type:"));
await munin.write(
  taskNs, "status", entry.content,
  ["completed", "runtime:pipeline", ...new Set([...originalTypeTags, "type:pipeline"])],
  entry.updated_at
);
```

---

## Bug 3 — Misleading error message when Runtime field is omitted

**Severity:** Low  
**Location:** `src/pipeline-compiler.ts:269-278`

When a phase has no `Runtime:` field, `phase.runtime` is `""` (empty string). This reaches `validateRuntimeId` which produces:

```
Pipeline compile failed: Phase "gather" uses unknown runtime ""
```

The empty string is the symptom, not the cause. A user who forgot the field entirely won't recognise this as a missing-field error.

**Observed:** `tasks/20260402-093103-test-missing-runtime/result`

**Fix:** Add an explicit guard before the zod parse in `validateRuntimeId`:
```typescript
function validateRuntimeId(phaseName: string, runtime: string): PipelineRuntimeId {
  if (!runtime) {
    throw new Error(`Phase "${phaseName}" is missing a Runtime field`);
  }
  if (runtime === "auto") { ... }
  ...
}
```

---

## Minor: Blank lines in phase task result output

**Severity:** Cosmetic  
**Location:** ollama executor result template (exact line TBD)

Every phase task result has three blank lines between the log file path and the `Group:` field:

```
- **Log file:** ~/.hugin/logs/...



- **Group:** pipeline:...
```

Reproducible on both `test-valid-linear-gather` and `test-on-dep-failure-summarize`. Likely caused by optional result fields (e.g. `Reply-to`, `Reply-format`) being rendered as empty lines when absent.

---

## Observation: Task pickup order is not FIFO

Not a bug, but worth documenting. `test-on-dep-failure` was submitted 4 seconds after `test-valid-linear` yet was picked up and executed first. Munin does not return pending tasks in submission order. Users who submit multiple tasks in sequence should not assume ordering.

---

## What worked correctly

- `Runtime: auto` → clean error: `Phase "gather" uses Runtime: auto, which is deferred until Step 6`
- `Authority: gated` → clean error: `Phase "gather" uses Authority: gated, which is deferred until Step 4`
- Both errors failed before any `spec` or child task was written — compile-time boundary is solid
- Linear dependency chain (gather → summarize) ran in correct order with proper blocked→pending promotion
- `On-dep-failure: continue` compiled correctly and the phase ran after its dependency completed
- Pinned models on `ollama-pi` (`qwen2.5:3b`) stayed on Pi — no host drift
