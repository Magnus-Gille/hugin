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
