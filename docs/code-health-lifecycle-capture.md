# Code-health lifecycle capture

The first code-health integration records only Hugin-owned, content-blind task
lifecycle identity. It is disabled unless `HUGIN_CODE_HEALTH_CAPTURE=on`.

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

This lifecycle leaf does not deliver observations or assessments to another
service, add executor tools, classify tasks, or alter task outcome, routing,
success, or permissions. Other repositories and registered-repo tasks without
the explicit code capability remain outside capture. Native lifecycle results
keep `assessmentState: "missing"` until a separate typed assessment producer
supplies validated evidence.
