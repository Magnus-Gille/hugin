#!/bin/bash
# Enable the orchestrator-v1 broker on the Pi and register hugin-mcp locally.
#
# Generates a 64-char hex token on the Pi, appends HUGIN_BROKER_KEYS to the
# Pi's .env (only if the var isn't already set), restarts hugin, and registers
# the hugin-mcp MCP on the laptop pointing at the Pi over Tailscale.
#
# The token is held in a shell variable for the duration of the run and never
# echoed. The script prints status only — no secret output.
#
# Usage: ./scripts/enable-broker.sh [hostname]
#   Default hostname: huginmunin.local (or 100.97.117.37 fallback)

set -euo pipefail

PI_HOST="${1:-}"
if [ -z "$PI_HOST" ]; then
  if ping -c1 -W1 huginmunin.local >/dev/null 2>&1; then
    PI_HOST="huginmunin.local"
  else
    PI_HOST="100.97.117.37"
  fi
fi
REMOTE="magnus@$PI_HOST"
REMOTE_ENV="/home/magnus/repos/hugin/.env"

DIST_PATH="/Users/magnus/repos/hugin/dist/mcp-server.js"
if [ ! -f "$DIST_PATH" ]; then
  echo "ERROR: $DIST_PATH not found. Run 'npm run build' first." >&2
  exit 1
fi

echo "==> Checking Pi for existing HUGIN_BROKER_KEYS..."
if ssh "$REMOTE" "grep -q '^HUGIN_BROKER_KEYS=' '$REMOTE_ENV'" 2>/dev/null; then
  echo "    Pi .env already has HUGIN_BROKER_KEYS. Skipping token generation."
  echo "    To rotate, remove the line manually first."
  exit 1
fi

echo "==> Generating broker token on Pi (kept in-memory only)..."
# Generate the token on the Pi (so it never crosses the laptop except as MCP arg later).
# The token lands in a remote shell variable, gets appended to .env, then is
# printed *only* on stdout for the laptop to pipe straight into `claude mcp
# add-json`. We capture it into a local shell var; nothing echoes it.
TOKEN=$(ssh "$REMOTE" 'TOKEN=$(openssl rand -hex 32); printf "HUGIN_BROKER_KEYS={\"claude-code\":\"%s\"}\n" "$TOKEN" >> '"$REMOTE_ENV"'; printf "%s" "$TOKEN"')

if [ -z "$TOKEN" ] || [ "${#TOKEN}" -ne 64 ]; then
  echo "ERROR: Token generation failed (got ${#TOKEN} chars)." >&2
  exit 1
fi

echo "==> Restarting hugin on Pi..."
ssh "$REMOTE" 'XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart hugin'

echo "==> Verifying hugin came back up..."
sleep 2
HEALTH=$(ssh "$REMOTE" 'curl -fsS http://127.0.0.1:3032/healthz 2>/dev/null || echo FAIL')
if [ "$HEALTH" != "ok" ]; then
  echo "WARNING: hugin healthz returned: $HEALTH"
  echo "Check: ssh $REMOTE 'XDG_RUNTIME_DIR=/run/user/1000 journalctl --user -u hugin -n 50'"
else
  echo "    hugin healthz: ok"
fi

echo "==> Registering hugin-mcp on laptop..."
# Build the MCP config JSON inline. claude mcp add-json takes a single JSON arg.
# We use printf to assemble it so the token never crosses an echo'd argv.
MCP_JSON=$(printf '{"command":"node","args":["%s"],"env":{"HUGIN_BROKER_URL":"http://%s:3033","HUGIN_BROKER_TOKEN":"%s"}}' \
  "$DIST_PATH" "$PI_HOST" "$TOKEN")

# Remove any existing registration so we don't 409 on conflict
claude mcp remove hugin -s user 2>/dev/null || true

if ! claude mcp add-json hugin "$MCP_JSON" -s user >/dev/null 2>/tmp/hugin-mcp-add.err; then
  # Redact any JSON payload from the error output before showing it
  sed 's/"HUGIN_BROKER_TOKEN":"[^"]*"/"HUGIN_BROKER_TOKEN":"<redacted>"/g' /tmp/hugin-mcp-add.err >&2
  rm -f /tmp/hugin-mcp-add.err
  echo "ERROR: claude mcp add-json failed (token preserved on Pi)." >&2
  exit 1
fi
rm -f /tmp/hugin-mcp-add.err

# Clear the token from memory before exit (best-effort)
unset TOKEN MCP_JSON

echo "==> Done."
echo ""
echo "Next: in a NEW Claude Code session, run 'claude mcp list' to confirm"
echo "      hugin shows as ✓ Connected, then try /delegate."
