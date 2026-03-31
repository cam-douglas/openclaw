#!/usr/bin/env bash
# Sync OpenClaw to a new target droplet.
# Supports two modes:
# 1) source-sync mode (default): copy from source droplet live
# 2) bundle mode: restore from a prebuilt migration bundle tar.gz
#
# Includes: full /root/.openclaw, secrets/config, gateway service install,
# watchdog install, and gateway restart on target.
#
# Usage:
#   ./scripts/droplet-migration-sync.sh --target-host <new-ip-or-host>
#   ./scripts/droplet-migration-sync.sh --target-host <new-ip-or-host> --bundle transfer/openclaw-gpu-migration-*.tar.gz
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
BUNDLE_PATH=""
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
    --bundle)
      BUNDLE_PATH="${2:-}"
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
DEST_TARGET="${SSH_USER:-root}@${TARGET_HOST}"
KEEP_SOURCE_GATEWAY_RUNNING="${KEEP_SOURCE_GATEWAY_RUNNING:-0}"

if [[ -z "$BUNDLE_PATH" ]]; then
  if [[ -z "$SOURCE_HOST" ]]; then
    SOURCE_HOST="${DROPLET_SSH_HOST:-${DROPLET_IP:-}}"
  fi
  if [[ -z "$SOURCE_HOST" ]]; then
    echo "error: set DROPLET_SSH_HOST or DROPLET_IP in $ENV_FILE (or pass --source-host)." >&2
    exit 1
  fi
else
  if [[ ! -f "$BUNDLE_PATH" ]]; then
    echo "error: bundle file not found: $BUNDLE_PATH" >&2
    exit 1
  fi
fi

SOURCE_TARGET="${SSH_USER:-root}@${SOURCE_HOST}"

# shellcheck source=scripts/droplet-ssh-common.sh
source "$ROOT/scripts/droplet-ssh-common.sh"
droplet_ssh_build_opts || exit 1
SSH_OPTS=("${DROPLET_SSH_OPTS[@]}")

echo "[sync] target: ${DEST_TARGET}"

ssh "${SSH_OPTS[@]}" "$DEST_TARGET" 'echo "[sync] target ssh ok: $(hostname)"'

SRC_HEAD=""
if [[ -z "$BUNDLE_PATH" ]]; then
  echo "[sync] source: ${SOURCE_TARGET}"
  ssh "${SSH_OPTS[@]}" "$SOURCE_TARGET" 'echo "[sync] source ssh ok: $(hostname)"'
  SRC_HEAD="$(ssh "${SSH_OPTS[@]}" "$SOURCE_TARGET" 'cd /root/openclaw && git rev-parse HEAD')"
  echo "[sync] source repo head: $SRC_HEAD"
fi

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

if [[ -n "$BUNDLE_PATH" ]]; then
  echo "[sync] bundle mode: uploading $(basename "$BUNDLE_PATH")"
  ssh "${SSH_OPTS[@]}" "$DEST_TARGET" 'mkdir -p /root/transfer'
  scp "${SSH_OPTS[@]}" "$BUNDLE_PATH" "$DEST_TARGET:/root/transfer/"
  bundle_remote="/root/transfer/$(basename "$BUNDLE_PATH")"
  echo "[sync] bundle mode: extracting on target"
  ssh "${SSH_OPTS[@]}" "$DEST_TARGET" "bash -s" <<REMOTE
set -euo pipefail
bundle_file="${bundle_remote}"
top_dir=\$(tar -tzf "\$bundle_file" | awk -F/ 'NR==1{print \$1}')
if [[ -z "\$top_dir" ]]; then
  echo "error: unable to determine bundle top directory" >&2
  exit 1
fi
tar -xzf "\$bundle_file" -C /root/transfer
bundle_dir="/root/transfer/\$top_dir"
if [[ -f "\$bundle_dir/openclaw-state.tar" ]]; then
  tar -C / -xpf "\$bundle_dir/openclaw-state.tar"
fi
if [[ -f "\$bundle_dir/openclaw-config.tar" ]]; then
  tar -C / -xpf "\$bundle_dir/openclaw-config.tar"
fi
if [[ ! -d /root/openclaw/.git ]] && [[ -f "\$bundle_dir/openclaw-source.bundle" ]]; then
  rm -rf /root/openclaw
  mkdir -p /root/openclaw
  cd /root/openclaw
  git init
  git fetch "\$bundle_dir/openclaw-source.bundle" "refs/heads/*:refs/remotes/bundle/*"
  git checkout -B main bundle/main
  git remote add origin https://github.com/openclaw/openclaw || true
fi
REMOTE
else
  echo "[sync] source-sync mode: pass 1 copy (live): state + secrets + service env"
  ssh "${SSH_OPTS[@]}" "$SOURCE_TARGET" \
    'tar -C / -cpf - root/.openclaw root/.config/openclaw root/.config/systemd/user/openclaw-gateway.service.d root/.config/systemd/user/openclaw-gateway.service.bak 2>/dev/null || tar -C / -cpf - root/.openclaw root/.config/openclaw root/.config/systemd/user/openclaw-gateway.service.d' \
    | ssh "${SSH_OPTS[@]}" "$DEST_TARGET" 'tar -C / -xpf -'

  if [[ "$KEEP_SOURCE_GATEWAY_RUNNING" != "1" ]]; then
    echo "[sync] stopping source gateway for final delta sync"
    ssh "${SSH_OPTS[@]}" "$SOURCE_TARGET" 'systemctl --user stop openclaw-gateway.service || true'
  fi

  echo "[sync] source-sync mode: pass 2 copy (final delta)"
  ssh "${SSH_OPTS[@]}" "$SOURCE_TARGET" \
    'tar -C / -cpf - root/.openclaw root/.config/openclaw root/.config/systemd/user/openclaw-gateway.service.d root/.config/systemd/user/openclaw-gateway.service.bak 2>/dev/null || tar -C / -cpf - root/.openclaw root/.config/openclaw root/.config/systemd/user/openclaw-gateway.service.d' \
    | ssh "${SSH_OPTS[@]}" "$DEST_TARGET" 'tar -C / -xpf -'
fi

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

if [[ -z "$BUNDLE_PATH" && "$KEEP_SOURCE_GATEWAY_RUNNING" != "1" ]]; then
  echo "[sync] source gateway remains stopped (cutover mode)."
elif [[ -z "$BUNDLE_PATH" ]]; then
  echo "[sync] source gateway left running (KEEP_SOURCE_GATEWAY_RUNNING=1)."
fi

echo "[sync] complete. run post-check:"
echo "  scripts/droplet-migration-post-sync.sh --target-host ${TARGET_HOST} --source-host ${SOURCE_HOST}"
