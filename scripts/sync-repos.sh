#!/usr/bin/env bash
# sync-repos.sh — Pull all git repos under /home/magnus/repos/ to stay current with GitHub.
#
# Runs `git fetch origin && git pull --ff-only` in each repo.
# Uses --ff-only so it never creates merge commits or rebases.
# Exits 0 even if individual repos fail — logs everything.
#
# Installation (systemd user timer):
#   mkdir -p ~/.config/systemd/user
#   cp scripts/sync-repos.service ~/.config/systemd/user/
#   cp scripts/sync-repos.timer   ~/.config/systemd/user/
#   systemctl --user daemon-reload
#   systemctl --user enable --now sync-repos.timer
#
#   Check status:  systemctl --user status sync-repos.timer
#   Check logs:    journalctl --user -u sync-repos.service
#   Run manually:  systemctl --user start sync-repos.service

set -euo pipefail

REPOS_DIR="${REPOS_DIR:-/home/magnus/repos}"
LOG_TAG="sync-repos"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

synced=0
up_to_date=0
diverged=0
failed=0

for dir in "$REPOS_DIR"/*/; do
    [ -d "$dir/.git" ] || continue

    repo_name="$(basename "$dir")"

    if ! fetch_output=$(git -C "$dir" fetch origin 2>&1); then
        log "FAIL  $repo_name — fetch failed: $fetch_output"
        ((failed++))
        continue
    fi

    pull_output=$(git -C "$dir" pull --ff-only 2>&1) && pull_rc=0 || pull_rc=$?

    if [ $pull_rc -ne 0 ]; then
        log "DIVERGED  $repo_name — cannot fast-forward: $pull_output"
        ((diverged++))
    elif echo "$pull_output" | grep -q "Already up to date"; then
        log "OK  $repo_name — already up to date"
        ((up_to_date++))
    else
        log "SYNCED  $repo_name — $pull_output"
        ((synced++))
    fi
done

log "Done. synced=$synced  up_to_date=$up_to_date  diverged=$diverged  failed=$failed"
exit 0
