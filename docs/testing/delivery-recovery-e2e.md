# Acceptance runbook: runtime-owned delivery crash-recovery (#75, #78)

**Issues:** [#75](https://github.com/Magnus-Gille/hugin/issues/75) (verify #68 reconciliation),
[#78](https://github.com/Magnus-Gille/hugin/issues/78) (A1 — land #77 + a
kill-during-local-execution acceptance test wired through the same task lifecycle).

This is the **manual/observational acceptance procedure** for the runtime-owned
artefact-delivery crash-recovery paths. It exercises the real task lifecycle on the Pi
(Munin → claim → agent run → delivery checkpoint → reconcile), which has no unit seam.

## Prerequisites (deploy ordering is load-bearing)

1. The **#77 fix must be deployed first** (host-stable `workerId` + reaper reconciles
   `delivery:pending`; PR #86). A `research-spike` SKILL.md against an OLD Hugin reintroduces
   #68's silent data loss — never update the skill before the dispatcher is deployed.
   - Confirm on the Pi: `curl -s localhost:3032/health | jq '{worker_id, process_instance_id}'`
     — `worker_id` must be **`hugin-hugin-node`** (no PID suffix). `process_instance_id`
     carries the PID for observability.
2. `./scripts/deploy-pi.sh` passes its preflights (NAS SSH/rsync probe; codex bwrap probe #59).
3. `HUGIN_DELIVERY_POLICY=require` (or `defer` for the #72 retry-loop variant, see S5).

## Conventions

- Submit by writing a `tasks/<id>/status` entry to Munin (tag `pending`, `runtime:claude`),
  with an `### Artifacts` manifest **before** `### Prompt`. Watch `~/.hugin/logs/<id>.log`.
- After each scenario, read back: `tasks/<id>/status` tags, `tasks/<id>/result` markdown,
  `tasks/<id>/result-structured`, and the NAS inbox (`/var/lib/hugin/mimir-inbox/`).
- A delivery failure must render **`- **Exit code:** 2`** + `- **Failure kind:** DELIVERY_FAILED`
  (Ratatoskr reads a non-numeric/negative code as success — see #73).

## S1 — happy path

Submit a tiny task whose agent writes one file to the staging prefix and declares it in the
manifest (remote = the allowed NAS tuple).

**Expect:** `~/.hugin/logs/<id>.log` shows **Hugin** (not the agent) running `rsync` →
`sha256sum` → atomic `ssh mv`; file lands in `mimir-inbox`; status tags include
`completed` + `delivery:verified`; `result` has a runtime-authored `### Artifact Delivery`
section; `result-structured.artifactDelivery.ok === true`.

## S2 — missing local content (the literal #68 bug)

Submit a task whose agent does NOT write the declared local file (or writes it empty).

**Expect:** terminal `failed`, `Exit code: 2`, `Failure kind: DELIVERY_FAILED`,
`delivery:failed` tag; the agent's textual content is **preserved** in `result`; **no** paid
rerun on resubmission of the same content. `failureKind: "missing-local"`.

## S3 — kill mid-delivery → auto-reconcile (the #77 fix)

The core #77 acceptance test.

1. Submit a task with a **large** artefact (e.g. 24 MB) so the `rsync` window is wide.
2. Tail the log; the moment the `rsync` line appears (delivery in flight), **SIGKILL** Hugin:
   `systemctl --user kill -s SIGKILL hugin` (or `kill -9 <MainPID>`). systemd `Restart=always`
   brings it back within `RestartSec` (~10 s).
3. Observe the restarted process.

**Expect (post-#77):** the restarted process has the **same** `worker_id` (`hugin-hugin-node`),
so `recoverStaleTasks` sees the orphaned `running + delivery:pending` checkpoint as **ours**
(even though the dead worker's lease is still live) and **reconciles it on the first restart** —
re-delivers without a paid agent rerun, lands the file on the NAS, flips to terminal
`completed` + `delivery:verified`. The startup log shows
`Reconciling delivery:pending task tasks/<id> on startup`.

**Regression being guarded:** pre-#77 (PID-derived `workerId`) the task stayed
`running + delivery:pending` non-terminal until a *second*, post-lease-expiry restart
(startup scan skipped the live-leased foreign task; the reaper deferred `delivery:pending`
back to the startup scan → deadlock). One restart must now suffice.

**Also acceptable (defence in depth):** if the lease expires before the next restart, the
lease reaper reconciles it (`Reconciling delivery:pending task … via lease reaper`).

## S4 — cancel during delivery

Submit a delivery task; once the checkpoint is `running + delivery:pending` and `rsync` is in
flight, request cancel (`cancel-requested` tag on `tasks/<id>/status`, or the pipeline parent).

**Expect:** terminal `cancelled` with the `delivery:*` markers preserved; the operator cancel
aborts the in-flight `rsync` (the cancellation watch stays active through delivery and targets
`currentDeliveryAbort`). NOT a spurious `DELIVERY_FAILED`.

## S5 — deferred retry loop (#72, only under `HUGIN_DELIVERY_POLICY=defer`)

1. Set `HUGIN_DELIVERY_POLICY=defer` and a short `HUGIN_DELIVERY_RETRY_INTERVAL_MS` (e.g. 30000)
   for the test. Point the manifest at a **temporarily unreachable** NAS path/host (simulate
   infra failure — e.g. block the NAS or use a valid-but-down allowed tuple).
2. Submit a delivery task.

**Expect:** first attempt hits an infra failure; task stays `running + delivery:pending`
(NOT terminal); a `delivery-retry` Munin key appears (`{attempts, firstAttemptAt}`); the
delivery-retry reaper re-attempts every interval (`Delivery-retry reaper re-attempting …`),
incrementing `attempts`. Restore the NAS → the next attempt verifies → terminal `completed` +
`delivery:verified`. Then exhaust the budget instead (keep NAS down): after
`HUGIN_DELIVERY_RETRY_MAX_ATTEMPTS` / `_MAX_AGE_MS`, the task terminalizes `failed` +
`Exit code: 2` + `DELIVERY_FAILED`. `missing-local`/`unsafe-local` must terminalize on the
**first** attempt even under `defer` (never deferred).

## Sign-off checklist

- [ ] S1 verified delivery + runtime-authored section
- [ ] S2 Exit 2 / DELIVERY_FAILED, content preserved, no paid rerun
- [ ] S3 **single** restart auto-reconciles (the #77 acceptance criterion)
- [ ] S4 cancelled with delivery markers, rsync aborted
- [ ] S5 (defer) retry loop + budget-exhaustion terminalization
- [ ] Only after all green: update `~/.claude/skills/research-spike/SKILL.md` (drop agent-side
      rsync; add `### Artifacts` before `### Prompt`).
