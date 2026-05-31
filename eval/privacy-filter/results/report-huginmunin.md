# OPF PII evaluation report (#56)

Examples scored: **34**

## Headline (micro-averaged)

| Detector | Typed F1 (relaxed) | Typed P | Typed R | Detection R | Exact F1 | Clean contamination |
|---|---|---|---|---|---|---|
| regex-baseline | 90.0% | 91.3% | 88.7% | 93.0% | 71.4% | 10.0% (1 spans) |
| opf | 86.5% | 87.1% | 85.9% | 90.1% | 72.3% | 10.0% (1 spans) |
| regex ∪ opf | 80.0% | 68.7% | 95.8% | 98.6% | 72.9% | 20.0% (2 spans) |

> *Detection R* is label-agnostic recall — did the detector notice PII is present at all? This is the leak-prevention metric: a miss before a cloud call is a leak.

## Per-label recall (relaxed)

| Label | regex-baseline | opf | regex ∪ opf |
|---|---|---|---|
| private_person | 90.9% (n=22) | 86.4% (n=22) | 95.5% (n=22) |
| private_email | 100.0% (n=9) | 100.0% (n=9) | 100.0% (n=9) |
| private_phone | 100.0% (n=6) | 100.0% (n=6) | 100.0% (n=6) |
| private_address | 40.0% (n=5) | 100.0% (n=5) | 100.0% (n=5) |
| private_date | 92.9% (n=14) | 78.6% (n=14) | 100.0% (n=14) |
| private_url | 100.0% (n=4) | 100.0% (n=4) | 100.0% (n=4) |
| account_number | 66.7% (n=6) | 33.3% (n=6) | 66.7% (n=6) |
| secret | 100.0% (n=5) | 100.0% (n=5) | 100.0% (n=5) |

## Per-label precision (relaxed)

| Label | regex-baseline | opf | regex ∪ opf |
|---|---|---|---|
| private_person | 83.3% | 86.4% | 65.6% |
| private_email | 100.0% | 100.0% | 90.0% |
| private_phone | 85.7% | 75.0% | 54.5% |
| private_address | 100.0% | 62.5% | 50.0% |
| private_date | 100.0% | 100.0% | 100.0% |
| private_url | 80.0% | 80.0% | 44.4% |
| account_number | 100.0% | 100.0% | 80.0% |
| secret | 100.0% | 100.0% | 62.5% |

## Latency (OPF)

- Host: `huginmunin (Raspberry Pi 5, aarch64, 4-core Cortex-A76)`  device: `cpu`  model: `openai/privacy-filter (bf16; mkldnn disabled — A76 lacks bf16)`
- Cold start: 44000 ms

| Content size | bytes | p50 | p95 |
|---|---|---|---|
| small (1 record) | 154 | 47401 ms | 50624 ms |
| medium (~10 KB, n=1) | 10140 | 323586 ms | 323586 ms |

## Decision criteria (design doc §Decision criteria)

- OPF typed recall vs baseline: 85.9% vs 88.7% (**-2.8%**)
- OPF detection recall vs baseline: 90.1% vs 93.0% (**-2.8%**)
- OPF clean contamination: 10.0% (1 spurious spans)

Adopt integration #1 (`HUGIN_EXFIL_POLICY=opf`) iff: recall ≥ baseline + materially better on names/addresses, p95 latency on the chosen host < poll interval, clean contamination tolerable.
