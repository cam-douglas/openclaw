#!/usr/bin/env bash
# Run one command with sudo, then invalidate the cached sudo timestamp (`sudo -k`)
# so the next `sudo` in this shell requires a password again. Use for privileged
# OpenClaw or system changes when you want no lingering sudo grace period.
#
# Usage:
#   ./scripts/sudo-revoke-after.sh -- openclaw gateway restart
#   ./scripts/sudo-revoke-after.sh -- bash -lc 'apt update && apt install -y jq'
set -euo pipefail
if [[ "${1:-}" != "--" ]] || [[ $# -lt 2 ]]; then
  echo "Usage: $0 -- <command> [args...]" >&2
  exit 2
fi
shift
sudo -v
"$@"
code=$?
sudo -k
exit "$code"
