#!/usr/bin/env bash
# Verify the OpenClaw CLI on the droplet is on PATH and reports a version.
# Uses the same .env, sudo gate, and SSH options as droplet-ssh.sh.
#
# Usage:
#   ./scripts/verify-droplet-openclaw.sh
#
# Optional: OPENCLAW_REMOTE_BIN (default: openclaw) — must match what you use with
#   `openclaw … droplet` locally (see src/cli/droplet-remote.ts).
#
# See docs/platforms/digitalocean.md → "Security model, limits, and mitigations".
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
REMOTE_BIN="${OPENCLAW_REMOTE_BIN:-openclaw}"

# shellcheck source=scripts/droplet-ssh-common.sh
source "$ROOT/scripts/droplet-ssh-common.sh"
droplet_ssh_build_opts || exit 1

# shellcheck source=scripts/droplet-sudo-gate.sh
source "$ROOT/scripts/droplet-sudo-gate.sh"
droplet_sudo_gate_refresh
droplet_sudo_revoke_on_exit

RB_Q="$(printf '%q' "$REMOTE_BIN")"
ssh "${DROPLET_SSH_OPTS[@]}" "$TARGET" \
  "REMOTE_BIN=${RB_Q} bash -lc 'set -euo pipefail; echo \"remote: \$(command -v \"\$REMOTE_BIN\" || true)\"; \"\$REMOTE_BIN\" --version'"
