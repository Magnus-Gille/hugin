#!/usr/bin/env bash
# Regression coverage for deploy-pi.sh source and deployment-marker safety.

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
if [[ "${FAKE_NPM_DIRTY_ON_BUILD:-0}" == "1" ]]; then
  printf 'build dirtied source\n' >>tracked.txt
fi
exit "${FAKE_NPM_RC:-0}"
EOF

cat >"$FAKE_BIN/rsync" <<'EOF'
#!/usr/bin/env bash
printf 'rsync %s\n' "$*" >>"$CALL_LOG"
if [[ "${FAKE_RSYNC_DIRTY_ON_SYNC:-0}" == "1" ]]; then
  printf 'sync dirtied source\n' >>tracked.txt
fi
exit "${FAKE_RSYNC_RC:-42}"
EOF

cat >"$FAKE_BIN/ssh" <<'EOF'
#!/usr/bin/env bash
call="${*//$'\n'/ }"
printf 'ssh %s\n' "$call" >>"$CALL_LOG"
if [[ -n "${FAKE_SSH_FAIL_MATCH:-}" && "$call" == *"$FAKE_SSH_FAIL_MATCH"* ]]; then
  exit "${FAKE_SSH_FAIL_RC:-99}"
fi
if [[ "$call" == *"test -d ~/repos/claude-config"* ]]; then
  exit 1
fi
if [[ "$call" == *"curl -fsS http://127.0.0.1:3032/health"* ]]; then
  printf '{"status":"ok","polling":true}\n'
fi
exit 0
EOF

chmod +x "$FAKE_BIN/npm" "$FAKE_BIN/rsync" "$FAKE_BIN/ssh"
export PATH="$FAKE_BIN:$PATH"
export CALL_LOG
export FAKE_NPM_DIRTY_ON_BUILD=0
export FAKE_NPM_RC=0
export FAKE_RSYNC_RC=42
export FAKE_RSYNC_DIRTY_ON_SYNC=0
export FAKE_SSH_FAIL_MATCH=""
export FAKE_SSH_FAIL_RC=99

failures=0

fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label (missing: $needle)"
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" != *"$needle"* ]] || fail "$label (unexpected: $needle)"
}

assert_order() {
  local haystack="$1" before="$2" after="$3" label="$4"
  if [[ "$haystack" != *"$before"* || "$haystack" != *"$after"* ]]; then
    fail "$label (missing ordering token)"
    return
  fi
  local tail="${haystack#*"$before"}"
  [[ "$tail" == *"$after"* ]] || fail "$label ($after appeared before $before)"
}

init_clean_source() {
  local source_dir="$1"
  mkdir -p "$source_dir/node_modules"
  printf 'node_modules/\n' >"$source_dir/.gitignore"
  printf 'tracked payload\n' >"$source_dir/tracked.txt"
  git -C "$source_dir" init -q
  git -C "$source_dir" add .gitignore tracked.txt
  git -C "$source_dir" -c user.name=Test -c user.email=test@example.invalid \
    commit -q -m initial
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

# A normal directory without an addressable Git HEAD is not a deploy source.
UNVERSIONED_SOURCE="$TMP_DIR/unversioned-source"
mkdir -p "$UNVERSIONED_SOURCE/node_modules"
: >"$CALL_LOG"
set +e
unversioned_output="$(cd "$UNVERSIONED_SOURCE" && bash "$DEPLOY_SCRIPT" testhost 2>&1)"
unversioned_rc=$?
set -e
[[ "$unversioned_rc" -ne 0 ]] || fail "unversioned source must fail deployment"
assert_contains "$unversioned_output" "addressable Git checkout" "unversioned-source failure explains the commit contract"
[[ ! -s "$CALL_LOG" ]] || fail "unversioned-source preflight must run before npm, rsync, or ssh"

# Defence in depth: a normal source reaches rsync with exclusions for both the
# symlink entry and directory contents, while retaining all existing excludes.
NORMAL_SOURCE="$TMP_DIR/normal-source"
init_clean_source "$NORMAL_SOURCE"
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
assert_contains "$calls" "--exclude=.deployed-commit" "rsync excludes the deployment marker"
assert_contains "$calls" "--exclude=tests/" "rsync retains the tests exclusion"
assert_contains "$calls" "--exclude=.DS_Store" "rsync retains the .DS_Store exclusion"
assert_contains "$calls" "rm -f '/home/magnus/repos/hugin/.deployed-commit'" "normal deployment invalidates the old marker before rsync"
assert_order "$calls" "rm -f '/home/magnus/repos/hugin/.deployed-commit'" "rsync " "normal deployment invalidates the marker before rsync"
assert_not_contains "$calls" "npm ci --omit=dev" "rsync failure stops before later remote mutation"
assert_not_contains "$calls" "mv '/home/magnus/repos/hugin/.deployed-commit.tmp' '/home/magnus/repos/hugin/.deployed-commit'" "rsync failure remains markerless"

# A deploy payload must be one clean, addressable local commit. Reject both a
# dirty source and a build that dirties tracked files before remote mutation.
DIRTY_SOURCE="$TMP_DIR/dirty-source"
init_clean_source "$DIRTY_SOURCE"
printf 'uncommitted\n' >>"$DIRTY_SOURCE/tracked.txt"
: >"$CALL_LOG"
set +e
dirty_output="$(cd "$DIRTY_SOURCE" && bash "$DEPLOY_SCRIPT" testhost 2>&1)"
dirty_rc=$?
set -e
[[ "$dirty_rc" -ne 0 ]] || fail "dirty source must fail deployment"
assert_contains "$dirty_output" "clean" "dirty-source failure explains the clean-commit contract"
[[ ! -s "$CALL_LOG" ]] || fail "dirty-source preflight must run before npm, rsync, or ssh"

BUILD_DIRTY_SOURCE="$TMP_DIR/build-dirty-source"
init_clean_source "$BUILD_DIRTY_SOURCE"
: >"$CALL_LOG"
export FAKE_NPM_DIRTY_ON_BUILD=1
set +e
build_dirty_output="$(cd "$BUILD_DIRTY_SOURCE" && bash "$DEPLOY_SCRIPT" testhost 2>&1)"
build_dirty_rc=$?
set -e
export FAKE_NPM_DIRTY_ON_BUILD=0
[[ "$build_dirty_rc" -ne 0 ]] || fail "a build that changes tracked source must fail deployment"
assert_contains "$build_dirty_output" "changed during build" "post-build failure explains source drift"
build_dirty_calls="$(cat "$CALL_LOG")"
assert_contains "$build_dirty_calls" "npm run build" "post-build source check runs after build"
assert_not_contains "$build_dirty_calls" "rsync " "post-build source drift fails before rsync"
assert_not_contains "$build_dirty_calls" "ssh " "post-build source drift fails before remote mutation"

# If the source changes while rsync is reading it, fail markerless before any
# install/restart operation can accept a mixed payload.
SYNC_DIRTY_SOURCE="$TMP_DIR/sync-dirty-source"
init_clean_source "$SYNC_DIRTY_SOURCE"
: >"$CALL_LOG"
export FAKE_RSYNC_RC=0
export FAKE_RSYNC_DIRTY_ON_SYNC=1
set +e
sync_dirty_output="$(cd "$SYNC_DIRTY_SOURCE" && bash "$DEPLOY_SCRIPT" testhost 2>&1)"
sync_dirty_rc=$?
set -e
export FAKE_RSYNC_DIRTY_ON_SYNC=0
export FAKE_RSYNC_RC=42
[[ "$sync_dirty_rc" -ne 0 ]] || fail "source drift during rsync must fail deployment"
assert_contains "$sync_dirty_output" "changed during sync" "post-sync failure explains source drift"
sync_dirty_calls="$(cat "$CALL_LOG")"
assert_contains "$sync_dirty_calls" "rm -f '/home/magnus/repos/hugin/.deployed-commit'" "sync-drift deployment invalidates the old marker"
assert_not_contains "$sync_dirty_calls" "npm ci --omit=dev" "source drift during rsync fails before remote install"
assert_not_contains "$sync_dirty_calls" "mv '/home/magnus/repos/hugin/.deployed-commit.tmp' '/home/magnus/repos/hugin/.deployed-commit'" "source drift during rsync remains markerless"

# Prove the exclusion semantics themselves against a real rsync: even if the
# preflight is accidentally bypassed in a future refactor, the local symlink
# must not replace or delete an existing remote dependency directory.
DEFENCE_SOURCE="$TMP_DIR/defence-source"
DEFENCE_REMOTE="$TMP_DIR/defence-remote"
mkdir -p "$DEFENCE_SOURCE" "$DEFENCE_REMOTE/node_modules" "$TMP_DIR/defence-shared"
ln -s "$TMP_DIR/defence-shared" "$DEFENCE_SOURCE/node_modules"
printf 'preserve me\n' >"$DEFENCE_REMOTE/node_modules/marker.txt"
printf 'accepted old sha\n' >"$DEFENCE_REMOTE/.deployed-commit"

PATH="$ORIGINAL_PATH" "$REAL_RSYNC" -a --delete \
  --exclude='node_modules' \
  --exclude='node_modules/' \
  --exclude='.deployed-commit' \
  "$DEFENCE_SOURCE/" "$DEFENCE_REMOTE/"

[[ -d "$DEFENCE_REMOTE/node_modules" ]] || fail "rsync exclusions must preserve the remote dependency directory"
[[ ! -L "$DEFENCE_REMOTE/node_modules" ]] || fail "rsync exclusions must not replace remote dependencies with a symlink"
[[ "$(cat "$DEFENCE_REMOTE/node_modules/marker.txt")" == "preserve me" ]] || fail "rsync exclusions must not delete remote dependencies"
[[ "$(cat "$DEFENCE_REMOTE/.deployed-commit")" == "accepted old sha" ]] || fail "rsync exclusion must leave marker ownership to the deploy lifecycle"

# A complete fake deployment proves the transactional marker boundary: remove
# the old marker before rsync, never touch remote Git, accept service + health,
# then stamp the exact local full SHA as the final remote mutation.
FULL_SOURCE="$TMP_DIR/full-source"
init_clean_source "$FULL_SOURCE"
full_sha="$(git -C "$FULL_SOURCE" rev-parse HEAD)"
: >"$CALL_LOG"
export FAKE_RSYNC_RC=0
set +e
(cd "$FULL_SOURCE" && bash "$DEPLOY_SCRIPT" testhost >/dev/null 2>&1)
full_rc=$?
set -e
[[ "$full_rc" -eq 0 ]] || fail "clean full deployment should pass the fake acceptance path"
full_calls="$(cat "$CALL_LOG")"
full_first_ssh="$(grep -m1 '^ssh ' "$CALL_LOG")"
assert_contains "$full_first_ssh" "rm -f '/home/magnus/repos/hugin/.deployed-commit'" "marker invalidation is the first remote command"
assert_contains "$full_calls" "rm -f '/home/magnus/repos/hugin/.deployed-commit'" "deployment invalidates the old marker"
assert_order "$full_calls" "rm -f '/home/magnus/repos/hugin/.deployed-commit'" "rsync " "marker invalidation precedes payload sync"
assert_not_contains "$full_calls" "git fetch origin" "deployment never depends on remote Git fetch"
assert_not_contains "$full_calls" "git reset" "deployment never depends on a remote Git checkout"
assert_contains "$full_calls" "npm ci --omit=dev" "deployment installs the shipped lockfile deterministically"
assert_not_contains "$full_calls" "npm install --omit=dev" "deployment never rewrites the shipped lockfile with npm install"
assert_contains "$full_calls" "curl -fsS http://127.0.0.1:3032/health" "deployment retains the health acceptance gate"
assert_contains "$full_calls" "enable --now hugin-daily-exam-factory.timer" "deployment enables the automatic daily factory"
assert_contains "$full_calls" "start hugin-daily-exam-factory.service" "deployment runs a factory acceptance sweep"
assert_contains "$full_calls" "daily exam manifest must be schema v2" "deployment requires the cross-client exposure manifest contract"
assert_contains "$full_calls" "provisional candidate lacks complete cross-client exposure coverage" "deployment rejects an unjoined provisional candidate"
assert_contains "$full_calls" "$full_sha" "deployment stamps the exact local full SHA"
assert_order "$full_calls" "curl -fsS http://127.0.0.1:3032/health" "mv '/home/magnus/repos/hugin/.deployed-commit.tmp' '/home/magnus/repos/hugin/.deployed-commit'" "health acceptance precedes atomic marker stamp"
assert_order "$full_calls" "start hugin-daily-exam-factory.service" "mv '/home/magnus/repos/hugin/.deployed-commit.tmp' '/home/magnus/repos/hugin/.deployed-commit'" "factory acceptance precedes atomic marker stamp"

# If the marker cannot be invalidated, the script must not begin payload sync.
: >"$CALL_LOG"
export FAKE_SSH_FAIL_MATCH="rm -f '/home/magnus/repos/hugin/.deployed-commit'"
export FAKE_SSH_FAIL_RC=74
set +e
(cd "$FULL_SOURCE" && bash "$DEPLOY_SCRIPT" testhost >/dev/null 2>&1)
invalidate_fail_rc=$?
set -e
export FAKE_SSH_FAIL_MATCH=""
[[ "$invalidate_fail_rc" -ne 0 ]] || fail "failed marker invalidation must fail deployment"
invalidate_fail_calls="$(cat "$CALL_LOG")"
assert_not_contains "$invalidate_fail_calls" "rsync " "failed marker invalidation prevents payload sync"

# Any failure after invalidation must remain markerless. A failed health check
# may not stamp merely because the service restart itself succeeded.
: >"$CALL_LOG"
export FAKE_SSH_FAIL_MATCH="curl -fsS http://127.0.0.1:3032/health"
export FAKE_SSH_FAIL_RC=73
set +e
(cd "$FULL_SOURCE" && bash "$DEPLOY_SCRIPT" testhost >/dev/null 2>&1)
health_fail_rc=$?
set -e
export FAKE_SSH_FAIL_MATCH=""
[[ "$health_fail_rc" -ne 0 ]] || fail "failed health acceptance must fail deployment"
health_fail_calls="$(cat "$CALL_LOG")"
assert_contains "$health_fail_calls" "rm -f '/home/magnus/repos/hugin/.deployed-commit'" "failed deployment first invalidates the old marker"
assert_not_contains "$health_fail_calls" "mv '/home/magnus/repos/hugin/.deployed-commit.tmp' '/home/magnus/repos/hugin/.deployed-commit'" "failed health acceptance remains markerless"

# The automatic factory is part of production acceptance: a broken compiled
# runner, unit sandbox, Munin credential, or manifest write must also leave the
# deployed revision markerless.
: >"$CALL_LOG"
export FAKE_SSH_FAIL_MATCH="start hugin-daily-exam-factory.service"
export FAKE_SSH_FAIL_RC=72
set +e
(cd "$FULL_SOURCE" && bash "$DEPLOY_SCRIPT" testhost >/dev/null 2>&1)
factory_fail_rc=$?
set -e
export FAKE_SSH_FAIL_MATCH=""
[[ "$factory_fail_rc" -ne 0 ]] || fail "failed factory acceptance must fail deployment"
factory_fail_calls="$(cat "$CALL_LOG")"
assert_contains "$factory_fail_calls" "start hugin-daily-exam-factory.service" "factory failure reaches the new acceptance gate"
assert_not_contains "$factory_fail_calls" "mv '/home/magnus/repos/hugin/.deployed-commit.tmp' '/home/magnus/repos/hugin/.deployed-commit'" "failed factory acceptance remains markerless"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures assertion(s) failed" >&2
  exit 1
fi

echo "All assertions passed"
