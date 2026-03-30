#!/usr/bin/env bash
# Submit a Munin stale-status review task to Hugin via Munin.
# Reads project statuses from Munin and checks for staleness,
# convention compliance, and inconsistencies.
#
# One-shot — run manually, not on a timer.

set -euo pipefail

MUNIN_URL="${MUNIN_URL:-http://localhost:3030}"
MUNIN_API_KEY="${MUNIN_API_KEY:?MUNIN_API_KEY is required}"

TASK_ID="$(date -u +%Y%m%d-%H%M%S)-stale-status-review"
TASK_NS="tasks/${TASK_ID}"

TASK_CONTENT=$(cat <<'TASK_EOF'
## Task: Munin stale-status review

- **Runtime:** claude
- **Context:** scratch
- **Model:** sonnet
- **Timeout:** 300000
- **Submitted by:** hugin

### Prompt
Read project status entries from Munin for all active projects: grimnir, heimdall, munin-memory, hugin, ratatoskr, skuld. Use memory_read with namespace "projects/<name>" and key "status" for each.

Then for each project:
1. Is the status entry stale (not updated in >14 days)?
2. Does the status follow conventions (should include: phase, current work, blockers)?
3. Are there any inconsistencies between projects?

Report findings as a structured markdown summary.
TASK_EOF
)

# Escape for JSON
TASK_JSON=$(python3 -c "
import json, sys
content = sys.stdin.read()
print(json.dumps(content))
" <<< "$TASK_CONTENT")

# Submit to Munin via JSON-RPC 2.0
BODY=$(cat <<JSON_EOF
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "memory_write",
    "arguments": {
      "namespace": "${TASK_NS}",
      "key": "status",
      "content": ${TASK_JSON},
      "tags": ["pending", "runtime:claude", "type:stale-review"]
    }
  }
}
JSON_EOF
)

RESPONSE=$(curl -s -X POST "${MUNIN_URL}/mcp" \
  -H "Authorization: Bearer ${MUNIN_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$BODY")

if echo "$RESPONSE" | grep -q '"error"'; then
  echo "ERROR: Failed to submit task: $RESPONSE"
  exit 1
fi

echo "Submitted stale-status review task: ${TASK_NS}"
