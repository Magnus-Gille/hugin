#!/usr/bin/env bash
# Hermetic runtime test: substitute only the PATH assignment in a scratch copy.
# The deployed script deliberately owns PATH, so ordinary PATH mocks are unsafe.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT_SCRIPT="${HUGIN_CLI_TEST_SOURCE:-$SCRIPT_DIR/update-cli.sh}"
TEST_TMP="$(mktemp -d "${TMPDIR:?}/hugin-cli-observation.XXXXXX")"
trap 'rm -rf "$TEST_TMP"' EXIT
chmod 700 "$TEST_TMP"
mkdir -m 700 "$TEST_TMP/home" "$TEST_TMP/home/hugin" "$TEST_TMP/bin"
TEST_BIN="$TEST_TMP/bin"
# Remove the one literal production PATH assignment, preserving all other code.
[[ $(grep -c '^export PATH=' "$INPUT_SCRIPT") -eq 1 ]] || exit 64
{ printf 'export PATH=%q\n' "$TEST_BIN:/usr/bin:/bin"; sed '/^export PATH=/d' "$INPUT_SCRIPT"; } >"$TEST_TMP/observe.sh"
cat >"$TEST_BIN/npm" <<'MOCK'
#!/bin/bash
if [[ $# -eq 5 && $1 == ls && $2 == -g && $4 == --depth=0 && $5 == --json ]]; then
  printf 'read\n' >>"$CALLS"
  if [[ ${MISSING_PACKAGE:-0} == 1 ]]; then printf '{}'; exit 1; fi
  printf '{"dependencies":{"%s":{"version":"1.2.3"}}}\n' "$3"
else
  printf 'MUTATION\n' >>"$CALLS"
  exit 65
fi
MOCK
cat >"$TEST_BIN/node" <<'MOCK'
#!/bin/bash
input=$(cat)
if [[ "$input" == *'"version":"1.2.3"'* ]]; then printf '1.2.3\n'; else printf 'not-installed\n'; fi
MOCK
for cli in claude codex; do
  cat >"$TEST_BIN/$cli" <<'MOCK'
#!/bin/bash
[[ $# -eq 1 && $1 == --version ]] || exit 64
[[ ${CLI_RC:-0} == 0 ]] || exit "$CLI_RC"
printf 'fixture-cli 1.2.3\n'
MOCK
done
cat >"$TEST_BIN/logger" <<'MOCK'
#!/bin/bash
printf 'log\n' >>"$CALLS"
MOCK
cat >"$TEST_BIN/curl" <<'MOCK'
#!/bin/bash
set -eu
output=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -d) printf '%s' "$2" >"$BODY"; shift 2 ;;
    *) shift ;;
  esac
done
cat >/dev/null
printf '{}' >"$output"
printf '%s' "${HTTP_STATUS:-200}"
printf 'curl\n' >>"$CALLS"
MOCK
cat >"$TEST_BIN/mktemp" <<'MOCK'
#!/bin/bash
exec /usr/bin/mktemp "${TMPDIR:?}/panel.XXXXXX"
MOCK
cat >"$TEST_BIN/python3" <<'MOCK'
#!/bin/bash
cat >/dev/null
printf '%s' '"synthetic observation"'
MOCK
chmod 700 "$TEST_BIN"/*
run() {
  : >"$TEST_TMP/calls"
  : >"$TEST_TMP/body"
  set +e
  OUTPUT=$(/usr/bin/env -i PATH=/usr/bin:/bin HOME="$TEST_TMP/home" TMPDIR="$TEST_TMP" \
    CALLS="$TEST_TMP/calls" BODY="$TEST_TMP/body" CLI_RC="${CLI_RC:-0}" \
    HTTP_STATUS="${HTTP_STATUS:-200}" MISSING_PACKAGE="${MISSING_PACKAGE:-0}" \
    /bin/bash "$TEST_TMP/observe.sh" 2>&1)
  RC=$?
  set -e
  if grep -q '^MUTATION$' "$TEST_TMP/calls"; then
    printf 'FAIL: attempted package mutation (intercepted mock only)\n' >&2
    exit 1
  fi
}
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
printf 'MUNIN_API_KEY=synthetic-token\nMUNIN_URL=http://fixture.invalid\n' >"$TEST_TMP/home/hugin/.env"
run
[[ $RC == 0 && "$OUTPUT" == *"npm-global: 1.2.3"* && "$OUTPUT" == *"checked:"* ]] || fail 'healthy observation'
[[ "$OUTPUT" != *"Updating "* && "$OUTPUT" != *" updated "* ]] || fail 'no false promotion claim'
{ grep -q "meta/hugin" "$TEST_TMP/body" && grep -q "cli-versions" "$TEST_TMP/body"; } || fail 'stable Munin destination'
HTTP_STATUS=503 run
[[ $RC == 0 && "$OUTPUT" == *"non-fatal, HTTP 503"* ]] || fail 'optional Munin failure stays nonfatal'
CLI_RC=1 run
[[ $RC == 1 && "$OUTPUT" == *"smoke: broken"* ]] || fail 'broken CLI fails health'
MISSING_PACKAGE=1 run
[[ $RC == 0 && "$OUTPUT" == *"npm-global: not-installed"* && "$OUTPUT" == *"smoke: ok"* ]] || fail 'standalone CLI may exist without npm package'
rm "$TEST_TMP/home/hugin/.env"
CLI_RC=127 run
[[ $RC == 1 && "$OUTPUT" == *"MUNIN_API_KEY not set"* ]] || fail 'missing CLI and optional reporting'
if grep -q '^curl$' "$TEST_TMP/calls"; then fail 'no optional credential means no report request'; fi
printf 'PASS: observation, no mutation, missing/broken CLI, package metadata, optional telemetry\n'
