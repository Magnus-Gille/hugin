# OpenAI Privacy Filter — evaluation results (#56)

**Status:** empirical run complete on the Hugin-Munin Pi (2026-05-31). Recommendation below.
**Issue:** [#56](https://github.com/Magnus-Gille/hugin/issues/56) · **Design/plan:** [`docs/design/openai-privacy-filter-eval.md`](../design/openai-privacy-filter-eval.md) · **Harness:** [`eval/privacy-filter/`](../../eval/privacy-filter/README.md)

## TL;DR

- **OPF runs on the Pi 5 only after a workaround** — the A76 CPU has no bf16, and torch's
  mkldnn path hard-errors on the bf16 model. Setting `torch.backends.mkldnn.enabled=False`
  routes bf16 matmuls through the native CPU kernel and it works (correctly).
- **OPF is *not* a clear win over a good regex baseline on Grimnir-shaped content.** Typed
  micro-F1 86.5% vs **90.0%**; detection recall 90.1% vs **93.0%**; clean-content
  false-positive load tied at 10%.
- **OPF's decisive win is the one category regex structurally can't do: free-form addresses
  (recall 40% → 100%).** It *loses* on dates (79% vs 93%) and Swedish account identifiers
  (33% vs 67%) — the latter a taxonomy gap (OPF has no national-ID class; personnummer /
  bankgiro / plusgiro / IBAN don't map cleanly).
- **Latency on the Pi rules out inline use.** ~44 s model load, ~3.7 s/example warm,
  **8.8 tokens/s**, ~324 s for a 10 KB input. The 30 s poll interval is not even close.
- **Verdict: per the pre-registered criteria, do NOT adopt integration #1 (OPF-replaces-regex)
  — on the Pi, or as a replacement anywhere.** OPF earns a narrower role (below).

## Setup

| | |
|---|---|
| Host | Hugin-Munin Pi 5, aarch64, 4× Cortex-A76, 8 GB |
| Install | `pip install -e .` into an isolated venv at `/var/lib/hugin/scratch/opf-eval`; model auto-downloaded (2.8 GB) to `~/.opf/privacy_filter` |
| Runtime fix | `torch.backends.mkldnn.enabled=False` via a `usercustomize.py` on `PYTHONPATH` (the A76 lacks bf16; mkldnn's bf16 matmul raises `c10::Error`) |
| Fixtures | 24 labelled (EN+SV, all 8 OPF labels) + 10 clean — `eval/privacy-filter/fixtures/` |
| Decode | OPF default (viterbi), `--eval-mode typed` |

The mkldnn-disabled fallback changes *speed*, not arithmetic — accuracy numbers are
representative; latency is a floor (a bf16-capable CPU would be faster).

## Quality (span-level, relaxed match)

| Detector | Typed F1 | Typed P | Typed R | Detection R | Exact F1 | Clean contamination |
|---|---|---|---|---|---|---|
| regex-baseline | **90.0%** | 91.3% | 88.7% | 93.0% | 71.4% | 10.0% (1 span) |
| opf | 86.5% | 87.1% | 85.9% | 90.1% | 72.3% | 10.0% (1 span) |
| regex ∪ opf | 80.0%¹ | 68.7%¹ | **95.8%** | **98.6%** | 72.9% | 20.0% (2 spans) |

### Per-label recall

| Label (support) | regex | opf | union | note |
|---|---|---|---|---|
| private_person (22) | 90.9% | 86.4% | 95.5% | union best; OPF also caught a signature name regex missed |
| private_address (5) | **40.0%** | **100%** | 100% | **OPF's headline win** — regex can't do free-form addresses |
| private_date (14) | 92.9% | 78.6% | 100% | OPF weaker; misses some written/partial forms |
| account_number (6) | 66.7% | **33.3%** | 66.7% | **OPF taxonomy gap** — SV personnummer/bankgiro/IBAN |
| email / phone / url / secret | 100% | 100% | 100% | tie (regex strong on structured PII) |

¹ Union precision is **understated**: the scorer does greedy 1:1 matching and does not merge
overlapping spans, so when regex and OPF both flag the same entity with slightly different
bounds/labels, the union shows 1 TP + 1 FP. A real union deployment would merge overlapping
spans before redaction; the meaningful union number is its **detection recall (98.6%)** — the
practical leak-prevention ceiling.

OPF's own `opf eval --per-class` cross-validates the harness: its token-level
`B-account_number` recall (0.333) equals our span-level account_number recall (33.3%);
self-reported `token_accuracy` 0.90.

## Latency / cost (Pi 5, CPU, mkldnn off)

| Measurement | Value |
|---|---|
| Cold model load | ~44 s |
| Warm per example (`opf eval`, 24 ex) | ~3.7 s (`model_forward` 89.6 s / 24) |
| Throughput | 8.8 tokens/s |
| Per-invocation, 154 B input | ~47–51 s (load-dominated) |
| Per-invocation, 10 KB input | ~324 s |
| Peak RSS | not captured (GNU `time` absent on the Pi); model is 2.8 GB on disk |

Hugin's natural integration shape (spawn `opf` per task result) pays the ~44 s load **every
time** → 50 s+ for even a tiny result. A persistent server amortizes load to the ~3.7 s/example
warm rate, but that is still far above a 30 s budget for anything but the smallest inputs, and
adds an always-on process competing with ollama-pi for the Pi's RAM.

## Decision (against the pre-registered criteria)

> Adopt integration #1 iff OPF recall ≥ baseline + materially better on names/addresses, p95
> latency on the chosen host < poll interval, and FP rate on clean content is tolerable.

- Recall **≥ baseline?** No (90.1% vs 93.0% detection; 85.9% vs 88.7% typed). ✗
- Materially better on names/addresses? **Addresses yes** (40→100), names roughly tied. ~
- p95 latency < poll interval on the Pi? **No, by 1–2 orders of magnitude.** ✗
- Clean FP tolerable? Tied with regex (10%). ✓

**→ Reject OPF-replaces-regex. Reject any inline OPF on the Pi.**

## Recommendation

1. **Keep the regex baseline as the structured-PII workhorse** (email/phone/url/date/secret/
   account — fast, 100% on most, no model). The `pii-regex-baseline.ts` built for this eval is
   itself the first span-level PII detector Hugin has had; consider wiring it into a
   `HUGIN_EXFIL_POLICY` mode independent of OPF.
2. **Use OPF only for the unstructured categories it actually wins (person, address), in an
   async role, on a faster host** — not inline, not on the Pi. The union's 98.6% detection
   recall shows the value is *additive*: regex ∪ OPF catches ~99% of PII presence vs 93% for
   regex alone. The cleanest shape is regex inline + an async OPF pass (Mac Studio over
   Tailscale, *if/when* that host exists per `projects/home-server-inference-evaluation`) that
   escalates sensitivity when it finds person/address spans regex missed.
3. **If OPF is adopted for Swedish content, expect to fine-tune** — the account_number gap is a
   taxonomy mismatch (`opf train` exists). Not worth it for the current value.
4. **Do not gate this decision on a 34-example fixture set.** See caveats.

## Caveats

- **Small n.** 24 PII + 10 clean; per-label support is tiny (address n=5, account n=6).
  Confidence intervals are wide — this is a bootstrap/smoke eval, not a definitive benchmark.
- **Author bias.** The same author wrote the fixtures *and* the regex baseline; the baseline
  may be unintentionally fitted to the fixtures. A held-out, third-party-labelled set (or
  OPF's own eval corpus) would harden the comparison.
- **Single host.** Only the Pi was benchmarked (the laptop and a hypothetical Mac Studio were
  not). The latency verdict is Pi-specific; the quality verdict is host-independent.
- **mkldnn-off latency is a floor**, not OPF's best-case throughput.

## Reproduce

```bash
npm run build:pii-fixtures                       # regenerate fixtures
npm run eval:pii                                 # regex baseline only (laptop, no OPF)
# on a host with OPF (see eval/privacy-filter/README.md):
./scripts/bench-opf.sh --device cpu --reps 3
# then score:
npx tsx scripts/run-pii-eval.ts \
  --opf eval/privacy-filter/results/<host>/predictions-all-<host>.jsonl \
  --timings eval/privacy-filter/results/<host>/bench-<host>.json \
  --md eval/privacy-filter/results/report-<host>.md
```

Raw host artifacts are intentionally not committed because they can expose
machine paths, host metadata, and input-derived text. Reproduce the evaluation
locally with the synthetic fixtures under [`eval/privacy-filter/`](../../eval/privacy-filter/README.md).
