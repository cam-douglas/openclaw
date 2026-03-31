#!/usr/bin/env bash
# Install the OpenClaw gateway watchdog on the droplet (run as root, from a repo checkout).
# Prefer systemd timer (every ~60s); removes legacy cron if present to avoid duplicate runs.
#
# Usage (on the VPS):
#   cd /root/openclaw && git pull && sudo bash scripts/install-droplet-watchdog.sh
# Or with a non-default checkout path:
#   sudo OPENCLAW_REPO_ROOT=/path/to/openclaw bash scripts/install-droplet-watchdog.sh
#
# Idempotent: safe to re-run after upgrades.
set -euo pipefail

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "error: run as root (sudo bash $0)" >&2
    exit 1
  fi
}

require_root

REPO="${OPENCLAW_REPO_ROOT:-${1:-/root/openclaw}}"
SCRIPT_SRC="${REPO}/scripts/droplet-gateway-watchdog.sh"
SERVICE_SRC="${REPO}/scripts/droplet-gateway-watchdog.service"
TIMER_SRC="${REPO}/scripts/droplet-gateway-watchdog.timer"

for f in "$SCRIPT_SRC" "$SERVICE_SRC" "$TIMER_SRC"; do
  if [[ ! -f "$f" ]]; then
    echo "error: missing $f (set OPENCLAW_REPO_ROOT or clone the repo)" >&2
    exit 1
  fi
done

install -m 750 "$SCRIPT_SRC" /usr/local/sbin/openclaw-gateway-watchdog.sh
mkdir -p /var/lib/openclaw
chmod 700 /var/lib/openclaw

install -m 644 "$SERVICE_SRC" /etc/systemd/system/openclaw-gateway-watchdog.service
install -m 644 "$TIMER_SRC" /etc/systemd/system/openclaw-gateway-watchdog.timer

systemctl daemon-reload
systemctl enable --now openclaw-gateway-watchdog.timer

# The gateway runs as root's systemd --user unit. Ensure root's user manager is
# available after reboot even when no interactive session is active, otherwise
# the watchdog cannot issue `systemctl --user restart ...`.
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger root >/dev/null 2>&1 || true
fi

# Avoid running the watchdog twice (timer + cron).
if [[ -f /etc/cron.d/openclaw-gateway-watchdog ]]; then
  rm -f /etc/cron.d/openclaw-gateway-watchdog
  echo "removed legacy /etc/cron.d/openclaw-gateway-watchdog (systemd timer is active)"
fi

systemctl --no-pager --full status openclaw-gateway-watchdog.timer || true
echo "install-droplet-watchdog: ok (timer active; next runs per OnUnitActiveSec)"
