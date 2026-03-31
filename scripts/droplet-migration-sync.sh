#!/usr/bin/env bash
# Sync OpenClaw from current source droplet to a new target droplet.
# Includes: repo checkout alignment, full /root/.openclaw transfer, secrets, gateway service install,
# watchdog install, and gateway restart on target.
#
# Usage:
#   ./scripts/droplet-migration-sync.sh --target-host <new-ip-or-host>
# Optional env:
#   MIGRATION_SOURCE_HOST=<old-ip-or-host>
#   KEEP_SOURCE_GATEWAY_RUNNING=1   # default: stop source gateway during final delta sync
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

TARGET_HOST=""
SOURCE_HOST="${MIGRATION_SOURCE_HOST:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-host)
      TARGET_HOST="${2:-}"
      shift 2
      ;;
    --source-host)
      SOURCE_HOST="${2:-}"
      shift 2
      ;;
    *)
      echo "error: unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$TARGET_HOST" ]]; then
  echo "error: --target-host is required." >&2
  exit 1
fi
if [[ -z "$SOURCE_HOST" ]]; then
  SOURCE_HOST="${DROPLET_SSH_HOST:-${DROPLET_IP:-}}"
fi
if [[ -z "$SOURCE_HOST" ]]; then
  echo "error: set DROPLET_SSH_HOST or DROPLET_IP in $ENV_FILE (or pass --source-host)." >&2
  exit 1
fi

SOURCE_TARGET="${SSH_USER:-root}@${SOURCE_HOST}"
DEST_TARGET="${SSH_USER:-root}@${TARGET_HOST}"
KEEP_SOURCE_GATEWAY_RUNNING="${KEEP_SOURCE_GATEWAY_RUNNING:-0}"

# shellcheck source=scripts/droplet-ssh-common.sh
source "$ROOT/scripts/droplet-ssh-common.sh"
droplet_ssh_build_opts || exit 1
SSH_OPTS=("${DROPLET_SSH_OPTS[@]}")

echo "[sync] source: ${SOURCE_TARGET}"
echo "[sync] target: ${DEST_TARGET}"

ssh "${SSH_OPTS[@]}" "$SOURCE_TARGET" 'echo "[sync] source ssh ok: $(hostname)"'
ssh "${SSH_OPTS[@]}" "$DEST_TARGET" 'echo "[sync] target ssh ok: $(hostname)"'

SRC_HEAD="$(ssh "${SSH_OPTS[@]}" "$SOURCE_TARGET" 'cd /root/openclaw && git rev-parse HEAD')"
echo "[sync] source repo head: $SRC_HEAD"

echo "[sync] prepare target checkout"
ssh "${SSH_OPTS[@]}" "$DEST_TARGET" "bash -s" <<'REMOTE'
set -euo pipefail
if [[ ! -d /root/openclaw/.git ]]; then
  rm -rf /root/openclaw
  git clone https://github.com/openclaw/openclaw /root/openclaw
fi
cd /root/openclaw
git fetch origin
git checkout main
git pull --rebase origin main
REMOTE

echo "[sync] pass 1 copy (live): state + secrets + service env"
ssh "${SSH_OPTS[@]}" "$SOURCE_TARGET" \
  'tar -C / -cpf - root/.openclaw root/.config/openclaw root/.config/systemd/user/openclaw-gateway.service.d root/.config/systemd/user/openclaw-gateway.service.bak 2>/dev/null || tar -C / -cpf - root/.openclaw root/.config/openclaw root/.config/systemd/user/openclaw-gateway.service.d' \
  | ssh "${SSH_OPTS[@]}" "$DEST_TARGET" 'tar -C / -xpf -'

if [[ "$KEEP_SOURCE_GATEWAY_RUNNING" != "1" ]]; then
  echo "[sync] stopping source gateway for final delta sync"
  ssh "${SSH_OPTS[@]}" "$SOURCE_TARGET" 'systemctl --user stop openclaw-gateway.service || true'
fi

echo "[sync] pass 2 copy (final delta)"
ssh "${SSH_OPTS[@]}" "$SOURCE_TARGET" \
  'tar -C / -cpf - root/.openclaw root/.config/openclaw root/.config/systemd/user/openclaw-gateway.service.d root/.config/systemd/user/openclaw-gateway.service.bak 2>/dev/null || tar -C / -cpf - root/.openclaw root/.config/openclaw root/.config/systemd/user/openclaw-gateway.service.d' \
  | ssh "${SSH_OPTS[@]}" "$DEST_TARGET" 'tar -C / -xpf -'

echo "[sync] target checkout + install + gateway + watchdog"
ssh "${SSH_OPTS[@]}" "$DEST_TARGET" "bash -s" <<REMOTE
set -euo pipefail
cd /root/openclaw
git fetch origin
git checkout main
git pull --rebase origin main
if [[ "\$(git rev-parse HEAD)" != "${SRC_HEAD}" ]]; then
  echo "[sync] warning: target main differs from source head; proceeding with target main." >&2
fi
pnpm install
pnpm build
npm install -g .
openclaw gateway install --force
systemctl --user restart openclaw-gateway.service
sudo bash scripts/install-droplet-watchdog.sh
REMOTE

if [[ "$KEEP_SOURCE_GATEWAY_RUNNING" != "1" ]]; then
  echo "[sync] source gateway remains stopped (cutover mode)."
else
  echo "[sync] source gateway left running (KEEP_SOURCE_GATEWAY_RUNNING=1)."
fi

echo "[sync] complete. run post-check:"
echo "  scripts/droplet-migration-post-sync.sh --target-host ${TARGET_HOST} --source-host ${SOURCE_HOST}"
