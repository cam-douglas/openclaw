# OpenClaw Transfer Runbook (Copy)

Canonical source: `docs/platforms/droplet-gpu-migration.md`

This copy exists in `transfer/` so transfer docs and artifacts are colocated.

## Phases

1. Pre-sync inventory:

```bash
bash transfer/scripts/pre-sync.sh
```

2. Build migration bundle:

```bash
bash transfer/scripts/build-bundle.sh
```

3. Sync/restore to target:

```bash
bash transfer/scripts/sync.sh --target-host <target-host> --bundle transfer/openclaw-gpu-migration-<timestamp>.tar.gz
```

4. Post-sync validation:

```bash
bash transfer/scripts/post-sync.sh --target-host <target-host>
```

## Notes

- Full procedure and troubleshooting are maintained in `docs/platforms/droplet-gpu-migration.md`.
- The scripts in `transfer/scripts/` call the canonical scripts in `scripts/`.
