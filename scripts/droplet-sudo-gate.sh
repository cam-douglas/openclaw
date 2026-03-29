#!/usr/bin/env bash
# Shared sudo gate for droplet helper scripts (local operator machine).
# - Tries `sudo -n -v` first so an existing sudo timestamp does not prompt again.
# - Falls back to interactive `sudo -v` when needed.
# - OPENCLAW_DROPLET_SUDO_GATE=0 skips gate and revoke (CI/automation only).
#
# shellcheck shell=bash
# Source after ROOT is set: source "$ROOT/scripts/droplet-sudo-gate.sh"

droplet_sudo_revoke_now() {
  if [[ "${OPENCLAW_DROPLET_SUDO_GATE:-1}" == "0" ]]; then
    return 0
  fi
  sudo -k 2>/dev/null || true
}

droplet_sudo_gate_refresh() {
  if [[ "${OPENCLAW_DROPLET_SUDO_GATE:-1}" == "0" ]]; then
    return 0
  fi
  if sudo -n -v 2>/dev/null; then
    return 0
  fi
  sudo -v
}

droplet_sudo_revoke_on_exit() {
  if [[ "${OPENCLAW_DROPLET_SUDO_GATE:-1}" == "0" ]]; then
    return 0
  fi
  if [[ "${OPENCLAW_DROPLET_SUDO_EXIT_TRAPPED:-}" == "1" ]]; then
    return 0
  fi
  OPENCLAW_DROPLET_SUDO_EXIT_TRAPPED=1
  # shellcheck disable=SC2064
  trap 'droplet_sudo_revoke_now' EXIT
}
