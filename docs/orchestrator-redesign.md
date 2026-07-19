# Hugin Orchestrator Re-platforming — Design / ADR

**Status:** Accepted (2026-06-16) · **Branch:** `feat/orchestrator-workflows` (worktree)

## Context

Hugin began as a task dispatcher for "research spikes" (backwards-engineered deep
research). Two things changed the goal:

1. Claude Code's **ultracode / Workflows** proved to be a powerful way to "just get
   things done" via multi-agent fanout — we want that *capability* in Hugin.
2. New local compute is arriving (BosGame **Strix Halo 128 GB**, alongside the Jetson
   Orin Nano and the Pi), and we want to make liberal, price-driven use of it plus
   cheap cloud open-weight models.

Crucially, we are **dropping Claude Code (the harness) entirely** — on the Pi and on
BosGame. The harness and the model become interchangeable commodities chosen on
**price / availability**, not vendor. Vendor lock-in is the thing we are designing out.

## Decisions

### D1 — Hugin owns orchestration (not a harness)

ultracode/Workflows are Claude-Code-specific and do not survive the harness swap. A
2026 survey of OSS harnesses (OpenCode, Goose, Aider, OpenHands, Cline, Crush, **pi**)
found none does externally-driveable multi-agent fanout well enough to lean on. pi
(pi.dev) states the contract we want explicitly: *"No sub-agents… orchestration is the
caller's job."*

→ The orchestration brain (fanout · verify · synthesize) lives **in Hugin**, extending
the existing `pipeline-*.ts` engine. Harnesses/models are pluggable **worker units**.

### D2 — pi (pi.dev) is the primary worker harness

`earendil-works/pi`: MIT, native ARM64 binaries, model-agnostic (`~/.pi/agent/models.json`
custom OpenAI-compatible providers), headless via `pi -p`, `--mode json` event stream,
and an RPC protocol over stdin/stdout (`docs/rpc.md`). MCP is *not* bundled (opt-in
extension) — fine, since Hugin owns orchestration. Goose is the upgrade path if a single
task ever needs internal decomposition.

### D3 — Vendor-neutral model roster, price-first

| Tier | Use | Models (initial) |
|------|-----|------------------|
| 1 — cheap heavy worker | bulk reason/summarize/classify/codegen | OpenRouter `:floor` → DeepSeek V4 Flash ($0.09/$0.18), Llama 4 Scout |
| 2 — mid | agentic / complex reasoning | DeepSeek V4 Pro, Qwen3.7 Plus |
| 3 — quality / orchestrator | planning, synthesis, verify | Claude (for now); ledger decides when an open model (e.g. Kimi K2.6) can take it |
| Sovereignty lane | `Sensitivity: private/internal` | Berget.ai (EU/Sweden, NIS2, no US jurisdiction) or local |

Blended cost vs all-Claude: **~15–25× cheaper**. Berget is ~10–40% pricier than
OpenRouter's floor — used as a sovereignty lane, not the default.

### D4 — Local seam = homeserver gateway `/delegate` + ledger (ADR-004, home-server-inference-evaluation)

Local inference (Strix/Orin) routes through the homeserver gateway's owner-key
`POST /delegate`, which verifies output, writes a ledger row, and can auto-escalate to a
frontier model. Hugin reads `GET /ledger` for the local lane's capability signal.

### D5 — Cross-provider quality learning: two stores for now (option b)

The homeserver `/ledger` has no external write path and is local-inference-focused.
Hugin keeps its **own cloud-worker verdict store** and reads `/ledger` only for the local
lane. Converge to a single KB later.

### D6 — Adaptive quality gate

Per (model × task-type), the verdict store/ledger drives confidence. Low confidence →
escalate to a stronger tier (or Claude verify); high confidence → trust. This is what
makes the price savings safe.

### D7 — Host split

- **Pi (hugin-node):** always-on control plane (poll/claim/heartbeat/CAS) + Munin memory.
  Keep it — Munin must be always-available; the dispatcher loop wants a stable base.
- **BosGame / M5:** heavy fanout execution host + local inference, on demand. Workflow
  fanout caps at `min(16, cores−2)` → Pi ≈ 2, Strix ≈ 14. Orchestrator **execution host
  is configurable** so big runs go to BosGame while control stays on the Pi.

## Build sequencing (multi-PR)

Cloud lanes need **no new hardware** and are testable today — they directly deliver
"Hugin chugs along on offline tasks with cheap models." Local/BosGame layer in as
hardware lands.

- **PR 1 (cloud lane):** ← *current*
  1. Vendor-neutral worker substrate — `pi-harness`, `berget`, generalized `direct-model`
     providers in the registry; sensitivity/price gates in the router.
  2. pi-harness executor — spawn `pi --mode json`, capture structured result.
  3. Native orchestration engine — extend `pipeline-*.ts` into the ultracode-equivalent
     (fanout · verify · synthesize) over worker executors.
- **PR 2:** adaptive quality + cloud-worker verdict store; wire `/ledger` for local lane.
- **PR 3:** savings tracker (price model × token volume vs all-Claude baseline → Munin).
- **PR 4:** host split (Pi control / BosGame execution), as BosGame arrives.

## Non-goals (this re-platforming)

- Running the orchestrator brain itself on an open model (deferred until the ledger
  shows an open model can orchestrate acceptably).
- Touching the home-server-inference-evaluation repo (single-ledger convergence is later).
