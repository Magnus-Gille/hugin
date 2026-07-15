# Friction reporting

Hugin stores concrete task-solving friction as schema-v1 events in the flat
Munin namespace `signals/friction`. A friction event says that the model,
environment, or task specification made execution harder than it should have
been. It is operational evidence; it is not a verdict on the final answer.

Use `hugin_rate` for product usefulness of a terminal Broker task. Use friction
reporting for events such as a missing tool, a sandbox failure, an unclear
prerequisite, or a model hitting a reasoning limit. One task can legitimately
have both kinds of evidence.

## Submission surfaces

All submission surfaces use the same taxonomy, payload, tags, and Munin
namespace:

| Surface | Entry point | Intended caller |
|---|---|---|
| Injected standalone MCP | `report_friction` | Claude SDK tasks running inside Hugin |
| Broker HTTP API | `POST /v1/friction/report` | Authenticated integrations |
| Main Hugin MCP | `hugin_report_friction` | Codex/Claude orchestrator sessions |
| CLI | `hugin-friction` or `npm run friction-submit --` | Humans, scripts, and quality gates |

The standalone MCP remains deliberately lossy: a Munin timeout is reported as
`dropped: true` and never blocks the task that encountered the friction. The
Broker API and its MCP/CLI clients are explicit post-run operations; a failed
write returns an error so the caller knows the evidence was not recorded.

The Broker endpoint is available only when the authenticated Broker is enabled.
It defaults `model_id` to the authenticated principal and adds
`source:broker-api` plus `reporter:<principal>` tags. A caller may provide a
more precise `model_id`, but the authenticated reporter tag remains. The
`source:*` and `reporter:*` prefixes are server-owned; caller-supplied tags with
either prefix are discarded.

Broker writes are retry-safe. The server derives the Munin key from the
authenticated reporter and normalized event payload, so submitting the same
event again returns the existing key with `deduplicated: true` instead of
adding a second corpus entry. A materially different report gets a different
key.

## CLI example

```bash
export HUGIN_BROKER_URL=http://huginmunin:3033
export HUGIN_BROKER_TOKEN="$(your-keychain-helper)"

hugin-friction \
  --friction-type tool_failure \
  --severity blocking \
  --summary "Codex sandbox could not start" \
  --detail "The outer systemd sandbox did not allow AF_NETLINK." \
  --task-id 20260714t214415z-dogfood-cassette3 \
  --tool-name codex-exec \
  --tag repo:cassette-ai \
  --tag issue:hugin-218
```

Never include credentials, tokens, private source text, or unnecessary task
content in `summary`, `detail`, or tags. Describe the failure and remediation,
not the sensitive payload being processed.

## API example

```http
POST /v1/friction/report
Authorization: Bearer <broker token>
Content-Type: application/json

{
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
