# OpenClaw Droplet Transfer Runbook

This is the end-to-end reference for moving an OpenClaw gateway host from one droplet to another.
It applies to GPU and non-GPU targets.

The process is designed to preserve the full runtime state, including:

- full `/root/.openclaw` content
- gateway secrets under `/root/.config/openclaw`
- gateway user service drop-ins
- watchdog behavior and metadata

## Migration modes

Use one of these modes:

1. **Bundle mode (recommended):** build a portable migration artifact first, then restore to target.
2. **Source-sync mode:** stream directly from source droplet to target droplet.

Bundle mode is better when you want repeatability, auditability, and easy retries.

## Prerequisites

- Source droplet reachable over SSH (`root@source-host`).
- Target droplet reachable over SSH (`root@target-host`).
- Local checkout has `.env` with source host values:
  - `DROPLET_IP` or `DROPLET_SSH_HOST`
  - `SSH_USER` (typically `root`)
- On target droplet, required tooling should be available (`git`, `node`, `pnpm`, `npm`).

## Phase 1: Pre-sync inventory

Capture source state and service metadata before any cutover work:

```bash
scripts/droplet-migration-pre-sync.sh
```

Optional:

```bash
scripts/droplet-migration-pre-sync.sh --source-host <source-host>
scripts/droplet-migration-pre-sync.sh --out-dir .droplet/migration/my-run
```

Artifacts include:

- source repo head and status
- `/root/.openclaw` size and config hash
- gateway and watchdog status
- watchdog unit definitions and recent watchdog journal
- tailscale summary (when installed)

## Phase 2: Build portable bundle (recommended)

Create a transfer bundle from the source droplet:

```bash
scripts/droplet-migration-build-bundle.sh
```

Optional:

```bash
scripts/droplet-migration-build-bundle.sh --source-host <source-host>
scripts/droplet-migration-build-bundle.sh --out-dir transfer
```

Outputs:

- `transfer/openclaw-gpu-migration-<timestamp>.tar.gz`
- `transfer/openclaw-gpu-migration-<timestamp>/`

Bundle contents:

- `openclaw-source.bundle` (git history bundle)
- `openclaw-state.tar` (full `.openclaw`)
- `openclaw-config.tar` (secrets and user service drop-ins)
- service/watchdog metadata files
- `CHECKSUMS.txt`
- `TRANSFER_README.md`

## Phase 3: Sync and restore on target

### Bundle mode

```bash
scripts/droplet-migration-sync.sh \
  --target-host <target-host> \
  --bundle transfer/openclaw-gpu-migration-<timestamp>.tar.gz
```

### Source-sync mode

```bash
scripts/droplet-migration-sync.sh --target-host <target-host>
```

Optional source override:

```bash
scripts/droplet-migration-sync.sh \
  --target-host <target-host> \
  --source-host <source-host>
```

Cutover behavior:

- In source-sync mode, source gateway is stopped before final delta sync unless:
  - `KEEP_SOURCE_GATEWAY_RUNNING=1`
- In both modes, target receives:
  - repo checkout prep and pull
  - `pnpm install`
  - `pnpm build`
  - `npm install -g .`
  - `openclaw gateway install --force`
  - `systemctl --user restart openclaw-gateway.service`
  - `sudo bash scripts/install-droplet-watchdog.sh`

## Phase 4: Post-sync validation

Run:

```bash
scripts/droplet-migration-post-sync.sh --target-host <target-host>
```

Optional source comparison:

```bash
scripts/droplet-migration-post-sync.sh \
  --target-host <target-host> \
  --source-host <source-host>
```

Validation checks include:

- target git head/status
- optional source-vs-target head comparison
- gateway active and listening on `:18789`
- watchdog timer active and enabled
- root lingering enabled (`loginctl show-user root -p Linger`)
- `openclaw.json` and `gateway-secrets.env` presence/hash
- `.openclaw` size presence
- tailscale status (if installed)

## Manual smoke checks after validation

On target:

```bash
openclaw --version
openclaw status
openclaw devices list --url ws://127.0.0.1:18789
systemctl --user is-active openclaw-gateway.service
ss -ltnp | grep 18789
```

If your workflow uses session commands heavily, also run:

```bash
openclaw sessions list
```

## SSH and firewall guidance during transfer

If SSH access is source-IP restricted and you use a mobile hotspot, your public IP can change.
When this happens, update firewall SSH source CIDR to current IP.

Quick local IP check:

```bash
curl -4s https://ifconfig.me
```

If SSH fails with `Connection refused`, verify on host console:

```bash
ss -ltnp | grep ':22'
systemctl status ssh --no-pager || systemctl status sshd --no-pager
```

## Watchdog and service parity checks

Expected watchdog state on target:

```bash
systemctl is-enabled openclaw-gateway-watchdog.timer
systemctl is-active openclaw-gateway-watchdog.timer
loginctl show-user root -p Linger
```

Expected gateway state:

```bash
systemctl --user is-active openclaw-gateway.service
ss -ltnp | grep 18789
```

If `systemctl --user restart` hangs in `deactivating`:

```bash
systemctl --user kill -s SIGKILL openclaw-gateway.service
systemctl --user start openclaw-gateway.service
```

## Bundle-first workflow when another tool already prepared artifacts

If another process already generated:

- `transfer/openclaw-gpu-migration-<timestamp>.tar.gz`
- matching extracted folder with `TRANSFER_README.md`

use this repository workflow directly:

```bash
scripts/droplet-migration-sync.sh \
  --target-host <target-host> \
  --bundle transfer/openclaw-gpu-migration-<timestamp>.tar.gz

scripts/droplet-migration-post-sync.sh --target-host <target-host>
```

## Rollback

If target is unhealthy after cutover:

1. Point your local env/firewall back to source host.
2. Restart source gateway:

```bash
ssh root@<source-host> 'systemctl --user restart openclaw-gateway.service'
```

3. Re-run post-sync checks after fixing target, then attempt cutover again.
