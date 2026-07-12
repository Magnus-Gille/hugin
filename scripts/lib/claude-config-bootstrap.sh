#!/usr/bin/env bash
# claude-config bootstrap helper for deploy-pi.sh (issue #153).
#
# claude-config is optional infra for a Hugin deploy — tracked separately as
# claude-config#2, not a Hugin concern. A missing checkout is expected and
# informational, not a deploy WARNING. An existing checkout that fails to
# pull/bootstrap is a real problem (something broke), so that stays a
# WARNING with its own distinct message.

claude_config_bootstrap() {
  local remote="$1"
  if ssh "$remote" "test -d ~/repos/claude-config/.git"; then
    ssh "$remote" 'cd ~/repos/claude-config && git pull -q --ff-only && ./bootstrap.sh --no-plugins' \
      || echo "  WARNING: claude-config bootstrap failed (checkout exists but pull/bootstrap errored) — inspect ~/repos/claude-config on the Pi."
  else
    echo "  INFO: ~/repos/claude-config not found on the Pi — bootstrap is optional infra (tracked separately, see claude-config#2) and was skipped."
    echo "  To enable it: ssh $remote 'git clone git@github.com:Magnus-Gille/claude-config.git ~/repos/claude-config && ~/repos/claude-config/bootstrap.sh --no-plugins'"
  fi
}
