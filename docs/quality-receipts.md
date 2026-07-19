# Quality Receipts

Quality Receipts separate successful execution from product acceptance. They are
authenticated, exact-bound, append-only evidence written by `hugin_rate` or
`POST /v1/delegate/rate` after a task becomes terminal.

## Native v1 is frozen

Native `quality:receipt-v1` remains byte/field compatible with the format shipped
in PR #227. Its fields are exactly:

- content-derived `receiptId` and `schemaVersion: 1`;
- task id, rating, text `ratingReason`, verification outcome, and optional retry count;
- rating clock, authenticated reviewer principal, and independence attestation; and
- binding attestation plus exact task-document, structured-result, and repository binding.

Attempt, rubric, predecessor, correction-group, failure-taxonomy, and producing-
configuration fields are not native-v1 claims. A normal `hugin_rate` call still
emits v1 and a v1-only ledger remains `schemaVersion: 1`.

## Concurrent append protocol

`feedback` is a read/fold/write ledger. Both an existing-entry append and the
missing-entry first write are compare-and-swap guarded:

1. read `feedback`;
2. validate and fold the immutable receipt;
3. if the entry exists, write with its exact `updated_at`;
4. if it is absent, write with Munin's explicit `create_if_absent: true`
   precondition and require the success result to say exactly `status: "created"`;
   and
5. on the matching typed conflict (`already_exists` for first create or
   `version_mismatch` for existing-entry CAS), re-read and re-fold, up to three
   attempts. Any untyped or mismatched failure fails closed.

This means two first reviewers cannot replace each other. An identical receipt
id is an idempotent retry. For native v2, the complete persisted artifacts must
also be canonically identical; reusing an id with a different clock or extension
field is an identity collision. A changed native-v1 verdict from the same
reviewer for the same binding remains a conflict.

This depends on the explicit Munin create-if-absent API from Munin #211. Hugin
does not invent a timestamp and does not assume that candidate is deployed:
deploy Munin first, verify `memory_write` accepts `create_if_absent: true` and
returns `conflict_reason: "already_exists"` to the loser, then deploy Hugin.
Existing-ledger reconciliation continues to use ordinary `expected_updated_at`
CAS and expects `conflict_reason: "version_mismatch"`. A pre-#211 server that
ignores the new field and returns anything other than `status: "created"` fails
loudly instead of receiving a false atomicity assumption.

## Native v2 corrections

Native v2 is only for append-only correction semantics. It never mutates or
relabels a v1 receipt. A correction:

- gets a new content-derived `receiptId` and `schemaVersion: 2`;
- names the predecessor as `correctsReceiptId`, matching the accepted Grimnir
  native-v2 bridge contract;
- binds an authoritative Hugin execution attempt distinct from the logical task
  instance;
- retains one SHA-256 `quality-correction-group-jcs-v1` fingerprint over task,
  attempt, authenticated reviewer, exact normalized rubric, and exact normalized
  result binding;
- carries the rubric as Grimnir's exact normalized `versionedConfigIdentity`
  (`id`, `version`, and a typed immutable `config_digest`), while retaining the
  verifier identity separately and losslessly;
- may carry content-blind prompt, harness, model/config, and tool-policy identities;
- may point to an exact corrected-successor result, follow-up task, PR, or
  replacement commit; and
- must advance the review clock and extend the unique current leaf. Missing
  predecessors, forks, cycles, reviewer/binding changes, and mid-chain rubric or
  attempt changes fail closed.

The closed failure codes are `none`, `incorrect-answer`, `incomplete-answer`,
`format-invalid`, `instruction-noncompliance`, `unsafe-output`,
`unsupported-claim`, `tool-failure`, `harness-failure`, `infrastructure`,
`verification-failure`, and `other`. Only `pass` plus `accepted_unchanged` may
use `none`; every other correction must identify a non-`none` failure.

The first correction upgrades the containing ledger to `schemaVersion: 2` while
preserving every native-v1 object unchanged. Both `quality:receipt-v1` and
`quality:receipt-v2` tags remain on a mixed ledger.

### Activation boundary: authoritative attempts

The native-v2 schema, fold, storage, and harvest path are implemented, but the
authenticated rate endpoint currently rejects every `correction` with HTTP 409.
Hugin does not yet persist an authoritative execution-attempt id in its task
result. Its claim-time MCP session UUID is process-local, while startup and lease
recovery can terminalize the task after that process disappears. The task id is
the logical task instance and must not be copied into `attemptId` as invented
provenance.

Hugin issue #240 owns starting and durably identifying the attempt. Once that
evidence is present in the exact structured result, the rate handler may bind
native v2 to it. Callers cannot supply an attempt id themselves. Until then,
native v1 remains fully operational and v2 fails closed.

The `quality-correction-group-jcs-v1` key uses a dedicated RFC 8785 canonicalizer:
ECMAScript number/string serialization, raw UTF-16 property ordering, and
rejection of non-finite numbers, lone surrogates, sparse arrays, and non-JSON
values. Its canonical payload is the exact normalized Grimnir bridge object
`{ task_id, attempt_id, reviewer: { principal, independence }, rubric, binding }`,
including snake-case binding fields and the full rubric `config_digest`. The
stored fingerprint is `{ algorithm: "sha256", version:
"quality-correction-group-jcs-v1", digest }`; those labels are not part of the
hashed payload. Native-v1 identity intentionally retains its frozen serializer.

The native-v2 `receiptId` follows Grimnir #86's independently executable bridge
construction: SHA-256 over the JCS-native common body containing task, attempt,
verdict, optional retries, rating clock, nested reviewer, rubric, binding
attestation, native binding, and predecessor. It excludes `schemaVersion`, the
receipt id itself, and Hugin-only extensions such as correction group, verifier,
failure, producing configuration, and references. Those extensions remain part
of the immutable stored artifact, so a same-id replay is accepted only when the
entire native-v2 object is canonically equal.

Native repository fields unavailable to the normalized group payload use the
contract's explicit unknown object. Fields that cannot apply to `not-managed`,
and `head_commit`/`diff_sha256` for `no-changes`, use `not-applicable`; other
unavailable repository fields use `not-observed`. A present native diff digest
becomes the normalized `git-binary-diff-sha256-v1` fingerprint.

Example correction input (hashes abbreviated here only for readability):

```json
{
  "task_id": "20260719t120000z-parser-fix",
  "rating": "wrong",
  "rating_reason": "The Unicode regression remains.",
  "verification_outcome": "discarded",
  "correction": {
    "predecessor_receipt_id": "qr-0123456789abcdef01234567",
    "rubric": {
      "id": "code-review",
      "version": "2.1.0",
      "config_digest": {
        "algorithm": "sha256",
        "canonicalization": "jcs-rfc8785-utf8-v1",
        "source_ref": "source-doc:rubric/code-review-2.1.0",
        "source_type": "rubric-config",
        "source_version": "rubric-source-2.1.0",
        "digest": "<64 lowercase hex>"
      }
    },
    "verifier": { "id": "claude-opus", "version": "2026-07-19" },
    "failure": {
      "taxonomy": { "id": "hugin-quality-failure", "version": "1" },
      "code": "incorrect-answer"
    },
    "references": {
      "corrected_successor": {
        "task_id": "20260719t130000z-parser-fix-followup",
        "structured_result_sha256": "<64 lowercase hex>"
      }
    }
  }
}
```

## Harvest semantics

Consumers validate the complete ledger, collapse each correction chain to its
unique unsuperseded leaf, and summarize only exact-bound leaves. Harvested
`effectiveReceipts` never includes the text reason; it includes its SHA-256 and,
for v2, the attempt, predecessor, correction group, rubric/verifier, failure,
optional producing configuration, and optional successor references. Native v1
evidence does not fabricate attempt or rubric fields.

Different reviewers remain independent receipt groups and may conflict. A new
rubric is not newest-wins evidence. LearningTaskContract v1 must fail closed when
more than one binding/rubric cohort is available because it has no governed
cohort selector. That multi-cohort state means the evidence is incomparable
under v1; it does not by itself mean the reviewers disagreed on the verdict.

`tests/fixtures/grimnir-quality-v2-contract.json` vendors the accepted Grimnir
#86 normalized fixture and its independently validated native receipt id and
correction-group digest. The Hugin contract test checks native v2 against that
cross-repository fixture, rather than merely recomputing expected values with
Hugin's own code.

## Post-deploy operational acceptance

These checks intentionally require deployed, authenticated services and are not
part of a source-only PR review:

Prerequisite: merge and deploy Munin #211 first, then probe one winning
`create_if_absent` write and one typed `already_exists` loser before deploying
this Hugin change.

1. rate one real terminal managed-repository success with native v1;
2. concurrently submit two different authenticated first reviews for a fresh
   terminal task and verify both immutable ids remain in `feedback`;
3. replay one identical request and verify the ledger and receipt count do not change;
4. after #240 has deployed authoritative attempt evidence, rate a real rejection,
   then append a native-v2 correction naming that receipt and an exact corrected-
   successor result;
5. verify the v1 predecessor bytes are unchanged, the v2 leaf has a new id and
   stable correction group, and an attempted fork returns HTTP 409; and
6. run the durable learning collector and next daily harvest, verifying the
   effective v2 leaf retains rubric/verifier, structured failure, available
   configuration identities, and successor references without prompt, result,
   diff, or reason text.

No receipt automatically promotes a model, prompt, harness, route, or artifact.
