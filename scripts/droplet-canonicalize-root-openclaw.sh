#!/usr/bin/env bash
# Run on the DigitalOcean droplet as root.
# Canonicalizes OpenClaw runtime to /root/.openclaw and reports legacy camdouglas paths.
#
# Usage:
#   sudo bash scripts/droplet-canonicalize-root-openclaw.sh           # scan + safe fixes + restart gateway
#   sudo bash scripts/droplet-canonicalize-root-openclaw.sh --dry-run # report only
#
# Safe fixes (unless --dry-run):
#   - Materialize /root/.openclaw if it is a symlink pointing at a legacy home path
#   - Rsync-merge /Users/camdouglas/.openclaw into /root/.openclaw when present
#   - Replace literal "/Users/camdouglas" with "/root" in config/text under /root/.openclaw
#     and in systemd user drop-ins for the gateway
#
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

LEGACY_OPENCLAW="/Users/camdouglas/.openclaw"
CANON="/root/.openclaw"
BACKUP_ROOT="/root/migration-backups"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "error: run as root on the droplet" >&2
    exit 1
  fi
}

require_root

echo "=== Droplet canonicalize: $(hostname) at ${TS} (dry-run=${DRY_RUN}) ==="
echo

echo "=== Paths matching camdouglas (limited) ==="
find /Users /home /root -maxdepth 6 \( -path '*camdouglas*' -o -path '*/Users/camdouglas/*' \) 2>/dev/null | head -80 || true
echo

echo "=== /Users tree (depth 3) ==="
if [[ -d /Users ]]; then
  find /Users -maxdepth 3 -print 2>/dev/null | head -60 || true
else
  echo "(no /Users directory)"
fi
echo

echo "=== /root/.openclaw stat ==="
if [[ -e "$CANON" ]]; then
  ls -la "$CANON" | head -5
  if [[ -L "$CANON" ]]; then
    echo "NOTE: $CANON is a symlink -> $(readlink -f "$CANON" 2>/dev/null || readlink "$CANON")"
  fi
else
  echo "(missing $CANON)"
fi
echo

echo "=== systemd user gateway (path hints) ==="
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
systemctl --user cat openclaw-gateway.service 2>/dev/null | head -60 || echo "(could not read unit)"
echo

replace_paths_in_file() {
  local f="$1"
  if [[ ! -f "$f" ]]; then
    return 0
  fi
  if ! grep -q '/Users/camdouglas' "$f" 2>/dev/null; then
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "dry-run: would rewrite /Users/camdouglas -> /root in $f"
    return 0
  fi
  cp -a "$f" "${f}.bak.${TS}"
  # shellcheck disable=SC2001
  sed 's#/Users/camdouglas#/root#g' "$f.bak.${TS}" >"$f"
  echo "rewrote paths in $f (backup ${f}.bak.${TS})"
}

materialize_openclaw_if_symlink() {
  if [[ ! -L "$CANON" ]]; then
    return 0
  fi
  local target
  target="$(readlink -f "$CANON" 2>/dev/null || true)"
  echo "Materializing symlink $CANON -> ${target:-unknown}"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "dry-run: would copy symlink tree into a real directory at $CANON"
    return 0
  fi
  local tmp
  tmp="$(mktemp -d)"
  rsync -aHAX --numeric-ids "$CANON/" "$tmp/"
  rm "$CANON"
  mv "$tmp" "$CANON"
  chmod 700 "$CANON" || true
  echo "OK: $CANON is now a real directory"
}

merge_legacy_openclaw() {
  if [[ ! -d "$LEGACY_OPENCLAW" ]]; then
    echo "No legacy directory: $LEGACY_OPENCLAW"
    return 0
  fi
  echo "Merging $LEGACY_OPENCLAW -> $CANON (rsync: update newer, preserve extras)"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "dry-run: would rsync -aHAX --update $LEGACY_OPENCLAW/ $CANON/"
    return 0
  fi
  mkdir -p "$BACKUP_ROOT"
  local snap="${BACKUP_ROOT}/users-camdouglas-openclaw-pre-merge.${TS}.tar.gz"
  tar -C "$(dirname "$LEGACY_OPENCLAW")" -czf "$snap" "$(basename "$LEGACY_OPENCLAW")"
  echo "Backup: $snap"
  mkdir -p "$CANON"
  rsync -aHAX --update "$LEGACY_OPENCLAW/" "$CANON/"
  echo "OK: merge complete"
}

rewrite_openclaw_tree() {
  local d f
  while IFS= read -r -d '' f; do
    case "$f" in
      *.bak.*) continue ;;
      *.json | *.jsonl | *.md | *.txt | *.env | *.service | *.conf | openclaw.bash)
        replace_paths_in_file "$f"
        ;;
    esac
  done < <(
    for d in "$CANON" "/root/.config/systemd/user"; do
      [[ -d "$d" ]] || continue
      find "$d" -type f \( \
        -name '*.json' -o -name '*.jsonl' -o -name '*.md' -o -name '*.txt' -o -name '*.env' -o \
        -name '*.conf' -o -name '*.service' -o -name 'openclaw.bash' \
      \) -print0 2>/dev/null || true
    done
  )
}

restart_gateway() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "dry-run: would systemctl --user restart openclaw-gateway.service"
    return 0
  fi
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  systemctl --user daemon-reload || true
  systemctl --user restart openclaw-gateway.service
  systemctl --user is-active openclaw-gateway.service || true
  echo "Gateway restarted."
}

materialize_openclaw_if_symlink
merge_legacy_openclaw
rewrite_openclaw_tree

echo
echo "=== Post-fix: grep /Users/camdouglas under /root/.openclaw (should be empty) ==="
if [[ -d "$CANON" ]]; then
  grep -R '/Users/camdouglas' "$CANON" 2>/dev/null | head -20 || echo "(no matches)"
else
  echo "(no $CANON)"
fi
echo

restart_gateway

echo
echo "Done. If legacy /Users/camdouglas still exists, remove it only after verifying the gateway:"
echo "  systemctl --user status openclaw-gateway.service"
echo "  openclaw channels status --probe"
echo "Then: rm -rf /Users/camdouglas   # only when satisfied (migration backup already under $BACKUP_ROOT if merge ran)"
