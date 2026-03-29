#!/usr/bin/env bash
# Open an SSH local port forward to the gateway Control UI (127.0.0.1:18789 on the droplet).
# Same sudo gate as droplet-ssh.sh: sudo -v before ssh, sudo -k on exit.
# See docs/platforms/digitalocean.md → "Security model, limits, and mitigations".
#
# Usage:
#   ./scripts/droplet-tunnel.sh
# Then open http://localhost:18789
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

DROPLET_IP="${DROPLET_IP:?Set DROPLET_IP in $ENV_FILE}"
TARGET="${SSH_USER:-root}@${DROPLET_IP}"

# shellcheck source=scripts/droplet-ssh-common.sh
source "$ROOT/scripts/droplet-ssh-common.sh"
droplet_ssh_build_opts || exit 1

sudo -v
# shellcheck disable=SC2064
trap 'sudo -k' EXIT

# Do not use exec ssh — the EXIT trap must run when the tunnel ends (sudo -k).
ssh "${DROPLET_SSH_OPTS[@]}" -o ExitOnForwardFailure=yes -L 18789:localhost:18789 -N "$TARGET"
