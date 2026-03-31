#!/usr/bin/env bash
# Post-sync validation for OpenClaw droplet migration.
# Compares key source/target signals and verifies target runtime health.
#
# Usage:
#   ./scripts/droplet-migration-post-sync.sh --target-host <new-ip-or-host>
#   ./scripts/droplet-migration-post-sync.sh --target-host <new-ip> --source-host <old-ip>
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
SOURCE_HOST=""
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

TARGET_CONN="${SSH_USER:-root}@${TARGET_HOST}"
SOURCE_CONN="${SSH_USER:-root}@${SOURCE_HOST}"

# shellcheck source=scripts/droplet-ssh-common.sh
source "$ROOT/scripts/droplet-ssh-common.sh"
droplet_ssh_build_opts || exit 1
SSH_OPTS=("${DROPLET_SSH_OPTS[@]}")

pass() { echo "PASS: $*"; }
warn() { echo "WARN: $*" >&2; }
fail() { echo "FAIL: $*" >&2; }

echo "[post-sync] target: ${TARGET_CONN}"
ssh "${SSH_OPTS[@]}" "$TARGET_CONN" 'echo "[post-sync] target ssh ok: $(hostname)"'

SRC_HEAD=""
if [[ -n "$SOURCE_HOST" ]]; then
  if ssh "${SSH_OPTS[@]}" "$SOURCE_CONN" 'true' 2>/dev/null; then
    SRC_HEAD="$(ssh "${SSH_OPTS[@]}" "$SOURCE_CONN" 'cd /root/openclaw && git rev-parse HEAD 2>/dev/null || true')"
  else
    warn "source host not reachable; skipping source-vs-target comparison"
  fi
fi
TGT_HEAD="$(ssh "${SSH_OPTS[@]}" "$TARGET_CONN" 'cd /root/openclaw && git rev-parse HEAD')"
if [[ -n "$SRC_HEAD" ]]; then
  if [[ "$SRC_HEAD" == "$TGT_HEAD" ]]; then
    pass "repo head matches source ($TGT_HEAD)"
  else
    warn "repo head differs: source=$SRC_HEAD target=$TGT_HEAD"
  fi
else
  pass "target repo head: $TGT_HEAD"
fi

TGT_STATUS="$(ssh "${SSH_OPTS[@]}" "$TARGET_CONN" 'cd /root/openclaw && git status -sb')"
if [[ "$TGT_STATUS" == "## main...origin/main" ]]; then
  pass "target git status clean and tracking origin/main"
else
  warn "target git status: $TGT_STATUS"
fi

GW_ACTIVE="$(ssh "${SSH_OPTS[@]}" "$TARGET_CONN" 'systemctl --user is-active openclaw-gateway.service 2>/dev/null || true')"
if [[ "$GW_ACTIVE" == "active" ]]; then
  pass "target gateway service active"
else
  fail "target gateway service not active (state=$GW_ACTIVE)"
  exit 2
fi

if ssh "${SSH_OPTS[@]}" "$TARGET_CONN" 'ss -ltnp 2>/dev/null | grep -q ":18789\s"'; then
  pass "target listener present on :18789"
else
  fail "target listener missing on :18789"
  exit 2
fi

if ssh "${SSH_OPTS[@]}" "$TARGET_CONN" 'systemctl is-active openclaw-gateway-watchdog.timer >/dev/null 2>&1'; then
  pass "watchdog timer active"
else
  fail "watchdog timer inactive"
  exit 2
fi

if ssh "${SSH_OPTS[@]}" "$TARGET_CONN" 'systemctl is-enabled openclaw-gateway-watchdog.timer >/dev/null 2>&1'; then
  pass "watchdog timer enabled"
else
  fail "watchdog timer not enabled"
  exit 2
fi

LINGER="$(ssh "${SSH_OPTS[@]}" "$TARGET_CONN" 'loginctl show-user root -p Linger --value 2>/dev/null || true')"
if [[ "$LINGER" == "yes" ]]; then
  pass "root linger enabled"
else
  warn "root linger not confirmed (value=$LINGER)"
fi

CFG_SHA="$(ssh "${SSH_OPTS[@]}" "$TARGET_CONN" 'sha256sum /root/.openclaw/openclaw.json 2>/dev/null | awk "{print \$1}" || true')"
if [[ -n "$CFG_SHA" ]]; then
  pass "target openclaw.json present (sha256=${CFG_SHA})"
else
  fail "target /root/.openclaw/openclaw.json missing"
  exit 2
fi

SEC_SHA="$(ssh "${SSH_OPTS[@]}" "$TARGET_CONN" 'sha256sum /root/.config/openclaw/gateway-secrets.env 2>/dev/null | awk "{print \$1}" || true')"
if [[ -n "$SEC_SHA" ]]; then
  pass "target gateway-secrets.env present (sha256=${SEC_SHA})"
else
  warn "target gateway-secrets.env missing"
fi

SIZE_TGT="$(ssh "${SSH_OPTS[@]}" "$TARGET_CONN" 'du -sb /root/.openclaw 2>/dev/null | awk "{print \$1}" || true')"
if [[ -n "$SIZE_TGT" ]]; then
  pass "target /root/.openclaw size bytes=${SIZE_TGT}"
fi

if ssh "${SSH_OPTS[@]}" "$TARGET_CONN" 'command -v tailscale >/dev/null 2>&1'; then
  TS_STATE="$(ssh "${SSH_OPTS[@]}" "$TARGET_CONN" 'tailscale status >/dev/null 2>&1 && echo up || echo down')"
  if [[ "$TS_STATE" == "up" ]]; then
    pass "tailscale installed and up on target"
  else
    warn "tailscale installed but not currently up on target"
  fi
else
  warn "tailscale not installed on target"
fi

echo "[post-sync] complete"
