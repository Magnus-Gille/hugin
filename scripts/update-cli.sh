#!/bin/bash
set -euo pipefail

# Update Claude Code and Codex CLI tools
# Intended to run daily via cron on the Pi
# Logs version changes to syslog

export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.npm-global/bin:$PATH"

update_package() {
  local pkg="$1"
  local old_version

  old_version=$(npm ls -g "$pkg" --depth=0 --json 2>/dev/null | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); console.log(j.dependencies?.['${pkg}']?.version || 'not-installed'); }
      catch { console.log('not-installed'); }
    });
  ")

  echo "Updating $pkg (current: $old_version)..."
  npm update -g "$pkg" 2>&1

  local new_version
  new_version=$(npm ls -g "$pkg" --depth=0 --json 2>/dev/null | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); console.log(j.dependencies?.['${pkg}']?.version || 'not-installed'); }
      catch { console.log('not-installed'); }
    });
  ")

  if [ "$old_version" = "$new_version" ]; then
    echo "$pkg: already up-to-date ($new_version)"
  else
    echo "$pkg: updated $old_version -> $new_version"
    logger -t hugin-update "$pkg updated $old_version -> $new_version"
  fi
}

echo "==> Updating CLI tools ($(date))"

update_package "@anthropic-ai/claude-code"
update_package "@openai/codex"

echo "==> Update check complete"
