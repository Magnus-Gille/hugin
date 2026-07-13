# Hugin — Status

**Close audit (2026-07-13, Codex) — sequence #190+#183 → #191 → #192 remains reviewable;
gi#158 shipped; gi#199/#156 were re-scoped only.** Hugin draft PR
[#193](https://github.com/Magnus-Gille/hugin/pull/193) adds full, boundary-honest Munin pagination
and starvation-free oldest-first claiming; PR
[#194](https://github.com/Magnus-Gille/hugin/pull/194) mirrors `draft` and `conversation` through the
shared Broker/MCP taxonomy; PR
[#195](https://github.com/Magnus-Gille/hugin/pull/195) records the wave-5 evidence. All three remain
intentional drafts, their worktrees are clean and origin-synced, and current GitHub CI is green.
None has been reviewed, merged, or deployed yet.

Wave 5 ran six matched one-shot leaves and six official `code_loop` harness leaves across those
Hugin tickets and gille-inference #158. Every one-shot was rated `redo` (three repo-hallucinated
local diffs; three no-local-attempt frontier escalations). Harness result: one correct narrow
single-file schema edit, five cap-exceeded/no-diff leaves; no multi-file success. Full evidence and
work/task IDs: `docs/m5-harness-wave5-2026-07-13.md`. gille-inference PR
[#246](https://github.com/Magnus-Gille/gille-inference/pull/246) implemented #158 with 18 triage
cases, 34 seeded review bugs + 6 clean controls, review recall/precision/confabulation evidence,
and empty/truncation promotion gates. Its requested Claude Opus review was blocked by Codex's
default external-disclosure auto-review policy, so the native Codex gate ran and caught two release
blockers; both were fixed. PR #246 was squash-merged as `cc64a69` and deployed from clean committed
`main`; final validation was 144 files / 2,377 tests. A close-time rsync dry run reports zero drift,
`home-gateway`, `llama-swap`, and `cloudflared` are active, and public `/healthz` is overall healthy.
The same response reports Orin `ok:false` because `qwen2.5-coder:3b` is unavailable; treat that as a
separate backend availability follow-up. gi#199 and gi#156 were edited on GitHub into narrow future
audit/verification scopes; no code was built for either.

The Claude-policy mismatch is diagnosed but not changed: the narrow fix is to retain Guardian and
add a full-default-derived `[auto_review].policy` that trusts authenticated Claude Code only for the
verified gille-inference and Ratatoskr repositories while continuing to deny secrets and unrelated
data. `~/.codex/config.toml` was left untouched pending Magnus's decision.

**Next:** (1) review, merge in order, and deploy Hugin #193 → #194 → #195 from clean `main`; (2)
investigate or acknowledge the unavailable Orin model; (3) under gi#156, run one supervised observed
scout/corpus pass before admitting #246's verifier to judgment-quality evidence; (4) decide whether
to install the scoped Claude trust policy.

---

**Latest session:** 2026-07-13 (Claude) — **M5-harvest campaign (`m5h-2026-07`): 9 tickets, 10 PRs, ~92 graded delegations, shadow lane live**
**Branch:** `main` @ `977e851` + this handoff; hugin deployed to Pi (health `ok`, polling, queue 0).

## Latest — M5-harvest campaign (2026-07-12/13)

**Goal:** solve real tickets slowly while routing every bounded sub-task through the graded broker
loop (`hugin_submit` → `await` → self-verify → `hugin_rate`), to harvest per-task-type evidence of
what the M5 can actually do. Vehicle: ticket-fleet headless sessions (one worktree per ticket, cap
2–3), broker-only delegation (`mcp__m5__ask` deliberately NOT allowlisted — it has no rating path).
New fleet scripts: `~/.claude/skills/ticket-fleet/scripts/{run,continue}-ticket-broker.sh`.

**Shipped (all Codex/Sol cross-reviewed, all merged):** #179 (deploy-pi warning #153), #180
(version-drift #123), #182 (hugin_list crowd-out #181), #185 (verifier-or-rubric warning #184);
gille-inference #228 (id-addressable ledger #227), #230 (#200), #231 (#229), #232 (#119), #237
(ledger evidence honesty #233), #238 (shadow lane #234, by Codex), #242 (taxonomy #198).

**Harvest results (66-leaf two-plane join, ledger × product ratings):**
- `mellum` did 52 leaves (30 verified pass, 1 fail, 21 unverified); `qwen3-coder-next-80b` did all 6
  `rewrite` leaves; 8 leaves were frontier-escalated.
- Reliable: `extract` (9/9 pass), `data-transform`, `claim-verify`, `unit-test-gen`.
- Weak: `qa-factual`/`classify` produce *confident* wrong answers; `rewrite` always needs editing
  (and it already runs on the 80b — that is a model ceiling, not a routing gap).
- **45% of non-escalated leaves landed `unverified`** because acceptance defaulted to `l1_review`.
  Attaching mechanical verifiers is the single biggest evidence lever → that is what #184/#185 and
  the wave-3 appendix rules address.
- M5's verifiers check *format, not truth* → capability-plane inflation on judgment types
  (gi#233/#237 now label verifier kind and surface `unverifiedShare`/`formatOnlyShare`).

**Shadow lane is LIVE (gi#234/#238):** deployed to the M5 and enabled with
`HOMESERVER_SHADOW_LANE=on`, `HOMESERVER_SHADOW_LANE_TASK_TYPES=code-review`. Proven end to end:
6 shadow rows in the first hour, including the **first graded local code-review evidence**
(`mellum`, pass, score 1, via a `containsAll` verifier). Escalated tasks WITHOUT a verifier produce
*ungraded* shadow rows — so code-review delegations should always carry one.

**Bugs the campaign found in its own infrastructure:** #181 (list crowd-out — caused by the
campaign's own rating writes; fixed+deployed), #183 (Munin pagination ceiling; Sol's two failure
scenarios recorded as acceptance criteria), #187 (deploy symlink incident; fixed via #189),
**#190 (NEW, open — dispatcher claim order starves older pending tasks under fleet load; a smoke
task starved 17 min behind 12+ younger claims)**, #191 (mirror `draft`/`conversation` task types).

**Coordination note:** Codex worked the same backlog in parallel and both agents solved #187
independently (#188 vs #189). #189 merged; the fleet's #188 was correctly closed as superseded.
**Lane assignment between Codex and the fleet is an open question for Magnus.**

**Next:** (1) settle Codex-vs-fleet lanes; (2) redeploy the gateway for #242, then land #191;
(3) fix #190; (4) wave 5 — gi#201 prompt is ready and unstarted; steer future waves at the 9 empty
taxonomy cells (`sql`, `translate`, `reason-math`, `reason-hard`, `plan-decompose`, `triage`,
`memory-decision`, `research-plan`, `gap-check`) and at the M5 **harness** lane (`pi`/opencode/
`code_loop`), which this campaign never exercised — all 66 leaves were one-shot completions.

---

**Previous session:** 2026-07-12 (Codex: deploy source hardening, issue #187)
**Branch:** `codex/hugin-187-node-modules-symlink` from `main@565f9e6`; merged as `977e851`.

## Latest — `node_modules` worktree symlinks rejected before deploy mutation (#187)

- `scripts/deploy-pi.sh` now fails before build, rsync, or SSH when the local
  `node_modules` entry is a symlink, with remediation to replace it with worktree-local
  dependencies via `npm ci`.
- Rsync now excludes both the `node_modules` entry and `node_modules/` contents. This is
  defence in depth against the incident where a worktree symlink bypassed the trailing-slash
  exclusion and rsync partially deleted the Pi dependency tree before exiting 23.
- New `scripts/deploy-pi.test.sh`, wired into CI, proves the preflight invokes none of npm,
  rsync, or SSH for a symlinked source; checks all prior deployment exclusions remain; and
  uses real local rsync to prove a source symlink cannot replace or delete a destination's
  real dependency directory.
- Validation: red/green shell regression, Bash syntax checks, TypeScript build, full suite
  (97 files / 1,657 tests), both shell test suites, and `git diff --check` are green.
- No production action was taken. After review/merge, deploy from a clean `main` checkout with
  real local dependencies using `./scripts/deploy-pi.sh`, then verify the user service is
  active/enabled and Pi loopback `/health` reports `status:"ok"`, `polling:true`, queue depth 0.
  Rollback is `git revert` of the merged #187 commit followed by the same deploy; the change has
  no data migration or configuration impact.

**Next:** independent PR review, green GitHub CI, merge, then deploy and verify from clean `main`.

**Last session:** 2026-07-12 (Claude) — M5 provenance (#163) + learning-loop health panel (#164)
**Branch:** `main` @ `287d473`; deployed to Hugin-Munin on 2026-07-12, health `ok` / `polling:true` / queue 0.

## Latest — M5 provenance + learning-loop health (#163, #164 — 2026-07-12)

Both merged and deployed. Both Codex-reviewed (`gpt-5.6-sol`, high effort); every finding fixed
before merge. Final suite 95 files / 1,612 tests, `tsc` clean, CI green.

### #163 — M5 execution provenance (PR [#176](https://github.com/Magnus-Gille/hugin/pull/176) → `1dd4e7e`)

Hugin delegates to M5 from two places. The direct executor carried a partial trace; the
**orchestrator fan-out worker parsed a few fields and then dropped every one of them** — a fanout
leaf could not be traced to the node/model/verifier that produced it. (The existing test even
stubbed a `ledgerId` and never asserted it survived, so the drop was invisible to CI.)

- New `src/m5-provenance.ts` — the ONE sanitizer of the untrusted `/delegate` response, shared by
  both M5 call sites. Validates enums/bounds, drops out-of-contract values, never throws.
- Provenance now flows into `orchestratorOutcomes[].delegation` on **every** post-JSON branch (a
  failed leaf is when the ledger row is most needed), and `runtimeMetadata.delegation` is widened
  with what neither path captured: verifier identity, delegate-policy mode/action/reason,
  `priceCatalogVersion`, `costTraceId`, `formatRetried`.
- **Latent bug fixed:** `buildStructuredTaskResult` calls Zod `.parse()` (throws) and
  `delegation.score` was `z.number()` — a non-numeric gateway `score` would have sunk the
  `result-structured` write of a successful, PAID run.
- Codex found 3 mediums, all real, all fixed: `Number.isInteger` vs zod 4's `.int()` (verified
  empirically — `Number.isInteger(2**53)` is `true` but `.int()` rejects it, so an unsafe-integer
  token count reached a `.parse()` that throws); out-of-scale `score` retained as valid (M5's real
  scale confirmed from its live ledger: `0, 0.2, 0.7, 1, null`); provenance lost on the
  response-validation failure branch.

**⚠️ #163 is REOPENED — its last hop is blocked on M5.** The acceptance asks that an operator
retrieve the M5 evidence row *by* the stored `ledgerId`. **M5's API cannot do that:** `GET /ledger`
`recent[]` rows carry **no id field at all**, `?id=` / `?delegationId=` are accepted (HTTP 200) but
**silently ignored**, and there is no `GET /ledger/:id` (404). Joining by id would need exactly the
timestamp archaeology #163 exists to eliminate. Hugin's half is done and live-verified (the join key
is durably stored). Filed as **[gille-inference#227](https://github.com/Magnus-Gille/gille-inference/issues/227)**;
close #163 when that lands and the by-id join can be demonstrated end to end.

### #164 — Learning-loop health panel (PR [#178](https://github.com/Magnus-Gille/hugin/pull/178) → `287d473`)

> PR #177 was the original; GitHub auto-closed it when its stacked base (`feat/163-m5-provenance`)
> was deleted on merge. #178 is the same commits rebased onto `main`, suite re-verified after rebase.

Auditing the data first showed the panel *alone* would have rendered "not instrumented" for the
criterion that matters most — so this instruments it too (Magnus approved the wider scope).

- **Durable-handoff instrumentation** (`src/broker/await-observation.ts`): `/v1/delegate/await` only
  ever READ state, so nothing recorded whether a result outlived the session that asked for it.
  `durableHandoff` = a **completed** result collected by a **different `orchestrator_session_id`**
  than submitted it. Documented as a **proxy that errs in BOTH directions** (the id is
  client-asserted and minted per MCP *process*, so an MCP restart inside a live session also trips
  it) — never presented as a measurement of session closure. Recorded fire-and-forget, CAS-guarded,
  and only when the evidence actually changes.
- **The panel** (`learning-loop-health.ts` pure + `learning-loop-collector.ts` IO): two evidence
  planes, deliberately NOT collapsed into one verdict — M5 capability (read from M5's ledger; M5
  stays the sole capability authority) and Hugin product (the #165 gate). Emitted as Heimdall
  **typed panels** (`stat`/`table`/`status`), which render with **zero Heimdall code** — so this is
  Hugin-only, no cross-repo ticket. (The `plugin`/`view` path would have needed a heimdall renderer.)
- **Honesty rules enforced in code + tests:** no percentage without an `n`; an unmeasured metric
  reports `not-instrumented`, never a flattering zero; infra errors excluded from quality rates; a
  capped table discloses what it dropped.

**Two bugs a green test suite completely hid** — both found by checking reality, not the schema:

1. **Production Munin:** the sole existing broker task predates PR #173 and lost its
   `broker:mcp-v2` status tag. Keying the corpus walk off that tag reported **0 tasks against a
   Munin holding 1** — under-counting the very trial the panel measures. Broker tasks are now
   identified by their embedded **envelope**, which was never dropped.
2. **Heimdall's normalizer** (`heimdall src/contract/panel-data.js`) keeps only rows passing
   `isObj = ... && !Array.isArray(v)` and **silently drops the rest**. Rows were `string[][]`, so
   **both tables would have rendered EMPTY on the real dashboard** while every test passed. Now
   objects keyed by column, with a test replicating Heimdall's exact rule. Live: 16/16 and 7/7 rows
   survive (previously 0/16, 0/7).

Codex found 9 mediums + 1 low, several attacking the PR's own honesty thesis — all fixed: a failed
corpus read rendering as a **measured zero**; a `partial` the human *discarded* counting as "useful
completion"; useful-completion readable as "met, 100%" from 1 rated pass out of 10 unrated (now
requires ≥50% rating coverage); `deriveRoutePolicy` asserting causation from any verified sample
anywhere (now requires evidence for that exact model × task-type); no CAS on the observation write
(a stale writer could permanently erase a proven handoff); unbounded fire-and-forget pile-up under
polling; `/heimdall.json` awaiting a cold corpus walk (~a minute — enough to blank Hugin's Heimdall
page, the #135 regression, with no exception thrown → now synchronous stale-while-revalidate);
unvalidated ledger counters yielding a false 100%.

### Deploy verification (2026-07-12)

`./scripts/deploy-pi.sh` → `hugin.service` active/enabled on huginmunin, `/health` `status:"ok"`,
`polling:true`, `queue_depth:0`, M5 delegate executor enabled, Broker on `100.97.117.37:3035`.
Panels verified live end-to-end: served from the Pi's `/heimdall.json` (16/16 + 7/7 rows survive
normalization) and **rendering real values on Heimdall's `/services/hugin`** page. Cold start
correctly showed `—`/"unavailable" rather than a fabricated zero, then populated after the
background refresh.

### ⚠️ What the panel says — the finding that matters

The capability plane is genuinely learning (`source-distill`/Mellum **698/698 verified at 71%**,
`classify`/mellum 12/12, `delegate-local`). The **product** plane — the one that decides Hugin's
fate on **2026-08-22** — is nearly empty:

| Criterion | Observed | Target | State |
|---|---|---|---|
| Completed broker tasks | 1 | 10 | not-met |
| Independent producers | 1 | 2 | not-met |
| Useful completion | 100% (n=1) | 70% | met |
| Collected by a later MCP process | 0 | 5 | not-met |
| Human rescue / redo | 0 | — | informational |
| Maintenance time | not measured | <2h | not-instrumented |
| Incidents | not measured | 0 | not-instrumented |

Route policy: still **shadow** — no route has changed because of evidence.

**On current evidence the #165 trial is not on track to be decidable.** It needs ≥10 completed broker
tasks from ≥2 independent producers, and tasks **must be rated with `hugin_rate`** — without ratings
the useful-completion gate reads `not-instrumented`, and it now refuses to declare "met" from thin
coverage (<50% of completed tasks rated). Backfilling volume without ratings would move exactly one row.

**Next session (agreed with Magnus): populate the trial database with more useful information.**

## Previous — canonical durable MCP→Hugin→M5 lifecycle (#167, 2026-07-11)

Issue [#167](https://github.com/Magnus-Gille/hugin/issues/167) is implemented,
reviewed, merged, deployed, and proven against the live production path.

- PR [#169](https://github.com/Magnus-Gille/hugin/pull/169) replaced the ordinary
  MCP delegation path with a canonical Munin-backed Hugin task lifecycle. Hugin owns
  intake, durable idempotency, macro placement, recovery, delivery, and product feedback;
  it makes exactly one bounded M5 `/delegate` call, while M5 remains the sole capability
  router and ledger authority. The legacy orch-v1 worker/reconciler no longer starts and
  its journal is read-only for historical compatibility.
- The v2 envelope has fail-closed defaults and bounds: internal sensitivity, M5-only
  destination, no tools, one attempt, zero external spend, durable Munin delivery,
  return-to-L1 review, 300 s default / 900 s maximum timeout, and 4,096 default /
  32,768 maximum output tokens. Broker authentication isolates principal task/result,
  list, await, rate, and idempotency state.
- Production enablement exposed the authenticated Broker only on the Pi's tailnet address.
  PRs [#170](https://github.com/Magnus-Gille/hugin/pull/170),
  [#171](https://github.com/Magnus-Gille/hugin/pull/171), and
  [#172](https://github.com/Magnus-Gille/hugin/pull/172) hardened credential reuse,
  tailnet health verification, and port persistence. Final allocation is Hugin Broker
  `100.97.117.37:3035`; Heimdall remains on 3033 and Ratatoskr on 3034.
- Live task `mcp-m5-fd095190fd5074ac89dea1c2` returned exactly
  `HUGIN167_LIVE_OK` through model `mellum`, outcome `pass`, score `1`, and M5 ledger ID
  `1cf65112-da3d-4ad2-9e6e-2855d5a2ad63`. Hugin was restarted immediately after submit;
  resubmitting the same principal + idempotency key with a rotated session returned the
  original task ID and original receipt timestamp with `reused_idempotency:true`.
- The restart exposed one final lifecycle seam: terminal status normalization had dropped
  `broker:mcp-v2`, so `hugin_await` returned 404 even though the result was durable. PR
  [#173](https://github.com/Magnus-Gille/hugin/pull/173) centralized persistent identity
  tags across claim, renewal, and terminal transitions and safely recognizes canonical
  pre-fix envelopes. After deployment, awaiting that same old task returned the complete
  structured result and preserved ledger ID. Its Hugin product rating is stored separately
  as `pass` / `accepted_unchanged`; it does not modify M5 capability evidence.
- Native Codex review findings were fixed before merge. Final validation: TypeScript build,
  `git diff --check`, GitHub CI, and the full suite (91 files / 1,538 tests) are green.
  Local M5 dogfood was advisory: root output was rated `partial`; subagent output was rated
  `wrong` and discarded. Final quality remained with the implementing/reviewing agents.

**Next:** exercise this ordinary Broker path during the #165 role-validation trial and
measure whether it reduces L1 attention. Feature expansion remains frozen except reliability
and security fixes. For future side-effecting destinations, add an execution-receipt protocol:
persistent intake idempotency prevents duplicate task creation, but cannot by itself prove
exactly-once external effects across a crash after an effect and before its receipt is stored.

**Close audit:** the main checkout is clean and synchronized. Clean, squash-merged PR worktrees
were intentionally retained pending explicit cleanup at `/private/tmp/hugin-167-durable-m5`,
`/private/tmp/hugin-169-enable-hardening`, `/private/tmp/hugin-170-broker-port`,
`/private/tmp/hugin-171-broker-port`, and `/private/tmp/hugin-172-preserve-tags`.

## Latest — truthful MCP Broker routing + roadmap reset (#168, 2026-07-11)

PR [#168](https://github.com/Magnus-Gille/hugin/pull/168) closed the defect where
the MCP Broker advertised and accepted aliases that no worker could drain.

- Added one executor-capability truth shared by submission, `/models`, and the
  worker. `large-reasoning` is executable only when the OpenRouter worker is
  configured; `tiny`, `medium`, and `pi-large-coder` remain historical protocol
  aliases but are rejected before idempotency reservation or durable writes.
- `/v1/delegate/models` now returns only enabled aliases and their backing
  runtime rows. hugin-mcp builds its submit enum from that live response and
  disables submission if discovery fails or returns no enabled executor.
- Alias-map version skew is rejected explicitly. Historical envelopes and
  journal rows remain parseable.
- Native Codex review found no blocking defects and strengthened the test that
  proves rejected aliases consume neither journal state nor the idempotency key.
  Claude review was intentionally skipped because it was unavailable. Full
  suite: 91 files / 1518 tests green; TypeScript build and CI green.

Roadmap reconciliation completed alongside the PR:

- Added #163 provenance, #164 learning-loop health, #165 role-validation trial,
  #166 truthful Broker routing, and #167 canonical durable Hugin→M5 leaf.
- Closed solved/superseded #147, #138, #141, and #84.
- Transferred cross-repo ownership: Hugin #98 → Grimnir #77, #117 → Grimnir
  #78, and #162 → claude-config #2.
- Corrected closed #38 and #129 to Done; removed optional #153 deploy hygiene
  from the active Roadmap while leaving the issue open.

**Next:** implement #167 as the architectural seam, with #163 provenance in the
same or immediately following slice. Keep the mini-Conductor and skill lane
frozen while #165 gathers evidence through 2026-08-22.

## Latest — Reviewed Orin macro route (#160, 2026-07-10)

PR [#161](https://github.com/Magnus-Gille/hugin/pull/161) merged as `cbb1f13` and deployed to
Hugin-Munin. The user-level service is active/enabled; loopback `/health` reports `status:"ok"`,
`polling:true`, and `queue_depth:0`.

Implemented a narrow Hugin-owned macro route for the M5 gateway's deployed Orin node.

- Only `homeserver` orchestrator worker leaves with planner task types `classify` or `extract`
  route explicitly to `nodeId:"orin"` and `qwen2.5-coder:3b`. `private`, broad, and
  unclassified leaves retain their configured worker route.
- Owner/evidenced leaves use `/delegate` with the explicit node and task type; raw
  OpenAI-compatible homeserver chat now also forwards `node:"orin"` for non-verified callers.
- A gateway `502`, `503`, or `504` triggers exactly one bounded re-route to the configured
  M5 worker model. The selected/effective node and fallback reason are present in worker logs
  and `result-structured.orchestratorOutcomes`; request content is never logged as routing data.
- Validation: focused route/executor/engine tests, `npm run build`, `git diff --check`, native
  Codex review (no findings), and GitHub CI `build-test` are green. The full local suite was
  green with loopback access.

**Next:** run a real public/internal classify or extract task against the Pi to confirm the M5
ledger reports `node_id='orin'` and capture verifier-backed evidence before broadening the lane.

## Latest — M5 `/delegate` orchestrator worker lane (#154, 2026-07-08)

PR [#156](https://github.com/Magnus-Gille/hugin/pull/156) merged to `main` as
`c30b76f`. It routes orchestrator `homeserver` **worker** leaves through the M5
gateway `/delegate` endpoint while preserving raw homeserver chat for direct executor
calls and non-worker roles.

- **Code shape:** `createWorkerExecutor("homeserver", { role: "worker" })` now returns
  `HomeserverDelegateWorkerExecutor`; plain `createWorkerExecutor("homeserver")` remains
  `DirectModelExecutor` and still posts to `/v1/chat/completions`.
- **Attribution plumbing:** planner-emitted `subtask.taskType` is forwarded to worker
  invocations; `/delegate` receives `taskType`, `modelId`, `maxTokens`, optional
  `verifier`/`responseFormat`, optional `premiumBaselineModelId`, and `delegatorModelId`.
  `HUGIN_ORCH_DELEGATOR_MODEL_ID` configures the actual outer/cloud conductor; fallback
  for homeserver worker leaves is the planner role model. Compatibility alias:
  `HUGIN_ORCH_DELEGATOR_MODEL`.
- **Validation:** focused orchestrator tests passed (`208` tests), full suite passed
  (`89` files / `1456` tests), `npm run build` passed, GitHub CI `build-test` passed.
  Live M5 dogfood exercised the new executor against `/delegate` with model `mellum`,
  taskType `qa-factual`, verifier `answerIs`, and delegatorModelId `openai/gpt-5.5`;
  it returned exactly `HUGIN154_OK`, token counts, and `costUsd:0`. M5
  `qwen3-coder-next-80b` also reviewed the bounded diff; reported findings were checked
  and did not require code changes beyond already-added docs clarity.
- **Production deploy:** `./scripts/deploy-pi.sh` deployed `main@c30b76f` to
  huginmunin, rebuilt locally, synced the Pi checkout, restarted `hugin.service`, and
  health verified over Pi loopback (`status:"ok"`, `polling:true`, queue depth `0`).
  User service is `active` and `enabled`.
- **Cron:** deploy reinstalled the daily CLI-update cron; remote crontab includes
  `0 4 * * * /home/magnus/repos/hugin/scripts/update-cli.sh 2>&1 | logger -t hugin-update`.

### Pending / next

- The deploy warning remains non-fatal: `~/repos/claude-config` is still missing on the Pi,
  so the claude-config bootstrap step warns during deploy.
- Direct laptop curl to `100.97.117.37:3032` failed because this service advertises/binds
  health on `127.0.0.1`; verify health with `ssh huginmunin.local 'curl -fsS
  http://127.0.0.1:3032/health'`.
- If a future task needs raw `/v1/chat/completions` specifically for orchestrator worker
  leaves, add an explicit worker path/provider switch; today `homeserver` worker means
  ledgered `/delegate` by design.

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
- **Production deploy:** Grimnir registry deploy completed for `hugin`; remote
  `/home/magnus/repos/hugin/.deployed-commit` is `68dcc97f4bf035b14237dfdf763987ff8cbc659d`,
  `hugin.service` is active, and `/health` reports `polling:true`, `queue_depth:0`, and M5
  gateway host `100.76.72.59` in the egress allowlist.
- **Live validation:** installed `opencode-ai@1.3.3` into `/home/magnus/.npm-global/bin` on
  huginmunin, restarted Hugin, then submitted `tasks/20260708-123853-opencode-live`.
  Result: completed in 64s, executor `opencode`, source `opencode-json`, model
  `m5/qwen3-coder-next-80b`, agent `build`, permission profile `trusted-code`, 7 tool calls,
  changed `/home/magnus/scratch/20260708-123853-opencode-live/math.js`, ran `npm test`, and
  produced `ok`.
- **Unit metadata reconciliation:** the earlier suspected deploy miss was a scope-check error, not a
  deploy-script failure. Grimnir's registry declares `hugin-daily-analysis.timer` without
  `scope:"user"`, so it defaults to the system manager; the companion service itself runs as
  `User=magnus`. The selective deploy had already installed and enabled the system timer under
  `/etc/systemd/system` at 14:36. The later manual user-manager "repair" created a duplicate user
  timer at 14:42; that duplicate has been removed. Current live state: system timer `active` /
  `enabled`, user timer `inactive` / `not-found`, next system run `2026-07-09 07:02:47 CEST`.

### Pending / next

- No deploy-script fix is required for `hugin-daily-analysis.timer`; keep checking the scope from
  `services.json` before interpreting a missing unit in one systemd manager as drift.
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
