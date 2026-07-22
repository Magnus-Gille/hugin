# Scheduling FIFO hardening

The dispatcher enumerates pending tasks with Munin's filter-only timestamp
paginator, filters for eligibility, and selects the minimum tuple
`(created_at ASC, namespace ASC)`. The namespace tie-breaker makes tasks created
in the same millisecond reproducible across polls. Claim ownership remains a
re-read followed by compare-and-swap.

If a timestamp bucket contains at least 50 rows, Munin cannot prove that bucket
complete. Hugin reports `pagination_truncated`, treats `queue_depth` and
`queue_depth_lower_bound` as lower-bound counts, emits a rate-limited warning,
and continues claiming the oldest eligible task from all visible rows. The
paginator still walks `updated_at` values older than the overflowing bucket, so
the ambiguity does not silently stop enumeration at that boundary.

Both `/health` and `tasks/_heartbeat/status` expose the content-blind fields
`queue_depth`, `queue_depth_lower_bound`, `oldest_pending_age_s`, and
`pagination_truncated`. No task prompt or metadata is included.

## Follow-up issue: composite Munin cursor

**Problem:** A timestamp-only cursor cannot enumerate or deterministically
continue within a bucket of 50 or more rows sharing one `updated_at`
millisecond. Hugin can safely keep working, but cannot claim complete queue
visibility or exact depth.

**Proposed contract:** Add a Munin continuation cursor ordered by
`(updated_at DESC, id DESC)`. The cursor must be exclusive and opaque to
callers, and filters must remain fixed across continuation requests. Hugin can
then replace exact-timestamp boundary probes with complete composite-cursor
enumeration.

**Acceptance:**

- Enumerate more than 50 rows with identical `updated_at` without duplicates or
  omissions.
- Resume after interruption from the exclusive cursor.
- Preserve filter-only ordering and reject a cursor reused with changed filters.
- Remove Hugin's equal-time `pagination_truncated` condition only after the new
  server contract is deployed and regression-tested.
