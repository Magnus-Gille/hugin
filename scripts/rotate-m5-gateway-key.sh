#!/usr/bin/env bash
set -euo pipefail

# Rotate the Hugin homeserver gateway key from the owner's workstation.
# Deployment-specific values intentionally live in the local config file; this
# script contains no target hostnames, credential values, or gateway paths.

SCRIPT_NAME="$(basename "$0")"
DEFAULT_CONFIG_PATH="${HOME:-/home/magnus}/.config/hugin/m5-key-rotation.env"
CONFIG_PATH="$DEFAULT_CONFIG_PATH"
DRY_RUN=0

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME [--config PATH] [--dry-run]

Rotate the staged M5 gateway key using values from PATH (default:
$DEFAULT_CONFIG_PATH).
EOF
}

die() {
  echo "ERROR: $1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      [ "$#" -ge 2 ] || die "--config requires a path"
      CONFIG_PATH="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -f "$CONFIG_PATH" ] || die "config file does not exist"

# The config is owner-local and is intentionally sourced so operators can use
# normal shell quoting. No config value is echoed by this script.
# shellcheck disable=SC1090
set -a
source "$CONFIG_PATH"
set +a

required_config=(
  M5_GATEWAY_SSH_TARGET
  M5_GATEWAY_CLI_WRAPPER
  M5_GATEWAY_KEY_ALIAS
  M5_GATEWAY_KEY_SCOPE
  M5_GATEWAY_KEY_TTL_SECONDS
  M5_GATEWAY_KEY_OVERLAP_SECONDS
  M5_SERVICE_SSH_TARGET
  M5_SERVICE_ENV_PATH
  M5_SERVICE_HEALTH_URL
  M5_GATEWAY_BASE_URL
  M5_GATEWAY_PROBE_PATH
  M5_SERVICE_UNIT
  M5_SERVICE_SYSTEMCTL_PREFIX
)
for config_name in "${required_config[@]}"; do
  [ -n "${!config_name:-}" ] || die "missing config value: $config_name"
done

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_single_line() {
  [[ "$1" != *$'\n'* && "$1" != *$'\r'* ]]
}

for numeric_name in M5_GATEWAY_KEY_TTL_SECONDS M5_GATEWAY_KEY_OVERLAP_SECONDS; do
  is_positive_integer "${!numeric_name}" || die "$numeric_name must be a positive integer"
done
for limit_name in M5_GATEWAY_KEY_RPM M5_GATEWAY_KEY_TPM M5_GATEWAY_KEY_PARALLEL; do
  if [ -n "${!limit_name:-}" ]; then
    is_positive_integer "${!limit_name}" || die "$limit_name must be a positive integer when set"
  fi
done
for config_name in "${required_config[@]}" M5_GATEWAY_CLI_WRAPPER; do
  is_single_line "${!config_name}" || die "$config_name must be a single line"
done
[[ "$M5_SERVICE_ENV_PATH" == /* ]] || die "M5_SERVICE_ENV_PATH must be absolute"

read -r -a gateway_wrapper_words <<<"$M5_GATEWAY_CLI_WRAPPER"
[ "${#gateway_wrapper_words[@]}" -gt 0 ] || die "M5_GATEWAY_CLI_WRAPPER is empty"

shell_quote() {
  local value="$1"
  value=${value//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

gateway_command() {
  local action="$1"
  local plan_id="${2:-}"
  local command=""
  local word
  for word in "${gateway_wrapper_words[@]}"; do
    command+=" $(shell_quote "$word")"
  done
  command+=" keys $(shell_quote "$action")"
  case "$action" in
    stage)
      command+=" --alias $(shell_quote "$M5_GATEWAY_KEY_ALIAS")"
      command+=" --scope $(shell_quote "$M5_GATEWAY_KEY_SCOPE")"
      command+=" --ttl $(shell_quote "$M5_GATEWAY_KEY_TTL_SECONDS")"
      command+=" --overlap $(shell_quote "$M5_GATEWAY_KEY_OVERLAP_SECONDS")"
      for limit_name in M5_GATEWAY_KEY_RPM M5_GATEWAY_KEY_TPM M5_GATEWAY_KEY_PARALLEL; do
        if [ -n "${!limit_name:-}" ]; then
          command+=" --$(printf '%s' "$limit_name" | sed 's/^M5_GATEWAY_KEY_//' | tr '[:upper:]' '[:lower:]') $(shell_quote "${!limit_name}")"
        fi
      done
      ;;
    preflight|commit|abort)
      command+=" --plan $(shell_quote "$plan_id")"
      ;;
    *)
      return 1
      ;;
  esac
  printf '%s' "${command# }"
}

if [ "$DRY_RUN" -eq 1 ]; then
  for step in stage write restart health probe preflight commit; do
    echo "DRY-RUN $step"
  done
  exit 0
fi

# These snippets are executed on the service host. The staged key and the old
# key are always stdin data; neither is interpolated into code, argv, or a
# workstation file. The service host uses a same-directory atomic replacement
# with mode 0600, then removes its private temporary inode.
read -r -d '' REMOTE_INSPECT_PY <<'PY' || true
# ROTATE_INSPECT
from pathlib import Path
import re
import sys

data = Path(sys.argv[1]).read_bytes()

def one(name: bytes, required: bool):
    matches = list(re.finditer(rb"(?m)^" + name + rb"=[^\r\n]*(?:\r?\n|$)", data))
    if len(matches) != (1 if required else (0 if not matches else 1)):
        raise SystemExit(2)
    return matches[0].group(0).rstrip(b"\r\n") if matches else None

api = one(b"HOMESERVER_GATEWAY_API_KEY", True)
expiry = one(b"HOMESERVER_GATEWAY_KEY_EXPIRES_AT", False)
sys.stdout.buffer.write(api + b"\n" + (expiry or b"__HUGIN_ROTATION_ABSENT__") + b"\n")
PY

read -r -d '' REMOTE_UPDATE_PY <<'PY' || true
# ROTATE_UPDATE
from pathlib import Path
import os
import re
import sys
import tempfile

path = Path(sys.argv[1])
expiry = sys.argv[2].encode()
data = path.read_bytes()
key = sys.stdin.buffer.read().strip(b" \t\r\n")
if not key or any(char in key for char in (b"\x00", b"\r", b"\n")):
    raise SystemExit(2)

def replace_one(source: bytes, name: bytes, value: bytes, required: bool):
    pattern = rb"(?m)^" + name + rb"=[^\r\n]*(?:\r?\n|$)"
    matches = list(re.finditer(pattern, source))
    if len(matches) != (1 if required else (0 if not matches else 1)):
        raise SystemExit(2)
    if not matches:
        if source and not source.endswith((b"\n", b"\r")):
            source += b"\n"
        return source + name + b"=" + value + b"\n"
    match = matches[0]
    return source[:match.start()] + name + b"=" + value + b"\n" + source[match.end():]

updated = replace_one(data, b"HOMESERVER_GATEWAY_API_KEY", key, True)
updated = replace_one(updated, b"HOMESERVER_GATEWAY_KEY_EXPIRES_AT", expiry, False)
directory = str(path.parent)
fd, temporary = tempfile.mkstemp(prefix=".hugin-m5-key-rotation-", dir=directory)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(updated)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    os.chmod(path, 0o600)
    directory_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PY

read -r -d '' REMOTE_ROLLBACK_PY <<'PY' || true
# ROTATE_ROLLBACK
from pathlib import Path
import os
import re
import sys
import tempfile

path = Path(sys.argv[1])
lines = sys.stdin.buffer.read().splitlines()
if len(lines) != 2 or not lines[0].startswith(b"HOMESERVER_GATEWAY_API_KEY="):
    raise SystemExit(2)
data = path.read_bytes()

def replace_existing(source: bytes, name: bytes, value: bytes):
    pattern = rb"(?m)^" + name + rb"=[^\r\n]*(?:\r?\n|$)"
    matches = list(re.finditer(pattern, source))
    if len(matches) != 1:
        raise SystemExit(2)
    match = matches[0]
    return source[:match.start()] + name + b"=" + value + b"\n" + source[match.end():]

restored = replace_existing(data, b"HOMESERVER_GATEWAY_API_KEY", lines[0].split(b"=", 1)[1])
expiry_pattern = rb"(?m)^HOMESERVER_GATEWAY_KEY_EXPIRES_AT=[^\r\n]*(?:\r?\n|$)"
expiry_matches = list(re.finditer(expiry_pattern, restored))
if len(expiry_matches) > 1:
    raise SystemExit(2)
if lines[1] == b"__HUGIN_ROTATION_ABSENT__":
    if expiry_matches:
        match = expiry_matches[0]
        restored = restored[:match.start()] + restored[match.end():]
else:
    expiry_value = lines[1].split(b"=", 1)[1]
    if expiry_matches:
        match = expiry_matches[0]
        restored = restored[:match.start()] + b"HOMESERVER_GATEWAY_KEY_EXPIRES_AT=" + expiry_value + b"\n" + restored[match.end():]
    else:
        if restored and not restored.endswith((b"\n", b"\r")):
            restored += b"\n"
        restored += b"HOMESERVER_GATEWAY_KEY_EXPIRES_AT=" + expiry_value + b"\n"

directory = str(path.parent)
fd, temporary = tempfile.mkstemp(prefix=".hugin-m5-key-rotation-", dir=directory)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(restored)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    os.chmod(path, 0o600)
    directory_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PY

python_command() {
  local code="$1"
  shift
  local command="python3 -c $(shell_quote "$code")"
  local arg
  for arg in "$@"; do
    command+=" $(shell_quote "$arg")"
  done
  printf '%s' "$command"
}

service_restart_command() {
  printf '%s restart %s' "$M5_SERVICE_SYSTEMCTL_PREFIX" "$(shell_quote "$M5_SERVICE_UNIT")"
}

service_health_command() {
  printf 'curl --silent --show-error --output /dev/null --write-out %s %s' \
    "$(shell_quote '%{http_code}')" "$(shell_quote "$M5_SERVICE_HEALTH_URL")"
}

service_probe_command() {
  local probe_url="${M5_GATEWAY_BASE_URL%/}/${M5_GATEWAY_PROBE_PATH#/}"
  local probe_script
  probe_script="key_line=\$(sed -n $(shell_quote '/^HOMESERVER_GATEWAY_API_KEY=/ {p;q;}') $(shell_quote "$M5_SERVICE_ENV_PATH")); "
  probe_script+="key=\${key_line#*=}; "
  probe_script+="curl --silent --show-error --output /dev/null --write-out $(shell_quote '%{http_code}') "
  probe_script+="-H @<(printf 'Authorization: Bearer %s' \"\$key\") $(shell_quote "$probe_url")"
  printf 'bash -c %s' "$(shell_quote "$probe_script")"
}

plan_id=""
new_expiry=""
stage_pid=""
backup_ready=0
old_api_line=""
old_expiry_line=""
stage_dir="$(mktemp -d)"
stage_fifo="$stage_dir/stage-output"
mkfifo "$stage_fifo"
trap 'rm -rf "$stage_dir"' EXIT

abort_staged_plan() {
  if [ -n "$plan_id" ]; then
    echo "ABORT"
    if ! ssh "$M5_GATEWAY_SSH_TARGET" "$(gateway_command abort "$plan_id")" >/dev/null 2>/dev/null; then
      echo "FAIL abort" >&2
      return 1
    fi
  fi
  return 0
}

rollback_after_stage() {
  local failed_step="$1"
  echo "FAIL $failed_step" >&2
  if [ "$backup_ready" -eq 1 ]; then
    echo "ROLLBACK write"
    if ! printf '%s\n%s\n' "$old_api_line" "$old_expiry_line" |
      ssh "$M5_SERVICE_SSH_TARGET" "$(python_command "$REMOTE_ROLLBACK_PY" "$M5_SERVICE_ENV_PATH")" >/dev/null 2>/dev/null; then
      echo "FAIL rollback" >&2
    fi
    echo "ROLLBACK restart"
    if ! ssh "$M5_SERVICE_SSH_TARGET" "$(service_restart_command)" >/dev/null 2>/dev/null; then
      echo "FAIL rollback-restart" >&2
    fi
  fi
  abort_staged_plan || true
  exit 1
}

capture_backup() {
  local old_state
  local old_state_rest
  if ! old_state="$(ssh "$M5_SERVICE_SSH_TARGET" "$(python_command "$REMOTE_INSPECT_PY" "$M5_SERVICE_ENV_PATH")" 2>/dev/null)"; then
    return 1
  fi
  old_api_line="${old_state%%$'\n'*}"
  old_state_rest="${old_state#*$'\n'}"
  old_expiry_line="${old_state_rest%%$'\n'*}"
  if [[ "$old_api_line" != HOMESERVER_GATEWAY_API_KEY=* ]] || [ -z "$old_expiry_line" ]; then
    return 1
  fi
  backup_ready=1
}

echo "STEP stage"
# A FIFO keeps the staged output on a pipe while retaining a waitable SSH PID;
# this works on the Bash 3.2 still present on some owner workstations.
ssh "$M5_GATEWAY_SSH_TARGET" "$(gateway_command stage)" >"$stage_fifo" 2>/dev/null &
stage_pid="$!"
exec 3<"$stage_fifo"

saw_stage_separator=0
while IFS= read -r stage_line <&3; do
  if [[ "$stage_line" =~ ^[[:space:]]*plan:[[:space:]]*([^[:space:]]+)$ ]]; then
    plan_id="${BASH_REMATCH[1]}"
  elif [[ "$stage_line" =~ ^[[:space:]]*overlap[[:space:]]expires:[[:space:]]*([^[:space:]]+)$ ]]; then
    new_expiry="${BASH_REMATCH[1]}"
  elif [ -z "$stage_line" ]; then
    saw_stage_separator=1
    break
  fi
done

if [ "$saw_stage_separator" -ne 1 ] || [ -z "$plan_id" ] ||
  [[ ! "$new_expiry" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$ ]]; then
  exec 3<&-
  wait "$stage_pid" || true
  if [ -n "$plan_id" ] && capture_backup; then
    rollback_after_stage stage
  fi
  echo "FAIL stage" >&2
  abort_staged_plan || true
  exit 1
fi

echo "PLAN $plan_id"
echo "EXPIRY $new_expiry"

if ! capture_backup; then
  exec 3<&-
  wait "$stage_pid" || true
  rollback_after_stage inspect
fi

echo "STEP write"
if ! cat <&3 |
  ssh "$M5_SERVICE_SSH_TARGET" "$(python_command "$REMOTE_UPDATE_PY" "$M5_SERVICE_ENV_PATH" "$new_expiry")" >/dev/null 2>/dev/null; then
  exec 3<&-
  wait "$stage_pid" || true
  rollback_after_stage write
fi
exec 3<&-
if ! wait "$stage_pid"; then
  rollback_after_stage stage
fi

echo "STEP restart"
if ! ssh "$M5_SERVICE_SSH_TARGET" "$(service_restart_command)" >/dev/null 2>/dev/null; then
  rollback_after_stage restart
fi

echo "STEP health"
health_code=""
for _ in $(seq 1 30); do
  if health_code="$(ssh "$M5_SERVICE_SSH_TARGET" "$(service_health_command)" 2>/dev/null)" &&
    [ "$health_code" = "200" ]; then
    echo "HTTP health $health_code"
    break
  fi
  sleep 1
done
if [ "$health_code" != "200" ]; then
  [ -n "$health_code" ] && echo "HTTP health $health_code"
  rollback_after_stage health
fi

echo "STEP probe"
probe_code=""
if probe_code="$(ssh "$M5_SERVICE_SSH_TARGET" "$(service_probe_command)" 2>/dev/null)"; then
  echo "HTTP probe $probe_code"
fi
if [ "$probe_code" != "200" ]; then
  [ -n "$probe_code" ] && echo "HTTP probe $probe_code"
  rollback_after_stage probe
fi

echo "STEP preflight"
if ! ssh "$M5_GATEWAY_SSH_TARGET" "$(gateway_command preflight "$plan_id")" >/dev/null 2>/dev/null; then
  rollback_after_stage preflight
fi

echo "STEP commit"
if ! ssh "$M5_GATEWAY_SSH_TARGET" "$(gateway_command commit "$plan_id")" >/dev/null 2>/dev/null; then
  rollback_after_stage commit
fi

echo "SUCCESS"
