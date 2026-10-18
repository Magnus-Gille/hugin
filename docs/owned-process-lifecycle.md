# Hugin-owned subprocess lifecycle

Hugin launches the Codex CLI, OpenCode, Pi orchestration workers, and the
research `bwrap`/Pi runtime in an owned POSIX process group. Launch options
retain their requested working directory, environment, and stdio while setting
`detached: true` to create the new group. Hugin accepts a group ID only from a
successful child `spawn` event and only when the reported PID is an integer
greater than 1.

Timeout, operator cancellation, and dispatcher shutdown send SIGTERM to the
whole owned group. The timeout path starts termination before requesting a
partial Munin result write. That partial write has a bounded request deadline
and uses create-if-absent, so a late timeout write cannot replace a terminal
result. Shutdown closes admission of new owned processes synchronously before
taking the cleanup snapshot, then tracks each launch as soon as its lifecycle
object is created and waits a bounded interval for the spawn/error event. A
Codex sandbox preflight that finishes after cancellation or shutdown returns a
normal failed executor result without starting the Codex child. If the group remains after the grace period, Hugin
sends SIGKILL and waits for group disappearance. It determines completion from
group state and exit/close events, never from `ChildProcess.killed`. ESRCH
retires the group handle permanently; Hugin does not retry that numeric handle
or fall back to signaling an individual child PID. This prevents later cleanup
retries after observed disappearance, though POSIX cannot eliminate PID reuse
between a liveness check and a signal. Runtime completion awaits
the bounded group cleanup and surfaces a bounded cleanup failure if signaling
or verification fails. A normally exiting leader also triggers cleanup, so
background descendants left in its group do not outlive the task.

The Claude Agent SDK owns its internal child process and exposes no Hugin-owned
PID. Hugin keeps the SDK abort signal and its bounded query-close fallback;
shutdown invokes that abort before any Munin persistence.

This is process-group cleanup, not a universal process-tree containment
boundary. A descendant that deliberately starts a new session or otherwise
escapes the group is outside this mechanism. Stronger containment for hostile
or escape-capable workloads requires a separate OS boundary such as cgroups.
The group-dependent executor path fails closed on Windows, which is not a
supported production target.
