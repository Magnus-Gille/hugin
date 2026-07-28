# Hugin R-exact configuration store

`HUGIN_R_EXACT_CONFIG_ROOT` is the owner-installed absolute path for Hugin's
durable R-exact configuration state. The live Orin macro selector reads only
that store. If the variable is absent or the store is unsafe, missing, corrupt,
or over its closed bounds, the selector returns no route; it never falls back
to an in-module route map.

The store is a local, mode-0700 resource. Its sole concrete adapter target is
`hugin-orin-macro-routing`; prompt, harness, and tool-policy remain
proposal-only W4.1 concepts and have no config adapter here. The payload is a
canonical, unique subset (including empty) of exactly four reviewed
`homeserver` `classify|extract` `public|internal` leaves, each immutably pinned
to `orin` / `qwen2.5-coder:3b`. A promotion therefore changes the live
selector, and exact recovery proves the prior selector behavior.

Every mutation uses an immediate, nonblocking exclusive lock on one persistent
mode-0600 lock inode. On Linux, Hugin opens that inode with `O_NOFOLLOW`, passes
the descriptor to `/usr/bin/flock`, and has the helper acquire `flock(2)` on
the inherited descriptor. The inherited helper descriptor and Hugin's parent
descriptor share one open file description, so the parent descriptor keeps
the kernel lock after the helper exits. Closing that descriptor releases the
lock atomically; process death, including `SIGKILL`, closes it and therefore
releases the lock too. A contended lock fails immediately. A missing or failed
`/usr/bin/flock` fails closed without running the mutation.

The persistent lock file contains no authoritative owner or stale-lease
metadata. Hugin never decides staleness from a boot ID, PID, or process start
time, and it never reclaims, renames, or unlinks the lock path. Before running
the mutation it verifies that the private, single-link regular pathname still
names the inode opened and locked by descriptor. The Linux lock is advisory:
it coordinates cooperating Hugin writers. The mode-0700 root and its Unix
owner are an explicit trust boundary, not a defense against a hostile process
running as that same owner that ignores the lock or replaces store pathnames.

On non-Linux developer and test hosts, the adapter provides only
process-local, fail-fast exclusion. It does not claim cross-process safety
there; the supported deployment platform is Linux. The live selector does not
take the mutation lock. It reads the complete old or new store produced by the
atomic rename and therefore does not wait or return a contention result. It
emits at most one path-free diagnostic per missing or corrupt store reason and
otherwise returns no route.

The serialized store has a closed maximum size of 262,144 bytes (256 KiB),
checked from metadata before reading and again from the bytes read before JSON
parsing. The raw `documents` and `snapshots` objects are limited to 64 and 32
entries respectively; those cardinalities are rejected before individual
candidates, snapshots, or documents are deeply validated. Mutations enforce
the same limits by retaining current and recovery-referenced documents before
deterministic cache pruning.

Within those bounds, the store validates the entire closed state, writes a
unique fsynced temporary file, renames it atomically, then fsyncs the
directory; a failed write removes only its own UUID-bound temporary file.
Stored candidates and current/snapshot documents are revalidated and
digest-bound on every read.

This composition makes the macro-routing target real: staged R-exact changes
are visible to `selectOrinMacroRoute`, persist across restart, and an exact
recovery returns the selector to its snapshot baseline. The store does not
install a controller/watchdog/recovery service, owner authority, journal
backend, or an arming mechanism. Those remain a separate W0 runtime
composition/deployment dependency; this repository ships no live root or
environment file.
