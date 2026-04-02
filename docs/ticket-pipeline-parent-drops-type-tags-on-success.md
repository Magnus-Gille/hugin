# Ticket — Pipeline Parent Drops Type Tags On Success

**Date:** 2026-04-02  
**Severity:** Medium  
**Area:** `Runtime: pipeline` parent lifecycle metadata  
**Status:** Open

## Summary

When a pipeline parent compiles and decomposes successfully, Hugin rewrites the parent task's status tags to a fixed set and drops any submitter-provided `type:*` tags.

## Why It Matters

The task lifecycle contract says `type:*` tags should survive pending → running → completed/failed. Regular task completion preserves them. Successful pipeline parents do not, which makes pipeline parents behave differently from normal tasks and breaks downstream filtering or analytics keyed on tags like `type:research` or `type:email`.

## Evidence

Pipeline success path in `src/index.ts`:

```ts
await munin.write(
  taskNs,
  "status",
  entry.content,
  ["completed", "runtime:pipeline", "type:pipeline"],
  entry.updated_at
);
```

Regular task completion in the same file preserves incoming `type:*` tags.

## Reproduction

1. Submit a pipeline parent with tags such as `["pending", "runtime:pipeline", "type:research"]`.
2. Let the pipeline compile and decompose successfully.
3. Read `tasks/<pipeline-id>/status`.
4. Observe that `type:research` is gone and only `type:pipeline` remains.

## Expected

Successful pipeline parents should preserve existing `type:*` tags and add `type:pipeline` if it is not already present.

## Suggested Fix

Mirror the normal task completion pattern:

1. Read incoming `type:*` tags from `entry.tags`.
2. Preserve them on the terminal parent status.
3. Add `type:pipeline` without duplicating tags.

## References

- `src/index.ts`
- `feedback/hugin/pipeline-parent-drops-type-tags-on-success`
