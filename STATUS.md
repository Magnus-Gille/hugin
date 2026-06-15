# Hugin — Status

**Last session:** 2026-06-15 (session 3 — merged the 4-PR sweep)
**Branch:** main (clean at `3ddf550`; 0 PRs open)

## Session 3 (2026-06-15) — all 4 sweep PRs reviewed & merged

Reviewed and merged the four PRs left open by the 2026-06-01 autonomous sweep. Both code PRs were independently reviewed (MERGE verdicts, fail-closed property on #102 verified at 5 layers). All CI green; #102 re-ran green against the post-#100 main before merge.

| PR | Track | Merged as |
|---|---|---|
| [#100](https://github.com/Magnus-Gille/hugin/pull/100) | Wire Orin host (#97) | `fa71a55` — `orin` host + `OLLAMA_ORIN_URL` end-to-end (hosts, registry `ollama-orin`, pipeline-ir, egress, index, CLAUDE.md). |
| [#99](https://github.com/Magnus-Gille/hugin/pull/99) | Tailscale ACL audit | `583e9c0` — `docs/security/tailscale-orin-acl-audit.md`; issue [#98](https://github.com/Magnus-Gille/hugin/issues/98) remains open (remediation is admin-console work). |
| [#101](https://github.com/Magnus-Gille/hugin/pull/101) | OPF on Orin (#56/#97) | `67fa7b7` — blocker doc; Orin bf16-native confirmed (no mkldnn workaround). Run still needs manual SSH finish. |
| [#102](https://github.com/Magnus-Gille/hugin/pull/102) | #84 slice-one | `3ddf550` — frontmatter procedure + 4 artifacts + `consultSkillLane` behind `HUGIN_SKILL_LANE` (default off, **fail-closed**). |

## ⏭️ Remaining — needs Magnus / hardware access (NOT code-completable)

1. **Deploy Orin** — install ollama on Orin, pull `qwen2.5-coder:7b`, set `OLLAMA_ORIN_URL=http://100.127.176.78:11434` in Pi `.env`, restart hugin, smoke-test `Ollama-host: orin`. (Also: redeploy Hugin to the Pi to pick up the merged Orin wiring.)
2. **Remediate #98** in Tailscale admin console — SSH `check` action, tags, scoped src excluding Pi; passphrase/HW-back the laptop `~/.ssh/id_ed25519`.
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
