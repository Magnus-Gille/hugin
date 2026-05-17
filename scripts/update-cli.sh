#!/bin/bash
set -euo pipefail

# Update Claude Code and Codex CLI tools
# Intended to run daily via cron on the Pi
# Logs version changes and failures to syslog (tag: hugin-update)
# Writes a one-line version status to Munin (meta/hugin/cli-versions)

export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.npm-global/bin:$PATH"

# Source the Pi .env for MUNIN_API_KEY (best-effort; Munin write is non-fatal)
if [ -f "$HOME/hugin/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME/hugin/.env"
  set +a
fi

MUNIN_URL="${MUNIN_URL:-http://localhost:3030}"

# Tracks whether any package install / smoke test failed
# (script exits non-zero at the end if set).
FAILED=0

# Always succeeds and always prints something. `npm ls` exits non-zero for a
# missing package or a damaged global tree; under `set -euo pipefail` a bare
# `v=$(installed_version ...)` would otherwise abort the script before our own
# failure handling runs (the exact silent-failure mode #60 is removing).
installed_version() {
  local pkg="$1" json ver
  json=$(npm ls -g "$pkg" --depth=0 --json 2>/dev/null || true)
  ver=$(node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); console.log(j.dependencies?.['${pkg}']?.version || 'not-installed'); }
      catch { console.log('not-installed'); }
    });
  " <<< "$json" 2>/dev/null || true)
  [ -z "$ver" ] && ver="not-installed"
  echo "$ver"
  return 0
}

update_package() {
  local pkg="$1"
  local old_version new_version

  old_version=$(installed_version "$pkg")

  echo "Updating $pkg (current: $old_version)..."
  # `npm i -g <pkg>@latest` forces cross-major upgrades; `npm update` would
  # silently stay within the pinned caret range and skip major releases.
  if ! npm i -g "${pkg}@latest" 2>&1; then
    echo "FAILED: $pkg install returned non-zero"
    logger -t hugin-update "FAILED: $pkg install returned non-zero"
    FAILED=1
    return
  fi

  new_version=$(installed_version "$pkg")

  if [ "$old_version" = "$new_version" ]; then
    echo "$pkg: already up-to-date ($new_version)"
  else
    echo "$pkg: updated $old_version -> $new_version"
    logger -t hugin-update "$pkg updated $old_version -> $new_version"
  fi
}

# Post-update smoke test: the CLI must actually run. A corrupt install
# (truncated tarball, broken bin shim) passes `npm i` but fails --version.
# Prints "ok" or "broken" to stdout (captured by the caller); all human/log
# output goes to stderr so it still reaches the cron log.
smoke_test() {
  local label="$1" cmd="$2"
  local out
  if out=$("$cmd" --version 2>&1); then
    echo "$label smoke test OK: $out" >&2
    logger -t hugin-update "$label --version OK: $out"
    echo "ok"
  else
    echo "FAILED: $label --version did not run (got: $out)" >&2
    logger -t hugin-update "FAILED: $label --version did not run"
    echo "broken"
  fi
}

# Best-effort one-line status to Munin so the other Grimnir environments
# can see CLI drift without SSH'ing to the Pi. Never fails the script, but
# logs its own failures to syslog so they aren't swallowed by silent cron.
write_munin_status() {
  local content="$1"
  if [ -z "${MUNIN_API_KEY:-}" ]; then
    echo "MUNIN_API_KEY not set — skipping Munin status write"
    logger -t hugin-update "Munin status skipped: MUNIN_API_KEY not set"
    return
  fi

  local content_json
  content_json=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$content") || {
    echo "Failed to JSON-encode Munin content — skipping"
    logger -t hugin-update "Munin status skipped: JSON encode failed"
    return
  }

  local body
  body=$(cat <<JSON_EOF
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "memory_write",
    "arguments": {
      "namespace": "meta/hugin",
      "key": "cli-versions",
      "content": ${content_json},
      "tags": ["meta", "cli-versions", "hugin"]
    }
  }
}
JSON_EOF
)

  # Capture the HTTP status via -w '%{http_code}' rather than --fail-with-body
  # (the latter needs curl >= 7.76; older Raspberry Pi OS images ship 7.74).
  # The bearer token is fed via --config on stdin so it never appears in argv
  # (process args are world-readable via /proc on Linux). Body -> temp file,
  # status code -> stdout; a connection failure yields http_code "000".
  local body_file http_code response
  body_file=$(mktemp)
  http_code=$(curl --config - -sS --max-time 10 \
    -o "$body_file" -w '%{http_code}' \
    -X POST "${MUNIN_URL}/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$body" <<CURLCFG
header = "Authorization: Bearer ${MUNIN_API_KEY}"
CURLCFG
  ) || http_code="000"
  response=$(cat "$body_file" 2>/dev/null || true)
  rm -f "$body_file"

  if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
    echo "Munin status write failed (non-fatal, HTTP ${http_code}): ${response}"
    logger -t hugin-update "FAILED: Munin status write (HTTP ${http_code})"
    return
  fi

  if echo "$response" | grep -q '"error"'; then
    echo "Munin status write returned a JSON-RPC error (non-fatal): $response"
    logger -t hugin-update "FAILED: Munin status write (JSON-RPC error)"
    return
  fi

  echo "Wrote CLI versions to Munin: meta/hugin/cli-versions"
}

echo "==> Updating CLI tools ($(date))"

update_package "@anthropic-ai/claude-code"
update_package "@openai/codex"

echo "==> Running post-update smoke tests"
CLAUDE_SMOKE=$(smoke_test "claude" "claude")
CODEX_SMOKE=$(smoke_test "codex" "codex")
if [ "$CLAUDE_SMOKE" = "broken" ]; then FAILED=1; fi
if [ "$CODEX_SMOKE" = "broken" ]; then FAILED=1; fi

# Record the actually-installed npm versions (not smoke health) so the Munin
# entry reflects "currently-installed versions" per #60's acceptance text;
# smoke health is appended as an annotation.
CLAUDE_PKG_VER=$(installed_version "@anthropic-ai/claude-code")
CODEX_PKG_VER=$(installed_version "@openai/codex")
MUNIN_CONTENT="claude-code: ${CLAUDE_PKG_VER} (smoke: ${CLAUDE_SMOKE}) | codex: ${CODEX_PKG_VER} (smoke: ${CODEX_SMOKE}) | updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_munin_status "$MUNIN_CONTENT"

if [ "$FAILED" -ne 0 ]; then
  echo "==> Update check completed WITH FAILURES"
  logger -t hugin-update "update-cli.sh completed with failures"
  exit 1
fi

echo "==> Update check complete"
