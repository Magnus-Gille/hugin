# Ticket — Pipeline Parent Result Omits Routing Metadata

**Date:** 2026-04-02  
**Severity:** Medium  
**Area:** `Runtime: pipeline` result contract  
**Status:** Open

## Summary

Pipeline parents parse and retain `Reply-to` and `Reply-format` in the compiled IR, but the successful decomposition result written back to the parent task does not include those fields. The current pipeline path also lacks parity with the standard result contract for `Group` and `Sequence`.

## Why It Matters

Downstream consumers such as Ratatoskr rely on result metadata for routing and correlation. A pipeline parent that succeeds now produces a result shape that is weaker than a normal completed task, which makes integrations treat pipeline parents as a special case.

## Evidence

The compiler parses and stores reply-routing metadata:

```ts
replyTo: readField(content, "Reply-to"),
replyFormat: readField(content, "Reply-format"),
```

But the decomposition result only renders pipeline summary fields:

```ts
export function buildPipelineDecompositionResult(pipeline: PipelineIR): string {
  return [
    "## Result\n",
    "- **Exit code:** 0",
    "- **Pipeline action:** compiled and decomposed",
    `- **Pipeline id:** ${pipeline.id}`,
    `- **Phases:** ${pipeline.phases.length}`,
    `- **Spec key:** ${pipeline.sourceTaskNamespace}/spec`,
```

Normal task results in `src/index.ts` include reply-routing and orchestration metadata when present.

## Reproduction

1. Submit a pipeline parent with `Reply-to` and `Reply-format`.
2. Let it compile and decompose successfully.
3. Read `tasks/<pipeline-id>/result`.
4. Observe that the reply metadata is missing.

## Expected

Pipeline parent results should preserve the same routing metadata contract as normal task results. If parent-level `Group` and `Sequence` are part of that contract, the compiler also needs to parse and carry them through the pipeline IR.

## Suggested Fix

1. Extend the pipeline document parser and IR if parent `Group` and `Sequence` should be preserved.
2. Render `Reply-to`, `Reply-format`, and any supported orchestration metadata in `buildPipelineDecompositionResult()`.
3. Add dispatcher-level tests for the successful `Runtime: pipeline` result shape.

## References

- `src/pipeline-compiler.ts`
- `src/index.ts`
- `feedback/hugin/pipeline-parent-result-omits-routing-metadata`
