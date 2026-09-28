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
STALE_TEMP="$TEST_ROOT/.hugin-m5-key-rotation-stale"
FRESH_TEMP="$TEST_ROOT/.hugin-m5-key-rotation-fresh"
STAGE_TERM_MARKER="$TEST_ROOT/stage-terminated"
WRITE_START_MARKER="$TEST_ROOT/write-started"
PROBE_AUTH_MARKER="$TEST_ROOT/probe-auth-accepted"
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
  # Mirrors the real gateway CLI: no line for the new key's expiry.
  printf "✓ staged 'hugin-test-key' → replacement 'hugin-test-key-r2'\n"
  printf '  plan: rot_test395plan0001\n'
  printf '  overlap expires: 2026-10-02T12:00:00.000Z\n'
  if [[ "${FAKE_STAGE_HOLD_BEFORE_SEPARATOR:-0}" == 1 ]]; then
    trap 'printf terminated >"$STAGE_TERM_MARKER"; exit 143' INT TERM
    while :; do :; done
  fi
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
rotations)
  case "${FAKE_ROTATION_STATE:-staged}" in
    committed) rotation_status=committed ;;
    aborted) rotation_status=aborted ;;
    *) rotation_status=staged ;;
  esac
  printf '%-21s %-18s %-20s %-10s %s\n' PLAN LOGICAL REPLACEMENT STATUS PREFLIGHT
  printf '%-21s %-18s %-20s %-10s %s\n' rot_test395plan0001 hugin-test-key hugin-test-key-r2 "$rotation_status" pending
  exit "${FAKE_ROTATIONS_RC:-0}"
  ;;
list)
  printf '%-20s %-16s %-6s %-10s %-7s %-9s %-9s %-4s %-22s %s\n' ALIAS LOGICAL TIER SCOPE RPM TPM DAILY PAR EXPIRES REVOKED
  printf '%-20s %-16s %-6s %-10s %-7s %-9s %-9s %-4s %-22s %s\n' hugin-test-key "" owner admin 600 2000000 0 2 never ""
  printf '%-20s %-16s %-6s %-10s %-7s %-9s %-9s %-4s %-22s %s\n' hugin-test-key-r2 hugin-test-key owner admin 600 2000000 0 2 "${FAKE_LIST_EXPIRES:-2026-10-28T12:00:00.000Z}" ""
  exit "${FAKE_LIST_RC:-0}"
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
  eval "exec fake-gateway-cli $command"
fi

if [[ "$target" == service-test-target ]]; then
  if [[ "$command" == *"python3 -c"* && "$command" == *"inspect"* ]]; then
    : # reserved for implementations that use an explicit inspect command
  fi
  if [[ "$command" == *"systemctl"* && "$command" == *"restart"* ]]; then
    bash -c "$command"
    exit $?
  fi
  if [[ "$command" == *"curl"* ]]; then
    bash -c "$command"
    exit $?
  fi
  if [[ "$command" == *"python3 -c"* ]]; then
    if [[ "$command" == *"ROTATE_UPDATE"* && "${FAKE_WRITE_HOLD:-0}" == 1 ]]; then
      : >"$WRITE_START_MARKER"
      trap 'exit 143' INT TERM
      while :; do :; done
    fi
    if [[ "${FAKE_WRITE_FAIL:-0}" == 1 && "$command" == *"ROTATE_UPDATE"* ]]; then
      exit 91
    fi
    if [[ "${FAKE_ROLLBACK_FAIL:-0}" == 1 && "$command" == *"ROTATE_ROLLBACK"* ]]; then
      exit 92
    fi
    if [[ "${FAKE_INSPECT_FAIL:-0}" == 1 && "$command" == *"ROTATE_INSPECT"* ]]; then
      exit 93
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
  header_file=""
  for argument in "$@"; do
    if [[ "$argument" == @/dev/fd/* ]]; then
      header_file="${argument#@}"
      break
    fi
  done
  [[ -n "$header_file" ]] || exit 97
  [[ "$(cat "$header_file")" == 'Authorization: Bearer new-secret-value' ]] || exit 98
  : >"$PROBE_AUTH_MARKER"
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
export CALL_LOG REMOTE_ENV STAGE_TERM_MARKER WRITE_START_MARKER PROBE_AUTH_MARKER

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
  rm -f "$STALE_TEMP" "$FRESH_TEMP" "$STAGE_TERM_MARKER" "$WRITE_START_MARKER" "$PROBE_AUTH_MARKER"
  printf 'stale rotation temp\n' >"$STALE_TEMP"
  printf 'fresh rotation temp\n' >"$FRESH_TEMP"
  chmod 600 "$STALE_TEMP" "$FRESH_TEMP"
  touch -t 202001010000 "$STALE_TEMP"
  : >"$CALL_LOG"
  unset FAKE_STAGE_RC FAKE_STAGE_HOLD_BEFORE_SEPARATOR FAKE_WRITE_FAIL FAKE_WRITE_HOLD \
    FAKE_ROLLBACK_FAIL FAKE_INSPECT_FAIL FAKE_SYSTEMCTL_RC FAKE_PROBE_HTTP_CODE \
    FAKE_PREFLIGHT_RC FAKE_COMMIT_RC FAKE_ABORT_RC FAKE_HEALTH_HTTP_CODE \
    FAKE_ROTATION_STATE FAKE_ROTATIONS_RC FAKE_LIST_RC
}

reset_fixture
set +e
success_output="$(bash "$ROTATE_SCRIPT" --config "$CONFIG" 2>"$TEST_ROOT/success.err")"
success_rc=$?
set -e
[[ "$success_rc" -eq 0 ]] || fail "success path exits zero"
assert_contains "$success_output" "rot_test395plan0001" "success reports the plan id"
assert_contains "$success_output" "2026-10-28T12:00:00.000Z" "success reports the gateway key expiry"
assert_contains "$success_output" "HTTP health 200" "success reports health HTTP code"
assert_contains "$success_output" "HTTP probe 200" "success reports probe HTTP code"
assert_contains "$(cat "$REMOTE_ENV")" \
  'HOMESERVER_GATEWAY_API_KEY=new-secret-value' "success writes the new API key"
assert_contains "$(cat "$REMOTE_ENV")" \
  'HOMESERVER_GATEWAY_KEY_EXPIRES_AT=2026-10-28T12:00:00.000Z' "success writes gateway key expiry"
assert_not_contains "$(cat "$REMOTE_ENV")" \
  'HOMESERVER_GATEWAY_KEY_EXPIRES_AT=2026-10-02T12:00:00.000Z' "success does not write overlap expiry"
assert_not_contains "$success_output$(cat "$TEST_ROOT/success.err")$(cat "$CALL_LOG")" \
  'new-secret-value' "plaintext never appears in output or argv logs"
mode="$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$REMOTE_ENV")"
[[ "$mode" == 0o600 ]] || fail "success keeps the service env mode at 0600"
[[ "$(grep -c '^HOMESERVER_GATEWAY_API_KEY=' "$REMOTE_ENV")" -eq 1 ]] \
  || fail "success keeps exactly one API-key line"
[[ -f "$PROBE_AUTH_MARKER" ]] || fail "probe sends the new API key"
[[ ! -e "$STALE_TEMP" ]] || fail "success removes stale rotation temp files"
[[ -e "$FRESH_TEMP" ]] || fail "cleanup preserves fresh rotation temp files"
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
    commit) export FAKE_COMMIT_RC=96 FAKE_ROTATION_STATE=aborted ;;
  esac
  set +e
  failure_output="$(bash "$ROTATE_SCRIPT" --config "$CONFIG" 2>"$TEST_ROOT/$failure_case.err")"
  failure_rc=$?
  set -e
  failure_err="$(cat "$TEST_ROOT/$failure_case.err")"
  [[ "$failure_rc" -ne 0 ]] || fail "$failure_case failure exits non-zero"
  assert_contains "$failure_output$failure_err" "FAIL $failure_case" "$failure_case reports its step"
  calls="$(cat "$CALL_LOG")"
  assert_contains "$calls" "keys abort --plan rot_test395plan0001" "$failure_case aborts the staged plan"
  assert_contains "$calls" "systemctl --user restart hugin.service" "$failure_case restarts during rollback"
  assert_env_restored
  assert_not_contains "$failure_output$failure_err$calls" \
    'new-secret-value' "$failure_case keeps the plaintext out of output and argv logs"
done

reset_fixture
export FAKE_ROLLBACK_FAIL=1 FAKE_HEALTH_HTTP_CODE=503
set +e
rollback_failure_output="$(bash "$ROTATE_SCRIPT" --config "$CONFIG" 2>"$TEST_ROOT/rollback-failure.err")"
rollback_failure_rc=$?
set -e
[[ "$rollback_failure_rc" -ne 0 ]] || fail "rollback failure exits non-zero"
assert_contains "$rollback_failure_output$(cat "$TEST_ROOT/rollback-failure.err")" \
  "FAIL rollback" "rollback failure is reported"
assert_contains "$(cat "$CALL_LOG")" "keys abort --plan rot_test395plan0001" \
  "rollback failure still aborts the staged plan"

for commit_state in committed staged aborted unknown; do
  reset_fixture
  export FAKE_COMMIT_RC=96 FAKE_ROTATION_STATE="$commit_state"
  if [[ "$commit_state" == unknown ]]; then
    export FAKE_ROTATIONS_RC=97 FAKE_LIST_RC=98
  fi
  set +e
  ambiguous_output="$(bash "$ROTATE_SCRIPT" --config "$CONFIG" 2>"$TEST_ROOT/ambiguous-$commit_state.err")"
  ambiguous_rc=$?
  set -e
  ambiguous_err="$(cat "$TEST_ROOT/ambiguous-$commit_state.err")"
  [[ "$ambiguous_rc" -ne 0 ]] || fail "ambiguous $commit_state commit exits non-zero"
  calls="$(cat "$CALL_LOG")"
  if [[ "$commit_state" == committed || "$commit_state" == staged || "$commit_state" == unknown ]]; then
    assert_contains "$(cat "$REMOTE_ENV")" \
      'HOMESERVER_GATEWAY_API_KEY=new-secret-value' \
      "ambiguous $commit_state outcome retains the new key"
    assert_not_contains "$calls" "keys abort --plan rot_test395plan0001" \
      "ambiguous $commit_state outcome does not abort"
    if [[ "$commit_state" == committed ]]; then
      assert_contains "$ambiguous_output$ambiguous_err" \
        "commit acknowledged ambiguously; new key retained" \
        "committed ambiguity explains retained key"
    elif [[ "$commit_state" == staged ]]; then
      assert_contains "$ambiguous_output$ambiguous_err" \
        "plan rot_test395plan0001 is still staged; new key retained" \
        "staged ambiguity retains the new key and explains recovery"
    else
      assert_contains "$ambiguous_output$ambiguous_err" \
        "commit outcome unknown; new key retained; manual recovery required" \
        "unknown ambiguity requires manual recovery"
    fi
  else
    assert_env_restored
    # aborted plan: roll back to the previous key (a further abort is harmless)
  fi
done

reset_fixture
export FAKE_STAGE_HOLD_BEFORE_SEPARATOR=1
set +e
bash "$ROTATE_SCRIPT" --config "$CONFIG" >"$TEST_ROOT/signal-before.out" 2>"$TEST_ROOT/signal-before.err" &
signal_before_pid=$!
set -e
for _ in $(seq 1 100); do
  grep -q 'keys stage' "$CALL_LOG" && break
  sleep 0.01
done
kill -TERM "$signal_before_pid"
set +e
wait "$signal_before_pid"
signal_before_rc=$?
set -e
[[ "$signal_before_rc" -ne 0 ]] || fail "signal before write exits non-zero"
assert_contains "$(cat "$CALL_LOG")" "keys abort --plan rot_test395plan0001" \
  "signal before write aborts the staged plan"
assert_not_contains "$(cat "$CALL_LOG")" "ROTATE_ROLLBACK" \
  "signal before write does not restore the service env"
[[ -f "$STAGE_TERM_MARKER" ]] || fail "signal stops the stage child"

reset_fixture
export FAKE_WRITE_HOLD=1
set +e
bash "$ROTATE_SCRIPT" --config "$CONFIG" >"$TEST_ROOT/signal-after.out" 2>"$TEST_ROOT/signal-after.err" &
signal_after_pid=$!
set -e
for _ in $(seq 1 100); do
  [[ -f "$WRITE_START_MARKER" ]] && break
  sleep 0.01
done
kill -TERM "$signal_after_pid"
set +e
wait "$signal_after_pid"
signal_after_rc=$?
set -e
[[ "$signal_after_rc" -ne 0 ]] || fail "signal after write exits non-zero"
assert_env_restored
assert_contains "$(cat "$CALL_LOG")" "keys abort --plan rot_test395plan0001" \
  "signal after write aborts the staged plan"
assert_contains "$(cat "$CALL_LOG")" "ROTATE_ROLLBACK" \
  "signal after write restores the service env"

HOSTILE_MARKER="$TEST_ROOT/hostile-command-ran"
HOSTILE_CONFIG="$TEST_ROOT/hostile.env"
sed "s|^M5_SERVICE_SYSTEMCTL_PREFIX=.*|M5_SERVICE_SYSTEMCTL_PREFIX=\"systemctl --user; touch $HOSTILE_MARKER\"|" \
  "$CONFIG" >"$HOSTILE_CONFIG"
reset_fixture
set +e
bash "$ROTATE_SCRIPT" --config "$HOSTILE_CONFIG" >"$TEST_ROOT/hostile.out" 2>"$TEST_ROOT/hostile.err"
hostile_rc=$?
set -e
[[ "$hostile_rc" -eq 0 ]] || fail "hostile systemctl prefix remains a valid quoted argument"
[[ ! -e "$HOSTILE_MARKER" ]] || fail "hostile systemctl prefix cannot execute a remote command"

TRACE_CONFIG="$TEST_ROOT/tracing.env"
cp "$CONFIG" "$TRACE_CONFIG"
printf '\nset -x\n' >>"$TRACE_CONFIG"
reset_fixture
set +e
bash "$ROTATE_SCRIPT" --config "$TRACE_CONFIG" >"$TEST_ROOT/tracing-config.out" 2>"$TEST_ROOT/tracing-config.err"
tracing_config_rc=$?
set -e
[[ "$tracing_config_rc" -ne 0 ]] || fail "config that enables tracing is rejected"
assert_contains "$(cat "$TEST_ROOT/tracing-config.err")" \
  "shell tracing must remain disabled" "tracing config is rejected explicitly"
assert_not_contains "$(cat "$TEST_ROOT/tracing-config.err")" \
  'old-secret-value' "config tracing cannot expose the old key"

reset_fixture
set +e
bash -x "$ROTATE_SCRIPT" --config "$CONFIG" >"$TEST_ROOT/bash-x.out" 2>"$TEST_ROOT/bash-x.err"
bash_x_rc=$?
set -e
[[ "$bash_x_rc" -eq 0 ]] || fail "bash -x success path remains successful"
assert_not_contains "$(cat "$TEST_ROOT/bash-x.err")" \
  'old-secret-value' "bash -x cannot expose the old key"

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

# The real gateway prints no new-key expiry during stage; when `keys list` is
# unavailable the script must fall back to stage time + TTL, never the overlap
# deadline.
reset_fixture
export FAKE_LIST_RC=7
set +e
fallback_output="$(bash "$ROTATE_SCRIPT" --config "$CONFIG" 2>"$TEST_ROOT/fallback.err")"
fallback_rc=$?
set -e
unset FAKE_LIST_RC
[[ "$fallback_rc" -eq 0 ]] || fail "expiry fallback run succeeds"
fallback_expiry="$(printf '%s\n' "$fallback_output" | awk '$1 == "EXPIRY" { print $2; exit }')"
[[ "$fallback_expiry" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
  || fail "expiry fallback yields an ISO timestamp (got: $fallback_expiry)"
[[ "$fallback_expiry" != "2026-10-02T12:00:00.000Z" ]] \
  || fail "expiry fallback must not use the overlap deadline"
[[ "$fallback_expiry" != "2026-10-28T12:00:00.000Z" ]] \
  || fail "expiry fallback must not read the unavailable key listing"

if (( failures > 0 )); then
  echo "$failures assertion(s) failed" >&2
  exit 1
fi
echo "rotate-m5-gateway-key: all assertions passed"
