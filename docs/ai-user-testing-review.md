# Hugin AI User Testing Review

**Codebase version:** commit `55195cf` (2026-04-05)
**Test suite:** 154 tests passing across 17 test files
**Source:** 7090 lines across 20 TypeScript source files
**Reviewers:** Claude Opus 4.6, Claude Sonnet 4.6, Claude Haiku 4.5
**Date:** 2026-04-05

---

## Methodology

### Phase 1: Code Review (all three Claude models)

Each model was given full context about the Hugin codebase (all source files, test structure, documentation, deployment scripts) and asked to review from the perspective of an AI that both submits tasks to and receives tasks from the dispatcher. Each model independently produced ratings across six categories.

### Phase 2: Hands-On User Testing (all three Claude models)

Each model submitted a real ollama task to Hugin via the Munin MCP tools, waited for execution, read back results, and reported on the end-to-end experience. Tasks were small, safe ollama prompts (qwen2.5:3b on Pi) with Norse mythology themes.

### External Review: Codex CLI

A separate review was conducted by Codex CLI (`codex-cli 0.118.0`) using gpt-5.4-mini (low effort) and gpt-5.4 (xhigh effort). Codex took a fundamentally different approach — hands-on artifact inspection, actually compiling pipelines locally, and comparing small vs. large model behavior against the documentation. See `docs/ai-user-testing-review-codex.md` for the full Codex review.

---

## 1. What is GREAT

### All three models agreed on

- **The lease-based task claiming with compare-and-swap is rock-solid.** Separate Munin clients for lease renewal (`leaseMunin`), cancellation watch (`cancelWatchMunin`), and main operations prevent head-of-line blocking. Worker identity (`hugin-<hostname>-<pid>`) enables correct stale-task recovery on restart. (Opus, Sonnet, Haiku)

- **The pipeline compiler is impressive.** In 576 lines, `pipeline-compiler.ts` does cycle detection, sensitivity propagation through the dependency DAG, side-effect/authority validation, and emits a fully validated IR with Zod. (Opus, Sonnet, Haiku)

- **Structured task results (dual human-readable + machine-readable) are excellent.** Both a markdown `result` and a Zod-validated JSON `result-structured` per task. Downstream consumers never need to screen-scrape. (Opus, Sonnet, Haiku)

- **The egress policy is a real security control.** Monkey-patching `globalThis.fetch` with host allowlist, including git push egress checks, is the right level of paranoia for an AI task dispatcher. (Opus, Sonnet, Haiku)

- **The two-stage SDK timeout (abort, then force-close after grace period) is correct.** Most implementations get this wrong with the Agent SDK's async generator model. (Opus, Sonnet)

### Opus additionally highlighted

- **The task schema is genuinely well-designed for AI consumption.** Markdown-with-metadata hits the sweet spot between structured JSON (awkward for humans) and pure natural language (impossible to parse reliably). The field set (`Reply-to`, `Reply-format`, `Group`, `Sequence`) enables routing without the AI understanding the delivery system.

- **The invocation journal** (`invocation-journal.jsonl`) -- append-only, file-mode 0o600, captures quota before/after, ollama token counts, fallback triggers. Operational telemetry that makes debugging possible weeks later.

- **Sensitivity classification is cleverly inverted.** Ollama (local) gets `private` max while Claude/Codex (cloud) gets `internal`. Correctly reflects trust boundary.

### Haiku additionally highlighted

- **The security documentation** (`docs/security/lethal-trifecta-assessment.md`) is thorough, self-critical, and honest about remaining gaps. "World-class security hygiene for a personal AI system."

- **The overall poll loop in index.ts** despite its size is a "marvel of defensive composition" -- error handling is consistent, security checks happen before claiming, the lifecycle state machine is enforced correctly.

---

## 2. What is OK

### All three models agreed on

- **The Munin client is functional but not exceptional.** Serial request queue with 75ms spacing works for single-task-at-a-time but would bottleneck under parallelism. Retry logic handles 429s and 5xx correctly. (Opus, Sonnet)

- **The sensitivity keyword list is coarse but safe.** Words like "bank", "journal", "invoice" trigger false positives in development contexts, but the system fails closed (rejects cloud runtimes if in doubt). (Opus, Sonnet, Haiku)

- **The heartbeat is minimal but functional.** Tells you the system is alive but requires reading Munin directly. No alerting, no Prometheus endpoint. (Sonnet, Haiku)

### Sonnet noted

- **The `isInfraFailure` regex** for ollama fallback triggering is clean but brittle. Pattern-matching `[Ollama (HTTP|error:]` in output works now but depends on the exact error format emitted by the executor.

- **The health endpoint** returns useful debugging info including the egress policy allowlist, but is an information disclosure surface if ever exposed non-locally.

### Haiku noted

- **Pipeline summary fingerprinting** for write dedup is clever but creates a freshness vs. write-volume tradeoff. A summary could be stale in memory but skipped because the fingerprint matches.

---

## 3. What Could Be Better

### All three models agreed on

- **The 3053-line `index.ts` is the single biggest maintainability problem.** It contains configuration, task parsing, sensitivity assessment, lease management, stale recovery, dependency promotion, cancellation, approval gating, pipeline dispatch, quota fetching, journal writing, git push, the poll loop, health endpoint, and graceful shutdown. At least 5-6 independently testable domains should be extracted. (Opus, Sonnet, Haiku)

- **`parseTask` is a wall of regex matches** (~130 lines) with no field-level validation or error reporting. Returns `null` on any failure. Negative timeout, nonsense dates, invalid sequences all parse silently. Compare to the pipeline compiler which has proper field-level error messages. (Opus, Sonnet, Haiku)

- **Context-refs are loaded sequentially, not batched.** Each ref uses a separate `munin.read()` despite `readBatch()` being available and used elsewhere. 5 refs = 5 sequential RPCs with 75ms spacing = 375ms unnecessary latency. (Opus, Sonnet)

### Opus highlighted

- **Post-task git push has no opt-out.** A task like "experiment with this approach and show me the diff" has no mechanism to prevent auto-push. Needs a field in the task schema.

- **The pipeline DSL requires exactly 4-space indentation for prompts.** Fragile for a format likely composed by AI models. Tabs or 2-space indent silently fail.

### Sonnet highlighted

- **Hardcoded `/home/magnus/` paths** appear throughout sensitivity classification. No env var to override. Wrong in any non-Pi deployment.

- **`getFoundBatchEntry` and `extractTaskId` are copy-pasted across four files** (`index.ts`, `pipeline-control.ts`, `pipeline-dispatch.ts`, `pipeline-summary-manager.ts`). Not in a shared module.

- **The shutdown handler marks the task failed *before* aborting the SDK.** The SDK task is still running when declared failed. If the SDK writes to the same `result` key in that window, the shutdown result gets overwritten.

### Haiku highlighted

- **Blocked task reconciliation is on a 5-poll cycle (150s).** On a fast queue, dependency joins could be stale. Should be configurable or event-driven.

- **Context-ref truncation silently drops content.** Task proceeds with partial context and a `[...truncated]` marker. Better UX: fail early with a clear error.

- **Heartbeat is fire-and-forget, can fail silently.** Errors are logged but not surfaced to the health endpoint.

---

## 4. What is BROKEN

### Opus found

- **Missing dependencies block tasks forever.** In `task-graph.ts`, a dependency that doesn't exist in Munin at all (`state === "missing"`) prevents both `shouldPromote` and `shouldFail`. A task with a typo in its `depends-on` tag will block indefinitely with no timeout or escalation.

- **Race condition in stale task recovery.** Between query and write, another worker could claim the task. The CAS prevents data corruption, but the error is not caught gracefully -- it throws and logs as "Failed to recover stale tasks" with no context about which task conflicted.

### Sonnet found

- **`processApprovalDecisions` and `gatePendingTaskForApproval` duplicate ~100 lines** with subtly different paths for handling approval rejection. Changes to rejection behavior must be synchronized across both.

- **Ollama timeout edge case.** If the initial fetch takes close to `timeoutMs`, the streaming timeout (`task.timeoutMs - (Date.now() - startMs)`) could be near-zero or negative. On slow Pi hardware, this could cancel a response that just finished connecting.

### Haiku found

- **No critical bugs or race conditions detected.** Haiku explicitly stated: "After thorough review, I found NO critical bugs" and attributed limitations to intentional design choices. (This may reflect Haiku's tendency to be more conservative in bug reporting.)

---

## 5. What is MISSING

### All three models agreed on

- **No task retry mechanism.** Failed tasks are terminal. No `max-retries` field, no exponential backoff, no way to say "try 3 times before failing." Resume exists for pipelines but not individual tasks. (Opus, Sonnet, Haiku)

- **No progress reporting during long-running tasks.** No channel for executing AI to report intermediate state. Only the heartbeat shows *which* task is running, not *what progress* has been made. (Opus, Sonnet, Haiku)

- **No task result notification / push delivery.** Results sit in Munin until polled. `Reply-to:` is forwarded but Hugin doesn't act on it. No push to submitter. (Opus, Sonnet)

- **No task priority or queue ordering.** `pollOnce()` takes whichever task Munin returns first. No priority field, no FIFO guarantee, no urgency mechanism. (Opus)

- **Cost tracking is incomplete.** `costUsd` is captured per task but there's no aggregation, no per-group rollup, no alerting when quota exceeds thresholds. Data exists but is unused. (Opus, Sonnet)

### Opus additionally identified

- **No resource limits per task.** SDK executor uses `bypassPermissions`. A task could fill `/home/magnus` or exhaust RAM.
- **No cost budget per task.** A task running Opus for 20 minutes has no spending cap.
- **No way to cancel in-flight Codex tasks gracefully.** SIGTERM during mid-commit could leave repo dirty.

### Sonnet additionally identified

- **No task submission schema validator / pre-flight API.** Malformed tasks fail after claiming, wasting a poll cycle.
- **No result delivery tracking.** No "acknowledged" state, no TTL. Completed tasks accumulate forever.
- **Pipeline phases can't pass results between each other automatically.** Must manually wire Context-refs.
- **No dry-run mode for pipelines.** Can't validate without creating child tasks.

### Haiku additionally identified

- **No observability for task lifecycle state transitions.** Invocation journal captures execution metrics but not intermediate state changes.
- **No cancellation reason passed to the running agent.** Agent sees abort but has no context for why.
- **No per-submitter rate limiting or cost quotas.**

---

## 6. What Would Make This WOW WOW WOW AWESOME!!!!!!

### Consensus picks (mentioned by 2+ models)

1. **Streaming progress channel** -- Let executing AI write to `tasks/<id>/progress` with intermediate state. Ratatoskr pushes updates to Telegram. Transforms "fire and forget" into "watch AI work in real-time." (Opus, Sonnet, Haiku)

2. **Break up `index.ts`** -- Extract `task-parser.ts`, `task-lifecycle.ts`, `execution-runner.ts`, `poll-coordinator.ts`, `health.ts`. Takes index.ts from 3053 to ~300 lines. Unlocks testability and extensibility. (Opus, Sonnet, Haiku)

3. **Task-level cost tracking and budgeting** -- `Budget: $0.50` field, abort when exceeded, daily/weekly cost reports. Real money savings for 10+ tasks/day. (Opus, Sonnet)

4. **Smart queue with dependency-aware scheduling / limited parallelism** -- One Ollama + one Claude task concurrently. Infrastructure is almost there (per-task leases, separate clients). (Opus, Sonnet)

5. **Pipeline phase result injection** -- `Context-from-phase: <phase-name>` auto-expanded to inject upstream results. Makes multi-step workflows genuinely composable. (Sonnet, Haiku)

6. **Task schema validator / linter** -- CLI tool or MCP endpoint that validates before execution. Catches malformed tasks before they waste poll cycles. (Opus, Sonnet)

7. **Observability dashboard** -- Real-time web UI showing pipelines, phase states, blocked tasks, approvals, costs. The invocation journal already has all the data. (Opus, Haiku)

### Opus's unique picks

- **AI inbox in Munin** -- `Reply-to: munin:inbox/<id>` for async result delivery to AI consumers. Claude sessions query for unread results on startup.
- **`--simulate` mode** -- Process tasks from JSONL instead of polling Munin. Enables local dev and integration testing without live Munin.

### Sonnet's unique picks

- **First-class task groups** -- Group completion events, group summaries, group-level cancellation. Makes batch workflows manageable.
- **Task submission MCP tool with Zod validation** -- Programmatic task submission with autocomplete, validation, and documentation.

### Haiku's unique picks

- **Cron-based task scheduling** -- `Schedule: 0 9 * * *` for time-based automation (daily briefings, weekly reports).
- **Query language for result routing** -- CEL/Jinja2 expressions like `if result.outcome == "failed" then telegram:alerts else silent`.
- **Cost-aware routing** -- Under threshold: Claude. Over threshold: try Ollama first, fall back to Claude.
- **Task replay / time-travel debugger** -- Replay failed tasks with same context and debug hooks to inspect intermediate state.
- **Policy engine for task validation** -- CEL/Rego policies that validate tasks before execution without code changes.
- **Human gates for non-pipeline tasks** -- Extend `Authority: gated` to standalone tasks.

---

## Cross-Model Comparison

| Category | Opus | Sonnet | Haiku |
|----------|------|--------|-------|
| **Tone** | Deeply technical, found subtle issues | Practical, focused on operational concerns | Most positive, comprehensive feature wishlist |
| **Bugs found** | 2 real issues (missing deps block forever, stale recovery race) | 3 issues (approval duplication, ollama timeout edge case, shutdown ordering) | 0 bugs found (explicitly stated) |
| **Top concern** | index.ts size + task schema parsing | index.ts size + hardcoded paths | Missing observability + lack of retry |
| **WOW pick** | AI inbox for async result delivery | Simulated/dry-run mode | Cost-aware routing + policy engine |
| **Review depth** | Deepest technical analysis, traced code paths | Best operational perspective, found duplication | Broadest feature vision, most constructive |

### Notable disagreements

- **Sensitivity model direction**: Opus found the ollama=private, claude=internal inversion "clever." Sonnet found it "backwards from what I'd expect" and wanted the threat model documented more clearly. Haiku found it "the right architectural choice."

- **Bug severity**: Opus and Sonnet found real edge cases and race conditions. Haiku explicitly stated "NO critical bugs or race conditions detected" -- this may reflect Haiku's more conservative approach to identifying issues in code it hasn't directly executed.

- **index.ts**: All three flagged it, but Haiku was most diplomatic ("large but organized"), Opus most direct ("single biggest maintainability problem"), and Sonnet most specific about the consequences (test duplication, untestable orchestration logic).

---

## Summary

Hugin is remarkably solid for a personal infrastructure project. All three models agreed on the key strengths: lease-based claiming, pipeline compiler quality, dual-format results, and security posture. The primary areas for improvement are consistent across reviewers: decompose `index.ts`, add retry/progress/notification mechanisms, and build cost tracking. The "WOW" features cluster around real-time visibility (progress streaming, dashboard), composability (phase result injection, task groups), and operational maturity (cost budgeting, schema validation, scheduling).

The security model is sound but has known gaps (keyword-based sensitivity, no cryptographic submitter verification) that are honestly documented. The codebase is well-tested and defensively written. The main risk is that the 3053-line `index.ts` will become increasingly difficult to maintain as features are added.

---

## Phase 2: Hands-On User Testing

All three Claude models submitted real ollama tasks (qwen2.5:3b on Pi) to Hugin via the Munin MCP tools and monitored execution to completion. All three tasks completed successfully.

### Task Summary

| Model | Task ID | Prompt | Pickup | Execution | Total | Rating |
|-------|---------|--------|--------|-----------|-------|--------|
| **Opus** | `20260405-opus-user-test` | Three haiku about Huginn & Muninn | 31s | 16s | ~47s | **8/10** |
| **Sonnet** | `20260405-sonnet-user-test` | Explain Yggdrasil in 3 sentences | 2s | 25s | ~27s | **9/10** |
| **Haiku** | `20260405-haiku-user-test` | List the nine worlds | ~44s | 23s | ~75s | **8/10** |

All tasks: ollama runtime, qwen2.5:3b model, Pi host, `scratch` context, `internal` sensitivity.

### What All Three Observed

**Submission was effortless.** A single `memory_write` call with the right namespace, key, tags, and markdown body. No errors, no retries, no schema validation failures. Every model rated the submission process as minimal-friction.

**Both result formats were available.** All three confirmed that `result` (human-readable markdown) and `result-structured` (Zod-validated JSON) were written atomically and available on first read. The structured result was universally praised:
- Runtime metadata showing `requestedModel` vs `effectiveModel`, `requestedHost` vs `effectiveHost`
- Sensitivity audit (`declared: internal`, `effective: internal`, `mismatch: false`)
- Clean lifecycle tracking with ISO 8601 timestamps

**Tag lifecycle was correct.** All tasks progressed from `["pending", "runtime:ollama"]` to `["completed", "runtime:ollama", "classification:internal"]`.

**Model output quality was acceptable for 3B.** Opus noted its haiku didn't follow 5-7-5 syllable patterns correctly. Haiku noted one of the nine worlds was non-canonical ("Jævulande" instead of Hel). All noted these are model limitations, not Hugin issues.

### Friction Points Observed

**No completion notification (all three).** Every model had to poll manually by sleeping and reading. Opus and Haiku explicitly called out the lack of push notification. Sonnet noted the `Reply-to:` field exists but was not tested.

**Pickup latency varies widely.** Sonnet got lucky with a 2-second pickup (poll fired almost immediately). Opus waited 31 seconds (one full poll cycle). Haiku waited ~44 seconds. This is inherent to the 30-second poll architecture.

**Log files are opaque from non-Pi environments (Sonnet).** The `logFile` field points to `~/.hugin/logs/<task>.log` on the Pi, which is not accessible from the laptop. Sonnet suggested surfacing log tails in the structured result.

**No client-side validation (Opus).** A typo in a field name would produce a task that Hugin silently misparsed. The `/submit-task` skill exists to automate this but isn't always available.

**Timestamp mismatch (Sonnet).** The `Submitted at:` field in the task body was a placeholder from the instructions and didn't match the actual submission time. Hugin correctly ignores it for operational purposes, but it could mislead audit trail readers.

### Model-Specific Observations

**Opus (8/10):** Most methodical. Noted the structured result schema is "genuinely useful — not just a JSON dump of the markdown, but a properly designed machine-readable format." Deducted for no completion notification and no client-side validation.

**Sonnet (9/10):** Highest rating. Most impressed by the 2-second pickup time and the runtime metadata in structured results. Only deduction was for log file opacity from non-Pi environments. Called the dispatcher "fast, reliable" with a "genuinely good" result schema.

**Haiku (8/10):** Most pragmatic. Noted the "silent, reliable execution" and "clear audit trail." Wanted to test failure modes next (malformed prompts, timeouts, ollama unavailable). Called the system "very polished" for an autonomous task dispatcher.

---

## Codex Review Comparison

A separate review by Codex CLI (`codex-cli 0.118.0`) using gpt-5.4-mini and gpt-5.4 is available at `docs/ai-user-testing-review-codex.md`. Here are the key differences from the Claude reviews:

### Different Approach, Different Findings

The **Claude reviews** (both code review and hands-on testing) operated with full source code access and found the system excellent. The **Codex review** operated more like a real downstream agent — trying to use the system through its documented interface — and found friction everywhere.

### What Codex Found That Claude Missed

1. **The README hello-world is a trap.** Missing `Submitted by:` defaults to `unknown`, which is rejected by the allowlist. A model copying the README literally creates a failing task. None of the three Claude models encountered this because the test instructions included `Submitted by: claude-code`.

2. **Pipeline runtime names differ from standalone runtime names.** `codex` (standalone) vs `codex-spawn` (pipeline). Codex hit this on its first pipeline compile attempt. Claude models noted the enum values but didn't flag the naming inconsistency.

3. **`Runtime: pipeline` is undocumented in AGENTS.md.** Claude models referenced pipelines extensively but didn't notice the operator-facing docs omit it.

4. **Stale engineering plans actively mislead.** Phase 4 plan says "not implemented"; STATUS.md says it's live. Claude didn't cross-reference docs against implementation.

5. **Path contract is misleading.** Docs say raw absolute paths pass through unchanged; code silently rejects paths outside `/home/magnus/`.

### Codex's Key Insight

> "Hugin is in a better state for strong operator models than for small or opportunistic agent users. The implementation is substantially ahead of the operator-facing documentation."

This aligns perfectly with the Claude hands-on results: all three models (which are "strong operator models" with full source context) had a smooth experience. But Codex showed that weaker models following only the documentation would hit avoidable failures.

### Codex's Top Recommendation

Write one short operator cookbook with copy-paste examples for: minimal standalone task, ollama task with Context-refs, pipeline with real runtime IDs, approval-decision JSON shape, and a "which artifact to read" table.

---

## Final Assessment

| Reviewer | Approach | Rating | Top Concern |
|----------|----------|--------|-------------|
| **Opus** (code review) | Deep architecture analysis | N/A | index.ts decomposition |
| **Sonnet** (code review) | Operational focus | N/A | Hardcoded paths, code duplication |
| **Haiku** (code review) | Feature vision | N/A | Missing observability |
| **Opus** (hands-on) | Submit + monitor ollama task | 8/10 | No completion notification |
| **Sonnet** (hands-on) | Submit + monitor ollama task | 9/10 | Log file opacity |
| **Haiku** (hands-on) | Submit + monitor ollama task | 8/10 | Poll latency |
| **Codex** (hands-on) | Compile pipelines, parse artifacts | N/A | Documentation gap |

**The system works well.** All three hands-on tests completed successfully with clean results. The implementation is solid and the structured result schema is genuinely good. The gap between implementation quality and documentation quality is the biggest actionable finding — and it was Codex, not Claude, that surfaced it most clearly.
