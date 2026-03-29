#!/usr/bin/env bash
# Bidirectional, non-destructive OpenClaw workspace markdown mirror sync.
# - Never deletes existing files.
# - Never overwrites original filenames.
# - Mirrors remote Markdown files into local with *_droplet suffix.
# - Mirrors local Markdown files into remote with *_local suffix.
# - Ignores all non-Markdown files.
#
# Usage:
#   ./scripts/sync-openclaw-preserve-bidirectional.sh
#   ./scripts/sync-openclaw-preserve-bidirectional.sh --dry-run
#   OPENCLAW_ENV_FILE=/path/to/.env ./scripts/sync-openclaw-preserve-bidirectional.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${OPENCLAW_ENV_FILE:-$ROOT/.env}"
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: missing env file: $ENV_FILE" >&2
  exit 1
fi

# shellcheck source=/dev/null
set -a
source "$ENV_FILE"
set +a

DROPLET_IP="${DROPLET_IP:?Set DROPLET_IP in $ENV_FILE}"
SSH_USER="${SSH_USER:-root}"
TARGET="${SSH_USER}@${DROPLET_IP}"

LOCAL_WORKSPACE_DIR="${LOCAL_OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
REMOTE_WORKSPACE_DIR="${REMOTE_OPENCLAW_WORKSPACE_DIR:-/root/.openclaw/workspace}"

if [[ ! -d "$LOCAL_WORKSPACE_DIR" ]]; then
  echo "error: local OpenClaw workspace dir missing: $LOCAL_WORKSPACE_DIR" >&2
  exit 1
fi

# shellcheck source=scripts/droplet-ssh-common.sh
source "$ROOT/scripts/droplet-ssh-common.sh"
droplet_ssh_build_opts || exit 1

if [[ -n "${SSH_KEY_PW:-}" ]]; then
  export SSHPASS="$SSH_KEY_PW"
  SSH=(sshpass -e ssh "${DROPLET_SSH_OPTS[@]}")
else
  SSH=(ssh "${DROPLET_SSH_OPTS[@]}")
fi

WORK_DIR="$(mktemp -d)"
LOCAL_SNAP="$WORK_DIR/local-snapshot"
REMOTE_SNAP="$WORK_DIR/remote-snapshot"
LOCAL_TO_REMOTE_STAGE="$WORK_DIR/local-to-remote-stage"
REMOTE_TO_LOCAL_STAGE="$WORK_DIR/remote-to-local-stage"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$LOCAL_SNAP" "$REMOTE_SNAP" "$LOCAL_TO_REMOTE_STAGE" "$REMOTE_TO_LOCAL_STAGE"

echo "snapshot: local -> $LOCAL_SNAP"
tar -C "$LOCAL_WORKSPACE_DIR" -cf - . | tar -C "$LOCAL_SNAP" -xf -

echo "snapshot: droplet -> $REMOTE_SNAP"
"${SSH[@]}" "$TARGET" "test -d '$REMOTE_WORKSPACE_DIR'"
"${SSH[@]}" "$TARGET" "tar -C '$REMOTE_WORKSPACE_DIR' -cf - ." | tar -C "$REMOTE_SNAP" -xf -

python3 - "$LOCAL_SNAP" "$LOCAL_TO_REMOTE_STAGE" "local" "$DRY_RUN" <<'PY'
import os
import shutil
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
suffix = sys.argv[3]
dry_run = sys.argv[4] == "1"

def split_name(name: str) -> tuple[str, str]:
    dot = name.rfind(".")
    if dot > 0:
        return name[:dot], name[dot:]
    return name, ""

def has_mirror_suffix(name: str) -> bool:
    base, _ext = split_name(name)
    return "_local" in base or "_droplet" in base

files = 0
symlinks = 0
for item in src.rglob("*"):
    if item.is_dir():
        continue
    rel = item.relative_to(src)
    if has_mirror_suffix(rel.name):
        continue
    if rel.suffix.lower() != ".md":
        continue
    base, ext = split_name(rel.name)
    mirrored_name = f"{base}_{suffix}{ext}"
    out = dst / rel.parent / mirrored_name
    out.parent.mkdir(parents=True, exist_ok=True)
    if item.is_symlink():
        symlinks += 1
    else:
        files += 1
    if dry_run:
        continue
    if item.is_symlink():
        target = os.readlink(item)
        if out.exists() or out.is_symlink():
            out.unlink()
        os.symlink(target, out)
    else:
        shutil.copy2(item, out)

print(f"stage={dst} suffix={suffix} files={files} symlinks={symlinks} dry_run={dry_run}")
PY

python3 - "$REMOTE_SNAP" "$REMOTE_TO_LOCAL_STAGE" "droplet" "$DRY_RUN" <<'PY'
import os
import shutil
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
suffix = sys.argv[3]
dry_run = sys.argv[4] == "1"

def split_name(name: str) -> tuple[str, str]:
    dot = name.rfind(".")
    if dot > 0:
        return name[:dot], name[dot:]
    return name, ""

def has_mirror_suffix(name: str) -> bool:
    base, _ext = split_name(name)
    return "_local" in base or "_droplet" in base

files = 0
symlinks = 0
for item in src.rglob("*"):
    if item.is_dir():
        continue
    rel = item.relative_to(src)
    if has_mirror_suffix(rel.name):
        continue
    if rel.suffix.lower() != ".md":
        continue
    base, ext = split_name(rel.name)
    mirrored_name = f"{base}_{suffix}{ext}"
    out = dst / rel.parent / mirrored_name
    out.parent.mkdir(parents=True, exist_ok=True)
    if item.is_symlink():
        symlinks += 1
    else:
        files += 1
    if dry_run:
        continue
    if item.is_symlink():
        target = os.readlink(item)
        if out.exists() or out.is_symlink():
            out.unlink()
        os.symlink(target, out)
    else:
        shutil.copy2(item, out)

print(f"stage={dst} suffix={suffix} files={files} symlinks={symlinks} dry_run={dry_run}")
PY

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "dry-run complete: no files written"
  exit 0
fi

echo "apply: local mirrors -> droplet ($REMOTE_WORKSPACE_DIR)"
tar -C "$LOCAL_TO_REMOTE_STAGE" -cf - . | "${SSH[@]}" "$TARGET" "mkdir -p '$REMOTE_WORKSPACE_DIR' && tar -C '$REMOTE_WORKSPACE_DIR' -xf -"

echo "apply: droplet mirrors -> local ($LOCAL_WORKSPACE_DIR)"
tar -C "$REMOTE_TO_LOCAL_STAGE" -cf - . | tar -C "$LOCAL_WORKSPACE_DIR" -xf -

echo "ok: non-destructive bidirectional mirror sync complete."
echo "local originals remain unchanged; droplet originals remain unchanged."
