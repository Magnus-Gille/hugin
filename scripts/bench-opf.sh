#!/usr/bin/env bash
# bench-opf.sh — run the OpenAI Privacy Filter (OPF) on this host and emit the
# numbers the #56 decision needs: per-invocation latency across content sizes,
# a warm per-example rate, peak RSS, and predictions over the Grimnir fixtures
# for the offline scorer (scripts/run-pii-eval.ts).
#
# Designed to run on BOTH the Hugin-Munin Pi (ARM64) and the laptop — the Pi
# number is the pivotal one (see docs/design/openai-privacy-filter-eval.md).
#
# Prereqs: `opf` on PATH (pip install -e . from openai/privacy-filter; the model
# auto-downloads to ~/.opf on first run), python3 (for timing + JSON assembly).
#
# Usage:
#   ./scripts/bench-opf.sh [--device cpu] [--reps 5] \
#       [--fixtures eval/privacy-filter/fixtures/grimnir-pii.jsonl] \
#       [--out eval/privacy-filter/results]
#
# Outputs (under --out, default eval/privacy-filter/results/<host>):
#   bench-<host>.json          latency/RSS, shaped for run-pii-eval.ts --timings
#   predictions-<host>.jsonl   OPF predictions over the fixtures (for --opf)

set -euo pipefail

DEVICE="cpu"
REPS=5
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$REPO_ROOT/eval/privacy-filter/fixtures/grimnir-pii.jsonl"
OUT_BASE="$REPO_ROOT/eval/privacy-filter/results"
OPF_BIN="opf"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)   DEVICE="$2"; shift 2 ;;
    --reps)     REPS="$2"; shift 2 ;;
    --fixtures) FIXTURES="$2"; shift 2 ;;
    --out)      OUT_BASE="$2"; shift 2 ;;
    --opf-bin)  OPF_BIN="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

HOST="$(hostname -s 2>/dev/null || hostname)"
OUT_DIR="$OUT_BASE/$HOST"
mkdir -p "$OUT_DIR"

if ! command -v "$OPF_BIN" >/dev/null 2>&1; then
  echo "ERROR: '$OPF_BIN' not found on PATH." >&2
  echo "Install: git clone https://github.com/openai/privacy-filter && (cd privacy-filter && pip install -e .)" >&2
  echo "The model auto-downloads to ~/.opf on first run. Re-run this script after install." >&2
  exit 1
fi

if [[ ! -f "$FIXTURES" ]]; then
  echo "ERROR: fixtures not found: $FIXTURES" >&2
  echo "Generate them first: npm run build:pii-fixtures" >&2
  exit 1
fi

echo "Host: $HOST | device: $DEVICE | reps: $REPS"
echo "OPF: $(command -v "$OPF_BIN")"

# --- Build content-size buckets from the fixtures (plain text for `opf -f`) ---
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Extract just the `text` fields from the fixtures into a corpus.
python3 - "$FIXTURES" > "$WORK/corpus.txt" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    for line in f:
        line = line.strip()
        if line:
            print(json.loads(line)["text"])
PY

# small ≈ one record; medium ≈ ~10 KB; large ≈ ~50 KB (repeat corpus to size).
head -n 1 "$WORK/corpus.txt" > "$WORK/small.txt"
python3 - "$WORK/corpus.txt" "$WORK/medium.txt" 10000 <<'PY'
import sys
src, dst, target = sys.argv[1], sys.argv[2], int(sys.argv[3])
body = open(src).read()
out = ""
while len(out) < target:
    out += body
open(dst, "w").write(out[:target])
PY
python3 - "$WORK/corpus.txt" "$WORK/large.txt" 50000 <<'PY'
import sys
src, dst, target = sys.argv[1], sys.argv[2], int(sys.argv[3])
body = open(src).read()
out = ""
while len(out) < target:
    out += body
open(dst, "w").write(out[:target])
PY

# --- Timed runner: one OPF invocation, prints "<ms> <child_rss_kb>" ---
timed_run() {
  local infile="$1"
  python3 - "$OPF_BIN" "$DEVICE" "$infile" <<'PY'
import resource, subprocess, sys, time
opf, device, infile = sys.argv[1], sys.argv[2], sys.argv[3]
t0 = time.perf_counter()
subprocess.run([opf, "-f", infile, "--device", device],
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
ms = (time.perf_counter() - t0) * 1000.0
# ru_maxrss: bytes on macOS, KB on Linux. Normalize to KB.
raw = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
rss_kb = raw / 1024 if sys.platform == "darwin" else raw
print(f"{ms:.1f} {rss_kb:.0f}")
PY
}

declare -a BUCKET_NAMES=("small" "medium" "large")
declare -a BUCKET_FILES=("$WORK/small.txt" "$WORK/medium.txt" "$WORK/large.txt")
SAMPLES="$WORK/samples.tsv"   # columns: bucket  bytes  ms  rss_kb
: > "$SAMPLES"

echo "Warming up (first invocation downloads/loads the model)…"
timed_run "$WORK/small.txt" >/dev/null || true

for i in "${!BUCKET_NAMES[@]}"; do
  name="${BUCKET_NAMES[$i]}"
  file="${BUCKET_FILES[$i]}"
  bytes="$(wc -c < "$file" | tr -d ' ')"
  echo "Bucket '$name' (${bytes} bytes), $REPS reps…"
  for ((r = 1; r <= REPS; r++)); do
    read -r ms rss <<< "$(timed_run "$file")"
    printf '%s\t%s\t%s\t%s\n' "$name" "$bytes" "$ms" "$rss" >> "$SAMPLES"
    printf '  rep %d: %s ms\n' "$r" "$ms"
  done
done

# --- Warm per-example rate via `opf eval` over the full fixture set ---
PRED_OUT="$OUT_DIR/predictions-$HOST.jsonl"
echo "Running 'opf eval' over fixtures → $PRED_OUT"
EVAL_START="$(python3 -c 'import time; print(time.perf_counter())')"
if ! "$OPF_BIN" eval "$FIXTURES" --predictions-out "$PRED_OUT" --device "$DEVICE" \
      >/dev/null 2>"$WORK/eval.err"; then
  echo "WARNING: 'opf eval' failed (see below); predictions may be absent." >&2
  sed 's/^/  /' "$WORK/eval.err" >&2 || true
fi
EVAL_END="$(python3 -c 'import time; print(time.perf_counter())')"
N_EXAMPLES="$(grep -c . "$FIXTURES" || echo 0)"

# --- Assemble bench.json shaped for run-pii-eval.ts --timings ---
BENCH_OUT="$OUT_DIR/bench-$HOST.json"
python3 - "$SAMPLES" "$HOST" "$DEVICE" "$EVAL_START" "$EVAL_END" "$N_EXAMPLES" > "$BENCH_OUT" <<'PY'
import json, statistics, sys
samples_path, host, device, ev_start, ev_end, n = sys.argv[1:7]
by_bucket = {}
max_rss_kb = 0.0
with open(samples_path) as f:
    for line in f:
        bucket, b, ms, rss = line.rstrip("\n").split("\t")
        by_bucket.setdefault(bucket, {"bytes": int(b), "ms": []})
        by_bucket[bucket]["ms"].append(float(ms))
        max_rss_kb = max(max_rss_kb, float(rss))

def pctl(xs, q):
    xs = sorted(xs)
    if not xs:
        return 0.0
    k = (len(xs) - 1) * q
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)

order = ["small", "medium", "large"]
buckets = []
for name in order:
    if name not in by_bucket:
        continue
    d = by_bucket[name]
    buckets.append({
        "label": name,
        "bytes": d["bytes"],
        "p50Ms": round(pctl(d["ms"], 0.5), 1),
        "p95Ms": round(pctl(d["ms"], 0.95), 1),
    })

n = int(n)
eval_total_ms = (float(ev_end) - float(ev_start)) * 1000.0
out = {
    "host": host,
    "device": device,
    "model": "openai/privacy-filter",
    "buckets": buckets,
    "rssMb": round(max_rss_kb / 1024, 1),
    "warmPerExampleMs": round(eval_total_ms / n, 1) if n else None,
    "evalTotalMs": round(eval_total_ms, 1),
    "evalExamples": n,
}
print(json.dumps(out, indent=2))
PY

echo ""
echo "Wrote $BENCH_OUT"
echo "Wrote $PRED_OUT"
echo ""
echo "Next: from the laptop, score it —"
echo "  tsx scripts/run-pii-eval.ts --opf $PRED_OUT --timings $BENCH_OUT \\"
echo "    --md eval/privacy-filter/results/report-$HOST.md --json eval/privacy-filter/results/report-$HOST.json"
