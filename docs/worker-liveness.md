# Worker liveness (issue #389)

Hugin's dispatcher writes a heartbeat to Munin (`tasks/_heartbeat`, key
`status`) so that submitters and monitoring can tell it apart from a worker
that silently died. Before this contract, nothing consumed the heartbeat
authoritatively: a four-week outage went unnoticed while submitters kept
writing `pending` tasks. `src/worker-liveness.ts` gives every consumer one
deterministic, pure definition of "is the worker alive"; `hugin-liveness`
exposes it as a CLI. Consumers such as the task submit/status skills and
Heimdall should call this contract instead of re-deriving their own
staleness threshold.

## Heartbeat fields

`emitHeartbeat` (`src/index.ts`) writes a JSON object as the entry content:

| Field | Type | Notes |
|---|---|---|
| `worker_id` | string | Host-based identity (issue #77), not PID-based. |
| `process_instance_id` | string | Distinguishes restarts of the same worker. |
| `polled_at` | string (ISO 8601) | Timestamp of this heartbeat write. |
| `current_task` | string \| null | The Munin task namespace currently executing, or `null` when idle. |
| `blocked_tasks` | number | Count of tasks in the `blocked` lifecycle. |
| `uptime_s` | number | Seconds since process start. |
| `group`, `sequence` | optional | Present only while executing a grouped/sequenced task. |
| `ollama_loaded` | optional object | Present only when at least one Ollama host has a loaded model. |
| ...queue observability fields | various | From `buildQueueObservabilityFields`; not read by liveness assessment. |

The outer poll loop (`pollOnce` plus its wrapper in the main loop) emits a
heartbeat once per poll cycle. A single task can run for up to the 12-hour
dispatcher ceiling, which would otherwise leave `polled_at` stale for the
task's entire execution even though the worker is alive and busy. To avoid
that, the already-running lease-renewal timer (`startLeaseRenewal`, every
`LEASE_RENEWAL_INTERVAL_MS` = 60s while a task is claimed) also calls
`emitHeartbeat` on every tick, so a busy worker keeps `current_task` set and
`polled_at` fresh throughout execution.

## Threshold and states

`computeWorkerLivenessThresholdMs(pollIntervalMs)` returns
`max(3 * pollIntervalMs, 180_000)` milliseconds — the `HUGIN_POLL_INTERVAL_MS`
config value (default 30000, max 3,600,000) tells the assessment how often a
healthy worker is expected to refresh its heartbeat.

`assessWorkerLiveness({ heartbeat, now, pollIntervalMs, pendingCount? })`
returns one of:

| State | Meaning |
|---|---|
| `healthy-idle` | Heartbeat age is within the threshold; `current_task` is `null`. |
| `healthy-busy` | Heartbeat age is within the threshold; `current_task` is set. |
| `stale` | Heartbeat age exceeds the threshold (worker likely dead or stuck). |
| `absent` | No `tasks/_heartbeat` entry was found at all. |
| `malformed` | The entry exists but is not valid JSON, fails the minimal schema, or has a `polled_at` in the future beyond a 60s clock-skew tolerance. |

A heartbeat age exactly equal to the threshold is still `healthy-*`; only an
age strictly greater than the threshold is `stale`. A future `polled_at`
within the 60s clock-skew tolerance is treated as healthy, not malformed —
only skew beyond that tolerance is `malformed`.

`attention` is `true` when the state is `stale`, `absent`, or `malformed` and
either `pendingCount` is unknown or `pendingCount > 0`; it is `false` for the
two healthy states, and also `false` for a non-healthy state when
`pendingCount` is known to be `0` (no submitter is currently waiting on a
dead worker).

The assessment is content-blind: its output carries only ids, timestamps,
and counts (`workerId`, `currentTask`, `ageMs`, `thresholdMs`, `attention`,
`reason`) — never task prompt or response text.

## CLI: `hugin-liveness`

```bash
hugin-liveness [--json] [--poll-interval-ms <n>]
```

- Reads `tasks/_heartbeat` (key `status`) via the same Munin client contract
  as other Hugin CLIs (`MUNIN_URL`, default `http://localhost:3030`;
  `MUNIN_API_KEY`, required). The API key is never printed.
- `--poll-interval-ms` defaults to `HUGIN_POLL_INTERVAL_MS` or `30000`.
- Optionally counts currently-pending tasks with the same cheap
  `tags:["pending"], namespace:"tasks/", entry_type:"state", limit:1` query
  Hugin's own `countTasksWithLifecycle` uses; a failure there degrades to
  "pending count unknown" rather than failing the whole check.
- Default output is a one-line human summary; `--json` prints the full
  `WorkerLivenessAssessment`.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | `healthy-idle` or `healthy-busy` |
| `1` | `stale`, `absent`, or `malformed` |
| `2` | Infrastructure error (Munin unreachable, missing `MUNIN_API_KEY`, bad arguments) |

## Source

`src/worker-liveness.ts` (pure assessment), `src/liveness-cli.ts` (CLI
composition root), `tests/worker-liveness.test.ts`,
`tests/liveness-cli.test.ts`, and the during-task heartbeat coverage in
`tests/heartbeat-during-task.test.ts`.
