# MCP durable M5 leaf lifecycle

**Status:** implemented contract (issue #167)

`hugin_submit` v2 creates one ordinary Hugin task and executes one bounded M5
`/delegate` leaf:

```text
hugin_submit -> Munin pending task -> Hugin lease/recovery -> M5 /delegate
             -> canonical result/result-structured -> hugin_await
```

The MCP fills safe defaults for an ergonomic ordinary submission. The Broker
validates the complete envelope: task type; explicit deterministic verifier or
L1 review; sensitivity (default `internal`); M5-only destination; no tools; one
attempt; zero external cost; durable execution; Munin delivery; timeout (default
5 minutes, maximum 15); output tokens (default 4,096, maximum 32,768); and
return-to-L1 escalation. The complete envelope is embedded in the task and
revalidated at claim time. Its values, not the human-readable display fields,
drive execution.

The authenticated principal plus idempotency key derives a stable task ID.
Retries compare the normalized behavior payload stored at that namespace;
rotating the MCP session ID does not create a collision. The same key and
payload returns the original task, including after Broker restart. The same key
with a different behavior payload is rejected. An in-process reservation closes
the concurrent-submit race before the first Munin write completes. Both the
durable identity and that reservation are scoped by authenticated principal.

Await and list are principal-isolated. A Broker key cannot discover or read
another principal's canonical results. Rate remains owner-only for Broker
tasks; the same authenticated endpoint can also review an ordinary terminal
Hugin task, which has no Broker owner.

`hugin_await` preserves its canonical full response by default and when called
with `verbosity: "full"`. Callers that only need the actionable outcome can use
`verbosity: "summary"`. The compact response retains the status, polling lease
and orphan evidence, error, outcome, exit code, body text, effective model and
host, delegation decision, and declared/effective/mismatch sensitivity fields
when present. It replaces the inline terminal result and its potentially large
learning provenance with Munin references:

```json
{
  "refs": {
    "status": { "namespace": "tasks/<task-id>", "key": "status" },
    "fullResult": {
      "namespace": "tasks/<task-id>",
      "key": "result-structured"
    }
  }
}
```

`fullResult` appears only when the Broker returned a structured terminal
result. The MCP projection does not alter or rewrite the durable document.

This guarantees one durable task for idempotent submission retries. It does not
claim exactly-once network execution if the process crashes after M5 performs a
future side effect but before Hugin stores the response. The current endpoint is
a no-tools inference leaf. Any future side-effecting gateway operation must add
gateway-side idempotency or a prepare/commit protocol before being admitted.

M5 remains the authority for model selection, verification and capability
evidence. Hugin preserves the returned task type, node, model, outcome, score,
decision reason, verifier notes and `ledgerId` in `result-structured`; Hugin's
`feedback` entry is a separate append-only quality-receipt ledger. Each current
receipt binds the exact status/result bytes and repository state, records the
authenticated reviewer, and never changes M5's capability ledger.

The old orch-v1 worker, reconciler and new journal writes are retired. The v1
alias catalogue and existing JSONL journal remain available for historical
reads only.
