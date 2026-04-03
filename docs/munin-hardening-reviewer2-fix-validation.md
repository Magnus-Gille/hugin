# Munin Hardening Reviewer 2 Fix Validation

Date: 2026-04-03
Branch: `codex/step1-live-eval`
Deployed worker: `hugin-huginmunin-801104`

## Trigger

Reviewer 2 found two issues in the first Munin-pressure hardening sprint:

1. High: lease renewal and current-task cancellation polling still shared the same Munin client request slot as background traffic, so a long `Retry-After` on low-priority work could starve lease renewal past expiry.
2. Medium: `readBatch()` trusted batch cardinality and positional ordering instead of failing closed on partial or reordered bridge responses.

## Fixes

### 1. Dedicated control-plane clients

`src/index.ts` now creates separate Munin clients for:

- main orchestration traffic
- lease renewal
- active-task cancellation polling

This removes the single shared request slot between background work and the lease/cancellation control plane.

### 2. Strict batch validation

`src/munin-client.ts` now makes `readBatch()` fail closed when:

- batch result count does not match request count
- returned `namespace` / `key` do not match the requested item at that position

The permissive namespace/key fallback was removed.

## Local Verification

- `npm run build`
- `npm test`

Result: passed (`95` tests).

New regression coverage includes:

- batch cardinality mismatch rejection
- out-of-order batch rejection
- separate Munin client instances not sharing a request slot

## Live Verification

### Startup

Deployed cleanly to `huginmunin.local`.

Observed after restart:

- service booted normally
- no startup batch-validation errors
- no watchlist-prime errors

### Lease-renewal probe

Task namespace: `tasks/20260403-092221-lease-renewal-probe`

Task:

- runtime: `claude`
- submitted by: `Codex`
- shell sleep of ~70 seconds before returning `LEASE_RENEWAL_OK`

Observed in the live journal:

- task claimed at `2026-04-03T07:22:39Z`
- lease renewed at `2026-04-03T07:23:39Z`
- task completed at `2026-04-03T07:24:00Z`

Observed in Munin:

- final status: `completed`
- result body: `LEASE_RENEWAL_OK`
- structured result duration: `81s`

## Conclusion

Reviewer 2's findings are resolved.

What is now proven:

- lease renewal still runs successfully in production after the client split
- strict batch validation does not break real startup or task execution
- the batch-read trust boundary now fails closed instead of silently mutating state from partial or reordered results
