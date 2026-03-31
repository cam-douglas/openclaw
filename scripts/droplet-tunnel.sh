#!/usr/bin/env bash
# Open an SSH local port forward to the gateway Control UI on the droplet (default 127.0.0.1:18789).
# When gateway.bind is tailnet, set OPENCLAW_DROPLET_SSH_FORWARD_HOST to the droplet Tailscale IPv4.
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

if [[ -z "${DROPLET_SSH_HOST:-}" && -z "${DROPLET_IP:-}" ]]; then
  echo "error: set DROPLET_SSH_HOST or DROPLET_IP in $ENV_FILE" >&2
  exit 1
fi
SSH_HOST="${DROPLET_SSH_HOST:-$DROPLET_IP}"
TARGET="${SSH_USER:-root}@${SSH_HOST}"
FORWARD_HOST="${OPENCLAW_DROPLET_SSH_FORWARD_HOST:-127.0.0.1}"

# shellcheck source=scripts/droplet-ssh-common.sh
source "$ROOT/scripts/droplet-ssh-common.sh"
droplet_ssh_build_opts || exit 1

# shellcheck source=scripts/droplet-sudo-gate.sh
source "$ROOT/scripts/droplet-sudo-gate.sh"
droplet_sudo_gate_refresh
droplet_sudo_revoke_on_exit

# Do not use exec ssh — the EXIT trap must run when the tunnel ends (sudo -k).
ssh "${DROPLET_SSH_OPTS[@]}" -o ExitOnForwardFailure=yes -L "18789:${FORWARD_HOST}:18789" -N "$TARGET"
