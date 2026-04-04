# Security Critical Holes Live Evaluation

**Date:** 2026-04-04  
**Service:** `huginmunin`  
**Scope:** legacy Claude spawn removal, first-pass outbound egress allowlist, context-ref classification enforcement

## Summary

The critical pre-Phase-5 security hardening pass is deployed and live-validated.

What passed:

- Claude now runs only through the Agent SDK; startup no longer advertises or supports the legacy spawn path.
- Hugin now exposes a live outbound allowlist in health and startup logs.
- Standalone tasks fail before execution when a classified Munin ref would cross the runtime trust boundary.
- Pipeline parents fail at compile time when a private-sensitive phase targets a cloud runtime.
- Munin artifact classification now maps `private -> client-confidential` correctly after one live-found integration fix.

## Live environment evidence

### Service startup

After deploy, `hugin.service` restarted cleanly and logged:

- `Claude executor: agent-sdk`
- `Egress policy: allowlist (...)`

Health on the Pi returned:

- `status: ok`
- `queue_depth: 0`
- `blocked_tasks: 0`
- `egress_policy.enabled: true`

## Probe 1: Private Munin context denied on Claude

### Setup

Submitted task:

- namespace: `tasks/20260404-220600-security-private-ref-claude`
- runtime: `claude`
- declared sensitivity: `internal`
- context ref: `people/magnus/profile`

### Observed

The task failed without execution.

Final status:

- `failed`
- `runtime:claude`
- namespace classification: `client-confidential`

Result:

- `Context ref "people/magnus/profile" is classified client-confidential, but runtime "claude" only allows up to internal`

Structured result:

- `resultSource: "security-policy"`
- `sensitivity.declared: "internal"`
- `sensitivity.effective: "private"`
- `sensitivity.mismatch: true`

### Conclusion

Context-ref classification enforcement is active on the live dispatcher and fails closed before prompt injection into an unsafe runtime.

## Probe 2: Private pipeline rejected on cloud runtime

### Setup

Submitted pipeline:

- namespace: `tasks/20260404-220901-security-private-pipeline-cloud-fixcheck`
- runtime: `pipeline`
- declared sensitivity: `private`
- single phase runtime: `claude-sdk`

### Observed

The parent failed during compile/decompose.

Final status:

- `failed`
- `runtime:pipeline`
- namespace classification: `client-confidential`

Result:

- `Pipeline compile failed: Runtime "claude-sdk" cannot execute private-sensitivity work (max allowed: internal)`

### Conclusion

Pipeline compile-time sensitivity enforcement is active on the live dispatcher.

## Live-found issue and fix

The first live pass exposed one integration bug:

- Hugin initially wrote Munin artifact classification as `private`, but Munin accepts `client-confidential` / `client-restricted` for high-sensitivity entries.

Fix:

- sensitivity-to-Munin mapping was updated to `private -> client-confidential`
- the service was redeployed
- the pipeline probe was rerun successfully

## First-pass egress note

The outbound control that is live today is a first pass:

- process-level fetch allowlist
- git push remote host allowlist
- systemd `RestrictAddressFamilies`

This is materially better than the previous open egress posture, but it is not yet a host-firewall-grade destination policy for every spawned child process. Further hardening can still be added later if needed.
