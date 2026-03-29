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

# Do not use exec ssh — the EXIT trap must run when the session ends (sudo -k).
ssh "${DROPLET_SSH_OPTS[@]}" "$TARGET"
