#!/usr/bin/env bash
# Submit a daily invocation journal analysis task to Hugin via Munin.
# Intended to run via systemd timer at 07:00 daily.
#
# Deterministically summarizes the last 24 hours into bounded evidence and
# submits that evidence as an ollama task with fallback to Claude.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
JOURNAL_FILE="${HUGIN_JOURNAL_FILE:-${HOME}/.hugin/invocation-journal.jsonl}"
MUNIN_URL="${MUNIN_URL:-http://localhost:3030}"
MUNIN_API_KEY="${MUNIN_API_KEY:?MUNIN_API_KEY is required}"

# Generate task ID
TASK_ID="$(date -u +%Y%m%d-%H%M%S)-daily-analysis"
TASK_NS="tasks/${TASK_ID}"

if [ ! -f "$JOURNAL_FILE" ]; then
  echo "No journal entries in last 24 hours, skipping submission"
  exit 0
fi

ANALYSIS_INPUT="$(node "${SCRIPT_DIR}/build-daily-analysis-input.mjs" "$JOURNAL_FILE")"
ENTRY_COUNT="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["entries"])' <<< "$ANALYSIS_INPUT")"
if [ "$ENTRY_COUNT" -eq 0 ]; then
  echo "No journal entries in last 24 hours, skipping submission"
  exit 0
fi
echo "Found ${ENTRY_COUNT} journal entries from last 24 hours"

# Build the task content
TASK_CONTENT=$(cat <<TASK_EOF
## Task: Daily invocation journal analysis

- **Runtime:** ollama
- **Context:** scratch
- **Model:** qwen2.5:3b
- **Fallback:** claude
- **Timeout:** 300000
- **Max output tokens:** 192
- **Submitted by:** hugin
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)

### Prompt
Turn the following precomputed Hugin invocation evidence into a concise operator report.
The aggregation is authoritative: do not recalculate or invent missing values.

Report:
1. Total tasks executed, success rate, failure rate
2. Average duration by runtime (claude, codex, ollama)
3. Total estimated cost (sum cost_usd where available)
4. Any anomalies (unusually long tasks, repeated failures, timeout patterns)
5. Quota utilization trend (if quota_before/quota_after data present)

Use markdown tables where appropriate. Keep the entire answer under 160 words.

\`\`\`json
${ANALYSIS_INPUT}
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
