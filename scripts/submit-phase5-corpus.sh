#!/usr/bin/env bash
# Phase 5 corpus evaluation — submit synthetic tasks to validate sensitivity classification.
# Run on the Pi (or anywhere with MUNIN_URL and MUNIN_API_KEY set).
#
# Each task is a trivial ollama prompt designed to test the classifier,
# not the AI output. What matters is the effective sensitivity and
# Munin classification on the result artifacts.

set -euo pipefail

MUNIN_URL="${MUNIN_URL:-http://localhost:3030}"
MUNIN_API_KEY="${MUNIN_API_KEY:?MUNIN_API_KEY is required}"
BATCH_TS="$(date -u +%Y%m%d-%H%M%S)"
GROUP="phase5-corpus-${BATCH_TS}"

submit_task() {
  local slug="$1"
  local content="$2"
  local task_id="${BATCH_TS}-${slug}"
  local task_ns="tasks/${task_id}"

  echo "Submitting ${task_ns}..."
  curl -s -X POST "${MUNIN_URL}/rpc" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${MUNIN_API_KEY}" \
    -d "$(cat <<ENDJSON
{
  "jsonrpc": "2.0",
  "method": "memory.write",
  "params": {
    "namespace": "${task_ns}",
    "key": "status",
    "content": $(echo "$content" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),
    "tags": ["pending", "runtime:ollama", "type:evaluation"]
  },
  "id": 1
}
ENDJSON
)" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("  OK" if "result" in r else f"  FAIL: {r.get(\"error\",r)}")'
}

submit_pipeline() {
  local slug="$1"
  local content="$2"
  local task_id="${BATCH_TS}-${slug}"
  local task_ns="tasks/${task_id}"

  echo "Submitting pipeline ${task_ns}..."
  curl -s -X POST "${MUNIN_URL}/rpc" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${MUNIN_API_KEY}" \
    -d "$(cat <<ENDJSON
{
  "jsonrpc": "2.0",
  "method": "memory.write",
  "params": {
    "namespace": "${task_ns}",
    "key": "status",
    "content": $(echo "$content" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),
    "tags": ["pending", "runtime:pipeline", "type:evaluation"]
  },
  "id": 1
}
ENDJSON
)" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("  OK" if "result" in r else f"  FAIL: {r.get(\"error\",r)}")'
}

echo "=== Phase 5 Corpus Evaluation ==="
echo "Group: ${GROUP}"
echo "Timestamp: ${BATCH_TS}"
echo ""

# ============================================================
# PUBLIC tasks (4) — explicit Sensitivity: public, no private signals
# Expected: effective=public, no mismatch
# ============================================================

echo "--- PUBLIC tasks ---"

submit_task "pub-1-release-notes" "## Task: Summarize release notes

- **Runtime:** ollama
- **Context:** scratch
- **Sensitivity:** public
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 1

### Prompt
Summarize the following open-source release notes in three bullet points: Version 2.0 adds dark mode, fixes a crash on startup, and improves performance by 30 percent. Reply in one paragraph."

submit_task "pub-2-readme-gen" "## Task: Generate README section

- **Runtime:** ollama
- **Context:** scratch
- **Sensitivity:** public
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 2

### Prompt
Write a short Getting Started section for an open-source CLI tool called fizzbuzz. Include installation via npm and a usage example. Keep it under 100 words."

submit_task "pub-3-no-sensitivity-scratch" "## Task: Simple question with no explicit sensitivity

- **Runtime:** ollama
- **Context:** scratch
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 3

### Prompt
What is the capital of Sweden? Reply in one sentence."

submit_task "pub-4-explicit-public-workspace" "## Task: Public task in workspace

- **Runtime:** ollama
- **Sensitivity:** public
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 4

### Prompt
List three benefits of automated testing. Keep it brief."

# ============================================================
# INTERNAL tasks (4) — repo context or no sensitivity with repo paths
# Expected: effective=internal, no mismatch
# ============================================================

echo "--- INTERNAL tasks ---"

submit_task "int-1-repo-context" "## Task: Code review question

- **Runtime:** ollama
- **Context:** repo:hugin
- **Sensitivity:** internal
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 5

### Prompt
Describe in one paragraph what a task dispatcher does in a multi-agent system."

submit_task "int-2-no-sensitivity-repo" "## Task: Repo task without explicit sensitivity

- **Runtime:** ollama
- **Context:** repo:hugin
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 6

### Prompt
Explain what systemd timers are in two sentences."

submit_task "int-3-internal-with-context-ref" "## Task: Task with internal context-ref

- **Runtime:** ollama
- **Context:** scratch
- **Sensitivity:** internal
- **Context-refs:** projects/hugin/status
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 7

### Prompt
Given the project context above, what phase is the project in? Reply in one sentence."

submit_task "int-4-workspace-path" "## Task: Workspace path task

- **Runtime:** ollama
- **Working dir:** /home/magnus/workspace
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 8

### Prompt
What does the ls command do? Reply in one sentence."

# ============================================================
# PRIVATE tasks (4) — private context, paths, or prompt keywords
# Expected: effective=private, no mismatch
# ============================================================

echo "--- PRIVATE tasks ---"

submit_task "priv-1-files-context" "## Task: Task with files context

- **Runtime:** ollama
- **Context:** files
- **Sensitivity:** private
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 9

### Prompt
List the types of documents commonly found in a personal file archive. Reply briefly."

submit_task "priv-2-people-context-ref" "## Task: Task with people context-ref

- **Runtime:** ollama
- **Context:** scratch
- **Sensitivity:** private
- **Context-refs:** people/magnus/profile
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 10

### Prompt
Given the context above, summarize the person described in one sentence."

submit_task "priv-3-prompt-keywords" "## Task: Prompt with private keywords

- **Runtime:** ollama
- **Context:** scratch
- **Sensitivity:** private
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 11

### Prompt
Explain best practices for storing a salary slip and bank statements securely. Keep it to three bullet points."

submit_task "priv-4-mimir-path" "## Task: Task with mimir path

- **Runtime:** ollama
- **Working dir:** /home/magnus/mimir
- **Sensitivity:** private
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 12

### Prompt
What is a good folder structure for a personal document archive? Reply briefly."

# ============================================================
# MISMATCH tasks (3) — declared too low, should ratchet up
# Expected: effective > declared, mismatch=true
# ============================================================

echo "--- MISMATCH tasks ---"

submit_task "mis-1-public-but-private-ref" "## Task: Declares public but has private context-ref

- **Runtime:** ollama
- **Context:** scratch
- **Sensitivity:** public
- **Context-refs:** people/magnus/profile
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 13

### Prompt
Summarize any context provided above in one sentence."

submit_task "mis-2-public-but-private-prompt" "## Task: Declares public but prompt has private keywords

- **Runtime:** ollama
- **Context:** scratch
- **Sensitivity:** public
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 14

### Prompt
Draft a template for recording salary information and bank account details for tax filing."

submit_task "mis-3-internal-but-files-context" "## Task: Declares internal but context is files (private)

- **Runtime:** ollama
- **Context:** files
- **Sensitivity:** internal
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 15

### Prompt
List three categories of personal files that should be backed up regularly."

# ============================================================
# PIPELINE tasks (3) — test propagation through dependency edges
# ============================================================

echo "--- PIPELINE tasks ---"

submit_pipeline "pipe-1-uniform-internal" "## Task: Pipeline with uniform internal sensitivity

- **Runtime:** pipeline
- **Sensitivity:** internal
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 16

### Pipeline

Phase: research
  Runtime: ollama-pi
  Prompt: |
    What are three benefits of microservices? Reply briefly.

Phase: summarize
  Runtime: ollama-pi
  Depends-on: research
  Prompt: |
    Summarize the research findings in one sentence."

submit_pipeline "pipe-2-private-upstream" "## Task: Pipeline where upstream phase is private, downstream inherits

- **Runtime:** pipeline
- **Sensitivity:** internal
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 17

### Pipeline

Phase: gather
  Runtime: ollama-pi
  Sensitivity: private
  Prompt: |
    List three types of personal financial documents.

Phase: analyze
  Runtime: ollama-pi
  Depends-on: gather
  Prompt: |
    Based on the previous phase, suggest a filing system. Reply briefly."

submit_pipeline "pipe-3-public-parent-private-phase" "## Task: Pipeline declares public but one phase has private context

- **Runtime:** pipeline
- **Sensitivity:** public
- **Submitted by:** claude-code
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Group:** ${GROUP}
- **Sequence:** 18

### Pipeline

Phase: public-work
  Runtime: ollama-pi
  Prompt: |
    What is the capital of France? Reply in one sentence.

Phase: private-work
  Runtime: ollama-pi
  Sensitivity: private
  Prompt: |
    List best practices for storing personal journal entries.

Phase: final
  Runtime: ollama-pi
  Depends-on: public-work, private-work
  Prompt: |
    Combine the above into a brief summary."

echo ""
echo "=== Submitted ${GROUP} — 18 tasks ==="
echo "Monitor with: curl -s ${MUNIN_URL}/rpc -H 'Authorization: Bearer <key>' -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"method\":\"memory.query\",\"params\":{\"query\":\"${GROUP}\",\"tags\":[\"type:evaluation\"]},\"id\":1}'"
