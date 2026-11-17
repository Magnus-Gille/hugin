# Maintenance drain (HUGIN-417)

A deploy that restarts `hugin.service` can race the dispatcher: `/health` with
`current_task: null` is only a snapshot, and the dispatcher may claim a pending
task before the restart, after which shutdown fails that task. The maintenance
drain closes that window. It is an owner-invoked **admission gate** only: it
stops Hugin from *starting* new work and reports verifiable readiness. It never
cancels, fails, replays or submits a task, is not a second deployment authority,
and does not read or change autonomy/arming state.

## Semantics

- **Admission unit.** One dispatcher loop iteration (cancellation/resume/approval
  processing, `pollOnce` claim and execution, reconciliation) and each lease /
  deferred-delivery reaper pass is "admitted work". Closing admission is
  synchronous: work already admitted finishes, work arriving afterwards is
  refused. Therefore no executor starts after a drain is accepted, and a
  claim racing a drain either completes first (and is waited for) or never
  begins.
- **Ready** means draining, no admitted work in flight, no current task, no
  delivery reconcile running, and startup recovery finished (a drain during boot
  reports busy). Until then a drain is **busy**; the running task is
  left alone.
- **Bounded, never a latch.** Admission reopens on `resume`, when the hold lease
  expires (default 15 min), and on process restart (the state is
  in memory only). `Restart=always` after a crash therefore silently reopens
  admission.
- Heartbeats and `/health` keep running while draining. `/health` shows
  `maintenance: { state: "open" | "draining" }`.

## Interface

Disabled (404) unless `HUGIN_MAINTENANCE_TOKEN` is set to a secret of at least
32 non-whitespace characters in the service environment (outside Git; never forwarded to task
subprocesses). Requests must originate from loopback (the listener binds
`127.0.0.1` by default; the check uses the socket peer, so **do not front this
port with a same-host reverse proxy or tunnel** — the token would then be the only
control) and carry `Authorization: Bearer <token>`. Status codes:
404 disabled, 503 shutting down, 403 non-loopback, 401 bad/missing token.

| Method and path | Purpose |
| --- | --- |
| `GET /admin/maintenance` | Snapshot: `state`, `ready`, `work_in_flight`, `current_task`, `drain_requested_at`, `hold_expires_at`, `process_instance_id`. |
| `POST /admin/maintenance/drain` | Body (all optional): `timeout_ms` (0–600000, default 0, how long to wait for readiness), `hold_ms` (1000–3600000, default 900000). Closes admission immediately. **200** when ready, **409** `{busy:true,...}` when work is still running after `timeout_ms`. A 409 does not undo the drain. |
| `POST /admin/maintenance/resume` | Reopen admission. Idempotent. |

The total hold is capped at 60 minutes from the first request: repeated drain
calls cannot extend past it, and once it is spent further drains are refused
(409, `state: "open"`) until work has actually been admitted again or `resume`
was called. `hold_ms` must exceed `timeout_ms` (400 otherwise). A shutdown during
the wait returns 503, not `ready`. Malformed bodies get a JSON 400.

Every drain/resume writes a content-blind console audit line; the reversal recipe
for a drain is `resume` (or a restart, or lease expiry).

## Deploy-consumer contract

An owning deploy adapter should, before invalidating the deployed-commit marker
or mutating the payload:

1. `POST .../drain` with a `timeout_ms` it is willing to wait. **200** → continue;
   **409** or any error → `resume` and abort the deploy with an explicit "Hugin
   busy" outcome (do not restart).
2. Remember `process_instance_id` and `hold_expires_at` from the 200.
3. Build/sync/install, then immediately before restart `GET` the status: abort
   (and `resume`) if the instance id changed, `ready` is false, or the lease has
   too little time left.
4. Restart, then verify `/health` reports `maintenance.state: "open"`; if it is
   still `draining` (same instance), `resume`.
5. On any failure path after step 1, call `resume`.

The token must not appear in argv: pass the header via `curl --config -` or a
mode-0600 header file. A seconds-wide window between step 3 and the restart
remains; it is bounded by the hold lease and by startup recovery of a task that
was claimed in that window.

Known pre-existing behaviour: `pollOnce` treats any claim-write error as a lost
CAS, so a timed-out write that actually landed can leave a task `running` with
no current task; startup recovery reconciles it.

Routing: the Grimnir `scripts/deploy.sh` adapter change and Hugin's own
`scripts/deploy-pi.sh` adoption are separate work with their own tests and owner
approval; neither is changed by this document.
