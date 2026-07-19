# Daily-use exam factory

Hugin can turn completed managed-repository tasks into candidates for the
offline Harbor evaluation lane. The production manifest is schema v2. It joins
the Hugin-local repository evidence to M5's owner-only, content-blind
cross-client exposure lookup. This is a **candidate factory**, not a holdout
seal, automatic evaluation, learning, or promotion path.

Historical schema-v1 manifests predate the cross-client lookup. They are legacy,
non-runnable artifacts and must never be treated as fresh evidence.

## What is captured

For a successful task branch, Hugin records a content-blind repository binding
in `result-structured`:

- resolved repository base branch and its exact commit used as the before tree;
- exact task-branch head commit;
- repository-relative changed-file names; and
- SHA-256 of the binary Git diff.

The prompt, answer, diff, file contents, and credentials are not copied into the
factory manifest. They remain in their existing owner-controlled systems. The
manifest keeps hashes and Munin/Git references so a later, reviewed packager can
reconstruct and verify the candidate.

Current Hugin results also record `repositoryOutcome` independently of change
evidence. A managed no-op is therefore explicit (`no-changes`) rather than
being indistinguishable from a skipped checkout, a checkout failure, an
unfinished finalization, or a publication failure.

`source.taskCreatedAt` is the Munin status entry's original `created_at`, not its
terminal update or result completion time. That distinction is load-bearing: a
task created before M5's complete capture window cannot become fresh merely
because it completed after the window opened.

## Candidate lanes

`npm run harvest:daily-exams` reads completed `tasks/` entries from Munin and
classifies them without running a model or writing any learning state:

| Lane | Meaning |
|---|---|
| `provisional-holdout` | Hugin has no evidence that M5 saw the task. `crossClientExposure.state` says whether the daily snapshot is still pending or was unseen within complete coverage. An independent verifier and a just-in-time exposure recheck are still required before any use. |
| `regression` | Hugin has evidence that the task reached an M5 runtime or leaf. It may test non-regression, but it is not fresh. |
| `quarantine` | Reproducibility, privacy, completion, repository, PR, or exposure evidence is incomplete. |

`completed` means that the executor lifecycle finished successfully; it is not
proof that the solution was accepted. The factory reads each task's optional
`feedback` document and joins only valid native-v1/v2 quality receipts whose
hashes bind the exact task document, structured result, and repository
state/diff. It collapses a valid correction chain to its unique unsuperseded
leaf. The content-blind quality view preserves receipt IDs, authenticated
reviewer principals, reason digests, and—on native v2—attempt, predecessor,
stable correction group, rubric/verifier, structured failure, available
producing-configuration identities, and successor references. It never copies
the text rating reason. Native v1 remains exact and does not acquire fabricated
attempt or rubric fields. Legacy flat feedback is labeled `legacy-unbound` and
never upgraded into acceptance. See `docs/quality-receipts.md`.

Every non-quarantined candidate remains `needs-independent-verifier`, including
one whose product output has an exact independent acceptance: accepting the
delivered change is not the same as proving it is a suitable exam oracle. The
acceptance is preserved separately as `quality.state: accepted` plus
`independentAccepted: true`. A partial, rejected, conflicting, malformed, or
stale receipt quarantines the candidate. The factory never promotes
configuration or merges a pull request.

## Cross-client exposure snapshot

Hugin computes the exact M5 fingerprint contract:

1. JavaScript `String.trim()` on the extracted task prompt;
2. no Unicode or internal-whitespace normalization;
3. UTF-8 bytes; then
4. lowercase SHA-256, version `trim-utf8-sha256-v1`.

The CLI deduplicates fingerprints and sends batches of at most 100 to
`POST /admin/task-exposures/lookup`, using the existing
`HOMESERVER_GATEWAY_URL` and minted-owner `HOMESERVER_GATEWAY_API_KEY` from the
Hugin service environment. A configured root URL or `/v1` base is normalized to
the root `/admin/...` endpoint. Credentials, prompt text, and response bodies
are never logged.

`crossClientExposure.state` is deliberately mechanical:

| State | Meaning |
|---|---|
| `not-checked` | Initial pure-factory state. An eligible production candidate may not remain here. |
| `seen` | M5 has positive exposure evidence. Coverage completeness is irrelevant; the candidate is regression-only. |
| `unseen-covered` | The result was unseen, coverage was complete, all six required lanes were covered, and `taskCreatedAt` was inside the inclusive `[coverage.from, coverage.through]` window. |
| `incomplete` | Lookup succeeded but the negative result could not prove freshness. The candidate is quarantined. |
| `error` | Auth, network, version, schema, cardinality, or other lookup ambiguity. The candidate is quarantined. |

The six required lanes are `chat`, `mcp-ask`, `delegate`,
`delegate-disagreement`, `delegate-shadow`, and `code-loop`. Historical
backfill does not need to be complete for a post-`coverage.from` task. Missing,
invalid, pre-window, post-window, or incomplete evidence always fails closed.

Only provisional-holdout candidates are queried; private/already-quarantined
tasks and locally proven regressions do not send their prompt-derived hashes to
M5. Identical provisional fingerprints are sent to M5 only once. If multiple
tasks in one manifest share the prompt, every provisional occurrence is
quarantined and every occurrence is labeled as a duplicate—even when a twin was
already private, quarantined, or regression-only—because none can be claimed as
an independent sample.
When a sweep has no provisional candidate, it still sends one fixed,
non-task-derived SHA-256 smoke fingerprint and discards the match. This proves
the minted-owner endpoint, authentication, and response schema instead of
letting an empty day produce a false-green deployment.

The snapshot persists `checkedAt`, `coverage.through`, the coverage contract,
and the content-blind match metadata. It is not durable freshness. A task may be
shown to M5 after the daily sweep. Any future packager or runner **must repeat
the same owner-only lookup immediately before freezing and again immediately
before running a holdout**. Nothing in schema v2 is named or treated as sealed.

## Run it

```bash
MUNIN_API_KEY=... \
HOMESERVER_GATEWAY_URL=http://m5:8080 \
HOMESERVER_GATEWAY_API_KEY=... \
npm run harvest:daily-exams -- \
  --since 2026-07-14T00:00:00Z \
  --limit 500 \
  --output /private/tmp/hugin-daily-exam-candidates.json
```

The output file is created mode `0600`. Omit `--output` to write JSON to stdout.
The command reports `historyComplete:false` whenever Munin pagination or the
caller limit prevents it from proving that the selected history is complete.
If the M5 lookup fails, Hugin first atomically writes a safe schema-v2 manifest
with affected candidates in `error`/quarantine, then exits non-zero so systemd
and deployment acceptance surface the fault. A stale successful snapshot is
never left in place.

Production runs the same compiled CLI from
`hugin-daily-exam-factory.timer` once per day. It inspects a rolling 48-hour
window and atomically replaces the private manifest at
`~/.hugin/daily-exam-candidates/latest.json`. Deployment installs the timer,
runs one acceptance sweep, requires schema v2, and rejects any eligible
`not-checked` candidate; the timer never invokes Harbor or a model.

## Safety boundary and next stage

The factory does not:

- claim that absence of Hugin-local M5 provenance proves global freshness;
- copy private tasks into an evaluation package;
- invent or trust a verifier;
- run Harbor or M5;
- import a learning observation; or
- promote a model, harness, prompt, or route.

The next stage consumes a reviewed candidate, repeats the exposure lookup,
reconstructs the base tree, derives and validates an independent verifier, and
only then creates a frozen Harbor declaration. It repeats the lookup again
immediately before execution. The reusable Gate D corpus and M5 capability
ledger remain owned by `gille-inference`; this Hugin-side factory owns daily
task discovery and reproducibility evidence.

The owner-side registry and lookup contract shipped in
[`gille-inference#257`](https://github.com/Magnus-Gille/gille-inference/issues/257).
