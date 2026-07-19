# Continuous Hugin/M5 learning loop

**Status:** first production-safe slice (2026-07-13)

## Goal

Every real or replayed task should improve either the production baseline or the evidence used to
choose the next experiment. A failed challenger is useful negative evidence, but it must never
silently replace the current champion.

The loop is:

```text
versioned champion
  → matched champion/challenger runs
  → independent verification + product rating
  → monotonic gates
  → promotion-ready OR reject-and-diagnose
  → next one-axis experiment
```

This slice gives Hugin a durable experiment ledger, evaluation state machine, and per-scope
champion lineage. It does **not** let Hugin edit or deploy M5 configuration. `promotion-ready`
means the owning configuration repo may apply the reviewed challenger. The operator then records
that applied commit/config reference, advances the champion pointer, and uses it as the mandatory
baseline for the next experiment.

## What is versioned

Each arm records a content-blind configuration fingerprint plus exact references for:

- logging schema and required-field contract;
- test harness, corpus, oracle, and holdout revision;
- agent prompt version and SHA-256;
- agent harness version/configuration, turn and timeout budgets, edit deadline, context strategy,
  and tool-policy version;
- model identity, provider/runtime, quantization, context/output limits, sampling, reasoning, and
  prompt-template version;
- routing policy version.

Prompt text and fixture contents remain in their owning repositories. Hugin stores only versions
and hashes, so experiment evidence cannot become a second sensitive-content archive.

Exactly one semantic axis may differ between champion and challenger. Hugin rejects an experiment
that claims to test a prompt while also changing the model, harness, or corpus.

## Evidence contract

An observation identifies an experiment, run, matched `sample_id`, arm, holdout status, and exact
configuration fingerprint. It may record:

- independently verified `pass` / `fail`, `unverified`, or `infra-error`;
- product outcome: accepted unchanged, minor edit, major rewrite, discarded, or unrated;
- latency, local cost, human-review time, and time-to-first-edit;
- observability coverage and verifier score;
- whether an edit occurred, tests ran/passed, and inspect/edit/check phase timing;
- failure kind plus task, M5-ledger, and code-loop work identifiers.

A judge model is advisory. A judge-only verdict never contributes verified quality evidence.
Duplicate `run_id` submissions are idempotent; conflicting duplicates, a second arm result for the
same sample, or a configuration fingerprint outside the experiment contract are rejected.

## Promotion rule

The evaluator uses matched pairs only. Before it can decide, it requires the experiment's minimum
pair count, holdout count, independent-verification coverage, rating coverage, and a measured
primary metric.

The challenger is rejected if it exceeds any configured regression limit for correctness, useful
completion, human rescue, infrastructure failures, latency, or cost. If every guard passes, it
must still clear the predeclared primary improvement threshold. Otherwise the champion remains.

`promotion-ready` is a mechanical evaluator result, not authorization to apply
the challenger. The promotion mutation additionally requires at least one
challenger run with an independent `pass` and an explicit product outcome of
accepted unchanged or minor edit. This guard remains active even when an
experiment deliberately sets `minRatedCoverage` to zero, so unrated mechanical
evidence can never advance the champion pointer. Hugin has no automatic PR
merge path; a repository merge remains a separately reviewed action.

Every evaluation returns dominant challenger failure signals and a concrete next action. Common
signals are `no-edit`, `tests-not-run`, `tests-failed`, `unverified-output`, `infra-error`, and the
explicit failure kind supplied by the harness.

## API and MCP tools

The authenticated Broker exposes:

- `POST /v1/learning/experiments/create`
- `POST /v1/learning/experiments/observe`
- `POST /v1/learning/experiments/rate`
- `POST /v1/learning/experiments/status`
- `POST /v1/learning/experiments/promote`

`hugin-mcp` mirrors them as:

- `hugin_experiment_create`
- `hugin_experiment_observe`
- `hugin_experiment_rate`
- `hugin_experiment_status`
- `hugin_experiment_promote`

State is principal-isolated and stored under `experiments/hugin/*` in Munin with CAS-guarded
updates. Each scope also has a champion pointer. A new experiment whose champion fingerprint does
not match that pointer is rejected, preventing an iteration from silently restarting at an
obsolete baseline. Promotion requires the exact evaluated challenger fingerprint and an applied
repository/config reference; it is idempotent and reconciles a crash between the champion-pointer
and experiment-state writes. Experiment writes use a dedicated Munin client so a large evidence
upload cannot queue behind task claims, leases, or terminal checkpoints.

Heimdall's Hugin page shows experiment state, matched/holdout counts, primary improvement, and the
next action. An unavailable ledger renders as unavailable, never as zero experiments.

Automated runners normally record `product_outcome: unrated` as soon as protected checks finish.
`hugin_experiment_rate` later enriches that exact run with a human/downstream usefulness outcome
and optional review time. This is a one-way, audited transition: an existing rating cannot be
overwritten. An experiment that requires product coverage therefore remains in `gathering` until
enough runs have been rated.

## First M5 iteration

The original draft incorrectly referred to a "Wave 5" corpus and gille-inference #201. That issue
is about chat-replay scoring and no such code-loop corpus exists. The reproducible baseline is the
existing ten-case Gate D battery. The first controlled experiment should change only
`agent-harness`:

- champion: current 13-turn code-loop configuration;
- challenger: identical configuration with inspect/edit/check timing plus an edit-deadline rule;
- matched corpus: all ten Gate D code-edit cases on both arms;
- holdout: two predeclared Gate D cases not used to design the rule;
- independent oracle: protected local check;
- primary metric: `edit-start-ms`;
- non-regression: zero correctness/usefulness/rescue regression, bounded latency, identical local
  cost.

The M5/gille-inference code-loop owner must emit the phase timing and work id. That owning-repo
work is tracked by [gille-inference #247](https://github.com/Magnus-Gille/gille-inference/issues/247).
Until it is deployed, Hugin records final diff/check facts but deliberately leaves edit timing
unmeasured, so this experiment remains `gathering` instead of manufacturing a conclusion.

## Running the Gate D loop

`scripts/run-m5-code-loop-experiment.ts` is the resumable Hugin-side adapter. Its JSON manifest
contains the fully versioned experiment contract, both arms' effective caps, and paths to each
sample's instruction/seed directory/check. Before any remote mutation it:

1. validates exactly one changed configuration axis;
2. hashes every instruction, seed file, check command, holdout flag, and protected path and compares
   the result with the declared corpus SHA-256;
3. verifies that M5 advertises the exact
   `code-loop-pi-2026-07-14-v6` / `pi-bash-events-v3` / schema 3 producer contract,
   including `edit_deadline_turn` and durable `client_run_id` starts;
4. idempotently creates or resumes the Hugin experiment;
5. runs matched pairs sequentially, counterbalancing which arm runs first;
6. records only content-blind observations—never diffs, prompts, check output, or seed contents.

Observation writes are reconciled after ambiguous Broker timeouts: the runner first reads the
durable experiment state and retries only an identical, absent `run_id`. This avoids rerunning a
paid M5 arm merely because Hugin committed the evidence but its HTTP response was lost.

Each arm derives a bounded content-blind `client_run_id` from the immutable experiment `run_id`.
M5 binds that caller id to a canonical request fingerprint before execution. A lost start response
is retried with the exact same request and id; M5 returns the original running or terminal work
instead of starting another paid run. Hugin persists the echoed caller id and request fingerprint
with the observation, and can consume a recovered terminal result directly after a restart.

The v3 result also records immutable content-blind agent-side check events: check kind, command
fingerprint, timing, pass/fail/execution-error, ordering, and event-stream coverage. It never trusts
the model summary. Unparseable NDJSON and refused or uncorrelated check candidates are counted
separately; `none`, `unobservable`, and `partial` remain distinct. Experiments that need to
attribute an improvement to genuine agent-side checking should predeclare
`gates.minChallengerAgentCheckCoverage`; its default is zero for backward compatibility.

An arm may declare a local-only `prompt_prefix_file`. The runner reads it once, verifies every byte
against that arm's versioned `prompt.sha256`, and prepends it to each corpus instruction. Hugin still
stores only the content hash and prompt version, so prompt-axis experiments remain reproducible and
content-blind. Omitting the file preserves the original instruction byte-for-byte and validates the
deployed passthrough prompt fingerprint.

Credentials stay in environment variables. Use the Keychain helper and tailnet path; never put
tokens in the manifest:

```bash
eval "$(m5-auth --env --tailnet)"
HUGIN_BROKER_URL=http://hugin-node.<tailnet>.ts.net:3035 \
HUGIN_BROKER_TOKEN=<keychain-or-env-token> \
npm run experiment:m5-code-loop -- /path/to/gate-d-wave.json --dry-run

# Remove --dry-run only after the matching gille-inference and Hugin contracts are deployed.
```

After mechanical collection, rate each run through `hugin_experiment_rate`. Do not promote while
the evaluator reports missing rating coverage, missing paired edit timing, or any non-regression
failure.
