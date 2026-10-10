# Code-health lifecycle capture

The code-health integration records Hugin-owned, content-blind task lifecycle
identity and accepts optional typed observations or assessments from the Claude
Agent SDK. It is disabled unless `HUGIN_CODE_HEALTH_CAPTURE=on`.

Capture is limited to an exact validated `Context: repo:<slug>` in the frozen
pilot registry (`sagascript` and `gille-inference`) and an explicit effective
`Capabilities: code`. Hugin does not infer coding intent from the prompt,
working directory, or repository contents. This requirement does not grant a
runtime any permission; the task's existing runtime capability and permission
checks remain authoritative.

The supported execution surface is the in-process dispatcher after normal task
parsing and runtime capability filtering. Parsed repository Q&A without the
explicit `code` capability, pipeline/broker execution, other repository slugs,
and other executor entry points are outside this pilot. Pre-claim rejection
paths can carry a distinct refusal identity when the task otherwise meets the
same eligibility rules; dependency-blocked tasks do not claim an attempt.

An eligible successful pending-to-running claim receives a Hugin-generated
UUID in `code-health-attempt:<uuid>`. The tag is replaced on a new claim,
preserved only through claimed lifecycle rewrites, and excluded from ordinary
pre-claim persistence unless it passes the strict UUID/uniqueness check.
Pre-claim refusals use a separate deterministic identity bound to the exact
status revision Hugin rejected; they do not receive an execution attempt UUID.

`result-structured.codeHealth` is optional and strict. It records the repo,
attempt/refusal identity, nullable Git revisions, explicit execution fact,
assessment state and references, requested model, nullable observed model, and
hashed planned-child identities. Missing assessment is explicit and is not a
participation receipt. Generic executor metadata is not treated as observed
model evidence. Orchestrator plan observation stores normalized child type and
an attempt-bound hash of the planner ID; it never stores the child prompt. At
most 32 child identities are embedded; `plannedChildrenOmitted` makes any
bounded omission explicit.

For orchestration, the optional observer runs only after a valid fanout plan is
parsed. It receives the planner IDs and normalized task types; malformed-plan
fallbacks are not observed, and observer errors do not affect execution. Known
child outcomes are filled from execution results at terminalization; children
without a recorded outcome remain `planned`. Startup recovery, lease recovery,
normal terminalization, local cancellation, shutdown, and delivery
reconciliation preserve the accepted attempt identity. During delivery
reconciliation, `executionFact: "completed"` means the executor had already
completed before the durable delivery checkpoint; the task's terminal
`outcome` and delivery fields still record whether delivery succeeded.

Operator cancellation of non-local or legacy tasks uses the existing generic
terminalization path and does not create code-health evidence. This avoids
claiming that the local executor observed or participated in work it did not
own.

The SDK's fixed in-process `get_code_health_context` and
`report_code_health` tools are exposed only when all gates are active:
`HUGIN_CODE_HEALTH_CAPTURE=on`, the existing `HUGIN_FRICTION_INJECTION=on`, the
existing `trusted-code` permission profile, an eligible dispatcher-created
attempt binding, Munin configuration, and an explicit `HUGIN_CODE_HEALTH_NAMESPACE`.
An empty or absent namespace keeps the SDK surface unconfigured. The context
tool returns only the bound task/repository/attempt, known model and revision
metadata, and the canonical required-field/rubric guide; it never returns task
prompts or source files. The existing friction MCP stays unchanged. No
permission mode, allowed-tool list, routing, task outcome, or success semantics
are modified.

`report_code_health` accepts a bounded canonical record and an optional exact
`expected_updated_at` correction CAS. Hugin validates the frozen record schema
and compares repo/task/attempt, parent and known child lineage, SHAs, and
requested/observed model fields to its binding before delivery. It rejects
contradictions instead of rewriting submitted evidence. Tool callbacks are
serialized, which makes duplicate IDs idempotent and enforces the limit of
three observations per attempt under concurrent calls. Only opaque record refs,
actual completeness, observed model, and acknowledged/queued/unsaved delivery
state reach the strict task-result envelope. Raw summaries and tool error
details are not projected. A queued code-health append is replayed by the
existing friction outbox on a later friction-MCP startup; until then the task
result reports the queued state.

Other repositories, registered-repo tasks without explicit `code` capability,
read-only tasks, disabled gates, non-SDK runtimes, and other executor entry
points remain outside typed capture. Assessment state remains `missing` until a
canonical assessment is actually supplied and validated. Hugin never creates
subjective ratings from task outcome or free-form result text.
