#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBMIT_SCRIPT="$SCRIPT_DIR/submit-dep-bumps.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FAKE_BIN="$TMP_DIR/bin"
CALL_LOG="$TMP_DIR/calls.log"
mkdir -p "$FAKE_BIN"
: >"$CALL_LOG"

cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
body="${!#}"
printf '%s\n' "$body" >>"$CALL_LOG"
if [[ "$body" == *'"name": "memory_read"'* ]]; then
  printf '%s\n' '{"result":{"content":[{"text":"{\"found\":true,\"content\":\"{\\\"fixable\\\":1}\"}"}]}}'
  exit 0
fi
printf '%s\n' '{"result":{"content":[{"text":"{}"}]}}'
EOF

cat >"$FAKE_BIN/gh" <<'EOF'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >>"$CALL_LOG"
exit 42
EOF

chmod +x "$FAKE_BIN/curl" "$FAKE_BIN/gh"
export CALL_LOG

failures=0
fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

# Missing owner must stop before any Munin read or task submission.
: >"$CALL_LOG"
set +e
missing_owner_output="$(PATH="$FAKE_BIN:$PATH" MUNIN_API_KEY=test-key GITHUB_OWNER= bash "$SUBMIT_SCRIPT" hugin 2>&1)"
missing_owner_rc=$?
set -e
[[ "$missing_owner_rc" -ne 0 ]] || fail "missing GITHUB_OWNER must fail closed"
[[ "$missing_owner_output" == *"GITHUB_OWNER"* ]] || fail "missing owner failure must explain the required setting"
[[ ! -s "$CALL_LOG" ]] || fail "missing owner must fail before reading or writing Munin"

# An unusable GitHub idempotency check must never be treated as "no open PR".
: >"$CALL_LOG"
set +e
gh_failure_output="$(PATH="$FAKE_BIN:$PATH" MUNIN_API_KEY=test-key GITHUB_OWNER=Magnus-Gille bash "$SUBMIT_SCRIPT" hugin 2>&1)"
gh_failure_rc=$?
set -e
[[ "$gh_failure_rc" -ne 0 ]] || fail "failed GitHub idempotency check must fail closed"
[[ "$gh_failure_output" == *"idempotency"* ]] || fail "GitHub failure must identify the idempotency problem"
calls="$(cat "$CALL_LOG")"
[[ "$calls" == *'"name": "memory_read"'* ]] || fail "test must reach the eligible audit entry"
[[ "$calls" != *'"name": "memory_write"'* ]] || fail "failed GitHub check must not submit a paid task"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures assertion(s) failed" >&2
  exit 1
fi

echo "All assertions passed"
