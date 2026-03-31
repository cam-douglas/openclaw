#!/usr/bin/env bash
# OpenClaw droplet: gateway + Tailscale liveness watchdog (run on the VPS as root).
#
# Security properties:
# - No secrets, no outbound network checks (only curl to 127.0.0.1).
# - Does not invoke `openclaw` CLI or any LLM provider — only systemd + curl + ss.
# - Uses systemd --user for the gateway unit; controls tailscaled via system.
# - Rate-limits gateway restarts to avoid restart storms.
#
# Checks (in order):
# - systemd --user unit is active
# - TCP listener exists on the gateway port (catches wedged/hung processes)
# - HTTP GET /healthz and /readyz on loopback (catches broken HTTP stack)
#
# Tailscale note: keeps tailscaled running; OpenClaw's `gateway.tailscale.*` is applied by the
# gateway process when it starts.
#
# Typical install (preferred — timer + no duplicate cron):
#   cd /root/openclaw && git pull && sudo bash scripts/install-droplet-watchdog.sh
# Manual:
#   sudo install -m 750 scripts/droplet-gateway-watchdog.sh /usr/local/sbin/openclaw-gateway-watchdog.sh
#   sudo mkdir -p /var/lib/openclaw && sudo chmod 700 /var/lib/openclaw
#   sudo install -m 644 scripts/droplet-gateway-watchdog.service /etc/systemd/system/
#   sudo install -m 644 scripts/droplet-gateway-watchdog.timer /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now openclaw-gateway-watchdog.timer
#
# See docs/platforms/digitalocean.md → "Gateway watchdog".
set -euo pipefail

log_msg() {
  # shellcheck disable=SC2059
  printf '[openclaw-gateway-watchdog] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ") $*" >&2
  if command -v logger >/dev/null 2>&1; then
    logger -t openclaw-gateway-watchdog -- "$*"
  fi
}

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "error: run as root (cron or systemd timer)" >&2
    exit 1
  fi
}

require_root

# Root's user session (gateway runs as systemd --user for uid 0).
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

UNIT="${OPENCLAW_GATEWAY_UNIT:-openclaw-gateway.service}"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
HEALTH_URL="${OPENCLAW_GATEWAY_HEALTH_URL:-http://127.0.0.1:${PORT}/healthz}"
READY_URL="${OPENCLAW_GATEWAY_READY_URL:-http://127.0.0.1:${PORT}/readyz}"
CURL_TIMEOUT="${OPENCLAW_GATEWAY_CURL_TIMEOUT:-4}"

TAILSCALED_UNIT="${OPENCLAW_TAILSCALED_UNIT:-tailscaled.service}"

STATE_DIR="${OPENCLAW_WATCHDOG_STATE_DIR:-/var/lib/openclaw}"
FAIL_STREAK_FILE="${STATE_DIR}/watchdog.fail-streak"
RESTART_LOG="${STATE_DIR}/watchdog.restarts.tsv"

# Consecutive failures of health+ready (listener missing restarts immediately, no streak).
FAILS_BEFORE_RESTART="${OPENCLAW_WATCHDOG_FAILS_BEFORE_RESTART:-1}"
RESTART_WINDOW_SEC="${OPENCLAW_WATCHDOG_RESTART_WINDOW_SEC:-3600}"
MAX_RESTARTS_PER_WINDOW="${OPENCLAW_WATCHDOG_MAX_RESTARTS_PER_WINDOW:-8}"

LOCK_PATH="${OPENCLAW_WATCHDOG_LOCK:-/run/openclaw-gateway-watchdog.lock}"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

exec 9>"$LOCK_PATH" || true
if ! flock -n 9; then
  log_msg "another watchdog instance is running; exiting"
  exit 0
fi

if [[ ! -S "${XDG_RUNTIME_DIR}/bus" ]]; then
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger root >/dev/null 2>&1 || true
  fi
  log_msg "user dbus not available (${XDG_RUNTIME_DIR}/bus missing); cannot manage systemd --user gateway (enable lingering for root)"
  exit 0
fi

now_epoch() {
  date +%s
}

count_recent_restarts() {
  local cutoff="$1"
  local n=0
  if [[ -f "$RESTART_LOG" ]]; then
    while read -r ts _; do
      [[ -z "${ts:-}" ]] && continue
      if [[ "$ts" =~ ^[0-9]+$ ]] && [[ "$ts" -ge "$cutoff" ]]; then
        n=$((n + 1))
      fi
    done <"$RESTART_LOG"
  fi
  printf "%s" "$n"
}

append_restart_record() {
  local reason="$1"
  printf "%s\t%s\n" "$(now_epoch)" "$reason" >>"$RESTART_LOG"
  if [[ -f "$RESTART_LOG" ]]; then
    local lines
    lines=$(wc -l <"$RESTART_LOG" | tr -d " ")
    if [[ "${lines:-0}" -gt 500 ]]; then
      tail -n 500 "$RESTART_LOG" >"${RESTART_LOG}.tmp"
      mv "${RESTART_LOG}.tmp" "$RESTART_LOG"
    fi
  fi
}

ensure_tailscaled() {
  if ! command -v systemctl >/dev/null 2>&1; then
    log_msg "systemctl not found; skipping tailscaled check"
    return 0
  fi
  if ! systemctl list-unit-files "${TAILSCALED_UNIT}" >/dev/null 2>&1; then
    log_msg "unit ${TAILSCALED_UNIT} not present; skipping tailscaled check"
    return 0
  fi
  local state
  state=$(systemctl is-active "${TAILSCALED_UNIT}" 2>/dev/null || true)
  if [[ "$state" != "active" ]]; then
    log_msg "tailscaled not active (state=${state:-unknown}); starting ${TAILSCALED_UNIT}"
    systemctl start "${TAILSCALED_UNIT}" || log_msg "warning: failed to start ${TAILSCALED_UNIT}"
    sleep 2
  fi
  if command -v tailscale >/dev/null 2>&1; then
    if ! tailscale status >/dev/null 2>&1; then
      log_msg "warning: tailscale status failed (node may need login: tailscale up)"
    fi
  fi
}

gateway_active() {
  systemctl --user is-active --quiet "$UNIT" 2>/dev/null
}

gateway_listen_ok() {
  if ! command -v ss >/dev/null 2>&1; then
    return 1
  fi
  # Match listeners on :PORT (IPv4/IPv6)
  ss -ltn 2>/dev/null | grep -E ":${PORT}\\s" >/dev/null 2>&1
}

curl_ok() {
  local url="$1"
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS --max-time "$CURL_TIMEOUT" "$url" >/dev/null 2>&1
}

gateway_probes_ok() {
  curl_ok "$HEALTH_URL" && curl_ok "$READY_URL"
}

restart_gateway() {
  local reason="$1"
  local cutoff window_count
  cutoff=$(($(now_epoch) - "${RESTART_WINDOW_SEC}"))
  window_count=$(count_recent_restarts "$cutoff")
  if [[ "$window_count" -ge "$MAX_RESTARTS_PER_WINDOW" ]]; then
    log_msg "refusing restart (${reason}): hit max ${MAX_RESTARTS_PER_WINDOW} restarts in ${RESTART_WINDOW_SEC}s (see ${RESTART_LOG})"
    return 1
  fi
  log_msg "restarting gateway (${reason})"
  append_restart_record "$reason"
  systemctl --user restart "$UNIT" || {
    log_msg "error: systemctl --user restart failed for ${UNIT}"
    return 1
  }
  return 0
}

ensure_tailscaled

if ! gateway_active; then
  log_msg "gateway unit not active (${UNIT})"
  restart_gateway "unit-inactive" || exit 0
  exit 0
fi

if ! gateway_listen_ok; then
  log_msg "no TCP listener on port ${PORT} while unit reports active"
  if restart_gateway "no-listener"; then
    : >"$FAIL_STREAK_FILE" || true
  fi
  exit 0
fi

if gateway_probes_ok; then
  : >"$FAIL_STREAK_FILE" 2>/dev/null || true
  exit 0
fi

prev=0
if [[ -f "$FAIL_STREAK_FILE" ]] && [[ "$(cat "$FAIL_STREAK_FILE" 2>/dev/null)" =~ ^[0-9]+$ ]]; then
  prev="$(cat "$FAIL_STREAK_FILE")"
fi
streak=$((prev + 1))
echo "$streak" >"$FAIL_STREAK_FILE"
log_msg "probe failed (health+ready) streak=${streak}/${FAILS_BEFORE_RESTART} health=${HEALTH_URL} ready=${READY_URL}"

if [[ "$streak" -lt "$FAILS_BEFORE_RESTART" ]]; then
  exit 0
fi

if restart_gateway "health-ready-failed"; then
  : >"$FAIL_STREAK_FILE" || true
fi

exit 0
