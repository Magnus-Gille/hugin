# Step 3 Bug Report — Structured Artifact Feature Testing

**Date:** 2026-04-02  
**Tested by:** Claude Code (claude-sonnet-4-6)  
**Test tasks:** `tasks/20260402-100000-*` through `tasks/20260402-100002-*`

---

## Test Matrix

| Task | Scenario | Expected | Result |
|------|----------|----------|--------|
| `test-step3-pipeline` | 2-phase pipeline, full summary lifecycle | decomposed → running → completed | decomposed → completed (running skipped — see Bug 1) |
| `test-step3-standalone` | standalone ollama task `result-structured` | structured artifact with runtimeMetadata | pass ✓ |
| `test-step3-failure` | gather times out (ollama-laptop 35B), report continues | `completed_with_failures`, phase timings correct | pass ✓ |

---

## Bug 1 — Summary refresh drops intermediate states under Munin 429 pressure

**Severity:** Medium  
**Observed in:** `test-step3-pipeline` after gather completed; also in the sprint demo's `step3-artifacts-valid2` run  
**Location:** `refreshPipelineSummary` → parallel `readStructuredTaskResult` calls

### What happens

After a phase task completes, the dispatcher immediately calls `refreshPipelineSummary`. That function reads `result-structured` for every phase in parallel, then writes the updated summary. This creates a burst of Munin API calls on top of the task-completion writes that just happened (the result, result-structured, and status updates).

When this burst exceeds Munin's rate limit, the summary refresh throws a 429 and the entire poll cycle is aborted:

```
Poll error: Error: Munin 429: {"error":"Too many requests"}
    at async readStructuredTaskResult (index.js:184:19)
    at async Promise.all (index 1)
    at async refreshPipelineSummary (index.js:211:23)
    at async pollOnce (index.js:1219:9)
```

The summary stays at its previous state until the _next_ poll cycle picks it up again (30 seconds later, by which point the terminal state is available directly). The intermediate state — e.g. "gather completed, report now running" — is never written.

### Observed evidence

`test-step3-pipeline` summary timestamps:
- `created_at`: `2026-04-02T12:44:03.280Z` (decomposed, at pipeline compilation)
- `updated_at`: `2026-04-02T12:44:43.827Z` (completed, after both phases finished)

Gather completed at `12:44:06`, report started at `12:44:36`. The 30-second gap is one poll cycle. A summary at the `running` state (gather done, report pending/running) was never written — the 429 during gather's post-completion refresh dropped it.

### Impact

Any consumer polling the summary during execution may see a stale `decomposed` state even though phases are actively running. The state machine appears to jump from `decomposed` directly to `completed` for fast pipelines.

### Suggested fix

Decouple the summary refresh from the critical post-task write path. Options:

1. **Best-effort with catch:** Wrap the summary refresh in a try/catch that logs the failure but does not propagate it to the poll loop. The summary will eventually be refreshed at the next poll cycle.
2. **Sequential reads:** Replace the parallel `Promise.all` on `readStructuredTaskResult` with sequential reads, reducing the instantaneous burst to Munin.
3. **Rate-aware retry:** Add backoff-with-retry on 429 responses in `MuninClient`.

Option 1 is the lowest-risk fix; option 3 addresses the root cause across all Munin interactions.

---

## Bug 2 — `errorMessage` in `result-structured` has leading/trailing newlines

**Severity:** Low  
**Observed in:** `tasks/20260402-100002-test-step3-failure-gather/result-structured`  
**Location:** wherever `errorMessage` is populated for timed-out ollama tasks

The `errorMessage` field in the structured result reads:

```json
"errorMessage": "\n[Ollama streaming timed out]\n"
```

The leading and trailing `\n` come from the raw string used to signal a timeout in the ollama executor. The `bodyText` field having whitespace is acceptable (it's freeform output), but `errorMessage` is machine-readable and downstream consumers would need to call `.trim()` before displaying or comparing it.

**Fix:** Trim the string before assigning it to `errorMessage` in `buildStructuredTaskResult`.

---

## What worked correctly

**Standalone task `result-structured`:**
All expected fields present and correct: `schemaVersion`, `taskId`, `taskNamespace`, `lifecycle`, `outcome`, `runtime`, `executor`, `resultSource`, `exitCode`, `startedAt`, `completedAt`, `durationSeconds`, `logFile`, `bodyKind`, `bodyText`. The `runtimeMetadata` block correctly records `requestedModel`, `effectiveModel`, `requestedHost`, `effectiveHost`, and `fallbackTriggered: false`.

**`completed_with_failures` state:**
When `gather` (ollama-laptop) timed out at 300s and `report` (ollama-pi, `On-dep-failure: continue`) ran to completion, the final summary correctly showed:
- `executionState: completed_with_failures`
- `terminal: true`
- `phaseCounts: { completed: 1, failed: 1 }`
- gather: `outcome: timed_out`, `exitCode: "TIMEOUT"`, `errorMessage` populated
- report: `outcome: completed`, full timing data

**Pipeline context on phase results:**
The failed gather's `result-structured` correctly includes the `pipeline` block:
```json
"pipeline": {
  "pipelineId": "20260402-100002-test-step3-failure",
  "phase": "gather",
  "dependencyTaskIds": [],
  "dependencyPhases": [],
  "submittedBy": "claude-code",
  "sensitivity": "internal",
  "authority": "autonomous"
}
```

**Decomposition summary written immediately:**  
The `summary` key was created within the same poll cycle as pipeline compilation, before any phase ran. `executionState: decomposed` and all phase lifecycle states (`pending`/`blocked`) were correct.

**Summary reaches terminal state reliably:**  
Despite the intermediate-state miss, the terminal `completed` or `completed_with_failures` summary was always written correctly once all phases finished.

---

## Observation: pipeline `durationSeconds` includes queue wait time

The `test-step3-pipeline` summary reports `durationSeconds: 41`. Breakdown:
- gather ran for 3s (12:44:03–12:44:06)
- report ran for 7s (12:44:36–12:44:43)
- Gap between them: ~30s (one poll cycle waiting for promotion + next pick-up)

The 30s queue wait is included in the pipeline duration because `durationSeconds` is computed as `max(completedAt) - min(startedAt)` across phases. This is architecturally correct but means `durationSeconds` reflects wall-clock latency, not CPU/inference time. No action needed, but Step 4 tooling should account for this when displaying or alerting on pipeline duration.
