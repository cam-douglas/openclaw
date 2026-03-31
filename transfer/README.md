# Transfer Pack

This directory contains transfer artifacts and transfer tooling entrypoints.

## What is here

- `TRANSFER_RUNBOOK.md` - human-readable migration runbook copy.
- `scripts/` - executable transfer entrypoints.
- `openclaw-gpu-migration-*/` - generated migration bundle folders.
- `openclaw-gpu-migration-*.tar.gz` - generated migration bundle archives.

## Transfer scripts (run from repo root)

- `transfer/scripts/pre-sync.sh`
- `transfer/scripts/build-bundle.sh`
- `transfer/scripts/sync.sh`
- `transfer/scripts/post-sync.sh`

These call the canonical implementations under `scripts/` so behavior stays in sync.

## Quick start

```bash
# 1) Capture source metadata
bash transfer/scripts/pre-sync.sh

# 2) Build portable bundle
bash transfer/scripts/build-bundle.sh

# 3) Restore to target host
bash transfer/scripts/sync.sh --target-host <target-host> --bundle transfer/openclaw-gpu-migration-<timestamp>.tar.gz

# 4) Validate target
bash transfer/scripts/post-sync.sh --target-host <target-host>
```
