# Design / Eval Plan: OpenAI Privacy Filter for local PII redaction (#56)

**Status:** evaluation plan (empirical benchmarks pending — they gate the decision)
**Issue:** [#56](https://github.com/Magnus-Gille/hugin/issues/56)

## What we're evaluating

[`openai/privacy-filter`](https://github.com/openai/privacy-filter) (OPF) — an Apache-2.0,
bidirectional token classifier over a PII taxonomy. ~1.5B params total / ~50M active
(MoE top-4 of 128 experts), 128K context, designed to run on CPU. Permissive license means it
can sit **inside** the trusted runtime boundary (unlike a hosted API).

The question is two-fold: (a) is OPF a meaningfully better PII substrate than Hugin's current
regex scanners, and (b) where in the fleet should it run.

## Why it's interesting for Hugin

Hugin already enforces a `public/internal/private` sensitivity lattice (`src/sensitivity.ts`)
and has two regex scanners — `src/prompt-injection-scanner.ts` (context-ref content) and
`src/exfiltration-scanner.ts` (task output). Regex is brittle for PII (misses paraphrase,
context, novel formats). A learned token classifier is a stronger substrate for the same jobs.

## Candidate integration points (ranked by value/effort)

| # | Integration | Value | Effort | Notes |
|---|-------------|-------|--------|-------|
| 1 | **Exfil-scanner upgrade** — OPF pass on task results before they land in Munin (augment, not replace, `exfiltration-scanner.ts`) | High | Med | Drop-in to the existing `HUGIN_EXFIL_POLICY` pipeline; new policy value `opf` alongside `warn/flag/redact`. Spans give precise redaction. |
| 2 | **Sensitivity inference** — feed OPF-detected PII spans into `sensitivity.ts` to escalate `public → internal/private` automatically | High | Med | Makes the lattice signal much stronger than keyword+path. Escalate-only (never downgrade). |
| 3 | **Context-ref sanitization** — when a cloud-capped runtime would be blocked by the sensitivity ceiling, optionally OPF-redact PII from context-refs and downgrade effective sensitivity | High | High | Big trust-story win, but redaction-then-cloud is the riskiest path (a miss = leak). Requires very high recall + an audit trail. Gate behind explicit opt-in. |
| 4 | **Pre-Munin write filter** — generic OPF pass on anything a cloud runtime writes to Munin | Med | Med | Defense in depth; overlaps #1. |

**Recommended first slice:** integration #1 (exfil-scanner augmentation) as a new
`HUGIN_EXFIL_POLICY=opf` mode — lowest risk (it only *adds* detections to an existing
pipeline), directly measurable against the regex baseline, and no behavior change unless opted in.
Integration #3 (redact-then-cloud) should NOT ship until #1/#2 establish OPF's recall in practice.

## Deployment options to evaluate

| Host | Pros | Cons | Verdict to test |
|------|------|------|-----------------|
| **Hugin-Munin Pi** (ARM64, 8 GB) | Co-located with Hugin+Munin, no network hop, stays on-device for `private` tasks | 1.5B (50M active) on ARM Pi CPU is tight; latency unknown | Benchmark throughput/latency — likely viable for async scan, maybe not inline |
| **MacBook** | Fast (Apple Silicon), already an orchestrator | Not always on; network hop from Pi; laptop sleeps | Good for dev/eval, poor for an always-on Pi-side filter |
| **Mac Studio** | Always-on, fast, lots of RAM | Network hop from Pi; another host in the trust boundary | Best if Pi latency is unacceptable — run OPF as a small local service over Tailscale |

The deployment decision hinges on **measured Pi latency**: if a 1–10 KB task result scans in
well under the poll interval, run it on the Pi (simplest trust story). If not, run it as a
Tailscale-local OPF service on the Mac Studio and have Hugin call it (still inside the tailnet,
no third-party egress).

## Evaluation protocol (the empirical work — gates the decision)

1. **Stand up OPF** on each candidate host; record cold-start + warm inference.
2. **Throughput/latency benchmark** per host: scan representative task results (1 KB, 10 KB,
   100 KB) and context-refs; record p50/p95 latency and memory. The Pi number is the pivotal one.
3. **Quality benchmark vs the regex baseline** on a labelled fixture set (synthetic + real-shaped
   Grimnir content with known PII spans): precision/recall/F1 for OPF vs `exfiltration-scanner.ts`
   regexes. Pay special attention to **recall** (a missed PII span before a cloud call = leak).
4. **False-positive cost** on clean technical content (code, logs) — over-redaction degrades task
   utility.
5. **Decision matrix:** integration point #1 ships only if OPF beats regex recall at acceptable
   latency on the chosen host and FP rate on clean content is tolerable.

## Decision criteria (pre-registered)

- **Adopt (integration #1)** if: OPF recall on the PII fixture ≥ regex baseline + materially
  better on paraphrased/novel PII, p95 latency on the chosen host < poll interval, FP rate on
  clean technical content < an agreed threshold.
- **Defer** if: Pi latency is prohibitive AND no always-on Mac host is acceptable in the trust
  boundary.
- **Reject** if: quality gain over regex is marginal at the realized cost/latency.

## Security considerations

- OPF runs **inside** the trusted boundary (local, Apache-2.0) — no third-party egress, so it does
  not itself widen the trust surface. A Mac-Studio deployment must stay Tailscale-only.
- Redact-then-cloud (#3) is the only integration that can *cause* a leak (via a recall miss); it
  must be opt-in, audited, and never the default — consistent with the cloud-runtime sensitivity cap.
- Sensitivity inference (#2) must be **escalate-only**: OPF can raise sensitivity, never lower it.

## Rough effort

- Eval harness + fixtures + per-host benchmark: ~1–2 days (the real cost is curating a labelled
  PII fixture set).
- Integration #1 (`HUGIN_EXFIL_POLICY=opf`): ~1 day once the host + model-serving shape is chosen.

## Harness (bootstrapped)

The harness that runs this protocol lives at [`eval/privacy-filter/`](../../eval/privacy-filter/README.md)
with pure, tested modules under [`src/privacy-filter/`](../../src/privacy-filter/). It is built so the
quality side runs **today on the laptop with zero OPF installed**, and OPF folds in as a second column
once it runs on a host.

- **Fixtures** — `eval/privacy-filter/fixtures/*.jsonl`, in OPF's native eval format (so `opf eval`
  consumes them directly). 24 labelled Grimnir-shaped examples (EN + SV) covering all 8 OPF labels +
  10 clean no-PII probes for the false-positive measurement. All PII fabricated. Generated by
  `npm run build:pii-fixtures` with offsets correct by construction (re-validated in tests).
- **Regex baseline** — `src/privacy-filter/pii-regex-baseline.ts`. Hugin has no span-level PII
  detector today, so this establishes the fair floor OPF must beat. Current laptop numbers: typed
  micro-F1 **90%**, detection recall **93%**; strong on email/phone/url/date/secret, weak (by design)
  on address (~40% recall) and lowercase names — the gaps that motivate a learned model.
- **Scorer** — `src/privacy-filter/pii-scorer.ts`. Span-level P/R/F1 under exact / relaxed / detection
  matching, per-label cuts, and clean-content contamination. Greedy 1:1 span matching.
- **Host benchmark** — `scripts/bench-opf.sh` (runs on Pi + laptop): per-invocation latency across
  content sizes, warm per-example rate via `opf eval`, peak RSS, and predictions JSONL for the scorer.
- **Report** — `npm run eval:pii` (or `scripts/run-pii-eval.ts --opf … --timings …`) prints a
  markdown + JSON report whose final section auto-evaluates the decision criteria below.

## Next step

The harness is in place; the gating action is now purely **running `scripts/bench-opf.sh` on the Pi
(and the laptop) once OPF is installed**, then scoring with `--opf`/`--timings`. Until the Pi latency
and OPF recall numbers exist, no integration ships. (The Mac Studio option remains contingent on the
`projects/home-server-inference-evaluation` buy decision; the Pi is the host we can benchmark today.)
