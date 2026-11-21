#!/bin/bash
set -euo pipefail

# Deploy Hugin to the Hugin-Munin Pi
# Usage: ./scripts/deploy-pi.sh [hostname]

TAILSCALE_IP="100.97.117.37"
if [ -n "${1:-}" ]; then
  PI_HOST="$1"
elif ping -c1 -W1 huginmunin.local >/dev/null 2>&1; then
  PI_HOST="huginmunin.local"
else
  echo "  mDNS unavailable, falling back to Tailscale IP"
  PI_HOST="$TAILSCALE_IP"
fi
DEPLOY_USER="${DEPLOY_USER:-magnus}"
REMOTE="$DEPLOY_USER@$PI_HOST"
REMOTE_DIR="/home/$DEPLOY_USER/repos/hugin"
# Dedicated research lane prerequisites. Keep the CLI exact-pinned: the Pi
# extension/flag contract is not compatible with arbitrary future releases.
RESEARCH_PI_PACKAGE="${HUGIN_RESEARCH_PI_PACKAGE:-@earendil-works/pi-coding-agent}"
RESEARCH_PI_VERSION="${HUGIN_RESEARCH_PI_VERSION:-0.84.1}"
# shellcheck source=lib/deploy-pi-remote-blocks.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/deploy-pi-remote-blocks.sh"

# HUGIN-421: optional maintenance drain (docs/maintenance-drain.md). Off by
# default so existing deploys are unchanged; HUGIN_DEPLOY_DRAIN=1 makes it
# mandatory and fail-closed: the deploy aborts (and resumes admission) unless
# Hugin is drained and ready. Requires HUGIN_MAINTENANCE_TOKEN in the Pi .env,
# provisioned by the owner. Nothing here cancels, fails or replays a task.
DEPLOY_DRAIN="${HUGIN_DEPLOY_DRAIN:-0}"
DRAIN_TIMEOUT_MS="${HUGIN_DEPLOY_DRAIN_TIMEOUT_MS:-120000}"
DRAIN_HOLD_MS="${HUGIN_DEPLOY_DRAIN_HOLD_MS:-900000}"
DRAIN_MIN_REMAINING_MS="${HUGIN_DEPLOY_DRAIN_MIN_REMAINING_MS:-60000}"
DRAIN_ACTIVE=0
case "$DEPLOY_DRAIN" in 0 | 1) ;; *) echo "ERROR: HUGIN_DEPLOY_DRAIN must be 0 or 1." >&2; exit 1 ;; esac
if [ "$DEPLOY_DRAIN" = 1 ]; then
  for drain_value in "$DRAIN_TIMEOUT_MS" "$DRAIN_HOLD_MS" "$DRAIN_MIN_REMAINING_MS"; do
    [[ "$drain_value" =~ ^[0-9]+$ ]] || { echo "ERROR: drain timings must be non-negative integers." >&2; exit 1; }
  done
  if [ "$DRAIN_TIMEOUT_MS" -gt 600000 ] || [ "$DRAIN_HOLD_MS" -le "$DRAIN_TIMEOUT_MS" ] || [ "$DRAIN_HOLD_MS" -lt 1000 ] || [ "$DRAIN_HOLD_MS" -gt 3600000 ]; then
    echo "ERROR: need timeout <= 600000 ms and 1000 <= hold <= 3600000 ms with hold > timeout." >&2
    exit 1
  fi
fi

# Reversal recipe for the drain: resume admission. Best effort on any failure
# exit; a restart or lease expiry reopens admission regardless.
drain_resume() {
  if [ "$DRAIN_ACTIVE" = 1 ]; then
    DRAIN_ACTIVE=0
    echo "==> Resuming Hugin task admission..." >&2
    ssh "$REMOTE" "$(maintenance_remote_block resume "$REMOTE_DIR")" >/dev/null ||
      echo "  WARNING: could not resume admission; it reopens on restart or hold-lease expiry." >&2
  fi
}
on_deploy_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then drain_resume; fi
  return "$rc"
}
trap on_deploy_exit EXIT

read_clean_deploy_sha() {
  local repo_root source_status source_sha
  if ! repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    echo "ERROR: deploy source is not an addressable Git checkout." >&2
    return 1
  fi
  if [ "$(pwd -P)" != "$(cd "$repo_root" && pwd -P)" ]; then
    echo "ERROR: run deploy-pi.sh from the Hugin repository root." >&2
    return 1
  fi
  if ! source_sha="$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" ||
    [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ERROR: deploy source HEAD is not an addressable full commit." >&2
    return 1
  fi
  if ! source_status="$(git status --porcelain=v1 --untracked-files=normal)"; then
    echo "ERROR: could not verify deploy-source cleanliness." >&2
    return 1
  fi
  if [ -n "$source_status" ]; then
    echo "ERROR: deploy source must be clean; refusing to stamp uncommitted content." >&2
    printf '%s\n' "$source_status" >&2
    return 1
  fi
  printf '%s\n' "$source_sha"
}

echo "==> Checking deploy source..."
# rsync distinguishes a directory from a symlink to a directory. The trailing-
# slash node_modules exclusion below therefore does not match the common
# worktree optimization where node_modules links to another checkout. Reject
# that source shape before any build, sync, or remote mutation can happen.
if [ -L node_modules ]; then
  echo "ERROR: local node_modules is a symlink; refusing to deploy." >&2
  echo "Replace it with worktree-local dependencies, for example:" >&2
  echo "  unlink node_modules && npm ci" >&2
  exit 1
fi
DEPLOY_SHA="$(read_clean_deploy_sha)" || exit 1

echo "==> Building locally..."
npm run build

# Re-read both HEAD and cleanliness after the build. Build output is ignored;
# any tracked/untracked source drift means the payload no longer represents the
# single commit whose SHA would be stamped.
if ! POST_BUILD_SHA="$(read_clean_deploy_sha)"; then
  echo "ERROR: deploy source changed during build; refusing remote mutation." >&2
  exit 1
fi
if [ "$POST_BUILD_SHA" != "$DEPLOY_SHA" ]; then
  echo "ERROR: deploy source HEAD changed during build; refusing remote mutation." >&2
  exit 1
fi

if [ "$DEPLOY_DRAIN" = 1 ]; then
  echo "==> Draining Hugin task admission (wait up to ${DRAIN_TIMEOUT_MS} ms)..."
  # A failed drain may still have closed admission (409 busy), so mark it
  # active before the call and let the EXIT trap resume on any failure.
  DRAIN_ACTIVE=1
  drain_rc=0
  DRAIN_JSON="$(ssh "$REMOTE" "$(maintenance_remote_block drain "$REMOTE_DIR" "$DRAIN_TIMEOUT_MS" "$DRAIN_HOLD_MS")")" || drain_rc=$?
  if [ "$drain_rc" -ne 0 ]; then
    case "$drain_rc" in
      11) echo "ERROR: Hugin busy: admitted work did not finish within ${DRAIN_TIMEOUT_MS} ms; deploy aborted, nothing restarted." >&2 ;;
      12) echo "ERROR: maintenance drain unavailable (HUGIN_MAINTENANCE_TOKEN not provisioned?); unset HUGIN_DEPLOY_DRAIN to deploy without it." >&2 ;;
      *) echo "ERROR: maintenance drain failed (exit $drain_rc); deploy aborted." >&2 ;;
    esac
    exit 1
  fi
  if ! DRAIN_INSTANCE="$(printf '%s' "$DRAIN_JSON" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const s=JSON.parse(r);if(s.ready!==true||!s.process_instance_id)process.exit(1);process.stdout.write(String(s.process_instance_id))})')"; then
    echo "ERROR: drain response was not a ready snapshot; deploy aborted." >&2
    exit 1
  fi
  echo "  Drained; instance $DRAIN_INSTANCE"
fi

echo "==> Invalidating prior deployment marker..."
# This is deliberately the first remote mutation. Every later failure leaves
# the service markerless; only the final accepted health gate may stamp it.
ssh "$REMOTE" "rm -f '$REMOTE_DIR/.deployed-commit' '$REMOTE_DIR/.deployed-commit.tmp'"

echo "==> Syncing to $REMOTE:$REMOTE_DIR..."
rsync -av --delete \
  --exclude='node_modules' \
  --exclude='node_modules/' \
  --exclude='.git' \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='.deployed-commit' \
  --exclude='tests/' \
  --exclude='.DS_Store' \
  ./ "$REMOTE:$REMOTE_DIR/"

# Close the small race between the post-build check and rsync reading the
# source. If anything changed while the payload was transferred, stop before
# install/restart and leave the already-invalidated deployment marker absent.
if ! POST_SYNC_SHA="$(read_clean_deploy_sha)"; then
  echo "ERROR: deploy source changed during sync; refusing acceptance." >&2
  exit 1
fi
if [ "$POST_SYNC_SHA" != "$DEPLOY_SHA" ]; then
  echo "ERROR: deploy source HEAD changed during sync; refusing acceptance." >&2
  exit 1
fi

echo "==> Installing dependencies on Pi..."
ssh "$REMOTE" "cd $REMOTE_DIR && npm ci --omit=dev"

echo "==> Installing pinned research Pi harness ($RESEARCH_PI_PACKAGE@$RESEARCH_PI_VERSION)..."
# npm's default global prefix (npm prefix --global) is not user-writable on a
# fresh host (it resolves under /usr), so install into an explicit
# user-owned prefix instead. hugin.service's PATH points at this same
# ~/.npm-global/bin (issue #390).
ssh "$REMOTE" "$(research_pi_install_block "$RESEARCH_PI_PACKAGE" "$RESEARCH_PI_VERSION" "$REMOTE_DIR")"

echo "==> Removing legacy system-level service (one-time migration, idempotent)..."
ssh "$REMOTE" "
  if systemctl is-enabled hugin.service --quiet 2>/dev/null; then
    sudo systemctl stop hugin.service 2>/dev/null || true
    sudo systemctl disable hugin.service 2>/dev/null || true
    sudo rm -f /etc/systemd/system/hugin.service
    sudo systemctl daemon-reload
    echo '  Legacy system-level hugin.service removed'
  else
    echo '  No legacy system-level service found, skipping'
  fi
"

echo "==> Installing user-level systemd services..."
ssh "$REMOTE" "
  mkdir -p ~/.config/systemd/user ~/.hugin/daily-exam-candidates ~/.hugin/experiment-cadence \
    /home/magnus/hugin-workspace/_default \
    /home/magnus/hugin-workspace/_scratch \
    /home/magnus/hugin-workspace/_files
  # hugin#272: no candidates.json seed needed -- the cadence CLI's default
  # production candidate-pool assembler scans the #232 registry itself.
  # A leftover file from an older deploy is simply never read.
  cp $REMOTE_DIR/hugin.service ~/.config/systemd/user/hugin.service
  cp $REMOTE_DIR/systemd/hugin-daily-exam-factory.service ~/.config/systemd/user/hugin-daily-exam-factory.service
  cp $REMOTE_DIR/systemd/hugin-daily-exam-factory.timer ~/.config/systemd/user/hugin-daily-exam-factory.timer
  cp $REMOTE_DIR/systemd/hugin-experiment-cadence.service ~/.config/systemd/user/hugin-experiment-cadence.service
  cp $REMOTE_DIR/systemd/hugin-experiment-cadence.timer ~/.config/systemd/user/hugin-experiment-cadence.timer
  XDG_RUNTIME_DIR=/run/user/1000 systemctl --user daemon-reload
  XDG_RUNTIME_DIR=/run/user/1000 systemctl --user enable hugin.service
  XDG_RUNTIME_DIR=/run/user/1000 systemctl --user enable --now hugin-daily-exam-factory.timer
  XDG_RUNTIME_DIR=/run/user/1000 systemctl --user enable --now hugin-experiment-cadence.timer
  loginctl enable-linger magnus 2>/dev/null || true
"

echo "==> Checking for .env file..."
if ssh "$REMOTE" "test -f $REMOTE_DIR/.env"; then
  echo "  .env exists"
else
  echo "  WARNING: No .env file found at $REMOTE_DIR/.env"
  echo "  Create one with: MUNIN_API_KEY=<key>"
  echo "  Generate a key or reuse the existing Munin API key"
fi

echo "==> Artefact-delivery preflight (issue #68)..."
# The deliverer runs ON the Pi and ships to the NAS over SSH+rsync from the
# systemd-user environment. Probe SSH (BatchMode, no prompts), rsync, and a
# write/read/delete round-trip BEFORE enabling HUGIN_DELIVERY_POLICY=require.
# Non-fatal: the runtime checkpoint + failure handling are the real safety net
# (a probe can pass while the long-running unit later loses env/keys/NAS), so a
# probe failure is a loud WARNING, not a hard deploy stop.
# Single source of truth: derive the probe target from the first
# HUGIN_DELIVERY_TARGETS tuple (same allowlist the runtime enforces), so the
# preflight cannot drift from the actual delivery target (Codex review #6).
# Falls back to the built-in default NAS when the env var is unset.
read -r DELIVERY_NAS_USER DELIVERY_NAS_HOST DELIVERY_NAS_DIR <<EOF
$(HUGIN_DELIVERY_TARGETS="${HUGIN_DELIVERY_TARGETS:-}" node -e '
  const raw = process.env.HUGIN_DELIVERY_TARGETS;
  let t = { user: "magnus", host: "100.99.119.52", remotePathPrefix: "/home/magnus/mimir-inbox/" };
  if (raw && raw.trim()) {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr[0]) t = arr[0];
  }
  const dir = String(t.remotePathPrefix).replace(/\/$/, "");
  process.stdout.write(`${t.user} ${t.host} ${dir}`);
' 2>/dev/null || echo "magnus 100.99.119.52 /home/magnus/mimir-inbox")
EOF
if ssh "$REMOTE" "
  set -e
  export HOME=/home/$DEPLOY_USER
  command -v rsync >/dev/null || { echo 'rsync missing on Pi'; exit 1; }
  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 \
    $DELIVERY_NAS_USER@$DELIVERY_NAS_HOST -- \
    \"mkdir -p $DELIVERY_NAS_DIR && touch $DELIVERY_NAS_DIR/.hugin-preflight && rm -f $DELIVERY_NAS_DIR/.hugin-preflight\"
"; then
  echo "  OK: Pi → NAS SSH/rsync write/read/delete probe passed"
else
  echo "  WARNING: artefact-delivery preflight FAILED."
  echo "  Do NOT set HUGIN_DELIVERY_POLICY=require until SSH keys / BatchMode /"
  echo "  NAS reachability are fixed (else delivery-capable tasks will fail)."
fi

echo "==> Host-side Codex sandbox preflight (issues #59/#218/#390)..."
# Exercise Codex's own zero-token sandbox entry point, not merely whichever
# bwrap happens to be first on PATH. This catches a missing/incompatible system
# bwrap before restart. It is still outside hugin.service confinement; the
# post-restart /health gate below is authoritative because Hugin repeats this
# exact command from inside the live unit before polling or any Codex task.
# Resolve codex using the exact PATH hugin.service grants at runtime, not the
# non-interactive SSH shell's PATH: a fresh host installs standalone Codex
# under ~/.local/bin, which a plain `ssh host cmd` shell does not put on PATH,
# so this preflight would otherwise report NO_CODEX despite the unit being
# able to find it. hugin.service's Environment=PATH= line is the single
# source of truth for that PATH (issue #390).
UNIT_SERVICE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/hugin.service"
UNIT_PATH="$(sed -n 's/^Environment=PATH=//p' "$UNIT_SERVICE_FILE" | head -n1)"
if [ -z "$UNIT_PATH" ]; then
  echo "ERROR: could not parse Environment=PATH= from $UNIT_SERVICE_FILE; refusing Codex preflight." >&2
  exit 1
fi
if ssh "$REMOTE" "$(codex_sandbox_preflight_block "$UNIT_PATH")"; then
  echo "  OK: Codex zero-token sandbox command passed on the host"
else
  echo "  WARNING: host-side Codex sandbox preflight FAILED."
  echo "  The post-restart in-service health acceptance will remain authoritative."
fi

echo "==> Installing CLI observation cron job..."
CRON_CMD="0 4 * * * $REMOTE_DIR/scripts/update-cli.sh 2>&1 | logger -t hugin-update"
ssh "$REMOTE" "crontab -l 2>/dev/null | grep -v 'update-cli.sh' | { cat; echo '$CRON_CMD'; } | crontab -"
echo "  Cron installed: daily at 04:00"

echo "==> Ensuring workspace directory exists..."
ssh "$REMOTE" "mkdir -p /home/$DEPLOY_USER/workspace"

echo "==> Killing orphan Hugin processes..."
ssh "$REMOTE" "SYSPID=\$(XDG_RUNTIME_DIR=/run/user/1000 systemctl --user show hugin.service --property=MainPID --value 2>/dev/null || echo 0)
for pid in \$(pgrep -f 'node dist/main.js'); do
  if [ \"\$pid\" = \"\$SYSPID\" ]; then continue; fi
  CWD=\$(readlink /proc/\$pid/cwd 2>/dev/null || echo '')
  if [ \"\$CWD\" = '$REMOTE_DIR' ]; then
    echo \"  Killing orphan Hugin PID \$pid\"
    kill \"\$pid\" 2>/dev/null || true
  fi
done"

if [ "$DEPLOY_DRAIN" = 1 ]; then
  echo "==> Re-verifying drain immediately before restart..."
  if ! ssh "$REMOTE" "$(maintenance_remote_block check "$REMOTE_DIR" "$DRAIN_INSTANCE" "$DRAIN_MIN_REMAINING_MS")" >/dev/null; then
    echo "ERROR: drain no longer valid (instance changed, not ready, or hold nearly expired); refusing restart." >&2
    exit 1
  fi
fi

echo "==> Restarting service..."
ssh "$REMOTE" "XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart hugin.service && sleep 2 && XDG_RUNTIME_DIR=/run/user/1000 systemctl --user status hugin.service --no-pager"

echo "==> Health check..."
ssh "$REMOTE" "
  for attempt in \$(seq 1 15); do
    if curl -fsS http://127.0.0.1:3032/health | /usr/bin/node -e '
      let raw = \"\";
      process.stdin.on(\"data\", (chunk) => raw += chunk).on(\"end\", () => {
        const health = JSON.parse(raw);
        if (health.codex_sandbox?.available !== true) process.exit(1);
        process.stdout.write(raw);
      });
    '; then
      exit 0
    fi
    sleep 1
  done
  echo 'in-service Codex sandbox self-test unavailable after 15 attempts' >&2
  exit 1
"

if [ "$DEPLOY_DRAIN" = 1 ]; then
  # A restart reopens admission (in-memory state). Confirm it did; if the same
  # instance is somehow still draining, resume explicitly.
  echo "==> Verifying task admission reopened..."
  if ssh "$REMOTE" "$(maintenance_remote_block status "$REMOTE_DIR")" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>process.exit(JSON.parse(r).state==="open"?0:1))'; then
    DRAIN_ACTIVE=0
  else
    drain_resume
    echo "  Admission was not confirmed open after restart; resume attempted."
  fi
fi

echo "==> Daily exam factory acceptance..."
ssh "$REMOTE" "
  XDG_RUNTIME_DIR=/run/user/1000 systemctl --user start hugin-daily-exam-factory.service
  test -s /home/$DEPLOY_USER/.hugin/daily-exam-candidates/latest.json
  /usr/bin/node -e 'const m=JSON.parse(require(\"node:fs\").readFileSync(process.argv[1],\"utf8\")); if(m.schemaVersion!==2) throw new Error(\"daily exam manifest must be schema v2\"); if(m.candidates.some((c)=>c.lane===\"provisional-holdout\"&&c.crossClientExposure?.state!==\"unseen-covered\")) throw new Error(\"provisional candidate lacks complete cross-client exposure coverage\"); const states=Object.fromEntries([\"not-checked\",\"seen\",\"unseen-covered\",\"incomplete\",\"error\"].map((s)=>[s,m.candidates.filter((c)=>c.crossClientExposure?.state===s).length])); process.stdout.write(JSON.stringify({schemaVersion:m.schemaVersion,generatedAt:m.generatedAt,inspectedTasks:m.inspectedTasks,historyComplete:m.historyComplete,counts:m.counts,crossClientExposureStates:states})+\"\\n\")' /home/$DEPLOY_USER/.hugin/daily-exam-candidates/latest.json
"

echo "==> Experiment cadence acceptance..."
# A successful tick durably logs even when the candidate pool is empty. This
# catches user-unit credential/sandbox failures before an accepted deployment
# can wait until the next morning to reveal them.
ssh "$REMOTE" "XDG_RUNTIME_DIR=/run/user/1000 systemctl --user start hugin-experiment-cadence.service"

echo ""
echo "Acceptance gates passed; finalizing deployment."
echo "Health check: curl http://$PI_HOST:3032/health"
echo "Logs: ssh $PI_HOST journalctl --user -u hugin.service -f"
echo "==> Recording accepted deployment $DEPLOY_SHA..."
# The remote tree is intentionally markerless and has no .git checkout. Stamp
# the exact local commit atomically only after restart/status and health both
# succeeded. No fallible deployment steps follow this boundary.
ssh "$REMOTE" "printf '%s\n' '$DEPLOY_SHA' > '$REMOTE_DIR/.deployed-commit.tmp' && mv '$REMOTE_DIR/.deployed-commit.tmp' '$REMOTE_DIR/.deployed-commit'"
