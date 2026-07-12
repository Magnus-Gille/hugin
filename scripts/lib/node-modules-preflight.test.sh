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
#
# rsync is required, not optional: this is the core regression coverage for
# #187 (a CI runner-image change that dropped rsync must fail this test, not
# silently no-op it — Codex review finding).
command -v rsync >/dev/null 2>&1 || {
  echo "FAIL: rsync is not installed — cannot verify the #187 regression, which is the point of this test" >&2
  exit 1
}

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

# Negative control: the OLD buggy exclude ('node_modules/' trailing slash)
# must still reproduce the original rsync exit 23 against this exact fixture
# — this proves the fixture actually recreates the incident, rather than the
# hardened args just happening to exit 0 for an unrelated reason.
old_rc=0
rsync -av --delete --exclude='node_modules/' --exclude='.git' --exclude='.git/' \
  --exclude='.env' --exclude='tests/' --exclude='.DS_Store' \
  "$SRC/" "$DEST/" >/dev/null 2>&1 || old_rc=$?
assert_eq "$old_rc" "23" "negative control: old trailing-slash exclude reproduces rsync exit 23"

# Reset the destination (the negative control run above may have partially
# mutated it) before exercising the hardened args on a clean fixture.
rm -rf "$DEST"
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

### --- Nested node_modules (Codex review finding) ---------------------------
# The exclude/protect patterns are deliberately unanchored so they match at
# any depth, not just the transfer root. Reproduce with a nested subpackage
# node_modules directory (this repo has skills/markdown-frontmatter-
# normalization/package.json, so a nested node_modules is a real possible
# shape, not a hypothetical).
NSRC="$WORK/nested-src"
NDEST="$WORK/nested-dest"
NREAL_DEPS="$WORK/nested-real-deps"

mkdir -p "$NREAL_DEPS/node_modules/some-pkg"
echo "real dep" > "$NREAL_DEPS/node_modules/some-pkg/index.js"
mkdir -p "$NSRC/pkg"
ln -s "$NREAL_DEPS/node_modules" "$NSRC/node_modules"
mkdir -p "$NSRC/pkg/node_modules/nested-dep"
echo "nested dep in source" > "$NSRC/pkg/node_modules/nested-dep/index.js"

mkdir -p "$NDEST/node_modules/existing-dep"
echo "top-level installed dep, must survive" > "$NDEST/node_modules/existing-dep/index.js"
mkdir -p "$NDEST/pkg/node_modules/nested-existing-dep"
echo "nested installed dep, must survive" > "$NDEST/pkg/node_modules/nested-existing-dep/index.js"

nrc=0
rsync -av --delete "${DEPLOY_RSYNC_EXCLUDE_ARGS[@]}" "$NSRC/" "$NDEST/" >/dev/null 2>&1 || nrc=$?
assert_eq "$nrc" "0" "nested node_modules: rsync with hardened excludes exits 0"

if [ -f "$NDEST/node_modules/existing-dep/index.js" ] && [ -f "$NDEST/pkg/node_modules/nested-existing-dep/index.js" ]; then
  echo "PASS: both top-level and nested destination node_modules contents survived"
else
  echo "FAIL: a nested node_modules directory was destroyed (unanchored-pattern regression)"
  failures=$((failures + 1))
fi

if [ -e "$NDEST/pkg/node_modules/nested-dep/index.js" ]; then
  echo "FAIL: nested source node_modules was transferred (should be excluded at any depth)"
  failures=$((failures + 1))
else
  echo "PASS: nested source node_modules correctly excluded from transfer"
fi

### --- Protect filter alone (defense-in-depth sanity) ------------------------
# Proves the 'P' protect rule is doing real work, not a no-op: even with NO
# exclude at all, --delete must not remove the destination's node_modules
# contents. (The transfer itself still errors, since nothing stops rsync
# from attempting to place the symlink — only the destination-side deletion
# protection is under test here.)
PSRC="$WORK/protect-src"
PDEST="$WORK/protect-dest"
PREAL_DEPS="$WORK/protect-real-deps"

mkdir -p "$PREAL_DEPS/node_modules/some-pkg"
echo "real dep" > "$PREAL_DEPS/node_modules/some-pkg/index.js"
ln -s "$PREAL_DEPS/node_modules" "$PSRC/node_modules" 2>/dev/null || {
  mkdir -p "$PSRC"
  ln -s "$PREAL_DEPS/node_modules" "$PSRC/node_modules"
}
mkdir -p "$PDEST/node_modules/existing-dep"
echo "installed dependency, must survive" > "$PDEST/node_modules/existing-dep/index.js"

rsync -av --delete -f 'P node_modules/***' "$PSRC/" "$PDEST/" >/dev/null 2>&1 || true
if [ -f "$PDEST/node_modules/existing-dep/index.js" ]; then
  echo "PASS: protect filter alone preserved destination node_modules contents (no-exclude case)"
else
  echo "FAIL: protect filter alone did not stop --delete from removing destination node_modules contents"
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures assertion(s) failed"
  exit 1
fi

echo "All assertions passed"
