#!/bin/bash
# Enable the durable MCP Broker on a configured host and register hugin-mcp locally.
#
# Generates (or safely reuses) a 64-char hex token on the Pi, binds the Broker
# to the Pi's Tailscale IP, restarts hugin, verifies both services, and
# registers the hugin-mcp MCP on the laptop pointing at that tailnet-only bind.
#
# The token is held in a shell variable for the duration of the run and never
# echoed. The script prints status only — no secret output.
#
# Usage: ./scripts/enable-broker.sh [hostname]
#   Default hostname: $HUGIN_DEPLOY_HOST or hugin.local

set -euo pipefail

PI_HOST="${1:-${HUGIN_DEPLOY_HOST:-hugin.local}}"
DEPLOY_USER="${DEPLOY_USER:-hugin}"
REMOTE="${DEPLOY_USER}@$PI_HOST"
REMOTE_DIR="${HUGIN_DEPLOY_DIR:-/var/lib/hugin/app}"
REMOTE_ENV="$REMOTE_DIR/.env"
# Heimdall owns 3033 and Ratatoskr owns 3034 on the Pi's tailnet address.
# Keep Hugin on a dedicated production port; the generic Broker default
# remains 3033 for other installations.
BROKER_PORT="3035"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_PATH="$(cd "$SCRIPT_DIR/.." && pwd)/dist/mcp-server.js"
if [ ! -f "$DIST_PATH" ]; then
  echo "ERROR: $DIST_PATH not found. Run 'npm run build' first." >&2
  exit 1
fi

echo "==> Resolving the Pi's tailnet-only Broker bind..."
BROKER_HOST=$(ssh "$REMOTE" 'tailscale ip -4 2>/dev/null | sed -n "1p"')
if ! [[ "$BROKER_HOST" =~ ^100\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: Could not resolve a valid Tailscale IPv4 address for the Pi." >&2
  exit 1
fi

echo "==> Checking Pi for existing HUGIN_BROKER_KEYS..."
if ssh "$REMOTE" "grep -q '^HUGIN_BROKER_KEYS=' '$REMOTE_ENV'" 2>/dev/null; then
  echo "    Reusing the existing claude-code token (kept in-memory only)."
  TOKEN=$(ssh "$REMOTE" "node -e 'const fs=require(\"fs\");const line=fs.readFileSync(process.argv[1],\"utf8\").split(/\\r?\\n/).find((x)=>x.startsWith(\"HUGIN_BROKER_KEYS=\"));if(!line)process.exit(2);const keys=JSON.parse(line.slice(line.indexOf(\"=\")+1));const token=keys[\"claude-code\"];if(typeof token!==\"string\")process.exit(3);process.stdout.write(token)' '$REMOTE_ENV'")
else
  echo "==> Generating broker token on Pi (kept in-memory only)..."
  # Generate the token on the Pi. It crosses to the laptop only in this shell
  # variable so the local MCP client can be configured; it is never echoed.
  TOKEN=$(ssh "$REMOTE" 'TOKEN=$(openssl rand -hex 32); printf "HUGIN_BROKER_KEYS={\"claude-code\":\"%s\"}\n" "$TOKEN" >> '"$REMOTE_ENV"'; printf "%s" "$TOKEN"')
fi

if ! [[ "$TOKEN" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "ERROR: Broker token load/generation failed." >&2
  exit 1
fi

echo "==> Configuring tailnet-only Broker bind..."
ssh "$REMOTE" "if grep -q '^HUGIN_BROKER_HOST=' '$REMOTE_ENV'; then sed -i 's/^HUGIN_BROKER_HOST=.*/HUGIN_BROKER_HOST=$BROKER_HOST/' '$REMOTE_ENV'; else printf 'HUGIN_BROKER_HOST=$BROKER_HOST\\n' >> '$REMOTE_ENV'; fi"
ssh "$REMOTE" "if grep -q '^HUGIN_BROKER_PORT=' '$REMOTE_ENV'; then sed -i 's/^HUGIN_BROKER_PORT=.*/HUGIN_BROKER_PORT=$BROKER_PORT/' '$REMOTE_ENV'; else printf 'HUGIN_BROKER_PORT=$BROKER_PORT\\n' >> '$REMOTE_ENV'; fi"

echo "==> Restarting hugin on Pi..."
ssh "$REMOTE" 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart hugin'

echo "==> Verifying hugin came back up..."
sleep 2
HEALTH=$(ssh "$REMOTE" 'curl -fsS http://127.0.0.1:3032/health 2>/dev/null || echo FAIL')
if [[ "$HEALTH" != *'"status":"ok"'* ]]; then
  echo "WARNING: hugin health returned an unhealthy response."
  echo "Check: ssh $REMOTE 'XDG_RUNTIME_DIR=/run/user/\$(id -u) journalctl --user -u hugin -n 50'"
else
  echo "    hugin health: ok"
fi

BROKER_HEALTH=$(ssh "$REMOTE" "curl -fsS http://$BROKER_HOST:$BROKER_PORT/health 2>/dev/null || echo FAIL")
if [[ "$BROKER_HEALTH" != *'"service":"hugin-broker"'* ]]; then
  echo "ERROR: Broker is not reachable on its tailnet bind." >&2
  unset TOKEN
  exit 1
else
  echo "    hugin Broker health: ok (tailnet-only)"
fi

echo "==> Registering hugin-mcp on laptop..."
# Build the MCP config JSON inline. claude mcp add-json takes a single JSON arg.
# We use printf to assemble it so the token never crosses an echo'd argv.
MCP_JSON=$(printf '{"command":"node","args":["%s"],"env":{"HUGIN_BROKER_URL":"http://%s:%s","HUGIN_BROKER_TOKEN":"%s"}}' \
  "$DIST_PATH" "$BROKER_HOST" "$BROKER_PORT" "$TOKEN")

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
