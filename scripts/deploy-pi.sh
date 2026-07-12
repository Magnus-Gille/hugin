#!/bin/bash
set -euo pipefail

# Deploy Hugin to the Hugin-Munin Pi
# Usage: ./scripts/deploy-pi.sh [hostname]

TAILSCALE_IP="100.97.117.37"
if [ -n "${1:-}" ]; then
  PI_HOST="$1"
elif ping -c1 -W1 huginmunin.local >/dev/null 2>&1; then
  PI_HOST="huginmunin.local"
else
  echo "  mDNS unavailable, falling back to Tailscale IP"
  PI_HOST="$TAILSCALE_IP"
fi
DEPLOY_USER="${DEPLOY_USER:-magnus}"
REMOTE="$DEPLOY_USER@$PI_HOST"
REMOTE_DIR="/home/$DEPLOY_USER/repos/hugin"

# Node_modules preflight + hardened rsync exclusion (issue #187). See
# scripts/lib/node-modules-preflight.sh for the full incident writeup.
# shellcheck source=lib/node-modules-preflight.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/node-modules-preflight.sh"

echo "==> node_modules preflight (issue #187)..."
node_modules_preflight_check "." || exit 1

echo "==> Building locally..."
npm run build

echo "==> Syncing to $REMOTE:$REMOTE_DIR..."
rsync -av --delete \
  "${DEPLOY_RSYNC_EXCLUDE_ARGS[@]}" \
  ./ "$REMOTE:$REMOTE_DIR/"

echo "==> Installing dependencies on Pi..."
ssh "$REMOTE" "cd $REMOTE_DIR && npm install --omit=dev"

echo "==> Removing legacy system-level service (one-time migration, idempotent)..."
ssh "$REMOTE" "
  if systemctl is-enabled hugin.service --quiet 2>/dev/null; then
    sudo systemctl stop hugin.service 2>/dev/null || true
    sudo systemctl disable hugin.service 2>/dev/null || true
    sudo rm -f /etc/systemd/system/hugin.service
    sudo systemctl daemon-reload
    echo '  Legacy system-level hugin.service removed'
  else
    echo '  No legacy system-level service found, skipping'
  fi
"

echo "==> Installing user-level systemd service..."
ssh "$REMOTE" "
  mkdir -p ~/.config/systemd/user
  cp $REMOTE_DIR/hugin.service ~/.config/systemd/user/hugin.service
  XDG_RUNTIME_DIR=/run/user/1000 systemctl --user daemon-reload
  XDG_RUNTIME_DIR=/run/user/1000 systemctl --user enable hugin.service
  loginctl enable-linger magnus 2>/dev/null || true
"

echo "==> Checking for .env file..."
if ssh "$REMOTE" "test -f $REMOTE_DIR/.env"; then
  echo "  .env exists"
else
  echo "  WARNING: No .env file found at $REMOTE_DIR/.env"
  echo "  Create one with: MUNIN_API_KEY=<key>"
  echo "  Generate a key or reuse the existing Munin API key"
fi

echo "==> Artefact-delivery preflight (issue #68)..."
# The deliverer runs ON the Pi and ships to the NAS over SSH+rsync from the
# systemd-user environment. Probe SSH (BatchMode, no prompts), rsync, and a
# write/read/delete round-trip BEFORE enabling HUGIN_DELIVERY_POLICY=require.
# Non-fatal: the runtime checkpoint + failure handling are the real safety net
# (a probe can pass while the long-running unit later loses env/keys/NAS), so a
# probe failure is a loud WARNING, not a hard deploy stop.
# Single source of truth: derive the probe target from the first
# HUGIN_DELIVERY_TARGETS tuple (same allowlist the runtime enforces), so the
# preflight cannot drift from the actual delivery target (Codex review #6).
# Falls back to the built-in default NAS when the env var is unset.
read -r DELIVERY_NAS_USER DELIVERY_NAS_HOST DELIVERY_NAS_DIR <<EOF
$(HUGIN_DELIVERY_TARGETS="${HUGIN_DELIVERY_TARGETS:-}" node -e '
  const raw = process.env.HUGIN_DELIVERY_TARGETS;
  let t = { user: "magnus", host: "100.99.119.52", remotePathPrefix: "/home/magnus/mimir-inbox/" };
  if (raw && raw.trim()) {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr[0]) t = arr[0];
  }
  const dir = String(t.remotePathPrefix).replace(/\/$/, "");
  process.stdout.write(`${t.user} ${t.host} ${dir}`);
' 2>/dev/null || echo "magnus 100.99.119.52 /home/magnus/mimir-inbox")
EOF
if ssh "$REMOTE" "
  set -e
  export HOME=/home/$DEPLOY_USER
  command -v rsync >/dev/null || { echo 'rsync missing on Pi'; exit 1; }
  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 \
    $DELIVERY_NAS_USER@$DELIVERY_NAS_HOST -- \
    \"mkdir -p $DELIVERY_NAS_DIR && touch $DELIVERY_NAS_DIR/.hugin-preflight && rm -f $DELIVERY_NAS_DIR/.hugin-preflight\"
"; then
  echo "  OK: Pi → NAS SSH/rsync write/read/delete probe passed"
else
  echo "  WARNING: artefact-delivery preflight FAILED."
  echo "  Do NOT set HUGIN_DELIVERY_POLICY=require until SSH keys / BatchMode /"
  echo "  NAS reachability are fixed (else delivery-capable tasks will fail)."
fi

echo "==> Codex sandbox preflight (issue #59)..."
# Codex's `codex exec` sandboxes shell commands and apply_patch through
# bubblewrap. When the system `bwrap` is missing, Codex silently falls back to a
# VENDORED bwrap that is incompatible with the Pi kernel: every shell command and
# file write fails with `bwrap: loopback: Failed to create NETLINK_ROUTE socket`,
# yet the task still exits 0 — so codex tasks "succeed" while delivering nothing
# (issue #59). Ensure the system bwrap exists AND can actually create the
# network namespace + loopback that Codex relies on. Non-fatal WARNING: this only
# affects the codex runtime, so it must not block a deploy that runs claude/ollama
# tasks. The runtime fix is `sudo apt install bubblewrap`.
if ssh "$REMOTE" "
  command -v bwrap >/dev/null 2>&1 || { echo 'NO_BWRAP'; exit 1; }
  # Mirror codex's usage: unshare the network namespace and bring up loopback.
  # This is the exact path that fails with the vendored bwrap on the Pi kernel.
  bwrap --unshare-net --ro-bind / / --dev /dev /bin/true 2>/dev/null || { echo 'BWRAP_NETNS_FAIL'; exit 1; }
"; then
  echo "  OK: system bwrap present and network-namespace probe passed (codex sandbox healthy)"
else
  echo "  WARNING: codex sandbox preflight FAILED."
  echo "  Codex tasks will exit 0 but deliver nothing (vendored-bwrap fallback is"
  echo "  incompatible with the Pi kernel). Fix on the Pi: sudo apt install bubblewrap"
  echo "  then re-run this probe. Until then, do not route code-capable tasks to codex."
fi

echo "==> Refreshing Claude config on the Pi (claude-config bootstrap)..."
# Config now lives in the versioned Magnus-Gille/claude-config repo (+ claude-skills,
# skills-private), consumed via symlinks. Pull latest + re-run bootstrap instead of the
# old rsync (which would clobber the symlinks with real dirs). See claude-config/README.md.
# See scripts/lib/claude-config-bootstrap.sh (issue #153): missing checkout is optional
# infra and informational, a broken existing checkout stays a real WARNING.
# shellcheck source=lib/claude-config-bootstrap.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/claude-config-bootstrap.sh"
claude_config_bootstrap "$REMOTE"

echo "==> Installing CLI update cron job..."
CRON_CMD="0 4 * * * $REMOTE_DIR/scripts/update-cli.sh 2>&1 | logger -t hugin-update"
ssh "$REMOTE" "crontab -l 2>/dev/null | grep -v 'update-cli.sh' | { cat; echo '$CRON_CMD'; } | crontab -"
echo "  Cron installed: daily at 04:00"

echo "==> Ensuring workspace directory exists..."
ssh "$REMOTE" "mkdir -p /home/$DEPLOY_USER/workspace"

echo "==> Syncing Pi git repo..."
ssh "$REMOTE" "cd $REMOTE_DIR && git fetch origin && git reset --hard origin/main"

echo "==> Killing orphan Hugin processes..."
ssh "$REMOTE" "SYSPID=\$(XDG_RUNTIME_DIR=/run/user/1000 systemctl --user show hugin.service --property=MainPID --value 2>/dev/null || echo 0)
for pid in \$(pgrep -f 'node dist/index.js'); do
  if [ \"\$pid\" = \"\$SYSPID\" ]; then continue; fi
  CWD=\$(readlink /proc/\$pid/cwd 2>/dev/null || echo '')
  if [ \"\$CWD\" = '$REMOTE_DIR' ]; then
    echo \"  Killing orphan Hugin PID \$pid\"
    kill \"\$pid\" 2>/dev/null || true
  fi
done"

echo "==> Restarting service..."
ssh "$REMOTE" "XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart hugin.service && sleep 2 && XDG_RUNTIME_DIR=/run/user/1000 systemctl --user status hugin.service --no-pager"

echo "==> Health check..."
ssh "$REMOTE" "curl -fsS http://127.0.0.1:3032/health"

echo ""
echo "Deploy complete!"
echo "Health check: curl http://$PI_HOST:3032/health"
echo "Logs: ssh $PI_HOST journalctl --user -u hugin.service -f"
