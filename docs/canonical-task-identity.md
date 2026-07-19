# Canonical Hugin task identity

**Status:** producer projection and LearningTaskContract v1 handshake are
implemented for Hugin's direct homeserver `/delegate` lane. End-to-end use
still requires the matching `gille-inference` #2 deployment; canonical
exposure capture remains `gille-inference` #4 work.

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

`renderedPromptFingerprint` identifies the exact UTF-8 bytes in the
`/delegate.prompt` field. It does not trim or normalize them. It is separate
from the raw identity because injected context and wrapper bytes legitimately
change it. The LearningTaskContract stamp additionally content-addresses the
Hugin envelope and the prompt, harness, and tool-policy configurations. Gille
owns the later gateway-envelope and runtime-chat-template stages.

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
field into an independently fanned-out subtask. It is not evidence-eligible.

## Trust and legacy boundary

This projection alone is Hugin producer evidence, not gateway evidence. A body
claim—even one sent over a Bearer-authenticated request—is not proof that Gille
bound it to the actual transport principal, admitted it once, recorded it, or
echoed it unchanged. No consumer may infer any of those facts from
`runtimeMetadata.huginTaskIdentity` alone. Hugin accepts gateway evidence only
when the v1 stamp is returned exactly in a principal-bound gateway echo; see
[`learning-task-handshake.md`](learning-task-handshake.md).

End-to-end trust additionally requires:

- Gille #2 to authenticate the actual caller, validate the versioned Hugin
  request stamp, bind it to admission, and return an exact echo;
- the deployed Hugin direct lane to create the authoritative attempt before
  dispatch, embed this identity in the preflight-bound stamp, and reject a
  missing or mismatched echo; and
- Gille #4 to record the stamped raw fingerprint as the exposure identity and
  establish a new coverage epoch whose start is no earlier than canonical
  capture becoming effective.

Until those land, current Gille rows remain honest legacy rendered-prompt
rows. They use the same `trim-utf8-sha256-v1` algorithm label but identify
different bytes for a context-wrapped Hugin request. They must not be relabeled,
backfilled, or treated as exact canonical Hugin exposure. Positive exact raw
matches remain conservative evidence of prior exposure; a negative lookup over
the legacy Hugin-delegate period is not canonical freshness proof.

The fixture in `tests/fixtures/hugin-learning-task-serializer-v1.json` drives
Hugin's real serializer and pins the contract capabilities, raw bytes, raw
fingerprint, task taxonomy, and production config identities. The matching
Gille fixture must be updated from this serializer before the two changes are
deployed together.
