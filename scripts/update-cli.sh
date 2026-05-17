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

# Tracks whether any package install failed (script exits non-zero at the end)
FAILED=0

installed_version() {
  local pkg="$1"
  npm ls -g "$pkg" --depth=0 --json 2>/dev/null | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); console.log(j.dependencies?.['${pkg}']?.version || 'not-installed'); }
      catch { console.log('not-installed'); }
    });
  "
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
# Prints the version to stdout (captured by the caller); all human/log
# output goes to stderr so it still reaches the cron log.
smoke_test() {
  local label="$1" cmd="$2"
  local out
  if out=$("$cmd" --version 2>&1); then
    echo "$label smoke test OK: $out" >&2
    logger -t hugin-update "$label --version OK: $out"
    echo "$out"
  else
    echo "FAILED: $label --version did not run (got: $out)" >&2
    logger -t hugin-update "FAILED: $label --version did not run"
    echo "broken"
  fi
}

# Best-effort one-line status to Munin so the other Grimnir environments
# can see CLI drift without SSH'ing to the Pi. Never fails the script.
write_munin_status() {
  local claude_v="$1" codex_v="$2"
  if [ -z "${MUNIN_API_KEY:-}" ]; then
    echo "MUNIN_API_KEY not set — skipping Munin status write"
    return
  fi

  local content
  content="claude-code: ${claude_v} | codex: ${codex_v} | updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local content_json
  content_json=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$content") || {
    echo "Failed to JSON-encode Munin content — skipping"
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

  local response
  if response=$(curl -s --max-time 10 -X POST "${MUNIN_URL}/mcp" \
    -H "Authorization: Bearer ${MUNIN_API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$body"); then
    if echo "$response" | grep -q '"error"'; then
      echo "Munin status write returned an error (non-fatal): $response"
    else
      echo "Wrote CLI versions to Munin: meta/hugin/cli-versions"
    fi
  else
    echo "Munin status write failed (non-fatal, host unreachable?)"
  fi
}

echo "==> Updating CLI tools ($(date))"

update_package "@anthropic-ai/claude-code"
update_package "@openai/codex"

echo "==> Running post-update smoke tests"
CLAUDE_VERSION=$(smoke_test "claude" "claude")
CODEX_VERSION=$(smoke_test "codex" "codex")
if [ "$CLAUDE_VERSION" = "broken" ]; then FAILED=1; fi
if [ "$CODEX_VERSION" = "broken" ]; then FAILED=1; fi

write_munin_status "$CLAUDE_VERSION" "$CODEX_VERSION"

if [ "$FAILED" -ne 0 ]; then
  echo "==> Update check completed WITH FAILURES"
  logger -t hugin-update "update-cli.sh completed with failures"
  exit 1
fi

echo "==> Update check complete"
