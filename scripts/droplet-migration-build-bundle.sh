#!/usr/bin/env bash
# Build a full OpenClaw migration bundle from the source droplet.
#
# Output (local):
# - transfer/openclaw-gpu-migration-<timestamp>.tar.gz
# - transfer/openclaw-gpu-migration-<timestamp>/ (exploded manifest dir)
#
# The bundle includes:
# - openclaw-source.bundle (git history bundle)
# - openclaw-state.tar (.openclaw full snapshot)
# - openclaw-config.tar (gateway/systemd config snapshot)
# - service/watchdog metadata + checksums + TRANSFER_README.md
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
OUT_DIR="${ROOT}/transfer"
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

mkdir -p "$OUT_DIR"
stamp="$(date -u +"%Y%m%d-%H%M%S")"
bundle_name="openclaw-gpu-migration-${stamp}"
local_tar="${OUT_DIR}/${bundle_name}.tar.gz"
local_dir="${OUT_DIR}/${bundle_name}"

TARGET="${SSH_USER:-root}@${SOURCE_HOST}"

# shellcheck source=scripts/droplet-ssh-common.sh
source "$ROOT/scripts/droplet-ssh-common.sh"
droplet_ssh_build_opts || exit 1

remote_dir="/tmp/${bundle_name}"
remote_tar="/tmp/${bundle_name}.tar.gz"

echo "[bundle] source: ${TARGET}"
echo "[bundle] building on source host..."
ssh "${DROPLET_SSH_OPTS[@]}" "$TARGET" "bash -s" <<REMOTE
set -euo pipefail
rm -rf "${remote_dir}" "${remote_tar}"
mkdir -p "${remote_dir}"

if [[ -d /root/openclaw/.git ]]; then
  cd /root/openclaw
  git bundle create "${remote_dir}/openclaw-source.bundle" --all
  git rev-parse HEAD > "${remote_dir}/repo-head.txt"
  git status -sb > "${remote_dir}/repo-status.txt" || true
fi

tar -C / -cpf "${remote_dir}/openclaw-state.tar" root/.openclaw
tar -C / -cpf "${remote_dir}/openclaw-config.tar" \
  root/.config/openclaw \
  root/.config/systemd/user/openclaw-gateway.service.d \
  root/.config/systemd/user/openclaw-gateway.service.bak 2>/dev/null || \
tar -C / -cpf "${remote_dir}/openclaw-config.tar" \
  root/.config/openclaw \
  root/.config/systemd/user/openclaw-gateway.service.d

systemctl cat openclaw-gateway-watchdog.service > "${remote_dir}/watchdog.service.txt" 2>/dev/null || true
systemctl cat openclaw-gateway-watchdog.timer > "${remote_dir}/watchdog.timer.txt" 2>/dev/null || true
systemctl --user cat openclaw-gateway.service > "${remote_dir}/gateway.user.service.txt" 2>/dev/null || true
journalctl -u openclaw-gateway-watchdog.service -n 120 --no-pager > "${remote_dir}/watchdog.journal.tail.txt" 2>/dev/null || true
if [[ -f /etc/cron.d/openclaw-gateway-watchdog ]]; then
  cp -a /etc/cron.d/openclaw-gateway-watchdog "${remote_dir}/watchdog.cron.txt"
fi

{
  echo "captured_at_utc=\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host=\$(hostname -f 2>/dev/null || hostname)"
  echo "gateway_user_active=\$(systemctl --user is-active openclaw-gateway.service 2>/dev/null || true)"
  echo "watchdog_timer_active=\$(systemctl is-active openclaw-gateway-watchdog.timer 2>/dev/null || true)"
  echo "watchdog_timer_enabled=\$(systemctl is-enabled openclaw-gateway-watchdog.timer 2>/dev/null || true)"
  echo "root_linger=\$(loginctl show-user root -p Linger --value 2>/dev/null || true)"
  echo "listener_18789=\$(ss -ltnp 2>/dev/null | awk '/:18789\\s/{print}' | tr '\\n' ';')"
  if command -v tailscale >/dev/null 2>&1; then
    echo "tailscale_ipv4=\$(tailscale ip -4 2>/dev/null | tr '\\n' ',')"
    echo "tailscale_ipv6=\$(tailscale ip -6 2>/dev/null | tr '\\n' ',')"
  fi
} > "${remote_dir}/source-metadata.txt"

cat > "${remote_dir}/TRANSFER_README.md" <<'README'
# OpenClaw GPU migration bundle

Contains:
- openclaw-source.bundle
- openclaw-state.tar
- openclaw-config.tar
- service/watchdog metadata and checksums

Recommended restore:
1) Copy this bundle to target host.
2) Extract.
3) Use local script:
   scripts/droplet-migration-sync.sh --target-host <new-host> --bundle <path-to-tar.gz>
4) Validate:
   scripts/droplet-migration-post-sync.sh --target-host <new-host>
README

(cd "${remote_dir}" && sha256sum * > CHECKSUMS.txt)
tar -C /tmp -czf "${remote_tar}" "${bundle_name}"
REMOTE

echo "[bundle] downloading tarball..."
scp "${DROPLET_SSH_OPTS[@]}" "$TARGET:${remote_tar}" "$local_tar"
mkdir -p "$local_dir"
tar -xzf "$local_tar" -C "$OUT_DIR"

ssh "${DROPLET_SSH_OPTS[@]}" "$TARGET" "rm -rf '${remote_dir}' '${remote_tar}'"

echo "[bundle] ready:"
echo " - ${local_tar}"
echo " - ${local_dir}"
