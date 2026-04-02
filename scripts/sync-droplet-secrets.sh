#!/usr/bin/env bash
# Securely sync secrets from a local gitignored .env to a remote OpenClaw droplet.
# See docs/platforms/digitalocean.md → "Security model, limits, and mitigations" (secrets on disk).
#
# - Writes /root/.config/openclaw/gateway-secrets.env (outside ~/.openclaw agents/workspace tree).
# - Strips inline API key profiles from auth-profiles.json so providers use env only.
# - Installs a systemd user drop-in so the gateway loads the env file.
# - Restarts openclaw-gateway (user service for root).
#
# Requires local sudo (sudo -v) before any SSH/SCP; revokes sudo cache on exit (sudo -k).
# Prereqs: ssh, scp, python3, sshpass (optional, for password SSH).
# Usage:
#   ./scripts/sync-droplet-secrets.sh
#   OPENCLAW_ENV_FILE=/path/to/.env ./scripts/sync-droplet-secrets.sh
#   ./scripts/sync-droplet-secrets.sh --dry-run
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${OPENCLAW_ENV_FILE:-$ROOT/.env}"
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: missing $ENV_FILE (copy from .env.example and fill secrets)" >&2
  exit 1
fi

# Clear inherited secret env vars first so removed keys in .env do not linger
# from the parent shell and accidentally win during render mapping.
for key in \
  OPENAI_API_KEY OPENAI_API_KEY_DROPLET \
  ANTHROPIC_API_KEY ANTHROPIC_API_KEY_DROPLET \
  OPENROUTER_API_KEY OPENROUTER_API_KEY_DROPLET \
  GROK_API_KEY GROK_API_KEY_DROPLET \
  GEMINI_API_KEY GEMINI_API_KEY_DROPLET \
  HUGGINGFACE_API_KEY HUGGINGFACE_API_KEY_DROPLET HF_TOKEN \
  KIMI_API_KEY KIMI_API_KEY_DROPLET \
  MOONSHOT_API_KEY MOONSHOT_API_KEY_DROPLET
do
  unset "$key" || true
done

# shellcheck source=/dev/null
set -a
source "$ENV_FILE"
set +a

DROPLET_IP="${DROPLET_IP:?Set DROPLET_IP in $ENV_FILE}"
SSH_USER="${SSH_USER:-root}"
REMOTE_SECRETS_DIR="/root/.config/openclaw"
REMOTE_ENV="${REMOTE_SECRETS_DIR}/gateway-secrets.env"
REMOTE_AUTH="/root/.openclaw/agents/main/agent/auth-profiles.json"
LEGACY_ENV="/root/.openclaw/.env"

TARGET="${SSH_USER}@${DROPLET_IP}"

# shellcheck source=scripts/droplet-ssh-common.sh
source "$ROOT/scripts/droplet-ssh-common.sh"
droplet_ssh_build_opts || exit 1

# Prompt for sudo only after local config validates (single `sudo -v`).
# shellcheck source=scripts/droplet-sudo-gate.sh
source "$ROOT/scripts/droplet-sudo-gate.sh"
droplet_sudo_gate_refresh

if [[ -n "${SSH_KEY_PW:-}" ]]; then
  export SSHPASS="$SSH_KEY_PW"
  SSH=(sshpass -e ssh "${DROPLET_SSH_OPTS[@]}")
  SCP=(sshpass -e scp -q "${DROPLET_SSH_OPTS[@]}")
else
  SSH=(ssh "${DROPLET_SSH_OPTS[@]}")
  SCP=(scp -q "${DROPLET_SSH_OPTS[@]}")
fi

TMP_ENV="$(mktemp)"
TMP_REMOTE_AUTH="$(mktemp)"
TMP_AUTH_OUT="$(mktemp)"
sync_cleanup() {
  rm -f "$TMP_ENV" "$TMP_REMOTE_AUTH" "$TMP_AUTH_OUT"
  droplet_sudo_revoke_now
}
trap sync_cleanup EXIT

python3 "$ROOT/scripts/render-droplet-systemd-env.py" >"$TMP_ENV"
chmod 600 "$TMP_ENV"

if ! "${SCP[@]}" "$TARGET:$REMOTE_AUTH" "$TMP_REMOTE_AUTH" 2>/dev/null; then
  echo '{"version":1,"profiles":{},"lastGood":{},"usageStats":{}}' >"$TMP_REMOTE_AUTH"
fi

python3 "$ROOT/scripts/strip-droplet-auth-profiles.py" "$TMP_REMOTE_AUTH" >"$TMP_AUTH_OUT"
chmod 600 "$TMP_AUTH_OUT"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "dry-run: would upload systemd env ($(wc -c <"$TMP_ENV") bytes) and auth-profiles ($(wc -c <"$TMP_AUTH_OUT") bytes)"
  exit 0
fi

"${SSH[@]}" "$TARGET" "mkdir -p /root/.openclaw/agents/main/agent /root/.config/systemd/user/openclaw-gateway.service.d ${REMOTE_SECRETS_DIR}"

"${SCP[@]}" "$TMP_ENV" "$TARGET:$REMOTE_ENV"
"${SCP[@]}" "$TMP_AUTH_OUT" "$TARGET:$REMOTE_AUTH"

"${SSH[@]}" "$TARGET" bash -s <<REMOTE
set -euo pipefail
chmod 700 "${REMOTE_SECRETS_DIR}"
chmod 600 "${REMOTE_ENV}"
chmod 600 /root/.openclaw/agents/main/agent/auth-profiles.json
# Remove legacy env path so secrets are not duplicated under ~/.openclaw/
rm -f "${LEGACY_ENV}"
cat > /root/.config/systemd/user/openclaw-gateway.service.d/env.conf <<'UNIT'
[Service]
EnvironmentFile=-/root/.config/openclaw/gateway-secrets.env
UNIT
chmod 644 /root/.config/systemd/user/openclaw-gateway.service.d/env.conf
export XDG_RUNTIME_DIR=/run/user/0
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
systemctl --user is-active openclaw-gateway.service
REMOTE

echo "ok: synced secrets to $TARGET; gateway user service restarted."
