#!/usr/bin/env bash
# claude-config bootstrap helper for deploy-pi.sh (issue #153).
#
# claude-config is optional infra for a Hugin deploy — tracked separately as
# claude-config#2, not a Hugin concern. A missing checkout is expected and
# informational, not a deploy WARNING. An existing (or unprovable) checkout
# is treated as a real problem: a broken pull/bootstrap AND an inconclusive
# presence probe both stay a WARNING, each with its own distinct message.
#
# The presence probe relies on ssh's own exit-code convention: 0 means the
# remote `test` ran and succeeded (checkout present), 1 means it ran and
# failed (checkout genuinely absent), anything else means ssh itself could
# not run the check at all (network/auth/timeout) — absence must never be
# assumed in that case.

claude_config_bootstrap() {
  local remote="$1"
  local probe_rc=0

  ssh "$remote" "test -d ~/repos/claude-config" || probe_rc=$?

  if [ "$probe_rc" -eq 0 ]; then
    ssh "$remote" 'cd ~/repos/claude-config && git pull -q --ff-only && ./bootstrap.sh --no-plugins' \
      || echo "  WARNING: claude-config bootstrap failed (checkout exists but pull/bootstrap errored) — inspect ~/repos/claude-config on the Pi."
  elif [ "$probe_rc" -eq 1 ]; then
    echo "  INFO: ~/repos/claude-config not found on the Pi — bootstrap is optional infra (tracked separately, see claude-config#2) and was skipped."
    echo "  To enable it: ssh $remote 'git clone git@github.com:Magnus-Gille/claude-config.git ~/repos/claude-config && ~/repos/claude-config/bootstrap.sh --no-plugins'"
  else
    echo "  WARNING: could not determine whether claude-config is checked out on the Pi (ssh probe exited $probe_rc) — check SSH connectivity, then inspect ~/repos/claude-config manually."
  fi
}
