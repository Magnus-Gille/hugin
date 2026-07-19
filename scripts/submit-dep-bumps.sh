#!/usr/bin/env bash
# Submit autonomous dependency-bump tasks to Hugin for repos with fixable npm audit findings.
#
# Reads weekly security-scan results from Munin (security/repos/<repo>) and,
# for each repo with fixable vulnerabilities, submits one Hugin task (runtime:claude,
# type:dep-bump) that runs `npm audit fix`, verifies build/test, and opens a PR.
#
# Idempotency: skips repos that already have an open `chore/audit-fix-*` PR (requires gh CLI).
# If gh is unavailable, the check is skipped and a warning is printed.
#
# Usage:
#   MUNIN_API_KEY=<key> GITHUB_OWNER=<owner> ./scripts/submit-dep-bumps.sh [repo1 repo2 ...]
#
#   If no repos are given, all repos found under security/repos/* in Munin are used.

set -euo pipefail

MUNIN_URL="${MUNIN_URL:-http://localhost:3030}"
MUNIN_API_KEY="${MUNIN_API_KEY:?MUNIN_API_KEY is required}"
GITHUB_OWNER="${GITHUB_OWNER:-}"

SCAN_DATE="$(date -u +%Y%m%d)"
SUBMITTED=0
SKIPPED=0
FAILED=0

# ── helpers ─────────────────────────────────────────────────────────────────

munin_call() {
  # Usage: munin_call <json-body>
  # Prints raw JSON response.
  curl -s -X POST "${MUNIN_URL}/mcp" \
    -H "Authorization: Bearer ${MUNIN_API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$1"
}

json_encode() {
  # Encode stdin as a JSON string (including quotes).
  python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"
}

extract_repos_from_query() {
  # Given a Munin memory_query JSON response, extract unique repo names
  # from namespaces matching security/repos/<repo>.
  python3 -c "
import json, sys, re
resp = json.load(sys.stdin)
results = resp.get('result', {}).get('content', [{}])[0].get('text', '{}')
data = json.loads(results)
entries = data.get('results', [])
repos = set()
for e in entries:
    m = re.match(r'^security/repos/([^/]+)$', e.get('namespace',''))
    if m:
        repos.add(m.group(1))
for r in sorted(repos):
    print(r)
"
}

extract_fixable_from_read() {
  # Given a Munin memory_read JSON response content string, extract
  # the fixable vulnerability count.  Returns 0 if not parseable.
  python3 -c "
import json, sys, re
resp = json.load(sys.stdin)
results = resp.get('result', {}).get('content', [{}])[0].get('text', '{}')
data = json.loads(results)
content = data.get('content', '')
# Try to find 'fixable: N' pattern in the content (written by the scan)
m = re.search(r'\"fixable\":\s*(\d+)', content)
if m:
    print(m.group(1))
    sys.exit(0)
# Also try plain text 'fixable N'
m = re.search(r'\bfixable[:\s]+(\d+)', content, re.IGNORECASE)
if m:
    print(m.group(1))
    sys.exit(0)
print('0')
"
}

has_open_audit_pr() {
  # Usage: has_open_audit_pr <repo>
  # Returns 0 (true) if an open chore/audit-fix-* PR exists for the repo, 1 otherwise.
  local repo="$1"
  if ! command -v gh &>/dev/null; then
    echo "  [warn] gh CLI not found — skipping idempotency check for ${repo}" >&2
    return 1  # can't check, assume no PR
  fi
  if [ -z "$GITHUB_OWNER" ]; then
    echo "  [warn] GITHUB_OWNER is unset — skipping idempotency check for ${repo}" >&2
    return 1
  fi
  # `gh pr list --head` matches an EXACT branch, not a prefix, so list open PRs
  # and match the chore/audit-fix-* branch family ourselves.
  local count
  count=$(gh pr list \
    --repo "${GITHUB_OWNER}/${repo}" \
    --state open \
    --json headRefName \
    --jq '[.[] | select(.headRefName | startswith("chore/audit-fix-"))] | length' \
    2>/dev/null || echo "0")
  [ "${count:-0}" -gt 0 ]
}

submit_task() {
  local repo="$1"
  local task_id task_ns task_content task_json body response

  task_id="$(date -u +%Y%m%d-%H%M%S)-dep-bump-${repo}"
  task_ns="tasks/${task_id}"

  # Build task content — the agent will run npm audit fix, verify, and let
  # the existing branch-per-task flow open the PR.
  task_content=$(cat <<TASK_EOF
## Task: Autonomous dependency bump for ${repo}

- **Runtime:** claude
- **Context:** repo:${repo}
- **Model:** sonnet
- **Timeout:** 600000
- **Submitted by:** hugin
- **Submitted at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
- **Sensitivity:** internal

### Prompt
You are running an autonomous dependency security fix for the **${repo}** repository.
The weekly Grimnir security scan found fixable npm audit vulnerabilities.

**Your task:**

1. Run \`npm audit fix\` (NO \`--force\` — never use --force).
2. If a \`build\` script exists in package.json, run \`npm run build\`.
   - If build FAILS: do NOT open a PR. Report the regression and list the failing output.
3. If a \`test\` script exists in package.json, run \`npm test\`.
   - If tests FAIL: do NOT open a PR. Report the regression with the failing test output.
   - If no test script exists: note this as "needs-manual-verification" in the PR body.
4. If build and tests pass (or no scripts exist):
   - The existing Hugin branch-per-task flow will commit changes to branch \`chore/audit-fix-${SCAN_DATE}\`, push, and open a PR.
   - Do NOT auto-merge. Leave the PR for human review.
5. In your result, summarize:
   - Which advisories were closed (CVE/GHSA IDs if available)
   - Which packages were bumped (package@old-version → package@new-version)
   - Any remaining advisories that require a major version bump (\`--force\`) — list these as "manual review needed"
   - Build/test status

**Rules:**
- NEVER run \`npm audit fix --force\`
- NEVER run any command that modifies git history (rebase, amend, etc.)
- NEVER attempt to merge the PR
- If \`npm audit fix\` reports "0 vulnerabilities" or makes no changes, report that and exit cleanly (no PR needed)
TASK_EOF
)

  task_json=$(json_encode <<< "$task_content")

  body=$(cat <<JSON_EOF
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "memory_write",
    "arguments": {
      "namespace": "${task_ns}",
      "key": "status",
      "content": ${task_json},
      "tags": ["pending", "runtime:claude", "type:dep-bump"]
    }
  }
}
JSON_EOF
)

  response=$(munin_call "$body")

  if echo "$response" | grep -q '"error"'; then
    echo "  [error] Failed to submit task for ${repo}: $response" >&2
    return 1
  fi

  echo "  Submitted: ${task_ns}"
}

# ── discover repos ───────────────────────────────────────────────────────────

if [ $# -gt 0 ]; then
  REPOS=("$@")
  echo "Scope: explicit repos: ${REPOS[*]}"
else
  echo "Querying Munin for repos under security/repos/* ..."
  QUERY_BODY=$(cat <<JSON_EOF
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "memory_query",
    "arguments": {
      "namespace": "security/repos",
      "limit": 100
    }
  }
}
JSON_EOF
)
  QUERY_RESPONSE=$(munin_call "$QUERY_BODY")

  if echo "$QUERY_RESPONSE" | grep -q '"error"'; then
    echo "ERROR: Failed to query Munin security/repos: $QUERY_RESPONSE" >&2
    exit 1
  fi

  mapfile -t REPOS < <(echo "$QUERY_RESPONSE" | extract_repos_from_query)

  if [ "${#REPOS[@]}" -eq 0 ]; then
    echo "No repos found under security/repos/* in Munin. Nothing to do."
    exit 0
  fi
  echo "Found ${#REPOS[@]} repo(s): ${REPOS[*]}"
fi

# ── per-repo processing ──────────────────────────────────────────────────────

for repo in "${REPOS[@]}"; do
  echo ""
  echo "── ${repo} ──"

  # Read the security scan entry for this repo
  READ_BODY=$(cat <<JSON_EOF
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "memory_read",
    "arguments": {
      "namespace": "security/repos/${repo}",
      "key": "audit"
    }
  }
}
JSON_EOF
)

  READ_RESPONSE=$(munin_call "$READ_BODY")

  if echo "$READ_RESPONSE" | grep -q '"error"'; then
    echo "  [warn] Could not read security/repos/${repo}/audit from Munin, skipping"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Check for "found: false" (entry doesn't exist)
  if echo "$READ_RESPONSE" | python3 -c "
import json,sys
resp = json.load(sys.stdin)
text = resp.get('result',{}).get('content',[{}])[0].get('text','{}')
data = json.loads(text)
sys.exit(0 if data.get('found') else 1)
" 2>/dev/null; then
    :  # found=true, continue
  else
    echo "  [skip] No audit entry in Munin for ${repo}"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  fixable=$(echo "$READ_RESPONSE" | extract_fixable_from_read)
  echo "  Fixable vulnerabilities: ${fixable}"

  if [ "$fixable" -eq 0 ] 2>/dev/null; then
    echo "  [skip] No fixable vulnerabilities"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Idempotency: check for existing open audit-fix PR
  if has_open_audit_pr "$repo"; then
    echo "  [skip] Open chore/audit-fix-* PR already exists for ${repo}"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Submit the task
  if submit_task "$repo"; then
    SUBMITTED=$((SUBMITTED + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done

# ── summary ──────────────────────────────────────────────────────────────────

echo ""
echo "Done. Submitted: ${SUBMITTED}, Skipped: ${SKIPPED}, Failed: ${FAILED}"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
