#!/usr/bin/env bash
# Bash-level regression test for node-modules-preflight.sh (issue #187).
#
# Covers the 2026-07-12 incident: a worktree convenience symlink
# (node_modules -> another checkout's real node_modules) bypassed rsync's
# directory-only exclude and partially deleted the Pi's remote dependency
# tree (rsync exit 23). Two things must hold:
#   1. node_modules_preflight_check hard-fails (with the exact remediation)
#      when node_modules is a symlink, and passes for a real directory or a
#      missing node_modules (first-time checkout).
#   2. DEPLOY_RSYNC_EXCLUDE_ARGS — the exact args deploy-pi.sh runs — are
#      independently robust: a real rsync run against a symlinked source and
#      a populated destination directory must not touch the destination's
#      node_modules contents, using real rsync (no stub — this checks actual
#      rsync semantics, never a real deploy, never ssh).
#
# Run: bash scripts/lib/node-modules-preflight.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_FILE="$SCRIPT_DIR/node-modules-preflight.sh"
if [ ! -f "$LIB_FILE" ]; then
  echo "FAIL: $LIB_FILE not found" >&2
  exit 1
fi
# shellcheck source=node-modules-preflight.sh
source "$LIB_FILE"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0

assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $label — expected [$expected], got [$actual]"
    failures=$((failures + 1))
  else
    echo "PASS: $label"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label — expected output to contain: $needle"
    echo "--- actual output ---"
    echo "$haystack"
    echo "---------------------"
    failures=$((failures + 1))
  else
    echo "PASS: $label"
  fi
}

### --- node_modules_preflight_check -----------------------------------------

# Case 1: node_modules missing entirely (first-time checkout) -> passes.
CASE1="$WORK/case1"
mkdir -p "$CASE1"
rc=0
node_modules_preflight_check "$CASE1" || rc=$?
assert_eq "$rc" "0" "missing node_modules: passes"

# Case 2: node_modules is a real directory -> passes.
CASE2="$WORK/case2"
mkdir -p "$CASE2/node_modules/some-pkg"
rc=0
node_modules_preflight_check "$CASE2" || rc=$?
assert_eq "$rc" "0" "real directory node_modules: passes"

# Case 3: node_modules is a symlink to some other directory -> hard-fails
# with the exact remediation.
CASE3_TARGET="$WORK/case3-target/node_modules"
mkdir -p "$CASE3_TARGET"
CASE3="$WORK/case3"
mkdir -p "$CASE3"
ln -s "$CASE3_TARGET" "$CASE3/node_modules"
rc=0
out="$(node_modules_preflight_check "$CASE3" 2>&1)" || rc=$?
assert_eq "$rc" "1" "symlinked node_modules: hard-fails"
assert_contains "$out" "FATAL" "symlinked node_modules: FATAL message present"
assert_contains "$out" "symlink" "symlinked node_modules: mentions symlink"
assert_contains "$out" "rm node_modules && npm ci" "symlinked node_modules: exact remediation present"

# Case 4 (the irony guard): the EXACT incident shape — a real `git worktree
# add` whose node_modules is a symlink back to the owning checkout's real
# node_modules, i.e. this fleet's own worktree convention that caused #187.
OWNING_REPO="$WORK/owning-repo"
mkdir -p "$OWNING_REPO"
git init -q "$OWNING_REPO"
git -C "$OWNING_REPO" -c user.email="test@example.com" -c user.name="Test" commit -q --allow-empty -m "init"
mkdir -p "$OWNING_REPO/node_modules/real-dep"
echo "real dep" > "$OWNING_REPO/node_modules/real-dep/index.js"

WORKTREE="$WORK/task-worktree"
git -C "$OWNING_REPO" worktree add -q -b "irony-guard-branch" "$WORKTREE" >/dev/null
ln -s "$OWNING_REPO/node_modules" "$WORKTREE/node_modules"

rc=0
out="$(node_modules_preflight_check "$WORKTREE" 2>&1)" || rc=$?
assert_eq "$rc" "1" "git worktree with symlinked node_modules (irony guard): hard-fails"
assert_contains "$out" "FATAL" "irony guard: FATAL message present"

### --- DEPLOY_RSYNC_EXCLUDE_ARGS: real rsync semantics ----------------------
# Reproduces the incident with the actual production exclude args: a source
# tree whose node_modules is a symlink, synced (rsync -av --delete) onto a
# destination that already has a real, populated node_modules directory. The
# destination's dependency tree must survive untouched and rsync must exit 0.

if ! command -v rsync >/dev/null 2>&1; then
  echo "SKIP: rsync not available, cannot verify exclusion semantics" >&2
else
  SRC="$WORK/rsync-src"
  DEST="$WORK/rsync-dest"
  REAL_DEPS="$WORK/rsync-real-deps"

  mkdir -p "$REAL_DEPS/node_modules/some-pkg"
  echo "real dep content" > "$REAL_DEPS/node_modules/some-pkg/index.js"

  mkdir -p "$SRC/dist"
  echo "console.log(1)" > "$SRC/dist/index.js"
  echo "SECRET" > "$SRC/.env"
  ln -s "$REAL_DEPS/node_modules" "$SRC/node_modules"

  mkdir -p "$DEST/node_modules/existing-dep"
  echo "installed dependency, must survive" > "$DEST/node_modules/existing-dep/index.js"
  mkdir -p "$DEST/dist"
  echo "old build" > "$DEST/dist/index.js"
  echo "REMOTE_SECRET" > "$DEST/.env"

  rrc=0
  rsync -av --delete "${DEPLOY_RSYNC_EXCLUDE_ARGS[@]}" "$SRC/" "$DEST/" >/dev/null 2>&1 || rrc=$?
  assert_eq "$rrc" "0" "rsync with hardened excludes: exits 0 despite symlinked source node_modules"

  if [ -f "$DEST/node_modules/existing-dep/index.js" ]; then
    echo "PASS: destination node_modules contents survived the sync"
  else
    echo "FAIL: destination node_modules contents were deleted (the #187 regression)"
    failures=$((failures + 1))
  fi

  if [ -L "$DEST/node_modules" ]; then
    echo "FAIL: destination node_modules became a symlink (would point at the worktree's dep store)"
    failures=$((failures + 1))
  else
    echo "PASS: destination node_modules stayed a real directory"
  fi

  if [ "$(cat "$DEST/.env")" = "REMOTE_SECRET" ]; then
    echo "PASS: destination .env preserved (not overwritten by source .env)"
  else
    echo "FAIL: destination .env was overwritten"
    failures=$((failures + 1))
  fi
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures assertion(s) failed"
  exit 1
fi

echo "All assertions passed"
