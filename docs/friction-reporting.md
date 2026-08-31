# Friction reporting

Hugin stores concrete task-solving friction as schema-v1 events in the flat
Munin namespace `signals/friction`. A friction event says that the model,
environment, or task specification made execution harder than it should have
been. It is operational evidence; it is not a verdict on the final answer.

Use `hugin_rate` for exact-bound product quality of a terminal Hugin task
(owner-only when it is a Broker task). Use friction reporting for events such
as a missing tool, a sandbox failure, an unclear prerequisite, or a model
hitting a reasoning limit. One task can legitimately have both kinds of
evidence.

## Submission surfaces

All submission surfaces use the same taxonomy, payload, tags, and Munin
namespace:

| Surface | Entry point | Intended caller |
|---|---|---|
| Injected standalone MCP | `report_friction` | Claude SDK tasks running inside Hugin |
| Broker HTTP API | `POST /v1/friction/report` | Authenticated integrations |
| Main Hugin MCP | `hugin_report_friction` | Codex/Claude orchestrator sessions |
| CLI | `hugin-friction` or `npm run friction-submit --` | Humans, scripts, and quality gates |

The standalone MCP remains non-blocking for the task that encountered the
friction, but it is no longer silently lossy. A Munin timeout or rejection is
returned as `ok: false, dropped: true`, and the exact event is written to a
bounded mode-0600 local outbox for replay. The response includes `recovery`:
`spooled` when durable local recovery is available, or `outbox_full` /
`outbox_error` when it is not. The standalone process replays retained events
at startup; deterministic namespace/key/content/tags identity makes a replay
safe to retry, and an already-existing matching Munin entry is treated as
success. Distinct event keys remain distinct occurrences.

Replay does not hold an outbox admission lock while performing Munin I/O, and
admission has no global lock or external `flock` dependency. A slow or
unavailable replay therefore cannot prevent new evidence from being durably
admitted. Concurrent replays use Munin's create-if-absent identity and
idempotent local deletion; ambiguous write results keep the event for a later
attempt. Concurrent filesystem admission uses atomic final-file creation and a
short per-process reservation, so separate processes may briefly overshoot the
soft active bound; later enqueue, replay, or status maintenance converges the
surplus into durable, visible quarantine when capacity permits. Quarantine
admission is also soft under cross-process races: maintenance atomically claims
only exact generated quarantine names and restores overflow events to their
content-addressed root, preserving the event while bringing the quarantine
entry/byte bound back down.

Malformed or foreign-version JSON is moved to a mode-0700 quarantine directory
with mode-0600 files, subject to separate copies of the same entry/byte bounds;
quarantined data remains visible in status and diagnostics. Valid overflow
events are retained and replayable from the same quarantine, rather than
silently discarded. If quarantine is full, a valid overflow claim is restored
to its content-addressed root for replay, while malformed claims remain active
and visible. Exact complete orphan-temporary files are verified against their
digest and atomically recovered; partial, mismatched, and other hidden
temporary or maintenance-claim names remain counted toward the active bound,
so crash leftovers cannot silently escape capacity accounting.

The outbox directory defaults to `$XDG_STATE_HOME/hugin/friction-outbox`, or
`$HOME/.local/state/hugin/friction-outbox`, and can be overridden with
`HUGIN_FRICTION_OUTBOX_PATH`. `HUGIN_FRICTION_OUTBOX_MAX_ENTRIES` and
`HUGIN_FRICTION_OUTBOX_MAX_BYTES` tune the bounded queue. A full queue never
evicts older evidence: the new event is reported as not spooled so the loss is
visible. The SDK forwards only explicitly set safe friction settings plus
`HOME`/`PATH` to the injected MCP, so non-Pi hosts do not inherit a guessed
state location. Diagnostics are bounded and redact credential-like values;
the SDK retains only relevant `friction-mcp` stderr on successful parent tasks.

The Broker API and its MCP/CLI clients are explicit post-run operations; a
failed write returns an error so the caller knows the evidence was not recorded.

All writers enforce the same authoritative tag families. The injected writer
keeps the corpus's established `source:model-self-report` value; authenticated
API/MCP/CLI writes stamp `source:broker-api` and `reporter:<principal>`.
Caller-supplied values in those families are discarded on every surface.
Merged tags are capped at Munin's 20-tag limit and each tag is bounded to 200
characters; derived tags are retained before caller routing tags, with the
Broker reserving one slot for authenticated reporter provenance.

The Broker endpoint is available only when the authenticated Broker is enabled.
It defaults `model_id` to the authenticated principal and adds
`source:broker-api` plus `reporter:<principal>` tags. A caller may provide a
more precise `model_id`, but the authenticated reporter tag remains. Taxonomy,
model, task, tool, classification, and provenance tag prefixes are server-owned.
Routing tags such as
`repo:*`, `issue:*`, and `phase:*` remain available to callers.

`model_id` is self-declared metadata, not authenticated identity. Consumers may
use it as a routing hypothesis or diagnostic dimension, but any attribution or
anti-poisoning decision must key on the authenticated `reporter:<principal>`
tag (or another independently bound model receipt), never `model:*` alone.

When `task_id` resolves to a private Munin task, the friction event inherits its
restricted classification. Reports without a linked task remain `internal`.

Broker writes are retry-safe without losing recurrence frequency. Each event
has an `event_id`: the MCP and CLI clients generate one automatically and reuse
it for an automatic transport retry. Raw API callers must supply a UUID and
reuse it only when retrying the same occurrence. The same event and payload
returns the existing key with `deduplicated: true`; reusing an ID with different
evidence returns HTTP `409`. A genuinely later recurrence gets a new ID and a
new corpus entry.

## CLI example

```bash
export HUGIN_BROKER_URL=http://huginmunin:3033
export HUGIN_BROKER_TOKEN="$(your-keychain-helper)"

hugin-friction \
  --friction-type tool_failure \
  --severity blocking \
  --summary "Codex sandbox could not start" \
  --detail "The outer systemd sandbox did not allow AF_NETLINK." \
  --event-id 11111111-2222-4333-8444-555555555555 \
  --task-id 20260714t214415z-dogfood-cassette3 \
  --tool-name codex-exec \
  --tag repo:cassette-ai \
  --tag issue:hugin-218
```

Never include credentials, tokens, private source text, or unnecessary task
content in `summary`, `detail`, or tags. Describe the failure and remediation,
not the sensitive payload being processed.

The standalone MCP also exposes only bounded failure metadata in its response
and stderr. Use `hugin_report_friction`, the Broker API, or `hugin-friction` for
an immediate fail-loud fallback when local outbox recovery is unavailable.

## API example

```http
POST /v1/friction/report
Authorization: Bearer <broker token>
Content-Type: application/json

{
  "event_id": "11111111-2222-4333-8444-555555555555",
  "friction_type": "prerequisite_missing",
  "severity": "high",
  "summary": "Managed repository assumed the wrong default branch",
  "detail": "The repository uses master, while the workflow assumed origin/main.",
  "task_id": "20260714t214415z-dogfood-cassette3",
  "tags": ["repo:cassette-ai", "issue:hugin-217"]
}
```

A successful write returns HTTP `201` with the durable Munin namespace, key,
and a `deduplicated` boolean.
Use `npm run friction-report` for the existing aggregate readout.
