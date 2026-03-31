#!/usr/bin/env bash
# Restrict inbound SSH to the Tailscale interface (tailscale0) so port 22 is not reachable on the
# public (eth0) address. Run on the droplet as root after verifying Tailscale works.
#
# Security:
# - Does not disable SSH on tailnet; you keep access via `ssh user@100.x` or MagicDNS.
# - Ensure you have a working Tailscale session (or DigitalOcean web console) before enabling.
# - Review other ports you need (HTTP/HTTPS) and add `ufw allow` rules before `ufw enable`.
#
# Usage:
#   sudo ./scripts/droplet-ufw-ssh-tailscale-only.sh
# Dry run (print rules only):
#   sudo DRY_RUN=1 ./scripts/droplet-ufw-ssh-tailscale-only.sh
set -euo pipefail

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "error: run as root" >&2
    exit 1
  fi
}

require_root

if ! command -v ufw >/dev/null 2>&1; then
  echo "error: ufw not installed (apt install ufw)" >&2
  exit 1
fi

if ! ip link show tailscale0 >/dev/null 2>&1; then
  echo "error: tailscale0 interface not found. Start Tailscale first (tailscale up)." >&2
  exit 1
fi

if command -v tailscale >/dev/null 2>&1; then
  if ! tailscale status >/dev/null 2>&1; then
    echo "error: tailscale status failed — fix login before firewalling SSH." >&2
    exit 1
  fi
fi

DRY_RUN="${DRY_RUN:-0}"

run_ufw() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] $*"
    return 0
  fi
  "$@"
}

echo "Configuring UFW: SSH only on tailscale0 (port 22). Other traffic defaults may be denied inbound."
echo "If you need public HTTP/HTTPS, add rules BEFORE enabling, or use DigitalOcean console."

run_ufw ufw --force reset
run_ufw ufw default deny incoming
run_ufw ufw default allow outgoing
run_ufw ufw allow in on tailscale0 to any port 22 proto tcp comment "SSH via Tailscale only"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] ufw --force enable"
  exit 0
fi

ufw --force enable
ufw status verbose

echo "Done. SSH to the public droplet IP on port 22 should now fail; use Tailscale (100.x or MagicDNS)."
