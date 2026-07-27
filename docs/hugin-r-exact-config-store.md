# Hugin R-exact configuration store

`HUGIN_R_EXACT_CONFIG_ROOT` is the owner-installed absolute path for Hugin's
durable R-exact configuration state. The live Orin macro selector reads only
that store. If the variable is absent, unsafe, missing, corrupt, or contended,
the selector returns no route; it never falls back to an in-module route map.

The store is a local, mode-0700 resource. Every mutation uses an exclusive
cross-process lock, validates the entire closed state, writes a unique fsynced
temporary file, renames it atomically, then fsyncs the directory. Stored
candidates and current/snapshot documents are revalidated and digest-bound on
every read.

This composition makes the macro-routing target real: staged R-exact changes
are visible to `selectOrinMacroRoute`, persist across restart, and an exact
recovery returns the selector to its snapshot baseline. The store does not
install a controller/watchdog/recovery service, owner authority, journal
backend, or an arming mechanism. Those remain a separate W0 runtime
composition/deployment dependency; this repository ships no live root or
environment file.
