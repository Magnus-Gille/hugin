#!/usr/bin/env bash
# Shared remote prerequisite command blocks for deploy-pi.sh and its hermetic
# regression test. The returned strings are executed by the remote shell.

research_pi_install_block() {
  local package="$1"
  local version="$2"
  local remote_dir="$3"

  cat <<EOF
  set -e
  NPM_GLOBAL_PREFIX="\$HOME/.npm-global"
  mkdir -p "\$NPM_GLOBAL_PREFIX"
  npm install --global --prefix "\$NPM_GLOBAL_PREFIX" --ignore-scripts '$package@$version'
  case "\$NPM_GLOBAL_PREFIX" in
    /*) ;;
    *) echo 'npm global prefix is not absolute' >&2; exit 1 ;;
  esac
  PI_BIN="\$NPM_GLOBAL_PREFIX/bin/pi"
  test -x "\$PI_BIN" || { echo 'research Pi executable missing from npm global prefix' >&2; exit 1; }
  test "\$("\$PI_BIN" --version 2>/dev/null)" = "$version" || {
    echo 'research Pi version mismatch' >&2
    "\$PI_BIN" --version >&2 || true
    exit 1
  }
  command -v bwrap >/dev/null || { echo 'bubblewrap (bwrap) is required for Runtime: research' >&2; exit 1; }
  test -f '$remote_dir/scripts/research-pi-extension.mjs'
  test -x '$remote_dir/scripts/research-web-search.mjs'
  test -x '$remote_dir/scripts/research-web-fetch.mjs'
EOF
}

codex_sandbox_preflight_block() {
  local unit_path="$1"

  cat <<EOF
  PATH='$unit_path' command -v codex >/dev/null 2>&1 || { echo 'NO_CODEX'; exit 1; }
  PATH='$unit_path' codex sandbox -- /bin/true >/dev/null 2>&1 || { echo 'CODEX_SANDBOX_FAIL'; exit 1; }
EOF
}

# HUGIN-421: remote command block for the HUGIN-417 maintenance drain
# (docs/maintenance-drain.md). The token is read on the Pi from the service
# .env (never sent through ssh argv) and handed to curl through `--config -`,
# so it is not visible in any process argument list.
#   $1 action: drain | status | resume | check
#   $2 remote_dir
#   drain:  $3 timeout_ms  $4 hold_ms
#   check:  $3 expected process_instance_id  $4 minimum remaining hold ms
# stdout carries the JSON response. Exit codes: 0 ok (200 / check passed),
# 11 busy (409), 12 disabled (no token or 404), 13 check failed, 1 other error.
maintenance_remote_block() {
  local action="$1"
  local remote_dir="$2"
  local arg1="${3:-}"
  local arg2="${4:-}"
  local method path body='' max_time=30

  case "$action" in
    drain)
      [[ "$arg1" =~ ^[0-9]+$ && "$arg2" =~ ^[0-9]+$ ]] || { echo "invalid drain timing" >&2; return 1; }
      method=POST; path=/drain; body="{\"timeout_ms\":$arg1,\"hold_ms\":$arg2}"
      max_time=$((arg1 / 1000 + 30))
      ;;
    resume) method=POST; path=/resume; body='{}' ;;
    status | check) method=GET; path='' ;;
    *) echo "unknown maintenance action: $action" >&2; return 1 ;;
  esac
  if [ "$action" = check ]; then
    [[ "$arg1" =~ ^[A-Za-z0-9._-]{1,128}$ && "$arg2" =~ ^[0-9]+$ ]] || { echo "invalid check arguments" >&2; return 1; }
  fi

  cat <<EOF2
  set -u
  TOKEN="\$(sed -n 's/^HUGIN_MAINTENANCE_TOKEN=//p' '$remote_dir/.env' 2>/dev/null | head -n1 | tr -d "\"'")"
  [ -n "\$TOKEN" ] || { echo 'HUGIN_MAINTENANCE_TOKEN not configured on host' >&2; exit 12; }
  OUT="\$(mktemp)"; trap 'rm -f "\$OUT"' EXIT
  CODE="\$(printf 'header = "Authorization: Bearer %s"\n' "\$TOKEN" | curl -sS --max-time $max_time -o "\$OUT" -w '%{http_code}' --config - -X $method -H 'Content-Type: application/json' ${body:+--data '$body'} 'http://127.0.0.1:3032/admin/maintenance$path')" || exit 1
  cat "\$OUT"
  case "\$CODE" in
    200) ;;
    409) exit 11 ;;
    404) exit 12 ;;
    *) echo "maintenance endpoint returned HTTP \$CODE" >&2; exit 1 ;;
  esac
EOF2
  if [ "$action" = check ]; then
    cat <<EOF3
  /usr/bin/node -e '
    const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const left = s.hold_expires_at ? Date.parse(s.hold_expires_at) - Date.now() : -1;
    const ok = s.state === "draining" && s.ready === true && s.process_instance_id === process.argv[2] && left >= Number(process.argv[3]);
    if (!ok) { console.error("drain check failed: state=" + s.state + " ready=" + s.ready + " instance_match=" + (s.process_instance_id === process.argv[2]) + " hold_left_ms=" + left); process.exit(13); }
  ' "\$OUT" '$arg1' '$arg2'
EOF3
  fi
}
