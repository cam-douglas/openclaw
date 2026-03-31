#!/usr/bin/env bash
# Prepare source-droplet migration metadata before moving to a new droplet.
# Creates a local artifact bundle under .droplet/migration/<timestamp>.
#
# Usage:
#   ./scripts/droplet-migration-pre-sync.sh
#   ./scripts/droplet-migration-pre-sync.sh --source-host 170.64.155.16
#   ./scripts/droplet-migration-pre-sync.sh --out-dir .droplet/migration/my-run
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${OPENCLAW_ENV_FILE:-$ROOT/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: missing $ENV_FILE" >&2
  exit 1
fi

# shellcheck source=/dev/null
set -a
source "$ENV_FILE"
set +a

SOURCE_HOST=""
OUT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-host)
      SOURCE_HOST="${2:-}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    *)
      echo "error: unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$SOURCE_HOST" ]]; then
  SOURCE_HOST="${DROPLET_SSH_HOST:-${DROPLET_IP:-}}"
fi
if [[ -z "$SOURCE_HOST" ]]; then
  echo "error: set DROPLET_SSH_HOST or DROPLET_IP in $ENV_FILE (or pass --source-host)." >&2
  exit 1
fi

if [[ -z "$OUT_DIR" ]]; then
  stamp="$(date -u +"%Y%m%dT%H%M%SZ")"
  OUT_DIR="$ROOT/.droplet/migration/$stamp"
fi
mkdir -p "$OUT_DIR"

TARGET="${SSH_USER:-root}@${SOURCE_HOST}"

# shellcheck source=scripts/droplet-ssh-common.sh
source "$ROOT/scripts/droplet-ssh-common.sh"
droplet_ssh_build_opts || exit 1

echo "[pre-sync] collecting source metadata from ${TARGET}"

ssh "${DROPLET_SSH_OPTS[@]}" "$TARGET" 'bash -s' <<'REMOTE' >"$OUT_DIR/source-metadata.txt"
set -euo pipefail
echo "# Source droplet metadata"
echo "captured_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "host=$(hostname -f 2>/dev/null || hostname)"
echo "kernel=$(uname -a)"
echo
echo "# Repo"
if [[ -d /root/openclaw/.git ]]; then
  cd /root/openclaw
  echo "repo_head=$(git rev-parse HEAD)"
  echo "repo_head_short=$(git rev-parse --short HEAD)"
  echo "repo_status=$(git status -sb | tr '\n' ';')"
  echo "repo_remote=$(git config --get remote.origin.url || true)"
else
  echo "repo_missing=1"
fi
echo
echo "# OpenClaw state"
if [[ -d /root/.openclaw ]]; then
  echo "state_dir_exists=1"
  echo "state_bytes=$(du -sb /root/.openclaw | awk "{print \$1}")"
else
  echo "state_dir_exists=0"
fi
if [[ -f /root/.openclaw/openclaw.json ]]; then
  echo "state_config_sha256=$(sha256sum /root/.openclaw/openclaw.json | awk "{print \$1}")"
fi
if [[ -f /root/.config/openclaw/gateway-secrets.env ]]; then
  echo "gateway_secrets_sha256=$(sha256sum /root/.config/openclaw/gateway-secrets.env | awk "{print \$1}")"
else
  echo "gateway_secrets_missing=1"
fi
echo
echo "# Gateway + watchdog"
echo "gateway_user_active=$(systemctl --user is-active openclaw-gateway.service 2>/dev/null || true)"
echo "watchdog_timer_active=$(systemctl is-active openclaw-gateway-watchdog.timer 2>/dev/null || true)"
echo "watchdog_timer_enabled=$(systemctl is-enabled openclaw-gateway-watchdog.timer 2>/dev/null || true)"
echo "root_linger=$(loginctl show-user root -p Linger --value 2>/dev/null || true)"
echo "listener_18789=$(ss -ltnp 2>/dev/null | grep -E ":18789\\s" | tr '\n' ';' || true)"
echo
echo "# Tailscale"
if command -v tailscale >/dev/null 2>&1; then
  echo "tailscale_ipv4=$(tailscale ip -4 2>/dev/null | tr '\n' ',' || true)"
  echo "tailscale_ipv6=$(tailscale ip -6 2>/dev/null | tr '\n' ',' || true)"
else
  echo "tailscale_missing=1"
fi
REMOTE

ssh "${DROPLET_SSH_OPTS[@]}" "$TARGET" 'systemctl cat openclaw-gateway-watchdog.service 2>/dev/null || true' \
  >"$OUT_DIR/watchdog.service.txt"
ssh "${DROPLET_SSH_OPTS[@]}" "$TARGET" 'systemctl cat openclaw-gateway-watchdog.timer 2>/dev/null || true' \
  >"$OUT_DIR/watchdog.timer.txt"
ssh "${DROPLET_SSH_OPTS[@]}" "$TARGET" 'systemctl --user cat openclaw-gateway.service 2>/dev/null || true' \
  >"$OUT_DIR/gateway.user.service.txt"
ssh "${DROPLET_SSH_OPTS[@]}" "$TARGET" 'journalctl -u openclaw-gateway-watchdog.service -n 120 --no-pager 2>/dev/null || true' \
  >"$OUT_DIR/watchdog.journal.tail.txt"

cat >"$OUT_DIR/NEXT_STEPS.txt" <<EOF
Source host: ${SOURCE_HOST}
Artifacts dir: ${OUT_DIR}

Next:
1) Provision target droplet.
2) Run sync:
   scripts/droplet-migration-sync.sh --target-host <new-droplet-ip-or-host>
3) Validate:
   scripts/droplet-migration-post-sync.sh --target-host <new-droplet-ip-or-host>
EOF

echo "[pre-sync] done -> $OUT_DIR"
