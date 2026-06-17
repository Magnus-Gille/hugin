# Hugin — Status

**Last session:** 2026-06-17 (session 5 — orchestrator re-platforming shipped + live-validated + merged)
**Branch:** main (clean at the PR #108 merge; 0 PRs open)

## Session 5 (2026-06-17) — Vendor-neutral orchestrator shipped (PR #108)

A "big rethink": turn Hugin from a Claude-Code-centric dispatcher into a **vendor-neutral orchestrator** that owns ultracode/Workflow-style fan-out itself, using a roster of cheap cloud + local models picked by price, with **no Claude Code / harness lock-in**. Full design: `docs/orchestrator-redesign.md`.

- **Decisions (research-backed):** Hugin OWNS orchestration (no OSS harness does externally-driveable fan-out well; pi.dev punts orchestration to the caller). pi.dev = future worker harness. Roster: OpenRouter (DeepSeek Flash etc.) + Berget.ai (EU-sovereign lane) + local via the ADR-004 homeserver gateway. Blended ~15–25× cheaper than all-Claude.
- **Built `Runtime: orchestrator`** (`src/orchestrator/*`): plan → concurrent cheap-worker fan-out → optional verify → synthesize, all roles vendor-neutral `provider+model` bindings via one injected `ModelInvoker`. Plus `model-pricing.ts`, a price-aware router tiebreaker, configurable active subscriptions (`HUGIN_ACTIVE_SUBSCRIPTIONS`), `ollama-pi` demoted to explicit-only, and a fail-closed sensitivity guard (private ⇒ sovereign/local only, zero spend otherwise).
- **Live-validated** end-to-end against OpenRouter (`deepseek-v4-flash`) + Berget (`Llama-3.1-8B`) + Google (`gemini-flash`): real fan-out → coherent synthesis, real `totalCostUsd`. Caught + fixed real bugs (pi v3 JSONL parser, Berget `max_tokens` OOM).
- **Codex-reviewed** (gpt-5.5 xhigh, no critical findings): fixed 6 findings pre-merge; filed 3 follow-ups → issues **#110** (AbortSignal threading), **#111** (private+Berget lane), **#112** (configurable max_tokens + finish_reason).
- **Merged PR [#108](https://github.com/Magnus-Gille/hugin/pull/108)** (full suite 1120 green, CI passed). Also synced **PR #107** (`homeserver-executor.ts`, the M5 gateway dual-path executor) which had landed on main meanwhile.
- **M5 (BosGame Strix Halo 128GB) arrived 2026-06-17** — being provisioned by another agent. Unblocks the local `/delegate` lane, private-capable local workers, PR4 host split, and PR2's real ledger.
- **Worktree retained:** `/Users/magnus/repos/hugin-orchestrator` (branch `feat/orchestrator-workflows`, merged) holds a gitignored `.env` with OpenRouter + Berget keys for live testing — reuse for PR2.

**Next:** when the M5 gateway is reachable (Tailscale), wire a `homeserver` worker provider (uses `homeserver-executor.ts`, `HOMESERVER_GATEWAY_URL`). Then PR2 (learning/verdict layer) → PR3 (savings tracker) → PR4 (Pi control / M5 execution host split). **Redeploy main to the Pi** — it still runs pre-orchestrator code.

## Session 4 (2026-06-15) — Orin Nano GPU cell LIVE in Hugin

End-to-end: recovered the Orin, benchmarked it, fixed a config bug, deployed to the Pi, smoke-tested, and demoed a draft→review pipeline.

- **Recovered the cell.** Host ollama 0.24.0 had auto-started after a reboot and was squatting `:11434`, crash-looping the dustynv GPU container. Stopped host ollama → container healthy. Later **`sudo systemctl disable ollama`** on the Orin (Magnus) so it never recurs.
- **Hardware-verified model envelope.** The 8 GB Orin is a hard **~3B cell**: `qwen2.5-coder:7b` AND `qwen3:4b` both **OOM** (contiguous CUDA buffer alloc fails). `qwen2.5-coder:3b` fits at **18 tok/s, 100% GPU**. 7B/8B coders need the BosGame/Mac-Studio tier.
- **PR [#104](https://github.com/Magnus-Gille/hugin/pull/104) merged** (`db86e14`) — `ollama-orin` registry default `7b → 3b` (7b would 500 every defaulted task).
- **GPU-memory wedge recovered without a reboot** — the big test pulls flooded page cache and broke even the 3b; deleting the oversized models freed it (drop_caches/reboot are password-gated, not in the Jetson NOPASSWD grant — friction logged).
- **Deployed merged `main` to the Pi** via `deploy-pi.sh` (Pi was 5 commits behind on old code); added `OLLAMA_ORIN_URL` to Pi `.env`. Pre-deploy backup on Pi branch `pi-predeploy-20260615` (snapshot `5aa104b`).
- **Smoke test:** task pinned `Ollama-host: orin` → `effectiveHost: orin`, exit 0, 5 s, no fallback. ✅
- **Capability test (LRUCache, medium):** bare 3B passed the happy path but failed update-marks-MRU + crashed (KeyError) + missed O(1). Classic small-model profile.
- **Pipeline demo (the fix):** `ollama-orin` draft → `claude-sdk` review (read draft from Munin, ~8¢) → corrected code passed all in-spec tests. Proves the cheap-local-draft + cloud-review pattern (the #84 skill-lane concept) works on real hardware.
- **Architecture note:** Pi (`huginmunin`) runs Hugin+Munin and orchestrates; Orin (`magnus-desktop`/`100.127.176.78`) is the GPU workhorse Hugin calls over HTTP.

## Session 3 (2026-06-15) — all 4 sweep PRs reviewed & merged

Reviewed and merged the four PRs left open by the 2026-06-01 autonomous sweep. Both code PRs were independently reviewed (MERGE verdicts, fail-closed property on #102 verified at 5 layers). All CI green; #102 re-ran green against the post-#100 main before merge.

| PR | Track | Merged as |
|---|---|---|
| [#100](https://github.com/Magnus-Gille/hugin/pull/100) | Wire Orin host (#97) | `fa71a55` — `orin` host + `OLLAMA_ORIN_URL` end-to-end (hosts, registry `ollama-orin`, pipeline-ir, egress, index, CLAUDE.md). |
| [#99](https://github.com/Magnus-Gille/hugin/pull/99) | Tailscale ACL audit | `583e9c0` — `docs/security/tailscale-orin-acl-audit.md`; issue [#98](https://github.com/Magnus-Gille/hugin/issues/98) remains open (remediation is admin-console work). |
| [#101](https://github.com/Magnus-Gille/hugin/pull/101) | OPF on Orin (#56/#97) | `67fa7b7` — blocker doc; Orin bf16-native confirmed (no mkldnn workaround). Run still needs manual SSH finish. |
| [#102](https://github.com/Magnus-Gille/hugin/pull/102) | #84 slice-one | `3ddf550` — frontmatter procedure + 4 artifacts + `consultSkillLane` behind `HUGIN_SKILL_LANE` (default off, **fail-closed**). |

## ⏭️ Remaining — needs Magnus / hardware access (NOT code-completable)

1. ✅ **DONE (session 4): Deploy Orin** — live, smoke-tested, registry default fixed (#104), host ollama disabled. Orin is a 3B cell (`qwen2.5-coder:3b`).
2. **Remediate #98** in Tailscale admin console — SSH `check` action is now active (it gated this session's Pi access — good); finish the rest (tags, scoped src excluding Pi; passphrase/HW-back the laptop `~/.ssh/id_ed25519`).
   - Optional: add `vm.drop_caches` (+ scoped reboot) to the Orin `magnus-jetson-ops` NOPASSWD grant so a wedged Jetson GPU can self-heal unattended.
   - Cleanup: delete Pi backup branch `pi-predeploy-20260615` once confident the deploy is solid.
3. **Finish #101 OPF run** — SSH Orin manually, run the 4 followup commands (`pip install -e ... --no-deps`, rsync fixtures, `bench-opf.sh --device cuda`, rsync back + `run-pii-eval.ts`), commit results under `eval/privacy-filter/results/orin/`.
4. **#84 go-live** — do **NOT** flip `HUGIN_SKILL_LANE=on` until a real active RouteBinding + live cell + local executor exist (6 go-live steps in PR #102 body; lane is a no-op today).
5. **Remove `magnus-docker-debug`** sudoers grant once Orin setup is stable: `sudo rm /etc/sudoers.d/magnus-docker-debug`.

## Completed This Session (2026-06-01)

### PR #96 merged — #56 closed
- Reviewed and squash-merged `feat/56-opf-pii-eval-harness` → main (commit `132a7c5`).
- Closed issue #56 with verdict summary: regex baseline stays inline; OPF reserved for faster-host async path.

### #97 filed — Orin Nano inference cell
- Researched best-fit models for 8 GB Orin Nano (Qwen3-Coder-30B-A3B **does not fit** — all 30B params resident; Qwen2.5-Coder-7B is the ceiling, 3B in practice with desktop running).
- Created [issue #97](https://github.com/Magnus-Gille/hugin/issues/97) and added to Grimnir Roadmap board.

### Orin Nano GPU inference cell — fully operational
End-to-end setup on `magnus-desktop` / `100.127.176.78` (Tailscale):

**Hardware confirmed:** Jetson Orin Nano Super 8 GB, L4T R36.4.7, CUDA 12.6 / compute 8.7 (Ampere, bf16-native).

**ollama via dustynv/ollama:0.6.8-r36.4-cu126-22.04:**
- Host ollama 0.24.0 segfaults on GPU (JetPack6 CUDA runner bug); dustynv image fixes it.
- Container `ollama-jetson` running: `docker run -d --runtime nvidia --network host --restart unless-stopped -e OLLAMA_HOST=0.0.0.0:11434 -e OLLAMA_MODELS=/data/models/ollama/models -v ollama_jetson:/data ... ollama serve`
- `qwen2.5-coder:3b` (1.9 GB) pulled and persisted to `ollama_jetson` volume.

**Key finding — headless required:**
- With desktop running: NvMap ENOMEM on contiguous 1.8 GB cudaMalloc despite 6 GB free (fragmentation). Max 22/37 layers offloaded → 8.3 tok/s (= CPU, no gain).
- `systemctl isolate multi-user.target` → full 37/37 layer GPU offload → **18.1 tok/s gen, 163 tok/s prompt eval** (~2× Pi).
- Made permanent: `set-default multi-user.target` committed on Orin.

**Benchmark (qwen2.5-coder:3b, num_ctx 4096):**
| Config | gen tok/s | prompt tok/s |
|---|---|---|
| Pi (CPU, #56 reference) | 8.8 | slow |
| Orin partial GPU (desktop up) | 8.3 | — |
| **Orin full GPU (headless)** | **18.1** | **163** |

**Sudo/auth model on Orin** (documented in `decisions/orin-ssh-auth` in Munin):
- SSH login: YubiKey FIDO2 (primary + backup) or password; `ssh orin` alias on Mac.
- Scoped NOPASSWD grants: `magnus-jetson-ops` (jetson_clocks, nvpmodel, systemctl ollama) + `magnus-docker-debug` (docker ps/logs/inspect/restart/stop/rm on ollama-jetson only).
- `docker run/exec`, `sudo bash` etc. remain password-gated.
- Tailscale (`magnus@100.127.176.78`) bypasses the YubiKey (no FIDO2 on Tailscale SSH) — Tailscale ACL policy should be audited separately.

## Open Issues (post-sweep)
- **#84** skill-distillation go-live capstone — slice-one authored in **PR #102** (fail-closed); go-live infra steps remain (cell + active binding + executor).
- **#97** Orin Nano cell — host wiring in **PR #100**; OPF benchmark in **PR #101** (partial); deploy + `magnus-docker-debug` teardown still pending.
- **#98** (new) Orin SSH YubiKey bypass — remediation is admin-console/host work (see PR #99 doc).

## Next Steps
1. **Wire Orin into Hugin** — add `orin` host to `src/ollama-hosts.ts`, add `OLLAMA_ORIN_URL` env to CLAUDE.md env table + deploy to Pi. TDD change + PR.
2. **OPF on Orin GPU** — install OPF in venv (CUDA path, no mkldnn workaround), re-run `bench-opf.sh` + `run-pii-eval.ts`, commit results under `eval/privacy-filter/results/orin/`.
3. **#84 slice-one authoring** — cell-agnostic, fully unblocked. Pick deterministic procedure (TS import normalization or markdown frontmatter), author procedure package + TaskClassifier + eval suite + grader.
4. **Tailscale SSH ACL audit** — Tailscale to Orin bypasses YubiKey; confirm ACL policy is intentional.
5. **Remove `magnus-docker-debug`** once Orin inference setup is stable: `sudo rm /etc/sudoers.d/magnus-docker-debug`.

## Key state
- `main` is clean at `132a7c5`
- Orin (`magnus-desktop`, `100.127.176.78`): headless, ollama-jetson container up, qwen2.5-coder:3b on GPU, 18.1 tok/s
- Pi (`huginmunin.local`): Hugin @ main, worker_id `hugin-huginmunin`, scratch clean
- `src/skill/` system on main (fail-closed); `HUGIN_SKILL_LANE=off` until #84 go-live
- OPF findings: `docs/security/privacy-filter-evaluation.md`; Pi artifacts: `eval/privacy-filter/results/huginmunin/`
- munin-memory MCP: known session-local tool-registration race (friction logged); workaround: `/mcp` → Reconnect
