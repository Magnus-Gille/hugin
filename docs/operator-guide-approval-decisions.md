# Operator Guide: Approval Decisions

When a pipeline phase declares `Authority: gated`, Hugin pauses it before execution and waits for an explicit approval or rejection. This guide covers the artifacts involved and how to write a valid decision.

## How the gate works

1. A gated phase's dependencies complete normally.
2. Hugin moves the phase to `awaiting-approval` and writes an **approval-request** artifact to Munin.
3. The pipeline summary shows `executionState: awaiting_approval`.
4. An operator (or Ratatoskr) writes an **approval-decision** artifact to Munin.
5. On the next poll cycle, Hugin reads the decision:
   - **Approved** — the phase returns to `pending` and executes normally.
   - **Rejected** — the phase fails without executing. Downstream phases follow their `onDependencyFailure` rules.

## Approval-request artifact (written by Hugin)

**Key:** `tasks/<phase-task-id>/approval-request`

You never need to write this — Hugin creates it automatically. Read it to get the values you need for your decision.

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | `1` | Always `1`. |
| `pipelineId` | string | The parent pipeline's ID. |
| `phaseName` | string | Human-readable phase name (e.g. `"deploy"`). |
| `phaseTaskId` | string | The phase's task ID. Copy this into your decision. |
| `authority` | `"gated"` | Always `"gated"`. |
| `sideEffects` | string[] | Declared side effects (e.g. `["deploy.service"]`). |
| `status` | `"pending"` | Always `"pending"`. |
| `requestedAt` | string | ISO 8601 timestamp of when the gate was reached. |
| `requestedByWorker` | string | Hugin worker instance ID. |
| `replyTo` | string? | Optional reply routing (e.g. `"telegram:1234"`). |
| `replyFormat` | string? | Optional reply format. |
| `operationKey` | string | Idempotency key (`<pipelineId>:<phaseTaskId>`). |
| `summary.runtime` | string | Runtime that will execute the phase (e.g. `"claude-sdk"`). |
| `summary.context` | string? | Execution context (e.g. `"repo:hugin"`). |
| `summary.promptPreview` | string | Truncated preview of the phase prompt (max 160 chars). |
| `summary.dependencyTaskIds` | string[] | Task IDs of upstream phases this phase depends on. |

### Example approval-request

```json
{
  "schemaVersion": 1,
  "pipelineId": "20260404-deploy-pipeline",
  "phaseName": "deploy",
  "phaseTaskId": "20260404-deploy-pipeline-deploy",
  "authority": "gated",
  "sideEffects": ["deploy.service"],
  "status": "pending",
  "requestedAt": "2026-04-04T08:00:00.000Z",
  "requestedByWorker": "hugin-huginmunin-874413",
  "operationKey": "20260404-deploy-pipeline:20260404-deploy-pipeline-deploy",
  "summary": {
    "runtime": "claude-sdk",
    "context": "repo:hugin",
    "promptPreview": "Deploy the reviewed change to huginmunin...",
    "dependencyTaskIds": ["20260404-deploy-pipeline-review"]
  }
}
```

## Approval-decision artifact (written by the operator)

**Key:** `tasks/<phase-task-id>/approval-decision`

This is the artifact you write to approve or reject a gated phase.

### Required fields

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | `1` | Must be `1`. |
| `pipelineId` | string | Must match the `pipelineId` from the approval-request. |
| `phaseTaskId` | string | Must match the `phaseTaskId` from the approval-request. |
| `decision` | `"approved"` or `"rejected"` | The decision. |
| `decidedAt` | string | ISO 8601 timestamp of when you made the decision. |

### Optional fields

| Field | Type | Description |
|---|---|---|
| `decidedBy` | string | Who made the decision (e.g. `"magnus"`). |
| `source` | string | What system wrote the decision (e.g. `"ratatoskr"`). |
| `comment` | string | Free-text reason. Shown in rejection results if provided. |

### Example: approve

```json
{
  "schemaVersion": 1,
  "pipelineId": "20260404-deploy-pipeline",
  "phaseTaskId": "20260404-deploy-pipeline-deploy",
  "decision": "approved",
  "decidedAt": "2026-04-04T08:05:00Z",
  "decidedBy": "magnus",
  "source": "ratatoskr"
}
```

### Example: reject

```json
{
  "schemaVersion": 1,
  "pipelineId": "20260404-deploy-pipeline",
  "phaseTaskId": "20260404-deploy-pipeline-deploy",
  "decision": "rejected",
  "decidedAt": "2026-04-04T08:05:00Z",
  "decidedBy": "magnus",
  "source": "ratatoskr",
  "comment": "Deploy target is not ready for this change"
}
```

## Writing the decision to Munin

Write the JSON payload to the phase task's namespace with key `approval-decision`:

```
namespace: tasks/<phase-task-id>
key:       approval-decision
content:   <the JSON payload>
```

Hugin polls tasks tagged `awaiting-approval` and will pick up the decision on its next cycle.

## Common mistakes

| Mistake | What happens |
|---|---|
| Missing `pipelineId` or `phaseTaskId` | Decision fails schema validation and is **silently ignored**. The phase stays in `awaiting-approval` indefinitely. |
| Missing `decidedAt` | Same — silently ignored. |
| Missing `schemaVersion` or wrong value | Silently ignored. |
| `pipelineId` or `phaseTaskId` doesn't match the approval-request | Hugin logs "Ignoring mismatched approval-decision artifact" and the phase stays in `awaiting-approval`. |
| `decision` is not exactly `"approved"` or `"rejected"` | Silently ignored. |
| Writing to the wrong namespace | Hugin never sees it. Write to the **phase task** namespace, not the parent pipeline namespace. |

> **Safety note:** Under-specified or malformed decisions are silently ignored by design. This prevents accidental approvals from partial payloads. If your decision seems to have no effect, check that all four required fields are present and that `pipelineId` and `phaseTaskId` match the approval-request exactly.

## Known side-effect types

Gated phases must declare at least one side effect. These are the valid side-effect IDs:

- `git.push`
- `git.merge`
- `github.pr.create`
- `github.pr.merge`
- `deploy.service`
- `message.telegram.send`
- `message.email.send`
- `file.write.outside_workspace`

## Quick reference

```
1. Read the approval-request:
   munin read tasks/<phase-task-id>/approval-request

2. Copy pipelineId and phaseTaskId from the request.

3. Write your decision:
   munin write tasks/<phase-task-id>/approval-decision '{
     "schemaVersion": 1,
     "pipelineId": "<from request>",
     "phaseTaskId": "<from request>",
     "decision": "approved",
     "decidedAt": "<now, ISO 8601>"
   }'

4. Hugin picks it up on the next poll cycle.
   - Approved: phase returns to pending and executes.
   - Rejected: phase fails. Check the phase result for details.
```
