# Hugin R-exact configuration store

`HUGIN_R_EXACT_CONFIG_ROOT` is the owner-installed absolute path for Hugin's
durable R-exact configuration state. The live Orin macro selector reads only
that store. If the variable is absent, unsafe, missing, corrupt, or contended,
the selector returns no route; it never falls back to an in-module route map.

The store is a local, mode-0700 resource. Its sole concrete adapter target is
`hugin-orin-macro-routing`; prompt, harness, and tool-policy remain
proposal-only W4.1 concepts and have no config adapter here. The payload is a
canonical, unique subset (including empty) of exactly four reviewed
`homeserver` `classify|extract` `public|internal` leaves, each immutably pinned
to `orin` / `qwen2.5-coder:3b`. A promotion therefore changes the live
selector, and exact recovery proves the prior selector behavior.

Every mutation uses an immediate exclusive cross-process lock. On Linux the
lock records boot ID, PID start time, and its exact device/inode; only a lock
proven stale by boot change, process absence, or PID-start mismatch is moved
away atomically for takeover. A live, corrupt, unreadable, or contended lock
fails closed without waiting. The selector emits at most one path-free
diagnostic per missing/corrupt/contended reason and otherwise returns no route.

The store validates the entire closed state, writes a unique fsynced temporary
file, renames it atomically, then fsyncs the directory; a failed write removes
only its own UUID-bound temporary file. Staged documents and snapshots are
bounded (64 and 32 respectively), retaining current and recovery-referenced
documents before deterministic cache pruning. Stored candidates and
current/snapshot documents are revalidated and digest-bound on every read.

This composition makes the macro-routing target real: staged R-exact changes
are visible to `selectOrinMacroRoute`, persist across restart, and an exact
recovery returns the selector to its snapshot baseline. The store does not
install a controller/watchdog/recovery service, owner authority, journal
backend, or an arming mechanism. Those remain a separate W0 runtime
composition/deployment dependency; this repository ships no live root or
environment file.
