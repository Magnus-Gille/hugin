# `hugin-gateway-preflight` synthetic journey (HUGIN-388)

Hugin owns and runs this Heimdall journey. One content-free attempt against the M5
gateway produces exactly two steps, reported as one closed `synthetic-journey-outcome`
v1 document to Heimdall (`POST /api/synthetic-journeys`; contract in
`heimdall/src/synthetic-journeys.js` and `heimdall/docs/synthetic-journeys.md`).

| Step | Read | Pass means |
| --- | --- | --- |
| `preflight` | `GET /v1/capabilities/learning-task` | A fresh, exact LearningTaskContract advertisement, verified by the same `verifyLearningTaskPreflightAdvertisement` the dispatcher uses |
| `gateway-admission` | `GET /portal/me` | The configured key is admitted as an owner principal. No prompt or inference is sent |

Code: `src/gateway-preflight-journey.ts` (attempt, local contract mirror, delivery) and
`src/gateway-preflight-journey-cli.ts` (entrypoint, `dist/gateway-preflight-journey-cli.js`).

## Semantics

- Built from closed enums and validated locally before any send. A local violation is a
  runner failure (`runner-invalid-outcome`), never a green or malformed post.
- Gateway/dependency failure => `outcome: fail`, `runner_outcome: ok`, a failed step with
  a closed `error_class`, later steps `skipped` (`blocked-by-preflight`).
- Runner failure (missing/invalid config, **rejected key on either route**,
  invalid outcome) => `outcome: unknown`, `runner_outcome: failed`, both steps
  `skipped`/`runner-unavailable`. Heimdall does not grade `unknown`, so the unit exits non-zero.
- `HOMESERVER_GATEWAY_URL` is validated exactly like the dispatcher's (root URL only, no
  credentials/path/query, loopback/LAN/tailnet host); otherwise `runner-config`, and the key is never sent.
- Partial evidence never passes: `pass` requires both steps pass in one attempt.
- Nothing but the closed fields is sent: no prompt, task, alias, model, key, URL, response
  body, advertisement id or trace. `trace_id` is `null` (Hugin has no producer-authored trace here).
- Delivery: `https` only (plain `http` solely for loopback), exact `/api/synthetic-journeys`
  path, no userinfo/query/fragment, no redirects. Transport errors and 5xx retry (0s, 1s, 4s)
  with the **byte-identical** document (same `attempt_id`); 4xx is final.
- Exit status: `0` when a runner-ok outcome (pass or fail) was delivered; `1` on delivery or
  runner failure. Stdout is one JSON line of classes only.

## Host configuration (never committed, never in argv)

| Variable | Source |
| --- | --- |
| `HOMESERVER_GATEWAY_URL`, `HOMESERVER_GATEWAY_API_KEY` | Hugin's existing `.env` (owner-scope key) |
| `HEIMDALL_SYNTHETIC_JOURNEYS_URL` | `~/.hugin/gateway-preflight-journey.env`, mode `0600` |
| `HEIMDALL_HUGIN_JOURNEY_TOKEN` | same file; dedicated Hugin journey credential |

`systemd/hugin-gateway-preflight-journey.{service,timer}` run it every five minutes
(`max_age_seconds` is 900). Heimdall binds only the tailnet address, so the delivery URL must be an `https` front for it (plain `http` is accepted only for loopback). The service has no `[Install]` section and `deploy-pi.sh`
does not install the units: they stay inert until the owner provisions the credential
file and enables the timer.

## Verification

Tests: `tests/gateway-preflight-journey.test.ts`. When a Heimdall checkout is at
`../heimdall` (or `HEIMDALL_REPO`), it also runs every emittable outcome through
Heimdall's real `validateJourneyOutcome`.
