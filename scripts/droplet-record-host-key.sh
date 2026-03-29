#!/usr/bin/env bash
# Record the droplet SSH host key into .droplet/known_hosts (gitignored) for pinned verification.
# Uses the same .env and sudo gate as droplet-ssh.sh. Safe to re-run after the droplet is rebuilt.
#
# After this, helper scripts auto-use "$ROOT/.droplet/known_hosts" when present, or set:
#   OPENCLAW_DROPLET_KNOWN_HOSTS=/absolute/path/to/.droplet/known_hosts
#
# See docs/platforms/digitalocean.md → "Further SSH hardening".
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
OUT_DIR="${ROOT}/.droplet"
OUT_FILE="${OUT_DIR}/known_hosts"

# shellcheck source=scripts/droplet-sudo-gate.sh
source "$ROOT/scripts/droplet-sudo-gate.sh"
droplet_sudo_gate_refresh
droplet_sudo_revoke_on_exit

mkdir -p "$OUT_DIR"
TMP="$(mktemp)"
if ! ssh-keyscan -T 10 "$DROPLET_IP" >"$TMP" 2>/dev/null; then
  rm -f "$TMP"
  echo "error: ssh-keyscan failed for ${DROPLET_IP} (network, firewall, or sshd not reachable)" >&2
  exit 1
fi

if [[ ! -s "$TMP" ]]; then
  rm -f "$TMP"
  echo "error: ssh-keyscan returned no keys for ${DROPLET_IP}" >&2
  exit 1
fi

mv "$TMP" "$OUT_FILE"
chmod 600 "$OUT_FILE"

echo "ok: wrote host key(s) to $OUT_FILE"
echo "hint: helpers will use this file automatically when it exists, or set OPENCLAW_DROPLET_KNOWN_HOSTS=$OUT_FILE"
