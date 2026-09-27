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
| `worker_id` | string | Host-based identity (issue #77), not PID-based; at most 200 characters and no control characters. |
| `process_instance_id` | string | Distinguishes restarts of the same worker. |
| `polled_at` | string (ISO 8601) | Timestamp of this heartbeat write. |
| `current_task` | string \| null | The Munin task namespace currently executing, or `null` when idle; at most 200 characters and no control characters. |
| `blocked_tasks` | number | Count of tasks in the `blocked` lifecycle. |
| `uptime_s` | number | Seconds since process start. |
| `group`, `sequence` | optional | Present only while executing a grouped/sequenced task. |
| `ollama_loaded` | optional object | Present only when at least one Ollama host has a loaded model. |
| ...queue observability fields | various | From `buildQueueObservabilityFields`; not read by liveness assessment. |

The outer poll loop (`pollOnce` plus its wrapper in the main loop) emits a
heartbeat once per poll cycle. A single task can run for up to the 12-hour
dispatcher ceiling, which would otherwise leave `polled_at` stale for the
task's entire execution even though the worker is alive and busy. To avoid
that, an independent task-heartbeat timer (`startTaskHeartbeat`, every 60s)
starts when execution begins and continues through checkpoint writes and
artifact delivery. It stops only when the task is fully finalized and
`current_task` is cleared. Lease renewal is separate and is not renewed
during delivery.

Heartbeat emissions are serialized. The dispatcher waits for the best-effort
loaded-model probe before building the snapshot, then queues the write so an
older busy snapshot cannot overwrite a newer idle one.

## Threshold and states

`computeWorkerLivenessThresholdMs(pollIntervalMs)` returns
`max(3 * pollIntervalMs, 180_000)` milliseconds. `pollIntervalMs` must be a
positive safe integer no greater than 3,600,000 — the same bound as the
dispatcher’s `HUGIN_POLL_INTERVAL_MS` parser. Invalid values are rejected.

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
- `--poll-interval-ms` defaults to `HUGIN_POLL_INTERVAL_MS` or `30000`; both
  values must be positive integers no greater than `3600000`.
- Optionally counts currently-pending tasks with the same cheap
  `tags:["pending"], namespace:"tasks/", entry_type:"state", limit:1` query
  Hugin's own `countTasksWithLifecycle` uses; a failure there degrades to
  "pending count unknown" rather than failing the whole check. The query is
  bounded by a 5-second timeout. Assessment time is captured after the
  heartbeat read and this query complete.
- Infrastructure errors print only a fixed error class and, when available,
  the HTTP status; response bodies and the configured `MUNIN_API_KEY` are
  never printed.
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
