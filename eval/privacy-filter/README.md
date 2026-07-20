# OPF PII evaluation harness (#56)

Offline harness to answer the two questions in
[`docs/design/openai-privacy-filter-eval.md`](../../docs/design/openai-privacy-filter-eval.md):

1. Is the [OpenAI Privacy Filter](https://github.com/openai/privacy-filter) (OPF)
   a meaningfully better PII substrate than Hugin's regex scanners?
2. Where in the fleet (Pi vs laptop) should it run?

It runs **today on the laptop with zero OPF installed** — the regex baseline and
the scorer have no external deps — and folds OPF in as a second column once you
run it on a host.

## Layout

| Path | What |
|---|---|
| `fixtures/grimnir-pii.jsonl` | 24 labelled, Grimnir-shaped examples (email, journal, Munin excerpts, calendar, invoices, support pastes). EN + SV. **All PII fabricated.** OPF-native eval format. |
| `fixtures/clean-technical.jsonl` | 10 no-PII examples (code, configs, logs, security *vocabulary*) — false-positive probes. A good detector emits zero spans here. |
| `results/<host>/` | Per-host `bench-<host>.json` (latency/RSS) + `predictions-<host>.jsonl` (OPF output), written by `bench-opf.sh`. |
| `../../src/privacy-filter/` | Pure, tested modules: `pii-types`, `fixtures`, `pii-regex-baseline`, `opf-output`, `pii-scorer`. |
| `../../scripts/build-pii-fixtures.ts` | Regenerates the fixtures (offsets correct by construction). |
| `../../scripts/run-pii-eval.ts` | Scores detectors → markdown + JSON report. |
| `../../scripts/bench-opf.sh` | Host-side: OPF latency benchmark + predictions over the fixtures. |

## Workflow

### 1. Baseline + fixtures (laptop, now)

```bash
npm run build:pii-fixtures   # (re)generate fixtures
npm run eval:pii             # score the regex baseline, print the report
```

### 2. Run OPF on a host (Pi, then laptop)

Install OPF on the host (the model auto-downloads to `~/.opf` on first run):

```bash
git clone https://github.com/openai/privacy-filter
cd privacy-filter && pip install -e .
```

Then, from the Hugin repo on that host:

```bash
./scripts/bench-opf.sh --device cpu --reps 5
# → eval/privacy-filter/results/<host>/bench-<host>.json
# → eval/privacy-filter/results/<host>/predictions-<host>.jsonl
```

### 3. Score OPF vs baseline (laptop)

```bash
tsx scripts/run-pii-eval.ts \
  --opf eval/privacy-filter/results/local/predictions-local.jsonl \
  --timings eval/privacy-filter/results/local/bench-local.json \
  --md eval/privacy-filter/results/report-local.md \
  --json eval/privacy-filter/results/report-local.json
```

## Metrics

- **Typed F1 (relaxed)** — label must match, any character overlap counts. The fair headline.
- **Exact F1** — identical `[start, end)`. Stricter; boundary quality.
- **Detection recall** — label-agnostic overlap. *The leak-prevention metric*: did we
  notice PII is present at all? A miss before a cloud call is a leak.
- **Per-label P/R** — where each approach wins/loses.
- **Clean contamination** — fraction of clean examples that got any prediction +
  total spurious spans. Over-redaction degrades task utility.

## Regex baseline — what it is and isn't

Hugin has no span-level PII detector today (`exfiltration-scanner.ts` is secrets,
`sensitivity.ts` is keyword classification). `pii-regex-baseline.ts` is a
best-effort regex over OPF's 8 labels, included so OPF is measured against a fair
floor — not a strawman:

- **Strong** on structured PII: email, URL, ISO/written dates, well-known secret
  shapes, phones. Current numbers (laptop): email/phone/url/secret recall 100%,
  date 93%.
- **Weak by design** on unstructured PII: the person heuristic is a TitleCase
  n-gram (over-fires on `Agent SDK`, misses lowercase mononyms); the address
  heuristic catches a few street forms and little else (recall ~40%). These low
  numbers *are* the finding that motivates a learned model.

### Taxonomy gaps to watch in the OPF column

- **Swedish personnummer / bankgiro / plusgiro** are mapped to `account_number`
  (OPF has no national-ID label). OPF recall here is a key unknown.
- OPF is likely English-centric; the SV / mixed fixtures (`info.lang`) exist to
  expose any Swedish recall gap.

## Decision criteria

Reproduced from the design doc, evaluated automatically in the report's last
section once OPF predictions are supplied:

> **Adopt** integration #1 (`HUGIN_EXFIL_POLICY=opf`) iff OPF recall ≥ baseline +
> materially better on names/addresses, p95 latency on the chosen host < poll
> interval, and clean contamination is tolerable. **Defer** if Pi latency is
> prohibitive and no always-on Mac host is acceptable. **Reject** if the quality
> gain over regex is marginal at the realized cost.
