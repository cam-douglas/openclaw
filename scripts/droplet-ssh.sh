#!/usr/bin/env bash
# SSH to the DigitalOcean / OpenClaw host using DROPLET_IP and SSH_USER from .env.
# Always requires local sudo (sudo -v) before connecting; clears sudo cache on exit (sudo -k).
# Canonical access pattern (why not raw ssh): docs/platforms/digitalocean.md → "Security model, limits, and mitigations".
#
# Usage:
#   ./scripts/droplet-ssh.sh
#
# Shell alias (zsh/bash), adjust path to your checkout:
#   alias oc-droplet='"/path/to/openclaw/scripts/droplet-ssh.sh"'
#
# Optional:
#   OPENCLAW_DROPLET_REMOTE_DIR=/root/openclaw ./scripts/droplet-ssh.sh
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

# DROPLET_SSH_HOST: Tailscale 100.x or MagicDNS (preferred over public DROPLET_IP once SSH is firewalled).
if [[ -z "${DROPLET_SSH_HOST:-}" && -z "${DROPLET_IP:-}" ]]; then
  echo "error: set DROPLET_SSH_HOST or DROPLET_IP in $ENV_FILE" >&2
  exit 1
fi
SSH_HOST="${DROPLET_SSH_HOST:-$DROPLET_IP}"
TARGET="${SSH_USER:-root}@${SSH_HOST}"
REMOTE_DIR="${OPENCLAW_DROPLET_REMOTE_DIR:-/root/openclaw}"

# shellcheck source=scripts/droplet-ssh-common.sh
source "$ROOT/scripts/droplet-ssh-common.sh"
droplet_ssh_build_opts || exit 1

# shellcheck source=scripts/droplet-sudo-gate.sh
source "$ROOT/scripts/droplet-sudo-gate.sh"
droplet_sudo_gate_refresh
droplet_sudo_revoke_on_exit

# Do not use exec ssh — the EXIT trap must run when the session ends (sudo -k).
# Start in the canonical droplet checkout unless overridden.
ssh -t "${DROPLET_SSH_OPTS[@]}" "$TARGET" "bash -lc 'if [ -d \"$REMOTE_DIR\" ]; then cd \"$REMOTE_DIR\"; fi; exec \${SHELL:-bash} -l'"
