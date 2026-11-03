# Installed CLI observation and promotion

The daily 04:00 `scripts/update-cli.sh` job observes the installed Claude Code
and Codex commands. Despite its retained filename, it never installs or updates
packages. The stable `hugin-update` syslog tag and Munin
`meta/hugin/cli-versions` key remain. Observations contain npm-global package
versions, separate CLI health, and a `checked` timestamp. A missing or broken
CLI fails the check; unavailable optional Munin reporting is nonfatal.

The command PATH matches Hugin's service order: the account's `.npm-global/bin`,
then `.local/bin`, then system directories. A standalone executable may differ
from the npm-global package metadata. Hugin's Claude runtime uses the locked
project Agent SDK; this observation of the global Claude CLI does not attest to
the SDK version. Deploying the locked project dependencies remains separate.

The task executor uses `codex exec --sandbox workspace-write -c
'approval_policy="on-request"' -- <prompt>`. This preserves the former
`--full-auto` sandbox/approval intent without relying on that removed shorthand.
The option terminator keeps task text from changing CLI options. The existing
model-free sandbox preflight still runs before dispatch; it does not prove CLI
argument compatibility. During promotion, also check the actual service-PATH
executable with these options followed by `--help` (before the `--` terminator),
without invoking a model. Do not replace them with approval or sandbox bypasses.

CLI promotion is an explicit operator release, separate from this cron job:

1. Select an exact package version and immutable registry integrity value.
   Review provenance, release changes, and the package's execution hooks.
2. Stage that artifact in an isolated environment with no production credentials;
   verify integrity, version, runtime compatibility and sandbox behavior.
3. Prepare the named target, exact artifact, acceptance checks, and a retained
   previous artifact for rollback. Obtain the required release authorization.
4. Promote the accepted artifact explicitly, verify it through the service PATH
   and in-service runtime checks, and record the action and rollback receipt.

This change does not implement an automatic promoter, select new package
versions, install packages, or alter the separately pinned research Pi harness.
Do not restore an unattended `@latest` install as a migration shortcut.
