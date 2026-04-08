# Ollama Performance Research Spike

**Date:** 2026-04-08
**Context:** Hugin eval tasks timing out on Pi; model selection issues with auto-routing

## Hardware

| | **Pi (huginmunin)** | **Laptop (M4 MacBook)** |
|--|--|--|
| CPU | ARM64, 4 cores | Apple M4, 10 cores |
| RAM | 7.9 GB | 32 GB |
| Storage | SD card (~40 MB/s) | NVMe SSD |
| GPU | None (CPU only) | Apple GPU (Metal) |
| Inference | CPU-only, FLASH_ATTENTION=1 | GPU-accelerated |

## Installed Models

| Model | Pi | Laptop | Size on disk | Quantization | Type |
|-------|-----|--------|-------------|--------------|------|
| qwen2.5:3b | Yes | Yes | 1.9 GB | Q4_K_M | Standard |
| qwen3.5:2b | Yes | No | 2.7 GB | Q8_0 | **Reasoning** (think tokens) |
| gemma4:e2b | Yes | Yes | 7.2 GB | Q4_K_M | Standard |
| qwen3.5:35b-a3b | No | Yes | 23.9 GB | Q4_K_M | Reasoning MoE |
| gemma4:26b | No | Yes | 18.0 GB | Q4_K_M | Standard |
| qwen3:14b | No | Yes | 9.3 GB | Q4_K_M | Standard |
| nemotron-3-super | No | Yes | 86.8 GB | Q4_K_M | Standard |
| qwen3-coder-next | No | Yes | 51.7 GB | Q4_K_M | Standard |
| gpt-oss:20b | No | Yes | 13.8 GB | MXFP4 | Standard |

## Benchmark Results

All benchmarks use a trivial prompt: "Reply with exactly: OK"

### Pi (ARM64, CPU-only)

| Model | Cold Start | Warm | Tokens | Notes |
|-------|-----------|------|--------|-------|
| **qwen2.5:3b** | **29s** (24.5s load) | **1.9s** | 2 | Best option for Pi |
| qwen3.5:2b (thinking ON) | 135s (38.6s load) | 90s | 270 | Generates ~268 think tokens before answering |
| qwen3.5:2b (think:false) | 42s (40.6s load) | ~2s (est) | 2 | Viable but requires chat API with `think:false` |
| gemma4:e2b | 120s (115.2s load) | 15.6s | 75 | Too large for SD card; verbose output |

### Laptop (Apple M4, GPU)

| Model | Cold Start | Warm | Tokens | Notes |
|-------|-----------|------|--------|-------|
| qwen2.5:3b | **2.3s** (2.0s load) | **0.7s** | 2-4 | 58.5 tok/s |

### Key Observations

1. **Cold start is dominated by SD card read speed.** Loading 1.9 GB (qwen2.5:3b) takes 24.5s from SD. Loading 7.2 GB (gemma4:e2b) takes 115s. NVMe on laptop loads the same model in 2s.

2. **qwen3.5:2b reasoning overhead is catastrophic on Pi.** The model generates ~270 internal "thinking" tokens for a trivial prompt. At Pi's ~3 tok/s CPU speed, this adds 90s to every request regardless of task complexity.

3. **`think:false` eliminates reasoning overhead.** qwen3.5:2b with `think:false` via the chat API produces 2 tokens in ~2s (warm), comparable to qwen2.5:3b. But Hugin's ollama executor currently uses the OpenAI-compatible API and doesn't pass this parameter.

4. **Model auto-unload timeout is 5 minutes** (default `OLLAMA_KEEP_ALIVE`). Since Hugin tasks are infrequent, the model is almost always cold. Every task pays the full load penalty.

5. **Pi can hold ~2 small models simultaneously** (~6 GB total). Loading a third evicts the least recently used.

6. **Laptop is 12-30x faster** on cold starts but unreliable for Hugin — only reachable when powered on and not sleeping.

7. **gemma4:e2b generates 75 tokens** for a 2-word answer even warm (15.6s). Excessively verbose for structured tasks.

## Configuration Changes Made

### Immediate fixes (deployed 2026-04-08)

1. **Reverted Pi default model to `qwen2.5:3b`** — the qwen3.5:2b upgrade (commit 81529e5) was a regression due to undiscovered reasoning overhead. Changed in `.env`, `src/index.ts`, `src/runtime-registry.ts`.

2. **Set `OLLAMA_KEEP_ALIVE=-1` on Pi** — models now stay loaded in RAM permanently, eliminating cold starts for the default model. Set in `/etc/systemd/system/ollama.service`.

3. **Auto-routed tasks use global default model** — previously, auto-routing to ollama-laptop would use its registry default (qwen3.5:35b-a3b, 23.9 GB). Now uses `OLLAMA_DEFAULT_MODEL` (qwen2.5:3b). Commit 8f4dbfe.

### Expected performance after fixes

| Scenario | Before | After |
|----------|--------|-------|
| Pi auto-routed task | 135s (qwen3.5:2b cold, thinking) | **~2s** (qwen2.5:3b warm, keep-alive) |
| Laptop auto-routed task | Timeout (qwen3.5:35b-a3b, 23.9 GB) | **~3s** (qwen2.5:3b warm) |

## Remaining Work

### Add `think:false` support to ollama executor

Hugin's ollama executor uses the OpenAI-compatible `/v1/chat/completions` API. To disable reasoning for qwen3.5 models, it needs to pass `think: false` (or the OpenAI-equivalent parameter) when the task doesn't require reasoning. This would make qwen3.5:2b viable on Pi for non-reasoning tasks.

### Pre-warm model on Hugin startup

Even with `OLLAMA_KEEP_ALIVE=-1`, the model gets evicted when ollama restarts (updates, crashes). Hugin could send a dummy request on startup to pre-warm the default model.

### Ollama health in heartbeat

Include loaded models and their memory footprint in Hugin's heartbeat emission. Currently the health endpoint shows host availability but not model state.

## Pi Memory Budget

| Component | RAM |
|-----------|-----|
| OS + services | ~1.5 GB |
| qwen2.5:3b (loaded) | ~2.1 GB |
| Buffer/cache | ~0.6 GB |
| **Available** | **~3.7 GB** |

With keep-alive, one model stays loaded permanently. Loading a second model (e.g., gemma4:e2b at 7.2 GB) would cause swap pressure. Tasks requiring larger models should route to the laptop.
