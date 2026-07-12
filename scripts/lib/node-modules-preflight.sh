#!/usr/bin/env bash
# node_modules preflight + rsync exclusion for deploy-pi.sh (issue #187).
#
# During the 2026-07-12 deploy of PR #186 from a clean worktree, the local
# node_modules was a symlink to the owning checkout's real node_modules (a
# common worktree space-saving convention). rsync's directory-only exclude
# pattern ('node_modules/' with a trailing slash) only matches a real
# directory — a symlink falls through it, gets treated as a plain file to
# transfer, and rsync then tries to replace the Pi's real node_modules
# directory with that symlink. That partially deleted the remote dependency
# tree and exited 23 before npm install/git-reset/restart ran (recovery was
# manual: remove the local symlink, `npm ci`, redeploy).
#
# Two independent layers, both proven against real rsync semantics with a
# local dir-to-dir experiment (never a real deploy, never ssh):
#   1. node_modules_preflight_check: hard-fail BEFORE build/rsync if the local
#      node_modules is a symlink at all — the safest fix is never reaching
#      rsync with the dangerous shape in the first place.
#   2. DEPLOY_RSYNC_EXCLUDE_ARGS: the exclude pattern itself, hardened to
#      match a symlink/dir/file alike ('node_modules', no trailing slash),
#      plus a 'protect' filter rule as defense-in-depth so --delete can
#      never remove the destination's node_modules contents even if the
#      exclude were ever bypassed or misconfigured.
# Both layers exist because the preflight alone leaves a bypass path (someone
# could run rsync directly, or the check could be skipped) — the rsync flags
# must be independently safe.
#
# Deliberately UNANCHORED (no leading '/'): an anchored '/node_modules' only
# matches the transfer root, so a nested node_modules (e.g. a subpackage
# under skills/) would fall through both the exclude and the protect filter
# — reintroducing the exact #187 failure mode one directory deeper, and
# silently regressing behavior vs. the historical unanchored 'node_modules/'
# pattern. Matching at any depth restores that coverage while still fixing
# the type bug (Codex review finding, verified with a nested-directory rsync
# experiment: both a top-level and a nested destination node_modules survive
# --delete, and neither is transferred from the source).

node_modules_preflight_check() {
  local dir="$1"
  if [ -L "$dir/node_modules" ]; then
    echo "  FATAL: $dir/node_modules is a symlink (probably a worktree pointing at" >&2
    echo "  another checkout's dependencies). rsync cannot safely exclude a" >&2
    echo "  symlink here and would attempt to overwrite the Pi's real" >&2
    echo "  node_modules directory with it, partially deleting remote deps." >&2
    echo "  Remediation:" >&2
    echo "    rm node_modules && npm ci" >&2
    echo "  then re-run this deploy." >&2
    return 1
  fi
  return 0
}

# Shared with the regression test (node-modules-preflight.test.sh) so the
# test can never drift from what deploy-pi.sh actually runs.
DEPLOY_RSYNC_EXCLUDE_ARGS=(
  --exclude='node_modules'
  -f 'P node_modules/***'
  --exclude='.git'
  --exclude='.git/'
  --exclude='.env'
  --exclude='tests/'
  --exclude='.DS_Store'
)
