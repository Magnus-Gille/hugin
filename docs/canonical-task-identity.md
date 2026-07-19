# Canonical Hugin task identity

**Status:** producer projection implemented for Hugin's direct homeserver
executor `/delegate` lane; authenticated gateway admission/capture and the
orchestrator worker lane are pending `gille-inference` #2/#4 and Hugin #240.

Hugin's logical task is the parsed `### Prompt` text before context injection,
the `## Task` wrapper, a system prompt, gateway orchestration, or a runtime chat
template. That text is the only input to the canonical raw-task fingerprint:

1. apply JavaScript `String.trim()`;
2. do not normalize Unicode or internal whitespace;
3. encode the result as UTF-8; and
4. SHA-256 those bytes as lowercase hexadecimal.

The version is `trim-utf8-sha256-v1`, matching LearningTaskContract v1 and the
existing content-blind exposure lookup. `src/task-identity.ts` is Hugin's
canonical implementation. The exact ASCII and deliberately non-normalized
Unicode vectors are in
`tests/fixtures/hugin-gille-task-identity-v1.json`.

## Real `/delegate` serialization

`buildHomeserverRequestBody()` is the serializer used by
`executeHomeserverTask()`. For the direct homeserver executor's `/delegate`
call, it continues to send the rendered user prompt in `prompt` and adds this
producer-owned projection:

```json
{
  "prompt": "## Context\n...\n\n---\n\n## Task\n...",
  "huginTaskIdentity": {
    "schemaVersion": 1,
    "producer": "hugin",
    "taskId": "task-123",
    "rawTaskFingerprint": {
      "algorithm": "sha256",
      "version": "trim-utf8-sha256-v1",
      "digest": "..."
    },
    "renderedPromptFingerprint": {
      "algorithm": "sha256",
      "version": "hugin-delegate-prompt-utf8-sha256-v1",
      "digest": "...",
      "utf8Bytes": 123
    }
  }
}
```

`renderedPromptFingerprint` identifies the exact UTF-8 bytes in the legacy
`/delegate.prompt` field. It does not trim or normalize them. It is separate
from the raw identity because injected context and wrapper bytes legitimately
change it. It is also narrower than the future three-stage prompt provenance:
an optional `systemPrompt`, gateway canonical envelope, and runtime chat
template are not represented by this field and remain Hugin #240 / Gille #2
work.

The task document cannot supply `huginTaskIdentity`; the serializer always
recomputes it from Hugin's accepted logical prompt and lifecycle task id. The
wire projection contains hashes, version, task id, and rendered byte count—not
a second copy of the raw logical task. Hugin preserves the same projection as
`result-structured.runtimeMetadata.huginTaskIdentity`, including failed
gateway calls, so later joins do not need to reconstruct it from a rendered
prompt.

The in-process orchestrator's homeserver worker uses a separate serializer in
`src/orchestrator/worker-executor.ts`. It remains on the legacy rendered-prompt
identity and does not emit `huginTaskIdentity`. Extending that lane requires an
authoritative outer task/attempt binding rather than copying this direct-runtime
field into an independently fanned-out subtask. Hugin #240 owns that common
attempt/stamp integration.

## Trust and legacy boundary

This projection is Hugin producer evidence, not yet gateway evidence. The
current public Gille `/delegate` parser ignores unknown fields and its exposure
recorder still hashes the rendered `prompt`; orchestrator worker calls do not
yet carry the projection at all. A body claim—even one sent over a
Bearer-authenticated request—is not proof that Gille bound it to the actual
transport principal, admitted it once, recorded it, or echoed it unchanged.
No consumer may infer any of those facts from
`runtimeMetadata.huginTaskIdentity` alone.

End-to-end trust requires:

- Gille #2 to authenticate the actual caller, validate the versioned Hugin
  request stamp, bind it to admission, and return an exact echo;
- Hugin #240 to create the authoritative attempt before dispatch, embed this
  identity in that preflight-bound stamp, and reject a missing or mismatched
  echo; and
- Gille #4 to record the stamped raw fingerprint as the exposure identity and
  establish a new coverage epoch whose start is no earlier than canonical
  capture becoming effective.

Until those land, current Gille rows remain honest legacy rendered-prompt
rows. They use the same `trim-utf8-sha256-v1` algorithm label but identify
different bytes for a context-wrapped Hugin request. They must not be relabeled,
backfilled, or treated as exact canonical Hugin exposure. Positive exact raw
matches remain conservative evidence of prior exposure; a negative lookup over
the legacy Hugin-delegate period is not canonical freshness proof.

The fixture intentionally stops at the current repository boundary: it drives
Hugin's real serializer and supplies the exact byte/hash/lookup values that
Gille #4 must consume. It does not mock a successful Gille capture or echo that
the current Gille implementation cannot produce.
