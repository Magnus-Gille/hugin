# Harbor Gate D proof-of-fit

This pilot evaluates Harbor as Hugin's isolated task-execution and verification
laboratory. It does **not** add Harbor to production dispatch, publish anything
to Harbor Hub, or write observations to Munin.

## Pinned contract

- Harbor: `0.18.0` on Python 3.12+
- M5 model: `qwen3-coder-next-80b`
- M5 harness: `code-loop-pi-2026-07-13-v2`
- Caps: 600 wall seconds, 13 turns, 60,000 completion tokens
- Tasks: Gate D `01-make-failing-test-pass` and `04-add-cli-flag`
- Harbor concurrency: one trial
- Container network: disabled on supported Linux providers; see the macOS note below
- Verifier: separate fresh container, original Gate D `check.sh`, no model

The corpus remains owned by `gille-inference`. The runner requires that source
checkout to be clean, records its exact commit, and generates ephemeral Harbor
tasks under the selected output directory. The source checkout's `node_modules`
must be installed on the Harbor worker itself (`npm ci`); the direct baseline
uses those dependencies and now checks source-local `tsx`/`tsc`, executes an
`esbuild` TypeScript transform, and runs `tsc --version` as a fail-fast
platform-compatibility preflight before making any M5 call.

Harbor 0.18.0's Docker provider rejects `no-network` on Docker Desktop for
macOS because its egress-control implementation cannot enforce that policy on
the host. The runner therefore defaults to `public` on macOS and records a
`conditional-go` even if all functional evidence passes. This is safe for the
pilot's synthetic Gate D fixtures because no M5 credential or other secret is
passed into either container. A production evaluation lane must run on Linux
with `--network-mode no-network` before the condition can be cleared.

If Docker Desktop's registry proxy is unavailable, the task generator accepts
`--base-image <local-image>`. Such an image must already provide `python3`,
Node 22, bash/diff/grep, and the pinned TypeScript/tsx/Node type packages at
`/opt/gate-d/node_modules`. `offline-base.Dockerfile` defines the local fallback
used by the initial macOS pilot. Its nonstandard base is recorded in the report
and is another condition to remove in the Linux rerun.

## Where Harbor fits

Harbor is an evaluation control plane, not another Hugin production runtime.
The intended boundary is:

```text
Gate D / future task corpus
        -> versioned Harbor task adapter
        -> isolated task container
        -> host-side M5 code_loop adapter
        -> M5 gateway + pinned harness/model
        -> collected edited tree
        -> fresh deterministic verifier container
        -> content-blind experiment observation
        -> Hugin learning ledger (only after review)
```

Hugin remains the durable dispatcher, Broker API, trust-policy owner, and Munin
lifecycle owner. M5 remains the inference gateway and `code_loop` owner. Harbor
owns repeatable task packaging, sandbox lifecycle, artifact transfer, verifier
isolation, and aggregate experiment results. This avoids duplicating Harbor's
benchmark machinery inside Hugin while keeping it out of the latency-sensitive
production dispatch path.

Good initial uses are harness/model comparisons, regression gates, failure
taxonomy, task-capability mapping, and generating evidence for Hugin's existing
champion/challenger promotion gate. Harbor should not decide production routing,
write promotions automatically, or become the canonical store for tasks and
results. Source tasks remain in their owning repositories; only version pins,
hashes, outcomes, usage, and provenance should cross into Hugin/Munin.

## Evidence layers

1. The baseline calls the live M5 `code_loop`, applies each returned diff to a
   pristine host copy, and runs the original Gate D verifier.
2. Harbor replays those exact diffs in its task containers. Reward and diff
   hashes must agree exactly with the baseline. This tests packaging and
   separate-verifier parity without model sampling noise.
3. Harbor then runs both tasks through the live external M5 agent. Hugin's
   existing TypeScript client validates the response and effective model,
   harness, and caps before the adapter applies the diff. The separate verifier
   produces the authoritative reward.

Only content-blind summaries belong in Hugin. Full replay results and Harbor
trajectories contain task content and remain in the local pilot output.

## Run

Create an isolated environment and install the pin:

```bash
uv venv --python 3.12 /private/tmp/hugin-harbor-pilot/venv
uv pip install \
  --python /private/tmp/hugin-harbor-pilot/venv/bin/python \
  -r scripts/harbor_pilot/requirements.txt
```

Start Docker Desktop, load the M5 owner credential through Keychain, and run:

```bash
eval "$(m5-auth --env --tailnet)"
HARBOR_BIN=/private/tmp/hugin-harbor-pilot/venv/bin/harbor \
  HARBOR_TELEMETRY=off \
  npm run pilot:harbor -- \
  --source-repo /Users/magnus/repos/gille-inference \
  --network-mode public \
  --base-image hugin/harbor-gate-d-base:node22.17-ts5.9.3-types22.13-arm64
```

The final `pilot-report.json` contains:

- baseline protected-verifier outcomes;
- exact replay reward and diff-hash parity;
- redacted live adapter metadata;
- the source commit and effective execution contract;
- a mechanical `go`, `conditional-go`, or `no-go` recommendation.

`go` means Harbor reproduced both baseline verifier decisions exactly and both
live trials completed the M5 adapter path with valid execution provenance. It
does not authorize automatic promotion or production routing.

`conditional-go` means those functional checks passed but the requested local
provider could not enforce network isolation. Re-run the same pin and source
commit on Linux with `--network-mode no-network` before treating the pilot as a
full go.

## Initial pilot outcome (2026-07-14)

The content-blind machine-readable record is
[`docs/research/harbor-gate-d-pilot-2026-07-14.json`](research/harbor-gate-d-pilot-2026-07-14.json).

| Evidence | Task 01 | Task 04 | Meaning |
|---|---:|---:|---|
| Direct live M5 baseline + host Gate D verifier | pass | pass | M5 returned two usable diffs |
| Exact Harbor replay of those diffs | pass | pass | 2/2 reward parity, 2/2 diff-hash parity, zero exceptions |
| Harbor live adapter completed | yes | yes | model, harness, caps, work id, and apply result were bound |
| Corrected separate-verifier score of live artifacts | pass | fail | real sample quality was 1/2; task 04 failed typecheck |

The first Harbor grading attempt incorrectly returned zero for every trial. The
separate verifier mount hid the task image's `/app/node_modules` symlink, and
the custom offline image also omitted `@types/node`. Both are evaluation-image
defects: the model diffs applied cleanly and replay diff hashes already matched.
The task generator now restores the symlink at verifier runtime, installs the
Node types in the standard image, and preflights custom images before making
paid or slow M5 calls. The corrected model-free replay passed 2/2.

The live task-04 artifact genuinely failed: `src/cli.ts` referenced an undefined
`formatJson`. This is the useful distinction Harbor adds—transport/harness
success and task success are separate signals. The sample is too small to
estimate a capability rate, but it reproduces the known weakness that motivated
including task 04.

Recommendation: **conditional-go** for an offline evaluation lane. Functional
fit is proven, but this macOS run used public container networking and a custom
native-arm64 base because Docker Desktop's registry path stalled. Require a
pinned Linux rerun with no network and the standard base before regular or
automated evaluation use. Do not integrate Harbor into production dispatch.

## Linux acceptance outcome (2026-07-14)

The content-blind acceptance record is
[`docs/research/harbor-gate-d-linux-acceptance-2026-07-14.json`](research/harbor-gate-d-linux-acceptance-2026-07-14.json).
Harbor ran inside a disposable Linux worker against Docker Desktop's LinuxKit
ARM64 daemon. All generated task, agent, and separate-verifier policies were
`no-network`, and both task/verifier Dockerfiles used the standard
`node:22.17.0-bookworm-slim` image at digest
`sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0`.

The first direct-baseline grading attempt was invalid because the Linux worker
linked the laptop checkout's Darwin `esbuild` binary. Harbor itself correctly
graded the exact replays 2/2. A model-free correction re-applied the already
recorded diffs and the original Gate D verifier after a clean Linux-native
`npm ci`; both passed, both diff hashes remained identical, and no M5 call was
repeated. The runner now detects this dependency mismatch before live work.

Final acceptance: exact replay parity 2/2, diff-hash parity 2/2, live adapter
completion 2/2, live verifier passes 2/2, zero Harbor exceptions, and zero
credential indicators in generated task/job output. The mechanical
recommendation is therefore **go** for the explicitly offline evaluation lane.
This clears the environment condition only; the two-task sample is still far
too small for capability-rate claims. Next expand to a predeclared matched
corpus and keep routing/promotion review in Hugin rather than Harbor.

## License and cost

Harbor 0.18.0's package metadata and
[upstream repository](https://github.com/harbor-framework/harbor) declare
Apache-2.0.
That permits internal use and modification without a Harbor runtime license fee,
subject to the license's notice and attribution requirements. Each Python
dependency and any bundled agent CLI retains its own license and must still be
covered by dependency review.

This pilot used local Docker and local M5 inference, did not authenticate to or
upload data to Harbor Hub, and Harbor reported `$0.00` model cost because the
external adapter deliberately treats home inference as zero API spend. That is
not a claim that the run is economically free: M5 electricity, hardware
depreciation, operator time, storage, and Docker licensing are unmetered here.
Optional cloud sandboxes and cloud model providers are separate third-party
services with their own billing. No public Harbor Hub price schedule was found
when this report was prepared, so hosted-Hub use should remain out of scope
until its commercial terms are explicitly reviewed.
