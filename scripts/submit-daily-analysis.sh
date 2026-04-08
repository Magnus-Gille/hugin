#!/usr/bin/env bash
# Submit a daily invocation journal analysis task to Hugin via Munin.
# Intended to run via systemd timer at 07:00 daily.
#
# Reads the last 24 hours of journal entries and submits them as an
# ollama task with fallback to Claude.

set -euo pipefail

JOURNAL_FILE="${HOME}/.hugin/invocation-journal.jsonl"
MUNIN_URL="${MUNIN_URL:-http://localhost:3030}"
MUNIN_API_KEY="${MUNIN_API_KEY:?MUNIN_API_KEY is required}"

# Generate task ID
TASK_ID="$(date -u +%Y%m%d-%H%M%S)-daily-analysis"
TASK_NS="tasks/${TASK_ID}"

# Read last 24 hours of journal entries
CUTOFF=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -v-24H +%Y-%m-%dT%H:%M:%S)

JOURNAL_DATA=""
if [ -f "$JOURNAL_FILE" ]; then
  # Filter entries from last 24h (ts field is ISO 8601)
  JOURNAL_DATA=$(while IFS= read -r line; do
    ts=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ts',''))" 2>/dev/null || echo "")
    if [ -n "$ts" ] && [ "$ts" \> "$CUTOFF" ]; then
      echo "$line"
    fi
  done < "$JOURNAL_FILE")
fi

if [ -z "$JOURNAL_DATA" ]; then
  echo "No journal entries in last 24 hours, skipping submission"
  exit 0
fi

ENTRY_COUNT=$(echo "$JOURNAL_DATA" | wc -l | tr -d ' ')
echo "Found ${ENTRY_COUNT} journal entries from last 24 hours"

# Build the task content
TASK_CONTENT=$(cat <<TASK_EOF
## Task: Daily invocation journal analysis

- **Runtime:** ollama
- **Context:** scratch
- **Model:** qwen2.5:3b
- **Fallback:** claude
- **Timeout:** 300000
- **Submitted by:** hugin
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)

### Prompt
Analyze the following Hugin invocation journal entries from the last 24 hours.

Report:
1. Total tasks executed, success rate, failure rate
2. Average duration by runtime (claude, codex, ollama)
3. Total estimated cost (sum cost_usd where available)
4. Any anomalies (unusually long tasks, repeated failures, timeout patterns)
5. Quota utilization trend (if quota_before/quota_after data present)

Use markdown tables where appropriate. Be concise.

\`\`\`jsonl
${JOURNAL_DATA}
\`\`\`
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
      "tags": ["pending", "runtime:ollama", "type:analysis"]
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

echo "Submitted daily analysis task: ${TASK_NS} (${ENTRY_COUNT} entries)"
