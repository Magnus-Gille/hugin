#!/bin/bash
set -euo pipefail

# Deploy Hugin to the Hugin-Munin Pi
# Usage: ./scripts/deploy-pi.sh [hostname]

PI_HOST="${1:-huginmunin.local}"
DEPLOY_USER="${DEPLOY_USER:-magnus}"
REMOTE="$DEPLOY_USER@$PI_HOST"
REMOTE_DIR="/home/$DEPLOY_USER/hugin"

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

echo "==> Installing systemd service..."
ssh "$REMOTE" "sudo cp $REMOTE_DIR/hugin.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable hugin"

echo "==> Checking for .env file..."
if ssh "$REMOTE" "test -f $REMOTE_DIR/.env"; then
  echo "  .env exists"
else
  echo "  WARNING: No .env file found at $REMOTE_DIR/.env"
  echo "  Create one with: MUNIN_API_KEY=<key>"
  echo "  Generate a key or reuse the existing Munin API key"
fi

echo "==> Ensuring workspace directory exists..."
ssh "$REMOTE" "mkdir -p /home/$DEPLOY_USER/workspace"

echo "==> Restarting service..."
ssh "$REMOTE" "sudo systemctl restart hugin && sleep 2 && sudo systemctl status hugin --no-pager"

echo ""
echo "Deploy complete!"
echo "Health check: curl http://$PI_HOST:3032/health"
echo "Logs: ssh $PI_HOST journalctl -u hugin -f"
