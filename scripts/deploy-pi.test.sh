#!/usr/bin/env bash
# Regression coverage for deploy-pi.sh source-tree safety (issue #187).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="$SCRIPT_DIR/deploy-pi.sh"
ORIGINAL_PATH="$PATH"
REAL_RSYNC="$(command -v rsync)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FAKE_BIN="$TMP_DIR/bin"
CALL_LOG="$TMP_DIR/calls.log"
mkdir -p "$FAKE_BIN"
: >"$CALL_LOG"

cat >"$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >>"$CALL_LOG"
EOF

cat >"$FAKE_BIN/rsync" <<'EOF'
#!/usr/bin/env bash
printf 'rsync %s\n' "$*" >>"$CALL_LOG"
# Stop a normal-source run immediately after capturing the sync arguments.
exit 42
EOF

cat >"$FAKE_BIN/ssh" <<'EOF'
#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >>"$CALL_LOG"
exit 99
EOF

chmod +x "$FAKE_BIN/npm" "$FAKE_BIN/rsync" "$FAKE_BIN/ssh"
export PATH="$FAKE_BIN:$PATH"
export CALL_LOG

failures=0

fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label (missing: $needle)"
}

# A worktree commonly links dependencies from its owning checkout. The deploy
# must reject that shape before build, rsync, or any remote command can run.
SYMLINK_SOURCE="$TMP_DIR/symlink-source"
mkdir -p "$SYMLINK_SOURCE" "$TMP_DIR/shared-node-modules"
ln -s "$TMP_DIR/shared-node-modules" "$SYMLINK_SOURCE/node_modules"

set +e
symlink_output="$(cd "$SYMLINK_SOURCE" && bash "$DEPLOY_SCRIPT" testhost 2>&1)"
symlink_rc=$?
set -e

[[ "$symlink_rc" -ne 0 ]] || fail "symlinked node_modules must fail deployment"
assert_contains "$symlink_output" "node_modules is a symlink" "symlink failure explains the unsafe source"
assert_contains "$symlink_output" "npm ci" "symlink failure gives a safe remediation"
[[ ! -s "$CALL_LOG" ]] || fail "symlink preflight must run before npm, rsync, or ssh"

# Defence in depth: a normal source reaches rsync with exclusions for both the
# symlink entry and directory contents, while retaining all existing excludes.
NORMAL_SOURCE="$TMP_DIR/normal-source"
mkdir -p "$NORMAL_SOURCE/node_modules"
: >"$CALL_LOG"

set +e
(cd "$NORMAL_SOURCE" && bash "$DEPLOY_SCRIPT" testhost >/dev/null 2>&1)
normal_rc=$?
set -e

[[ "$normal_rc" -eq 42 ]] || fail "normal source should reach the rsync stub"
calls="$(cat "$CALL_LOG")"
assert_contains "$calls" "npm run build" "normal source still builds first"
assert_contains "$calls" "--exclude=node_modules --exclude=node_modules/" "rsync excludes the node_modules entry (including symlinks)"
assert_contains "$calls" "--exclude=node_modules/" "rsync retains the node_modules directory exclusion"
assert_contains "$calls" "--exclude=.git" "rsync retains the .git entry exclusion"
assert_contains "$calls" "--exclude=.git/" "rsync retains the .git directory exclusion"
assert_contains "$calls" "--exclude=.env" "rsync retains the .env exclusion"
assert_contains "$calls" "--exclude=tests/" "rsync retains the tests exclusion"
assert_contains "$calls" "--exclude=.DS_Store" "rsync retains the .DS_Store exclusion"
[[ "$calls" != *"ssh "* ]] || fail "rsync failure must stop before any remote command"

# Prove the exclusion semantics themselves against a real rsync: even if the
# preflight is accidentally bypassed in a future refactor, the local symlink
# must not replace or delete an existing remote dependency directory.
DEFENCE_SOURCE="$TMP_DIR/defence-source"
DEFENCE_REMOTE="$TMP_DIR/defence-remote"
mkdir -p "$DEFENCE_SOURCE" "$DEFENCE_REMOTE/node_modules" "$TMP_DIR/defence-shared"
ln -s "$TMP_DIR/defence-shared" "$DEFENCE_SOURCE/node_modules"
printf 'preserve me\n' >"$DEFENCE_REMOTE/node_modules/marker.txt"

PATH="$ORIGINAL_PATH" "$REAL_RSYNC" -a --delete \
  --exclude='node_modules' \
  --exclude='node_modules/' \
  "$DEFENCE_SOURCE/" "$DEFENCE_REMOTE/"

[[ -d "$DEFENCE_REMOTE/node_modules" ]] || fail "rsync exclusions must preserve the remote dependency directory"
[[ ! -L "$DEFENCE_REMOTE/node_modules" ]] || fail "rsync exclusions must not replace remote dependencies with a symlink"
[[ "$(cat "$DEFENCE_REMOTE/node_modules/marker.txt")" == "preserve me" ]] || fail "rsync exclusions must not delete remote dependencies"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures assertion(s) failed" >&2
  exit 1
fi

echo "All assertions passed"
