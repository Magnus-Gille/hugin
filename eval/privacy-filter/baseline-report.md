# OPF PII evaluation report (#56)

Examples scored: **34**

## Headline (micro-averaged)

| Detector | Typed F1 (relaxed) | Typed P | Typed R | Detection R | Exact F1 | Clean contamination |
|---|---|---|---|---|---|---|
| regex-baseline | 90.0% | 91.3% | 88.7% | 93.0% | 71.4% | 10.0% (1 spans) |

> *Detection R* is label-agnostic recall — did the detector notice PII is present at all? This is the leak-prevention metric: a miss before a cloud call is a leak.

## Per-label recall (relaxed)

| Label | regex-baseline |
|---|---|
| private_person | 90.9% (n=22) |
| private_email | 100.0% (n=9) |
| private_phone | 100.0% (n=6) |
| private_address | 40.0% (n=5) |
| private_date | 92.9% (n=14) |
| private_url | 100.0% (n=4) |
| account_number | 66.7% (n=6) |
| secret | 100.0% (n=5) |

## Per-label precision (relaxed)

| Label | regex-baseline |
|---|---|
| private_person | 83.3% |
| private_email | 100.0% |
| private_phone | 85.7% |
| private_address | 100.0% |
| private_date | 100.0% |
| private_url | 80.0% |
| account_number | 100.0% |
| secret | 100.0% |

## Latency (OPF)

_No timings supplied. Run `scripts/bench-opf.sh` on the Pi and the laptop, then pass `--timings <bench.json>`._

## Decision criteria (design doc §Decision criteria)

_OPF predictions not supplied — only the regex baseline was scored. Generate predictions with `scripts/bench-opf.sh` and re-run with `--opf`._
