# Hugin — Status

**Last session:** 2026-07-08 (Codex) — OpenCode harness adapter merged
**Branch:** main at `8d3423e`; production deploy/validation still pending on huginmunin.

## Latest — OpenCode harness adapter spike (2026-07-08)

PR #155 merged to `main` as `8d3423e`. It added an explicit `Runtime: opencode` lane for the
Grimnir agent-harness decoupling track. The lane
uses a temporary OpenCode config pointed at the M5/OpenAI-compatible gateway, runs
`opencode run --format json`, captures normalized tool/test/diff events, and removes the temp config
directory after execution.

- **Runtime shape:** registry entry `opencode-m5`, explicit-only (`autoEligible:false`), harness
  family, local egress, capped at `internal` sensitivity for now.
- **Permissions:** `read-only` maps to OpenCode `plan` with `edit`/`bash` denied; `Capabilities:
  code` + `Permission profile: trusted-code` maps to `build` with `edit`/`bash` allowed.
- **Config:** defaults to `HOMESERVER_GATEWAY_URL` + `HOMESERVER_GATEWAY_API_KEY`, with
  `HUGIN_OPENCODE_*` overrides for base URL, key, provider id, default model, and executable path.
- **Tests:** focused executor tests use a fake `opencode` binary to prove temp config/env/cleanup and
  JSONL event normalization without spending M5 tokens. Local `npm run build`, focused runtime tests,
  `npm test`, and `git diff --check` passed. M5 advisory review reported no blocking issues.

### Pending / next

- Deploy latest `hugin` from `main` on huginmunin.
- Submit a small live `Runtime: opencode` fixture task on huginmunin using M5 and record the result.
- Keep Claude as fallback until OpenCode has production traces plus Verdandi/audit identity coverage.

## Previous — Claude SDK task permission profiles (#149, 2026-07-08)

**Production state before this branch:** service active/healthy on huginmunin. Production runtime
includes PR #150 and the later #152 homeserver delegate-field fix; exact latest deployment marker is
`/home/magnus/repos/hugin/.deployed-commit`.


Implemented a cheapest-first least-privilege gate for `Runtime: claude`: tasks now default to `Permission profile: read-only`, which runs Claude Code in `dontAsk` mode with only read-only local tools and read-only Munin MCP tools pre-approved. The historical full-bypass lane is preserved only when the task explicitly declares both `Capabilities: code` and `Permission profile: trusted-code`; malformed or non-code trusted-code requests downgrade to read-only.

Validation: `npm test -- tests/sdk-executor.test.ts tests/dispatcher.test.ts`, `npm run build`, and full `npm test` passed locally. M5 advisory review accepted in part: added the `Capabilities: code` guard and removed `TodoWrite` from the read-only tool allowlist; rejected the blanket recommendation to remove bypass entirely because #149 explicitly keeps full bypass for trusted code tasks.

PR #150 merged as `ca2ebb9` after green GitHub checks, then deployed to huginmunin on 2026-07-08
via the delegated-worker path plus Grimnir's registry-aware selective deploy for the final marker
repair. During final marker repair, Hugin `main` advanced to `922aa5c` (#152, homeserver delegate
field forwarding); it was verified with `npm test -- tests/homeserver-executor.test.ts`,
`npm run build`, deployed, and stamped so the remote checkout, runtime artifacts, and Grimnir marker
agree.

Production evidence:

- Remote `/home/magnus/repos/hugin` is on `main`, and `.deployed-commit` matches the deployed
  checkout after `grimnir/scripts/deploy.sh hugin`.
- `hugin.service` is active/enabled under the user manager and `/health` returns `status:"ok"`,
  `polling:true`, and `queue_depth:0`.
- Live permission-probe logs showed the intended effective modes before Claude quota stopped
  execution: default profile -> `Permission profile: read-only` / `permissionMode:"dontAsk"`;
  malformed `trusted-code` without `Capabilities: code` -> read-only / `dontAsk`; explicit
  `Capabilities: code` + `Permission profile: trusted-code` -> `permissionMode:"bypassPermissions"`.
- Grimnir registry validation after marker repair reported **7 ok, 0 issues, 0 warnings**.
- Follow-up deploy hardening landed: Hugin `scripts/deploy-pi.sh` and Grimnir `scripts/deploy.sh`
  now exclude both Git directories and Git worktree `.git` files from rsync, preventing a detached
  worktree deploy from corrupting the remote checkout metadata.

Residual caveats:

- Claude on the Pi is quota-blocked until **2026-07-09 21:00 Europe/Stockholm**, so the probes
  validated initialization/permission mode but not successful post-initialization Claude execution.
- The existing non-fatal deploy warning remains: `~/repos/claude-config` is missing on the Pi, so
  the claude-config bootstrap step warns during deploy.

## Session 9 (2026-07-03) — Homeserver (M5) wired as sovereign orchestrator provider + go-live (#137)

The Session-5 roadmap head ("wire a `homeserver` worker provider once the M5 gateway is reachable") unblocked and shipped: gateway live on the tailnet (`100.76.72.59:8080`), Pi's existing PR #107 credential verified working (no key mint needed).

- **PR [#137](https://github.com/Magnus-Gille/hugin/pull/137) → `3ab3208`:** `PROVIDER_CONFIG.homeserver` with request-time env-resolved base URL (`HOMESERVER_GATEWAY_URL` = gateway ROOT, `/v1` appended via new `resolveProviderBaseUrl`); `homeserver` joins `berget` in `SOVEREIGN_OR_LOCAL_PROVIDERS` (**first local private lane**); gateway host derived into the egress allowlist; explicit **$0 pricing** for the 7 gateway chat models; `Model:` accepts `provider|model` (per-task local routing).
- **Reviews (both fixed test-first pre-merge):** Codex gpt-5.5 xhigh — 1 Medium (unconstrained URL trusted as sovereign → `isSovereignGatewayHost` fail-closed validation: loopback/RFC1918/CGNAT/.ts.net/.local only; public hosts incl. `inference.gille.ai` rejected pre-call) + 2 Low. Parallel 4-lens Claude workflow with refute pass — 2 confirmed Medium (env-leaking tests, reproduced by execution; untested guard-vs-`Model:`-override ordering → new `effectiveOrchestratorConfig` + composition tests pin guard-judges-post-override-config).
- **35 new/updated tests; suite 1216 green** (incl. a run with `HOMESERVER_GATEWAY_*` deliberately exported); `tsc` clean; CI green.
- **Go-live done:** Pi `.env` roles all bound `homeserver|qwen3-30b-instruct` (one model — llama-swap holds one; Pi has no cloud keys, so orchestrator was previously non-functional there); deployed via `deploy-pi.sh` (active, healthy). **Live-validated the headline capability:** a `Sensitivity: private` orchestrator task was admitted (all-homeserver roles), planner fanout=3, workers at explicit `$0.000000`, synthesizer merged survivors, 12.5s, exit 0.
- **Follow-up filed: [#138](https://github.com/Magnus-Gille/hugin/issues/138)** — 429/503 backpressure awareness (worker 3/3 failed on parallel fan-out against the single-model gateway — expected symptom; engine resilience covered it). Also noted there: bare pricing-slug namespace assumption.

## Session 9c (2026-07-04) — PR3 savings tracker shipped + live (#142)

- **PR [#142](https://github.com/Magnus-Gille/hugin/pull/142) → `df5c98f`:** per-call ModelCallRecord ledger (all roles); apples-to-apples savings per covered call; `tasks/_savings` aggregate (verdict-store CAS mechanics, lastRunNonce idempotency); `savings` + token counts in result-structured. Codex clean (1 Low); adversarial review: 2 confirmed Mediums (provider token counts vs integer contracts — silent aggregate wipe + dropped result-structured doc), fixed at ingestion + defense in depth. 51 new tests; suite 1390 green.
- **Live-validated:** first measured run — actual **$0**, baseline (claude-sonnet-4-6) $0.0138, **savedUsd $0.0138**, 5 covered / 2 uncovered calls; adaptive verify ran the NEW independent local verifier (`homeserver|qwen3-coder-next-80b`, visible in byModel) and returned verdictOk:true on a subtask. Local-compute directive applied: verifier rebound to 80b (still M5), #141 annotated with local-first escalation ladder.

## Session 9b (2026-07-04) — PR2 verdict layer shipped + live (#140/#141)

- **PR [#140](https://github.com/Magnus-Gille/hugin/pull/140) → `5fc7170`:** the learning loop (ADR `docs/orchestrator-verdict-layer.md`, D5/D6). Planner-emitted taskTypes (gateway's authoritative 22-type taxonomy incl. `claim-verify`); verdict store at `tasks/_verdicts` (batched CAS, detached fire-and-forget, dedicated Munin client, **only VERIFIED verdicts are quality signal** — `unverifiedPasses` streak + `HUGIN_ORCH_REPROBE_UNVERIFIED` re-probe kills the delegate-local absorbing state); adaptive verify gate (`HUGIN_ORCH_ADAPTIVE_VERIFY`, verdict store for cloud / cached fail-open `GET /ledger` for homeserver); verified-fail excluded from synthesis; `orchestratorOutcomes` in result-structured (PR3's raw material). Double review (Codex xhigh: 3 Med; 4-lens refute-pass workflow: confidence-poisoning CONFIRMED BY EXECUTION + 5 more) — all fixed test-first. 124 new tests; suite 1340 green.
- **Deployed + live-validated:** Pi runs `HUGIN_ORCH_ADAPTIVE_VERIFY=on`; validation task completed and `tasks/_verdicts` populated with real rows — `qwen3-30b-instruct|summarize {attempts:2, passes:2}` (gate verified on unknown confidence, verifier passed), `qa-factual`/`synthesis` rows recorded infra errors (excluded from quality rate; the #138 backpressure symptom).
- **Follow-up filed: [#141](https://github.com/Magnus-Gille/hugin/issues/141)** (escalation re-run on stronger tier + broker rating ingestion + router confidence ranking).

**Next:** PR4 (Pi control / M5 execution host split — re-scope first: workers are I/O-bound HTTP today, so land #138 backpressure and revisit when pi-harness workloads exist). Open issues: **#138** (backpressure), **#123** (worker version-drift), **#117** (repo sprawl), **#98** (Tailscale admin console), **#84** (skill-lane go-live — M5 is now a viable cell). Still: clone `claude-config` on the Pi (deploy WARNING).

## Session 8 (2026-07-03) — Heimdall ongoing-tasks view restored (#135)

Magnus couldn't find the ongoing Hugin tasks on the reworked Heimdall page (new split: Heimdall = platform, owning service = content). Root cause: our `GET /heimdall.json` (#116, 2026-06-27) promoted hugin to **Tier-1 self-describing** in Heimdall's discovery, and Tier-1 panels come **only from the descriptor** — Heimdall's static `knownPanelsFor('hugin')` fallback (which carried the Tasks + Task history panels) stopped being consulted, while the v1 `/tasks` page was retired in the same rework. Our `panels: []` blanked the page.

- **Fix (PR [#136](https://github.com/Magnus-Gille/hugin/pull/136) → `38ad855`, closes #135):** declare both panels in `HEIMDALL_DESCRIPTOR.panels` — `{id: hugin-tasks, plugin: hugin, view: tasks, refresh: 60}` + `{id: hugin-history, view: history, refresh: 120}` — the exact shape Heimdall's fallback used (validated against heimdall `src/contract/schema.js` `normalizePanels`). Heimdall's existing `plugins/hugin.js` renders them live from the Munin DB; no push loop, no Heimdall change.
- Red/green TDD; suite 1184 green; `tsc` clean; **Codex review (gpt-5.5 xhigh): clean, no findings**; CI green.
- **Deployed to Pi + verified live:** Pi serves the descriptor with both panels; Heimdall `/services/hugin` (port 3033, Tailscale-bound) references both; fragments render real data (`/api/plugins/hugin/hugin/hugin-tasks` shows the live queue; Task History shows 313 tasks).
- **Ownership note (durable):** hugin's Heimdall page content is declared in `src/heimdall-descriptor.ts` — panels removed there disappear from the dashboard. Heimdall's fallback only applies if the descriptor endpoint is unreachable.

## Session 7 (2026-07-03) — Expired Pi Claude auth: silent overnight drain → classified, pre-flighted, and alarmed (#129)

Resolved issue **#129** (filed by munin-memory): an expired Pi Claude credential silently failed every overnight autonomous task with a bare `failed` tag — the 401 buried in the raw Pi log, cause invisible from Munin, one dead token draining the whole queue. Shipped across 3 merged PRs + 1 follow-up issue, each red/green-ish + **Codex-reviewed** (every finding fixed before merge). Also did the ops **go-live** (refresh Pi credential + wire the Ratatoskr alarm).

| PR | Issue | Merged as | What |
|---|---|---|---|
| [#130](https://github.com/Magnus-Gille/hugin/pull/130) | **#129** (asks 2,3) | `a510ef2` | Distinct `AUTH_FAILED` classification (new `src/failure-classification.ts`: `failure:auth` tag + `- **Failure kind:**` line + structured `errorMessage`) for a Claude SDK 401; + pre-flight OAuth-usage auth probe (`HUGIN_CLAUDE_AUTH_PREFLIGHT`, default on) that short-circuits before a paid run. Codex: 2 Medium (403-as-unauthorized; over-broad classifier patterns) → fixed. |
| [#132](https://github.com/Magnus-Gille/hugin/pull/132) | **#131** | `2a249b5` | Proactive credential alarm (new `src/auth-alarm.ts` pure edge-triggered state machine) delivered via **Ratatoskr's Alert Bus** (`POST /api/send` → Telegram + Heimdall echo). Periodic reaper, Munin-persisted state, restart-safe. Envelopes verified against Ratatoskr's own `validateAlert`. Codex: High (state advanced before delivery) + Medium (Ratatoskr host not in egress allowlist) → fixed. |
| [#133](https://github.com/Magnus-Gille/hugin/pull/133) | **#131 follow-up** | `0a500b2` | **Prod-revealed fix.** The credential file's `accessToken`/`expiresAt` is a short-lived (~8h) token Claude Code **auto-refreshes** via `refreshToken` — so neither `expiresAt` nor a probe-401 is a reliable "dead" signal (the false "expires in ~8h" alarm; worse, the pre-flight would wrongly **block** an overnight task that would have refreshed). Fix: expiry/`unauthorized` gated on **absence** of a refreshToken; the reliable signal is now a real runtime `AUTH_FAILED` fed **reactively** into the alarm's shared deduped edge state. Codex (×2): TOCTOU (stale-`ok` masks reactive-`unauthorized`) → probe moved inside the async lock; + unhandled-rejection guard. |

- **Ops go-live done.** (1) Refreshed the Pi's Claude credential (Magnus ran `/login` on huginmunin; verified the OAuth-usage endpoint returns **200**). (2) Wired the alarm: set `HUGIN_RATATOSKR_SEND_URL` (`http://100.97.117.37:3034/api/send`), `HUGIN_RATATOSKR_SEND_API_KEY` (copied from Ratatoskr's `.env`, never printed), `HUGIN_AUTH_ALARM_CHAT_ID` (`8786385198`) in the Pi's Hugin `.env`. (3) Deployed all three PRs to the Pi; verified **no false alarm** post-fix (a healthy refresh-token credential is silent). Cleared the stale `tasks/_auth_alarm` Munin state (`expiryWarned:true`→`false`, CAS-guarded).
- **Full suite 1183 green** (12 new: 6 classification + 6/11 auth-alarm); `tsc` clean; CI green on every merge.
- **Key insight (in Munin `projects/hugin`):** Claude Code OAuth creds auto-refresh a short-lived access token, so file `expiresAt` and access-token 401s are NOT reliable liveness signals — only a real runtime `AUTH_FAILED` (refresh-token dead / logout) is.

**Next (unchanged, hardware-gated):** wire a `homeserver` worker provider once the M5 gateway is reachable (Tailscale); then PR2 (learning/verdict) → PR3 (savings tracker) → PR4 (Pi/M5 host split). Open issues: **#123** (worker version-drift self-check), **#117** (repo-sprawl consolidation), **#98** (Orin SSH/FIDO2), **#84** (skill-lane slice-one). Still: clone `claude-config` on the Pi to clear the deploy WARNING.

## Session 6 (2026-07-02) — Orchestrator hardening trio merged + Pi redeployed

Cleared the three orchestrator follow-up issues filed from Session 5's Codex review of PR #108, then completed Session 5's outstanding "redeploy main to the Pi" item. All three were red/green TDD + Codex-reviewed (gpt-5.5 xhigh); every finding fixed test-first before merge.

| PR | Issue | Merged as | What |
|---|---|---|---|
| [#125](https://github.com/Magnus-Gille/hugin/pull/125) | **#112** | `4a21385` | Configurable worker `max_tokens` (`HUGIN_ORCH_MAX_TOKENS` env + per-role `RoleBinding.maxTokens`, default 4096); parse `finish_reason`; surface `finish_reason:length` truncation as `WorkerResult.truncated` → engine `warnings[]` → `### Warnings` summary + logs (planner/worker/verifier/synth). Codex: 1 Medium (missing verifier warning) → fixed. |
| [#126](https://github.com/Magnus-Gille/hugin/pull/126) | **#110** | `4dfdc22` | Thread `AbortSignal` end-to-end (`WorkerRequest.signal` → `invoke` → both executors); DirectModel combines signal+timeout & short-circuits pre-aborted; PiHarness kills child on abort; `runOrchestratorTask` aborts the engine when timeout wins or caller aborts; cleared the `currentOrchestratorAbort` leak in `pollOnce` finally. Codex: 1 Low (abort-reason not first-writer-wins) → fixed with fake-timer race test. |
| [#127](https://github.com/Magnus-Gille/hugin/pull/127) | **#111** | `d1ccd80` | Enable private + Berget-sovereign lane: `getDispatcherRuntimeMaxSensitivity("orchestrator")` → `"private"` (was falling back to `internal`, pre-rejecting every private orchestrator task before the role guard). Defers to `assertProvidersAllowSensitivity` (fail-closed, before any model call). Codex security pass: **no leak path**; found orchestrator `Context-refs` were gated-but-never-injected → added `injectedContext` (post-guard) + handoff regression tests. |

- **Stacked PRs, merged bottom-up** (#125→#126→#127). Each squash-merge required rebasing the next branch onto the new `main` (dropping redundant commits) — clean each time; `main` has exactly 3 tidy commits. #127 needed a close/reopen to re-trigger CI after the base retarget (concurrency-group cancellation).
- **Deployed to the Pi** via `deploy-pi.sh` — hugin now `active (running)` PID 516820 on the *orchestrator* code (was pre-orchestrator since Session 5); health `{"status":"ok",...,"polling":true}`. Artefact-delivery + codex/bwrap preflights passed. **One WARNING:** claude-config bootstrap failed — `~/repos/claude-config` needs cloning on the Pi (one-time infra; unrelated to hugin, non-fatal).
- Full suite 1165 green; CI green on every merge.

**Next (unchanged from Session 5, hardware-gated):** wire a `homeserver` worker provider once the M5 gateway is reachable (Tailscale); then PR2 (learning/verdict layer) → PR3 (savings tracker) → PR4 (Pi control / M5 execution host split). Remaining repo issues: **#123** (worker version-drift self-check), **#117** (repo-sprawl consolidation), **#98** (Orin SSH/FIDO2 — admin-console), **#84** (skill-lane slice-one). Consider cloning `claude-config` on the Pi to clear the deploy WARNING.

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
