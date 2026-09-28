#!/usr/bin/env bash
set -euo pipefail

# Hermetic contract tests for rotate-m5-gateway-key.sh. Every remote command,
# CLI call, curl, and systemctl invocation is stubbed; no network is used.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROTATE_SCRIPT="$SCRIPT_DIR/rotate-m5-gateway-key.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAKE_BIN="$TEST_ROOT/bin"
CALL_LOG="$TEST_ROOT/calls.log"
REMOTE_ENV="$TEST_ROOT/service.env"
CONFIG="$TEST_ROOT/rotation.env"
mkdir -p "$FAKE_BIN"
: >"$CALL_LOG"

cat >"$CONFIG" <<EOF
M5_GATEWAY_SSH_TARGET="gateway-test-target"
M5_GATEWAY_CLI_WRAPPER="sandboxed-gateway-cli --service gateway"
M5_GATEWAY_KEY_ALIAS="hugin-test-key"
M5_GATEWAY_KEY_SCOPE="admin"
M5_GATEWAY_KEY_TTL_SECONDS="86400"
M5_GATEWAY_KEY_OVERLAP_SECONDS="3600"
M5_GATEWAY_KEY_RPM="42"
M5_GATEWAY_KEY_TPM="4200"
M5_GATEWAY_KEY_PARALLEL="3"
M5_SERVICE_SSH_TARGET="service-test-target"
M5_SERVICE_ENV_PATH="$REMOTE_ENV"
M5_SERVICE_HEALTH_URL="http://127.0.0.1:3032/health"
M5_GATEWAY_BASE_URL="http://gateway.test.invalid"
M5_GATEWAY_PROBE_PATH="/protected/health"
M5_SERVICE_UNIT="hugin.service"
M5_SERVICE_SYSTEMCTL_PREFIX="systemctl --user"
EOF

cat >"$REMOTE_ENV" <<'EOF'
MUNIN_API_KEY=munin-test-value
HOMESERVER_GATEWAY_API_KEY=old-secret-value
HOMESERVER_GATEWAY_KEY_EXPIRES_AT=2026-10-01T12:00:00.000Z
EOF

cat >"$FAKE_BIN/fake-gateway-cli" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'cli %s\n' "$*" >>"$CALL_LOG"
action=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == keys ]]; then
    action="$argument"
    break
  fi
  previous="$argument"
done
case "$action" in
stage)
  printf '✓ staged hugin-test-key\n'
  printf '  plan: plan-test-395\n'
  printf '  overlap expires: 2026-10-02T12:00:00.000Z\n'
  printf '\n'
  printf '  new-secret-value\n'
  exit "${FAKE_STAGE_RC:-0}"
  ;;
preflight)
  exit "${FAKE_PREFLIGHT_RC:-0}"
  ;;
commit)
  exit "${FAKE_COMMIT_RC:-0}"
  ;;
abort)
  exit "${FAKE_ABORT_RC:-0}"
  ;;
*)
  exit 64
  ;;
esac
EOF

cat >"$FAKE_BIN/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
target="${1:-}"
command="${2:-}"
printf 'ssh target=%s command=%s\n' "$target" "$command" >>"$CALL_LOG"

if [[ "$target" == gateway-test-target ]]; then
  bash -c "fake-gateway-cli $command"
  exit $?
fi

if [[ "$target" == service-test-target ]]; then
  if [[ "$command" == *"python3 -c"* && "$command" == *"inspect"* ]]; then
    : # reserved for implementations that use an explicit inspect command
  fi
  if [[ "$command" == *"systemctl --user restart"* ]]; then
    systemctl --user restart hugin.service
    exit $?
  fi
  if [[ "$command" == *"curl"* ]]; then
    bash -c "$command"
    exit $?
  fi
  if [[ "$command" == *"python3 -c"* ]]; then
    if [[ "${FAKE_WRITE_FAIL:-0}" == 1 && "$command" == *"ROTATE_UPDATE"* ]]; then
      exit 91
    fi
    bash -c "$command"
    exit $?
  fi
  exit 64
fi

exit 65
EOF

cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"$CALL_LOG"
if [[ "$*" == *"@/dev/fd/"* ]]; then
  printf '%s\n' "${FAKE_PROBE_HTTP_CODE:-200}"
else
  printf '%s\n' "${FAKE_HEALTH_HTTP_CODE:-200}"
fi
EOF

cat >"$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl %s\n' "$*" >>"$CALL_LOG"
exit "${FAKE_SYSTEMCTL_RC:-0}"
EOF

cat >"$FAKE_BIN/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

chmod +x "$FAKE_BIN"/*
export PATH="$FAKE_BIN:$PATH"
export CALL_LOG REMOTE_ENV

failures=0
fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label (missing: $needle)"
}
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" != *"$needle"* ]] || fail "$label (unexpected: $needle)"
}
assert_env_restored() {
  grep -qx 'HOMESERVER_GATEWAY_API_KEY=old-secret-value' "$REMOTE_ENV" \
    || fail "rollback restores the previous API key"
  grep -qx 'HOMESERVER_GATEWAY_KEY_EXPIRES_AT=2026-10-01T12:00:00.000Z' "$REMOTE_ENV" \
    || fail "rollback restores the previous expiry"
  local mode
  mode="$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$REMOTE_ENV")"
  [[ "$mode" == 0o600 ]] || fail "rollback keeps the service env mode at 0600"
}
reset_fixture() {
  cat >"$REMOTE_ENV" <<'EOF'
MUNIN_API_KEY=munin-test-value
HOMESERVER_GATEWAY_API_KEY=old-secret-value
HOMESERVER_GATEWAY_KEY_EXPIRES_AT=2026-10-01T12:00:00.000Z
EOF
  : >"$CALL_LOG"
  unset FAKE_STAGE_RC FAKE_WRITE_FAIL FAKE_SYSTEMCTL_RC FAKE_PROBE_HTTP_CODE \
    FAKE_PREFLIGHT_RC FAKE_COMMIT_RC FAKE_ABORT_RC FAKE_HEALTH_HTTP_CODE
}

reset_fixture
set +e
success_output="$(bash "$ROTATE_SCRIPT" --config "$CONFIG" 2>"$TEST_ROOT/success.err")"
success_rc=$?
set -e
[[ "$success_rc" -eq 0 ]] || fail "success path exits zero"
assert_contains "$success_output" "plan-test-395" "success reports the plan id"
assert_contains "$success_output" "2026-10-02T12:00:00.000Z" "success reports the new expiry"
assert_contains "$success_output" "HTTP health 200" "success reports health HTTP code"
assert_contains "$success_output" "HTTP probe 200" "success reports probe HTTP code"
assert_contains "$(cat "$REMOTE_ENV")" \
  'HOMESERVER_GATEWAY_API_KEY=new-secret-value' "success writes the new API key"
assert_contains "$(cat "$REMOTE_ENV")" \
  'HOMESERVER_GATEWAY_KEY_EXPIRES_AT=2026-10-02T12:00:00.000Z' "success writes expiry"
assert_not_contains "$success_output$(cat "$TEST_ROOT/success.err")$(cat "$CALL_LOG")" \
  'new-secret-value' "plaintext never appears in output or argv logs"
mode="$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$REMOTE_ENV")"
[[ "$mode" == 0o600 ]] || fail "success keeps the service env mode at 0600"
[[ "$(grep -c '^HOMESERVER_GATEWAY_API_KEY=' "$REMOTE_ENV")" -eq 1 ]] \
  || fail "success keeps exactly one API-key line"
assert_contains "$(cat "$CALL_LOG")" \
  'sandboxed-gateway-cli --service gateway keys stage --alias hugin-test-key --scope admin --ttl 86400 --overlap 3600 --rpm 42 --tpm 4200 --parallel 3' \
  "stage uses the configured sandbox wrapper and limits"

for failure_case in stage write restart health probe preflight commit; do
  reset_fixture
  case "$failure_case" in
    stage) export FAKE_STAGE_RC=93 ;;
    write) export FAKE_WRITE_FAIL=1 ;;
    restart) export FAKE_SYSTEMCTL_RC=94 ;;
    health) export FAKE_HEALTH_HTTP_CODE=503 ;;
    probe) export FAKE_PROBE_HTTP_CODE=401 ;;
    preflight) export FAKE_PREFLIGHT_RC=95 ;;
    commit) export FAKE_COMMIT_RC=96 ;;
  esac
  set +e
  failure_output="$(bash "$ROTATE_SCRIPT" --config "$CONFIG" 2>"$TEST_ROOT/$failure_case.err")"
  failure_rc=$?
  set -e
  failure_err="$(cat "$TEST_ROOT/$failure_case.err")"
  [[ "$failure_rc" -ne 0 ]] || fail "$failure_case failure exits non-zero"
  assert_contains "$failure_output$failure_err" "FAIL $failure_case" "$failure_case reports its step"
  calls="$(cat "$CALL_LOG")"
  assert_contains "$calls" "keys abort --plan plan-test-395" "$failure_case aborts the staged plan"
  assert_contains "$calls" "systemctl --user restart hugin.service" "$failure_case restarts during rollback"
  assert_env_restored
  assert_not_contains "$failure_output$failure_err$calls" \
    'new-secret-value' "$failure_case keeps the plaintext out of output and argv logs"
done

reset_fixture
set +e
dry_output="$(bash "$ROTATE_SCRIPT" --config "$CONFIG" --dry-run 2>"$TEST_ROOT/dry.err")"
dry_rc=$?
set -e
[[ "$dry_rc" -eq 0 ]] || fail "dry-run exits zero"
assert_contains "$dry_output" "DRY-RUN stage" "dry-run reports stage"
assert_contains "$dry_output" "DRY-RUN commit" "dry-run reports commit"
[[ ! -s "$CALL_LOG" ]] || fail "dry-run contacts no stubbed remote"
assert_not_contains "$dry_output$(cat "$TEST_ROOT/dry.err")" \
  'new-secret-value' "dry-run does not expose a key"

if (( failures > 0 )); then
  echo "$failures assertion(s) failed" >&2
  exit 1
fi
echo "rotate-m5-gateway-key: all assertions passed"
