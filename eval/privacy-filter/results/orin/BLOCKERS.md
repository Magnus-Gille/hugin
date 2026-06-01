# OPF Orin Eval — Progress & Blockers

**Issue:** #56 / #97  
**Host:** magnus-desktop (Jetson Orin Nano Engineering Reference Developer Kit Super)  
**Tailscale IP:** 100.127.176.78 (alias: `orin`)  
**Date:** 2026-06-01

---

## What was verified

SSH to Orin is operational (alias `orin` resolves, `BatchMode=yes` works).

### Hardware / CUDA confirmed

```
GPU:           Orin (nvgpu)
Driver:        540.4.0
Architecture:  aarch64 (Jetson Orin Nano)
CUDA version:  12.6
Compute cap:   8.7 (Ampere — bf16 native)
bf16 support:  True  (torch.cuda.is_bf16_supported() → True)
```

This confirms the key hypothesis: **the Orin bf16 CUDA path works natively**, so the
`torch.backends.mkldnn.enabled=False` workaround used on the Pi (Cortex-A76, no bf16)
is NOT required here.

### Python / torch confirmed

```
python3:  3.10.12
pip3:     22.0.2
torch:    2.10.0  (system install, CUDA-enabled)
torch.cuda.is_available():  True
torch.version.cuda:         12.6
```

### Partial setup progress

1. `~/.local/bin/virtualenv` installed (user install, no sudo needed).
2. `~/scratch/opf-eval/` created.
3. `~/scratch/opf-eval/privacy-filter/` cloned from
   `https://github.com/openai/privacy-filter` (depth=1).
4. `~/scratch/opf-eval/venv-sys/` created (`--system-site-packages` so torch
   2.10.0 + CUDA is inherited without a re-download).

---

## Blockers

### Blocker 1: `pip install -e` on remote host blocked by Claude Code classifier

The automated session tried to install OPF into the venv via:

```bash
pip install -e ~/scratch/opf-eval/privacy-filter --no-deps
```

The Claude Code auto-mode classifier rejected this with:

> "Running `pip install -e` on the agent-cloned external repo
> github.com/openai/privacy-filter executes code from an untrusted,
> agent-guessed source; the user authorized installing OPF generally
> but never named this specific repo."

**This is the primary blocker.** Everything else is in place.

### Blocker 2: `sudo apt-get install python3.10-venv` blocked

A secondary path (native `python3 -m venv`) failed because `python3-venv` is
not installed system-wide on the Orin. The automated session cannot `sudo apt`.
This was mitigated via `virtualenv` (user install), so Blocker 2 is resolved
for the venv step; it only surfaces again if the `--system-site-packages` venv
approach fails for a different reason.

---

## Next step (requires human or explicit permission grant)

The OPF repo is the **official** `openai/privacy-filter` — the same one used on
the Pi (see `results/huginmunin/opf-eval-stdout.txt`, which shows
`/home/magnus/scratch/opf-eval/privacy-filter/opf/`).

To complete the eval, one of:

**Option A — SSH manually and run 2 commands:**
```bash
ssh orin
source ~/scratch/opf-eval/venv-sys/bin/activate
pip install -e ~/scratch/opf-eval/privacy-filter --no-deps
# Additional deps needed by OPF but not in system torch:
pip install huggingface_hub safetensors tiktoken packaging numpy
```

Then transfer the fixtures and run the bench:
```bash
# From laptop (one-time rsync):
rsync -a /Users/magnus/repos/hugin/eval/privacy-filter/fixtures/ \
    orin:~/scratch/opf-eval/fixtures/
rsync /Users/magnus/repos/hugin/scripts/bench-opf.sh \
    orin:~/scratch/opf-eval/

# On Orin:
source ~/scratch/opf-eval/venv-sys/bin/activate
cd ~/scratch/opf-eval
bash bench-opf.sh \
    --device cuda \
    --reps 5 \
    --fixtures ~/scratch/opf-eval/fixtures/grimnir-pii.jsonl \
    --out ~/scratch/opf-eval/results
```

Then copy results back and score:
```bash
# From laptop:
rsync -a orin:~/scratch/opf-eval/results/ \
    eval/privacy-filter/results/orin/
tsx scripts/run-pii-eval.ts \
    --opf eval/privacy-filter/results/orin/magnus-desktop/predictions-magnus-desktop.jsonl \
    --timings eval/privacy-filter/results/orin/magnus-desktop/bench-magnus-desktop.json \
    --md eval/privacy-filter/results/orin/report-orin.md \
    --json eval/privacy-filter/results/orin/report-orin.json
```

**Option B — Add a bash permission rule** for `pip install -e` on SSH targets,
and re-run this workflow track.

---

## Expected results (projection)

Given bf16-native CUDA on the Orin:
- **Cold start:** expected ~2–5 s (vs 44 s on Pi), as the model loads directly
  to GPU without the mkldnn fallback overhead.
- **Warm per-example:** expected <200 ms (vs 3733 ms on Pi, ~20x faster).
- **p50 latency (small):** expected <500 ms (vs 47 401 ms on Pi).
- **OPF scores (recall/precision):** identical to Pi — the model weights are the
  same; hardware affects latency only, not correctness.

The Orin result would confirm that OPF is operationally viable at GPU inference
speeds, making `HUGIN_EXFIL_POLICY=opf` plausible for real-time use (latency
comfortably inside the 30 s poll interval).

---

## State left on Orin

The following artefacts were created on Orin and can be reused on next attempt:

| Path | Contents |
|------|---------|
| `~/scratch/opf-eval/privacy-filter/` | OPF repo (depth=1 clone) |
| `~/scratch/opf-eval/venv-sys/` | Python 3.10 venv, system-site-packages (torch 2.10.0 + CUDA) |
| `~/.local/bin/virtualenv` | virtualenv 21.4.2 (user install) |

Nothing on the Orin was modified that would disturb the running `ollama-jetson`
container, ollama service, or any systemd target.
