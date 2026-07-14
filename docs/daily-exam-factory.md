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
| `provisional-holdout` | Hugin has no evidence that M5 saw the task. A cross-client exposure check and an independent verifier are still required before sealing it. |
| `regression` | Hugin has evidence that the task reached an M5 runtime or leaf. It may test non-regression, but it is not fresh. |
| `quarantine` | Reproducibility, privacy, completion, repository, PR, or exposure evidence is incomplete. |

Every non-quarantined candidate still has readiness
`needs-independent-verifier`. Agent prose and a changed test file are not an
independent grading oracle.

## Run it

```bash
MUNIN_API_KEY=... npm run harvest:daily-exams -- \
  --since 2026-07-14T00:00:00Z \
  --limit 500 \
  --output /private/tmp/hugin-daily-exam-candidates.json
```

The output file is created mode `0600`. Omit `--output` to write JSON to stdout.
The command reports `historyComplete:false` whenever Munin pagination or the
caller limit prevents it from proving that the selected history is complete.

## Safety boundary and next stage

The factory does not:

- claim that absence of Hugin-local M5 provenance proves global freshness;
- copy private tasks into an evaluation package;
- invent or trust a verifier;
- run Harbor or M5;
- import a learning observation; or
- promote a model, harness, prompt, or route.

The next stage consumes a reviewed candidate, checks a shared exposure registry,
reconstructs the base tree, derives and validates an independent verifier, and
only then creates a frozen Harbor declaration. The reusable Gate D corpus and
M5 capability ledger remain owned by `gille-inference`; this Hugin-side factory
owns daily task discovery and reproducibility evidence.

The owner-side exposure lookup is tracked in
[`gille-inference#257`](https://github.com/Magnus-Gille/gille-inference/issues/257).
