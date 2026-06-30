#!/bin/bash
# DEPRECATED (2026-06-30). Do not use.
#
# This script used to rsync ~/.claude/ (CLAUDE.md, skills, commands, settings — hooks
# stripped, plugins ignored) from the laptop to the Pi. It was lossy and one-directional.
#
# Config is now a versioned single source of truth across all machines:
#   - Magnus-Gille/claude-config        (global CLAUDE.md, commands, hooks, agents, settings.base.json)
#   - Magnus-Gille/claude-skills        (public skills)
#   - Magnus-Gille/claude-skills-private (private skills, symlinked via ../skills-private)
#
# Each machine clones them into ~/repos and runs claude-config/bootstrap.sh, which symlinks
# ~/.claude content and merges settings. The sync-repos timer keeps everything current.
#
# To refresh a machine's config now:
#   ssh <host> 'cd ~/repos/claude-config && git pull --ff-only && ./bootstrap.sh'
# (deploy-pi.sh does this automatically.)
echo "sync-claude-config.sh is DEPRECATED — config now lives in the claude-config repo." >&2
echo "Run: ssh <host> 'cd ~/repos/claude-config && git pull --ff-only && ./bootstrap.sh'" >&2
exit 0
