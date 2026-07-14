# Daily-use exam factory

Hugin can turn completed managed-repository tasks into quarantined candidates
for the offline Harbor evaluation lane. This is a **candidate factory**, not an
automatic learning or promotion path.

## What is captured

For a successful task branch, Hugin records a content-blind repository binding
in `result-structured`:

- exact `origin/main` commit used as the before tree;
- exact task-branch head commit;
- repository-relative changed-file names; and
- SHA-256 of the binary Git diff.

The prompt, answer, diff, file contents, and credentials are not copied into the
factory manifest. They remain in their existing owner-controlled systems. The
manifest keeps hashes and Munin/Git references so a later, reviewed packager can
reconstruct and verify the candidate.

## Candidate lanes

`npm run harvest:daily-exams` reads completed `tasks/` entries from Munin and
classifies them without running a model or writing any learning state:

| Lane | Meaning |
|---|---|
| `provisional-holdout` | Hugin-local provenance is negative, M5's owner lookup returned `seen:false`, the task was created inside a complete live all-lane coverage window, and an independent verifier is still required. |
| `regression` | Hugin-local provenance or M5's cross-client registry proves exposure. It may test non-regression, but it is not fresh. |
| `quarantine` | Reproducibility, privacy, completion, repository, PR, lookup availability, coverage window, or exposure evidence is incomplete. |

Every non-quarantined candidate still has readiness
`needs-independent-verifier`. Agent prose and a changed test file are not an
independent grading oracle.

## Run it

```bash
MUNIN_API_KEY=... \
HOMESERVER_GATEWAY_URL=http://100.76.72.59:8080 \
M5_TASK_EXPOSURE_API_KEY=... \
npm run harvest:daily-exams -- \
  --since 2026-07-14T00:00:00Z \
  --limit 500 \
  --output /private/tmp/hugin-daily-exam-candidates.json
```

The output file is created mode `0600`. Omit `--output` to write JSON to stdout.
The command reports `historyComplete:false` whenever Munin pagination or the
caller limit prevents it from proving that the selected history is complete.

Before classification, the CLI applies the shared
`trim-utf8-sha256-v1` contract to each exact `### Prompt` and sends only the
unique SHA-256 digests to M5's owner-authenticated batch lookup. The manifest is
schema v2 and records bounded coverage metadata plus per-candidate timestamps,
lanes, model IDs, and harness IDs; it never records lookup prose or raw task
text. A dedicated `M5_TASK_EXPOSURE_API_KEY` is preferred and falls back to
`HOMESERVER_GATEWAY_API_KEY` only when that is a real minted owner credential.
Redirects are denied so the owner token cannot leave the configured sovereign
gateway.

Positive matches are regression evidence even for older tasks. A negative is
usable only when live coverage is complete, all six gateway-controlled lanes
are present, and the earliest task creation/submission timestamp is inside the
reported window. Missing credentials, lookup failures, incomplete coverage,
old tasks, and contract drift fail closed to quarantine. The harvester still
completes and exposes `exposureLookup.status`; deployment acceptance rejects an
`unavailable` production lookup rather than stamping a partially wired release.

Production runs the same compiled CLI from
`hugin-daily-exam-factory.timer` once per day. It inspects a rolling 48-hour
window and atomically replaces the private manifest at
`~/.hugin/daily-exam-candidates/latest.json`. Deployment installs the timer and
runs one acceptance sweep, including the read-only M5 lookup; the timer never
invokes Harbor or a model.

## Safety boundary and next stage

The factory does not:

- claim that an unbound, incomplete, or out-of-window negative proves freshness;
- copy private tasks into an evaluation package;
- invent or trust a verifier;
- run Harbor or M5 inference;
- import a learning observation; or
- promote a model, harness, prompt, or route.

The next stage consumes a reviewed candidate, reconstructs the base tree,
derives and validates an independent verifier, rechecks exposure immediately
before sealing, and only then creates a frozen Harbor declaration. The reusable
Gate D corpus and M5 capability ledger remain owned by `gille-inference`; this
Hugin-side factory owns daily task discovery and reproducibility evidence.

The owner-side exposure contract shipped in
[`gille-inference#257`](https://github.com/Magnus-Gille/gille-inference/issues/257)
and is documented in that repository's `docs/task-exposure-contract.md`.
