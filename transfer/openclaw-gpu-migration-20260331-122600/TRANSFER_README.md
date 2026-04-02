# OpenClaw GPU migration bundle

Contains:

- openclaw-source.bundle
- openclaw-state.tar
- openclaw-config.tar
- service/watchdog metadata and checksums

Recommended restore:

1. Copy this bundle to target host.
2. Extract.
3. Use local script:
   scripts/droplet-migration-sync.sh --target-host <new-host> --bundle <path-to-tar.gz>
4. Validate:
   scripts/droplet-migration-post-sync.sh --target-host <new-host>
