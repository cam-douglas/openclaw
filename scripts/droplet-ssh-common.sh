#!/usr/bin/env bash
# Shared OpenSSH client options for droplet helper scripts (not executed directly).
# Source after ROOT (repo root) and .env are loaded.
#
# Environment:
#   OPENCLAW_DROPLET_SSH_STRICT=1  — require host key in known files (no accept-new).
#   OPENCLAW_DROPLET_KNOWN_HOSTS   — explicit path to a known_hosts file (optional).
# If unset, uses "$ROOT/.droplet/known_hosts" when that file exists (pinning).
#
# See docs/platforms/digitalocean.md → "Further SSH hardening".

droplet_ssh_build_opts() {
  DROPLET_SSH_OPTS=()

  local kh_explicit="${OPENCLAW_DROPLET_KNOWN_HOSTS:-}"
  local kh_auto=""
  if [[ -n "${ROOT:-}" && -f "${ROOT}/.droplet/known_hosts" ]]; then
    kh_auto="${ROOT}/.droplet/known_hosts"
  fi
  local kh=""
  if [[ -n "$kh_explicit" ]]; then
    kh="$kh_explicit"
  else
    kh="$kh_auto"
  fi

  DROPLET_SSH_OPTS+=(
    -o ConnectTimeout=20
    -o IdentitiesOnly=yes
    -o ServerAliveInterval=30
    -o ServerAliveCountMax=3
  )

  if [[ -n "$kh_explicit" && ! -f "$kh_explicit" ]]; then
    echo "error: OPENCLAW_DROPLET_KNOWN_HOSTS points to missing file: $kh_explicit" >&2
    echo "hint: run ./scripts/droplet-record-host-key.sh or unset OPENCLAW_DROPLET_KNOWN_HOSTS" >&2
    return 1
  fi

  if [[ -n "$kh" && -f "$kh" ]]; then
    # Pin to this file only (do not fall back to system ssh_known_hosts for host identity).
    DROPLET_SSH_OPTS+=( -o "UserKnownHostsFile=${kh}" -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes )
  elif [[ "${OPENCLAW_DROPLET_SSH_STRICT:-}" == "1" ]]; then
    DROPLET_SSH_OPTS+=( -o StrictHostKeyChecking=yes )
  else
    DROPLET_SSH_OPTS+=( -o StrictHostKeyChecking=accept-new )
  fi

  # Optional: match `src/cli/droplet-ssh-options.ts` — disable agent so encrypted keys prompt (client-side).
  if [[ "${OPENCLAW_DROPLET_SSH_IDENTITY_AGENT_NONE:-}" == "1" ]]; then
    DROPLET_SSH_OPTS+=( -o IdentityAgent=none )
  fi
  if [[ -n "${OPENCLAW_DROPLET_SSH_IDENTITY:-}" ]]; then
    DROPLET_SSH_OPTS+=( -o "IdentityFile=${OPENCLAW_DROPLET_SSH_IDENTITY}" )
  fi
  return 0
}
