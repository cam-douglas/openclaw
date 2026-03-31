# Migrate OpenClaw to a New GPU Droplet

This runbook covers a staged migration from an existing OpenClaw droplet to a new GPU droplet with:

- bundle build (portable transfer artifact)
- pre-sync inventory and capture
- cutover sync (including full `/root/.openclaw`)
- post-sync verification

The scripts below run from your local checkout and use your `.env` SSH settings.

## Prerequisites

- New droplet is provisioned and reachable via SSH as `root`.
- Old droplet remains reachable during migration.
- Local `.env` has source droplet info:
  - `DROPLET_IP` (or `DROPLET_SSH_HOST`)
  - `SSH_USER` (usually `root`)

## 1) Pre-sync (source snapshot)

Run:

```bash
scripts/droplet-migration-pre-sync.sh
```

Optional:

```bash
scripts/droplet-migration-pre-sync.sh --source-host <old-droplet-ip-or-host>
scripts/droplet-migration-pre-sync.sh --out-dir .droplet/migration/my-run
```

This writes migration artifacts under `.droplet/migration/...` including:

- source repo head/status
- `/root/.openclaw` size + config hash
- gateway + watchdog status
- watchdog unit definitions and recent journal
- tailscale status summary (if present)

## 2) Build portable migration bundle (recommended)

Run:

```bash
scripts/droplet-migration-build-bundle.sh
```

Optional:

```bash
scripts/droplet-migration-build-bundle.sh --source-host <old-droplet-ip-or-host>
scripts/droplet-migration-build-bundle.sh --out-dir transfer
```

Outputs:

- `transfer/openclaw-gpu-migration-<timestamp>.tar.gz`
- `transfer/openclaw-gpu-migration-<timestamp>/` (exploded manifest directory)

Bundle includes:

- OpenClaw git history bundle (`openclaw-source.bundle`)
- full `.openclaw` snapshot (`openclaw-state.tar`)
- runtime/config snapshot (`openclaw-config.tar`)
- service/watchdog metadata, checksums, and `TRANSFER_README.md`

## 3) Sync + cutover to target GPU droplet

Run:

```bash
scripts/droplet-migration-sync.sh --target-host <new-gpu-droplet-ip-or-host>
```

Bundle mode (use your portable tarball):

```bash
scripts/droplet-migration-sync.sh \
  --target-host <new-gpu-droplet-ip-or-host> \
  --bundle transfer/openclaw-gpu-migration-<timestamp>.tar.gz
```

Optional:

```bash
scripts/droplet-migration-sync.sh \
  --target-host <new-gpu-droplet-ip-or-host> \
  --source-host <old-droplet-ip-or-host>
```

What it does (source-sync mode):

1. Verifies SSH to source and target.
2. Prepares target checkout (`/root/openclaw` clone/pull).
3. Pass 1 live copy (source -> target) of:
   - `/root/.openclaw`
   - `/root/.config/openclaw`
   - `/root/.config/systemd/user/openclaw-gateway.service.d`
4. Stops source gateway (unless `KEEP_SOURCE_GATEWAY_RUNNING=1`).
5. Pass 2 final delta copy.
6. On target:
   - `pnpm install`
   - `pnpm build`
   - `npm install -g .`
   - `openclaw gateway install --force`
   - `systemctl --user restart openclaw-gateway.service`
   - `sudo bash scripts/install-droplet-watchdog.sh`

What it does (bundle mode):

1. Uploads the bundle tarball to target (`/root/transfer/`).
2. Extracts and restores:
   - `openclaw-state.tar` -> `/root/.openclaw`
   - `openclaw-config.tar` -> `/root/.config/openclaw` and user service drop-ins
3. Bootstraps `/root/openclaw` from `openclaw-source.bundle` when needed.
4. Runs install/build/restart + watchdog install on target.

## 4) Post-sync validation

Run:

```bash
scripts/droplet-migration-post-sync.sh --target-host <new-gpu-droplet-ip-or-host>
```

Optional source comparison:

```bash
scripts/droplet-migration-post-sync.sh \
  --target-host <new-gpu-droplet-ip-or-host> \
  --source-host <old-droplet-ip-or-host>
```

Checks include:

- target git head/status
- source-vs-target head comparison (when source reachable)
- gateway service active + listener on `:18789`
- watchdog timer active/enabled
- root lingering enabled
- `openclaw.json` and `gateway-secrets.env` presence/hash
- `/root/.openclaw` size presence
- tailscale availability/status (if installed)

## Recommended cutover checklist

After post-sync passes:

1. Update local `.env` target host values (`DROPLET_IP` / `DROPLET_SSH_HOST`).
2. Update firewall rules for the new droplet.
3. Run smoke checks against new droplet:
   - `openclaw --version`
   - `openclaw status`
   - `openclaw devices list --url ws://127.0.0.1:18789`
4. Keep old droplet available for rollback until confidence window passes.

## Rollback

If the new droplet is unhealthy, point your local env/firewall back to the old droplet and restart its gateway:

```bash
ssh root@<old-droplet-ip> 'systemctl --user restart openclaw-gateway.service'
```
