#!/usr/bin/env bash
# Bash-level test for claude-config-bootstrap.sh (issue #153).
#
# Stubs `ssh` so no network/remote access happens. Exercises the four
# outcomes the deploy script must distinguish:
#   1. checkout missing on the Pi  -> informational message, no WARNING
#   2. checkout present, pull/bootstrap succeeds -> silent (no WARNING)
#   3. checkout present, pull/bootstrap fails    -> WARNING
#   4. presence probe itself inconclusive (ssh/network failure, not the
#      remote `test` reporting "absent") -> WARNING, never INFO
#
# Run: bash scripts/lib/claude-config-bootstrap.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAKE_BIN_DIR="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN_DIR"' EXIT

cat >"$FAKE_BIN_DIR/ssh" <<'EOF'
#!/usr/bin/env bash
# Fake ssh for tests: never touches the network. Inspects the remote
# command string to decide what the "remote" would have reported.
remote="$1"
shift
cmd="$*"
case "$cmd" in
  *"test -d ~/repos/claude-config"*)
    if [ -n "${MOCK_PROBE_RC:-}" ]; then
      exit "$MOCK_PROBE_RC"
    fi
    [ "${MOCK_DIR_EXISTS:-0}" = "1" ]
    ;;
  *"git pull"*"bootstrap.sh"*)
    [ "${MOCK_BOOTSTRAP_OK:-0}" = "1" ]
    ;;
  *)
    echo "fake ssh: unexpected remote command: $cmd" >&2
    exit 99
    ;;
esac
EOF
chmod +x "$FAKE_BIN_DIR/ssh"

export PATH="$FAKE_BIN_DIR:$PATH"

LIB_FILE="$SCRIPT_DIR/claude-config-bootstrap.sh"
if [ ! -f "$LIB_FILE" ]; then
  echo "FAIL: $LIB_FILE not found" >&2
  exit 1
fi
# shellcheck source=claude-config-bootstrap.sh
source "$LIB_FILE"

failures=0

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label — expected output to contain: $needle"
    echo "--- actual output ---"
    echo "$haystack"
    echo "---------------------"
    failures=$((failures + 1))
  else
    echo "PASS: $label"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "FAIL: $label — expected output NOT to contain: $needle"
    echo "--- actual output ---"
    echo "$haystack"
    echo "---------------------"
    failures=$((failures + 1))
  else
    echo "PASS: $label"
  fi
}

# Case 1: missing checkout -> informational, not a WARNING, includes the
# exact remediation command.
out="$(MOCK_DIR_EXISTS=0 claude_config_bootstrap "magnus@testhost")"
assert_not_contains "$out" "WARNING" "missing checkout: no WARNING"
assert_contains "$out" "INFO" "missing checkout: informational message present"
assert_contains "$out" "git clone" "missing checkout: remediation command present"
assert_contains "$out" "magnus@testhost" "missing checkout: remediation command targets the right host"

# Case 2: checkout present, pull/bootstrap succeeds -> no WARNING at all.
out="$(MOCK_DIR_EXISTS=1 MOCK_BOOTSTRAP_OK=1 claude_config_bootstrap "magnus@testhost")"
assert_not_contains "$out" "WARNING" "healthy checkout: no WARNING"

# Case 3: checkout present but pull/bootstrap fails -> WARNING, distinct
# wording from the "missing" case (this is a real problem, not optional).
out="$(MOCK_DIR_EXISTS=1 MOCK_BOOTSTRAP_OK=0 claude_config_bootstrap "magnus@testhost")"
assert_contains "$out" "WARNING" "broken checkout: WARNING present"
assert_not_contains "$out" "git clone" "broken checkout: no clone remediation (checkout already exists)"

# Case 4: the presence probe itself fails inconclusively (e.g. ssh exits 255
# for a transport/auth/timeout failure) rather than the remote `test`
# cleanly reporting "absent" (exit 1). Must NOT be reported as the optional
# "missing" case — that would hide a real connectivity problem behind an
# informational message.
out="$(MOCK_PROBE_RC=255 claude_config_bootstrap "magnus@testhost")"
assert_contains "$out" "WARNING" "inconclusive probe: WARNING present"
assert_not_contains "$out" "INFO" "inconclusive probe: no INFO"
assert_not_contains "$out" "git clone" "inconclusive probe: no clone remediation (absence unproven)"

if [ "$failures" -gt 0 ]; then
  echo "$failures assertion(s) failed"
  exit 1
fi

echo "All assertions passed"
