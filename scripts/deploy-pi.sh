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
  mkdir -p ~/.config/systemd/user ~/.hugin/daily-exam-candidates ~/.hugin/experiment-cadence
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

echo "==> Host-side Codex sandbox preflight (issues #59/#218)..."
# Exercise Codex's own zero-token sandbox entry point, not merely whichever
# bwrap happens to be first on PATH. This catches a missing/incompatible system
# bwrap before restart. It is still outside hugin.service confinement; the
# post-restart /health gate below is authoritative because Hugin repeats this
# exact command from inside the live unit before polling or any Codex task.
if ssh "$REMOTE" "
  command -v codex >/dev/null 2>&1 || { echo 'NO_CODEX'; exit 1; }
  codex sandbox -- /bin/true >/dev/null 2>&1 || { echo 'CODEX_SANDBOX_FAIL'; exit 1; }
"; then
  echo "  OK: Codex zero-token sandbox command passed on the host"
else
  echo "  WARNING: host-side Codex sandbox preflight FAILED."
  echo "  The post-restart in-service health acceptance will remain authoritative."
fi

echo "==> Refreshing Claude config on the Pi (claude-config bootstrap)..."
# Config now lives in the versioned Magnus-Gille/claude-config repo (+ claude-skills,
# skills-private), consumed via symlinks. Pull latest + re-run bootstrap instead of the
# old rsync (which would clobber the symlinks with real dirs). See claude-config/README.md.
# See scripts/lib/claude-config-bootstrap.sh (issue #153): missing checkout is optional
# infra and informational, a broken existing checkout stays a real WARNING.
# shellcheck source=lib/claude-config-bootstrap.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/claude-config-bootstrap.sh"
claude_config_bootstrap "$REMOTE"

echo "==> Installing CLI update cron job..."
CRON_CMD="0 4 * * * $REMOTE_DIR/scripts/update-cli.sh 2>&1 | logger -t hugin-update"
ssh "$REMOTE" "crontab -l 2>/dev/null | grep -v 'update-cli.sh' | { cat; echo '$CRON_CMD'; } | crontab -"
echo "  Cron installed: daily at 04:00"

echo "==> Ensuring workspace directory exists..."
ssh "$REMOTE" "mkdir -p /home/$DEPLOY_USER/workspace"

echo "==> Killing orphan Hugin processes..."
ssh "$REMOTE" "SYSPID=\$(XDG_RUNTIME_DIR=/run/user/1000 systemctl --user show hugin.service --property=MainPID --value 2>/dev/null || echo 0)
for pid in \$(pgrep -f 'node dist/index.js'); do
  if [ \"\$pid\" = \"\$SYSPID\" ]; then continue; fi
  CWD=\$(readlink /proc/\$pid/cwd 2>/dev/null || echo '')
  if [ \"\$CWD\" = '$REMOTE_DIR' ]; then
    echo \"  Killing orphan Hugin PID \$pid\"
    kill \"\$pid\" 2>/dev/null || true
  fi
done"

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
