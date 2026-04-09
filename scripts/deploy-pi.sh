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

echo "==> Building locally..."
npm run build

echo "==> Syncing to $REMOTE:$REMOTE_DIR..."
rsync -av --delete \
  --exclude='node_modules/' \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='tests/' \
  --exclude='.DS_Store' \
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

echo "==> Syncing global Claude config..."
"$(dirname "$0")/sync-claude-config.sh" "$PI_HOST"

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
