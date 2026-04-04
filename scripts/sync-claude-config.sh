#!/bin/bash
set -euo pipefail

# Sync global ~/.claude/ config from laptop to Pi
# Usage: ./scripts/sync-claude-config.sh [hostname]

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
REMOTE_CLAUDE_DIR="/home/$DEPLOY_USER/.claude"
LOCAL_CLAUDE_DIR="$HOME/.claude"

if [ ! -d "$LOCAL_CLAUDE_DIR" ]; then
  echo "ERROR: Local ~/.claude/ directory not found"
  exit 1
fi

echo "==> Syncing global Claude config to $REMOTE..."

# Ensure remote .claude directory exists
ssh "$REMOTE" "mkdir -p $REMOTE_CLAUDE_DIR/skills $REMOTE_CLAUDE_DIR/commands"

# Sync CLAUDE.md (global instructions)
if [ -f "$LOCAL_CLAUDE_DIR/CLAUDE.md" ]; then
  echo "  Syncing CLAUDE.md..."
  rsync -av "$LOCAL_CLAUDE_DIR/CLAUDE.md" "$REMOTE:$REMOTE_CLAUDE_DIR/CLAUDE.md"
fi

# Sync skills/ directory
if [ -d "$LOCAL_CLAUDE_DIR/skills" ]; then
  echo "  Syncing skills/..."
  rsync -av --delete "$LOCAL_CLAUDE_DIR/skills/" "$REMOTE:$REMOTE_CLAUDE_DIR/skills/"
fi

# Sync commands/ directory
if [ -d "$LOCAL_CLAUDE_DIR/commands" ]; then
  echo "  Syncing commands/..."
  rsync -av --delete "$LOCAL_CLAUDE_DIR/commands/" "$REMOTE:$REMOTE_CLAUDE_DIR/commands/"
fi

# Sync settings.json with hooks stripped out
if [ -f "$LOCAL_CLAUDE_DIR/settings.json" ]; then
  echo "  Syncing settings.json (excluding hooks)..."
  # Use node to strip hooks and laptop-specific entries
  node -e "
    const fs = require('fs');
    const settings = JSON.parse(fs.readFileSync('$LOCAL_CLAUDE_DIR/settings.json', 'utf8'));
    // Remove hooks (Pi environment differs)
    delete settings.hooks;
    // Remove any laptop-specific paths that won't exist on Pi
    console.log(JSON.stringify(settings, null, 2));
  " | ssh "$REMOTE" "cat > $REMOTE_CLAUDE_DIR/settings.json"
fi

echo "==> Claude config sync complete!"
