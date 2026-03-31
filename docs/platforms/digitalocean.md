---
summary: "OpenClaw on DigitalOcean (simple paid VPS option)"
read_when:
  - Setting up OpenClaw on DigitalOcean
  - Looking for cheap VPS hosting for OpenClaw
title: "DigitalOcean (Platform)"
---

# OpenClaw on DigitalOcean

## Goal

Run a persistent OpenClaw Gateway on DigitalOcean for **$6/month** (or $4/mo with reserved pricing).

If you want a $0/month option and don’t mind ARM + provider-specific setup, see the [Oracle Cloud guide](/platforms/oracle).

## Cost Comparison (2026)

| Provider     | Plan            | Specs                  | Price/mo    | Notes                                 |
| ------------ | --------------- | ---------------------- | ----------- | ------------------------------------- |
| Oracle Cloud | Always Free ARM | up to 4 OCPU, 24GB RAM | $0          | ARM, limited capacity / signup quirks |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | €3.79 (~$4) | Cheapest paid option                  |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6          | Easy UI, good docs                    |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6          | Many locations                        |
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5          | Now part of Akamai                    |

**Picking a provider:**

- DigitalOcean: simplest UX + predictable setup (this guide)
- Hetzner: good price/perf (see [Hetzner guide](/install/hetzner))
- Oracle Cloud: can be $0/month, but is more finicky and ARM-only (see [Oracle guide](/platforms/oracle))

---

## Prerequisites

- DigitalOcean account ([signup with $200 free credit](https://m.do.co/c/signup))
- SSH key pair (or willingness to use password auth)
- ~20 minutes

## 1) Create a Droplet

<Warning>
Use a clean base image (Ubuntu 24.04 LTS). Avoid third-party Marketplace 1-click images unless you have reviewed their startup scripts and firewall defaults.
</Warning>

1. Log into [DigitalOcean](https://cloud.digitalocean.com/)
2. Click **Create → Droplets**
3. Choose:
   - **Region:** Closest to you (or your users)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/mo** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH key (recommended) or password
4. Click **Create Droplet**
5. Note the IP address

## 2) Connect via SSH

From a **repo checkout** on your Mac, use the helper (it **always** runs **`sudo -v`** once before `ssh`, then `sudo -k` when the session ends):

```bash
./scripts/droplet-ssh.sh
```

For a **one-off** connection without the helper, use the same pattern (do not skip the gate):

```bash
sudo -n -v 2>/dev/null || sudo -v
ssh root@YOUR_DROPLET_IP
sudo -k
```

### SSH over Tailscale (recommended)

The droplet still has a **public** IPv4 from the provider. To **stop using that address for SSH**:

1. Install and log in to **Tailscale** on the droplet and your Mac (`tailscale up`).
2. Note the droplet **tailnet** address (`tailscale ip -4` on the server, usually `100.x`).
3. Set **`DROPLET_SSH_HOST`** to that address (or a MagicDNS name) in your Mac `.env`, **or** keep using `DROPLET_IP` until you are ready to switch.
4. **Before** blocking port 22 on the public interface, confirm `ssh root@<100.x>` works from your Mac.

**Restrict SSH to Tailscale only (UFW on the droplet)**

Review `scripts/droplet-ufw-ssh-tailscale-only.sh` (it resets UFW defaults). Run only when you have **console access** (DigitalOcean web console or another path) if something goes wrong:

```bash
sudo ./scripts/droplet-ufw-ssh-tailscale-only.sh
```

This allows inbound **TCP 22 only on `tailscale0`**. SSH to the **public** IP on port 22 should then fail; use the tailnet address instead.

Also consider a **cloud firewall** (DigitalOcean Firewalls) that allows SSH only from Tailscale exit nodes or your home IP, as a belt-and-suspenders layer.

**Passphrases and sudo**

- **SSH key passphrase**: enforced on the **client** (your Mac). OpenSSH cannot require “unlock this key every time” from the server. Use **`ssh-agent`** for convenience, or set **`OPENCLAW_DROPLET_SSH_IDENTITY_AGENT_NONE=1`** and **`OPENCLAW_DROPLET_SSH_IDENTITY`** so each connection can prompt for the key passphrase (see `.env.example`).
- **Server `sudo` password**: unrelated to SSH; configure in `/etc/sudoers` on the droplet. The repo’s **`sudo -v` before SSH** is a **local Mac** gate so droplet helpers are not run without unlocking your Mac’s sudo first.

### Local `.env` (optional, repo checkout on your Mac)

The repo root is gitignored for `.env`. Copy `.env.example` to `.env` and set `DROPLET_IP` (or `DROPLET_SSH_HOST` for tailnet-only SSH), SSH user, and any API keys you use locally. Use `./scripts/droplet-ssh.sh` or `./scripts/droplet-tunnel.sh` instead of raw `ssh` so access stays sudo-gated.

Prefer **SSH keys** over storing a server password in `.env`.

### `openclaw … droplet` (run CLI on the VPS)

With `DROPLET_IP` (and optional `SSH_USER`) in your environment, you can append **`droplet`** to almost any CLI invocation to run it **on the droplet over SSH** (after the local sudo gate, with `sudo -k` after):

```bash
openclaw status droplet
openclaw doctor droplet
openclaw onboard droplet
openclaw tui droplet
openclaw models status --probe droplet
```

Use a recent `openclaw` on your Mac and on the VPS so you get the quiet `bash --noprofile --norc` wrapper and config warning dedupe; older global installs still run a login shell over SSH and spam logs.

This spawns `ssh <user>@<DROPLET_IP> 'env -i … /bin/bash --noprofile --norc -c …'` so the remote skips login/rc noise (for example broken Homebrew lines in `/root/.profile`) and does not inherit a noisy environment from sshd while the inner script still exports a sane `PATH` before `exec` (see `src/cli/droplet-remote.ts`). It also forwards **`OPENCLAW_GATEWAY_TOKEN`** and **`OPENCLAW_GATEWAY_PASSWORD`** from your local environment (for example `~/.openclaw/.env` after `loadCliDotEnv`) into that remote session so **`openclaw tui droplet`** can authenticate to the gateway on the VPS — otherwise the TUI may show HTTP 401 because non-login SSH does not load profile-based env and the gateway user unit may be the only place those vars exist server-side. A bare remote `openclaw` often fails with `command not found` when the CLI lives under nvm/fnm or `/usr/local/bin`. Set `OPENCLAW_REMOTE_BIN` to an absolute path if needed. Confirm the remote install with **`./scripts/verify-droplet-openclaw.sh`**. Not supported on Windows without OpenSSH/`ssh` in `PATH` (use WSL or scripts above).

On **macOS**, when the SSH session ends successfully (the local `ssh` process exits normally), the CLI plays the system sound **Funk** (`Funk.aiff`; you can refer to it as **funky** via `OPENCLAW_COMPLETION_SOUND_NAME=funky`) so you get an audible completion cue for short or long runs. The same **local** chime runs when **`openclaw tui`** (connected to any gateway, including the droplet) finishes a chat run—only your Mac plays audio, never the VPS. Disable globally with **`OPENCLAW_COMPLETION_SOUND=0`** or **`OPENCLAW_DROPLET_COMPLETION_SOUND=0`**, TUI-only with **`OPENCLAW_TUI_COMPLETION_SOUND=0`**, override the file with **`OPENCLAW_COMPLETION_SOUND_PATH`** / **`OPENCLAW_DROPLET_COMPLETION_SOUND_PATH`**, or play only on success with **`OPENCLAW_DROPLET_COMPLETION_SOUND_SUCCESS_ONLY=1`** (see `.env.example`).

When chat exec approvals are enabled, use batch approvals for multi-step flows:

```bash
/approve-batch start
/approve-batch review
/approve-batch run
# or /approve-batch deny
```

`/approve-batch` is different from `/approve <id> allow-always`.

### Privileged changes and sudo cache

For work that requires `sudo` on the droplet, avoid leaving a reusable sudo grace window in the shell. After privileged OpenClaw or system commands, run `sudo -k` to clear the cached credential, or use the helper from a repo checkout:

```bash
./scripts/sudo-revoke-after.sh -- openclaw gateway restart
```

To require a password on **every** `sudo` invocation (no 15-minute cache), install a sudoers drop-in with `visudo` (example; adjust user/group to match your setup):

```text
# In a sudoers drop-in (use visudo):
Defaults timestamp_timeout=0
```

## Security model, limits, and mitigations

This section maps **known limits** of the droplet workflow to **concrete mitigations** you can apply today.

### The repo cannot block raw SSH

**Limit:** Nothing in git can stop you (or a script) from running `ssh user@ip` directly. Helper scripts are **opt-in policy** on your Mac.

**Mitigation:**

- Prefer **`./scripts/droplet-ssh.sh`**, **`./scripts/droplet-tunnel.sh`**, **`./scripts/sync-droplet-secrets.sh`**, **`./scripts/verify-droplet-openclaw.sh`**, and **`./scripts/droplet-record-host-key.sh`** (pinned host keys) so access stays **sudo-gated** (`sudo -v` before SSH/SCP, `sudo -k` after).
- If you use raw `ssh`/`scp`, still follow the same **sudo gate → connect → sudo -k** pattern from [Connect via SSH](#2-connect-via-ssh).

### Local `sudo -v` is a friction gate, not server authentication

**Limit:** Prompting for your Mac password before SSH does **not** verify the droplet identity or stop a malicious host on first connect.

**Mitigation:**

- Use **SSH keys** (disable password login on the server when keys work).
- Rely on **host key verification** (`known_hosts`). Helpers use `StrictHostKeyChecking=accept-new` on first connect; confirm the fingerprint when prompted.
- **Firewall the droplet** (for example UFW: allow SSH and only what you need).
- **Harden `sshd`** (Ubuntu: `/etc/ssh/sshd_config.d/`): e.g. `PasswordAuthentication no` when using keys; keep the daemon updated via `apt`.

### One Mac password prompt per droplet helper

Helpers share **`scripts/droplet-sudo-gate.sh`**: they run **`sudo -v` once** (refreshes the sudo timestamp; when a credential is already cached, this usually does **not** prompt). Trailing **`openclaw … droplet`** does the same before SSH. If you enable **`OPENCLAW_REQUIRE_LOCAL_SUDO`** on macOS, the CLI does **not** run that policy’s separate **`sudo -v` / `sudo -k` pair** for `… droplet` invocations, so you get **one** prompt from the droplet helper instead of two in a row. **`sync-droplet-secrets.sh`** runs the sudo gate **after** your `.env` loads and SSH client options are valid so a bad config exits before any prompt. For trusted automation only, set **`OPENCLAW_DROPLET_SUDO_GATE=0`** to skip the gate and the exit **`sudo -k`**.

If your **`sudoers`** uses **`timestamp_timeout=0`**, every **`sudo`** will prompt; that is separate from OpenClaw. A prior **`sudo -n` + `sudo -v` chain was removed** because some macOS/PAM setups prompted twice.

### Secrets on disk and in the gateway process

**Limit:** Files such as `/root/.config/openclaw/gateway-secrets.env` are still files on disk. Moving keys to env for systemd does not remove them from **process memory** while the gateway runs.

**Mitigation:**

- Use **`./scripts/sync-droplet-secrets.sh`** after changing provider keys so the droplet file layout and **`OPENCLAW_AUTH_STORE_READONLY=1`** (installed by that script) stay aligned with the intent: avoid persisting keys back under agent paths.
- Never commit **`.env`**; rotate keys if leaked.
- Understand the tradeoff: the gateway **must** hold credentials in memory to call APIs; the sync layout reduces duplicate **on-disk** copies next to agent workspaces.

### Mac vs droplet configuration drift

**Limit:** Your laptop checkout and the VPS can diverge (OpenClaw version, config, keys).

**Mitigation:**

- Run **`openclaw doctor`** on the Mac and **`openclaw doctor droplet`** (or SSH in and run `openclaw doctor`) after upgrades or odd behavior.
- Re-run **`./scripts/sync-droplet-secrets.sh`** whenever local provider env changes should apply on the server.
- Align versions when debugging: compare `openclaw --version` locally vs **`./scripts/verify-droplet-openclaw.sh`** on the droplet.

### Remote CLI (`openclaw … droplet`) and the remote binary

**Limit:** Trailing **`droplet`** runs whatever **`openclaw`** resolves to **on the server** (PATH and install method).

**Mitigation:**

- Run **`./scripts/verify-droplet-openclaw.sh`** to print `command -v` and **`openclaw --version`** on the droplet.
- If the binary name or path differs, set **`OPENCLAW_REMOTE_BIN`** locally (same as for `openclaw … droplet`; see `src/cli/droplet-remote.ts`).

### Further SSH hardening (optional)

Helpers and **`openclaw … droplet`** share the same client defaults where possible:

- **`IdentitiesOnly=yes`** — avoid sending every key in your agent to the server.
- **Keepalives** — `ServerAliveInterval` / `ServerAliveCountMax` so dead tunnels or NATs fail faster.
- **First connect** — default **`StrictHostKeyChecking=accept-new`** (OpenSSH stores the host key after prompt). For **stricter** verification, pin keys:

1. Run **`./scripts/droplet-record-host-key.sh`** once (or after the droplet is recreated). This writes **`$REPO_ROOT/.droplet/known_hosts`** (gitignored).
2. With that file present, scripts **auto-use** it via **`UserKnownHostsFile`** and **`GlobalKnownHostsFile=/dev/null`** so only those keys are trusted for this connection.
3. Or set **`OPENCLAW_DROPLET_KNOWN_HOSTS`** to an explicit path, or **`OPENCLAW_DROPLET_SSH_STRICT=1`** to require a known host key in the default **`~/.ssh/known_hosts`** (no `accept-new`).

**`droplet-tunnel.sh`** also sets **`ExitOnForwardFailure=yes`** so a bad forward fails immediately.

Implementation: **`scripts/droplet-ssh-common.sh`**, **`src/cli/droplet-ssh-options.ts`**.

## 3) Install OpenClaw

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4) Run Onboarding

```bash
openclaw onboard --install-daemon
```

The wizard will walk you through:

- Model auth (API keys or OAuth)
- Channel setup (Telegram, WhatsApp, Discord, etc.)
- Gateway token (auto-generated)
- Daemon installation (systemd)

## 5) Verify the Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

### Sync API keys from your Mac (repo checkout)

If you keep provider keys in a **gitignored** repo-root `.env` (see `.env.example`), you can push them to the droplet **over SSH** (encrypted in transit) and restart the gateway user service. The script requires **local sudo** before SSH/SCP (same policy as `droplet-ssh.sh`):

```bash
./scripts/sync-droplet-secrets.sh
```

The script writes `/root/.config/openclaw/gateway-secrets.env` (mode `600`, directory mode `700`) for systemd—**outside** `~/.openclaw/agents/...` so provider secrets are not stored beside workspace/agent files. It **removes** env-backed API key entries from `auth-profiles.json` so providers resolve from the gateway environment only, sets `OPENCLAW_AUTH_STORE_READONLY=1` to avoid persisting keys back under the agent directory, installs a user-unit drop-in, and runs `systemctl --user restart openclaw-gateway.service`. Use `./scripts/sync-droplet-secrets.sh --dry-run` to preview sizes only.

Prefer **SSH keys** over storing a password; never commit `.env`.

#### Where environment variables come from (operators and workspace agents)

- **OpenClaw gateway (daemon):** Your **local** gitignored repo-root `.env` (or `OPENCLAW_ENV_FILE` when running `./scripts/sync-droplet-secrets.sh`) is what you edit to rotate keys that the **gateway** should see. The systemd user unit loads `EnvironmentFile=-/root/.config/openclaw/gateway-secrets.env`, **generated** from that local `.env` by `scripts/render-droplet-systemd-env.py` during sync. Workflow: edit local `.env` → `./scripts/sync-droplet-secrets.sh` → gateway restarts. Optional provider keys such as `MOONSHOT_API_KEY` / `KIMI_API_KEY` (or `*_DROPLET`) can be included in that local `.env` so the render step maps them into `gateway-secrets.env` when you want the **gateway** to use them.
- **Workspace projects on the droplet (for example Moonshot Engine):** Keep **one** Moonshot Engine tree under **`projects/moonshot-engine`** inside the OpenClaw workspace (not a second copy directly under the workspace root). Its **project root** `.env` sits next to that project’s `AGENTS.md` (gitignored). With the default workspace for user `root` (`~/.openclaw/workspace`), the Moonshot Engine env file is **`/root/.openclaw/workspace/projects/moonshot-engine/.env`**. Agents working **inside that project** should read keys from that path (or `<configured-workspace>/projects/moonshot-engine/.env` if `agents.defaults.workspace` is overridden), not from `~/.config/...` first and not from `~/.openclaw/.env` on the droplet. The sync script **removes** `/root/.openclaw/.env` on purpose; that is not the canonical file for a named project’s app keys.
- **Do not conflate the two:** `gateway-secrets.env` feeds the **gateway process**. A project’s `.env` feeds **that project’s** scripts and tooling when run from its workspace root.

#### Homebrew (Linuxbrew) on the droplet

The upstream installer **refuses to run as `root`**. Install as the dedicated `linuxbrew` user (prefix `/home/linuxbrew/.linuxbrew`). To run `brew` from an SSH session:

```bash
sudo -u linuxbrew -H bash -lc 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)" && brew --version'
```

Use the same pattern to install formulae (for example plugin or skill dependencies). Do not add `eval "$(…brew…)"` lines to `/root/.profile` that point at paths that do not exist yet; that produces noisy login errors.

Limits: the gateway process still receives keys in `process.env` (required for API calls). This layout prevents **on-disk** copies under typical agent paths; it does not sandbox the Node process memory from privileged code paths.

## 6) Access the Dashboard

The gateway binds to loopback by default. To access the Control UI:

**Option A: SSH Tunnel (recommended)**

From a repo checkout (sudo-gated):

```bash
./scripts/droplet-tunnel.sh
```

Then open `http://localhost:18789`.

Without the script, use `sudo -v`, then `ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP`, then `sudo -k` when done.

**Option B: Tailscale Serve (HTTPS, loopback-only)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Open: `https://<magicdns>/`

Notes:

- Serve keeps the Gateway loopback-only and authenticates Control UI/WebSocket traffic via Tailscale identity headers (tokenless auth assumes trusted gateway host; HTTP APIs still require token/password).
- To require token/password instead, set `gateway.auth.allowTailscale: false` or use `gateway.auth.mode: "password"`.

**Option C: Tailnet bind (no Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Open: `http://<tailscale-ip>:18789` (token required).

If you still use an SSH tunnel or **`openclaw tui droplet`** on macOS, the forward must target that same address (not loopback). Set **`OPENCLAW_DROPLET_SSH_FORWARD_HOST`** to the droplet Tailscale IPv4 in your repo **`.env`** (and use **`./scripts/droplet-tunnel.sh`**, which reads it). Default is **`127.0.0.1`**.

## 7) Connect Your Channels

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

See [Channels](/channels) for other providers.

---

## Optimizations for 1GB RAM

The $6 droplet only has 1GB RAM. To keep things running smoothly:

### Add swap (recommended)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Use a lighter model

If you're hitting OOMs, consider:

- Using API-based models (Claude, GPT) instead of local models
- Setting `agents.defaults.model.primary` to a smaller model

### Monitor memory

```bash
free -h
htop
```

### Upgrade instance size

If the gateway or agents still feel sluggish, hit OOMs, or spend a lot of time in swap after [adding swap](#add-swap-recommended) and using a lighter model, **moving to a larger droplet** (more RAM and vCPU) usually helps. A 1GB instance is tight for Node, `pnpm build`, and concurrent tool-heavy sessions; 2GB or more reduces swapping and improves throughput for typical OpenClaw workloads.

---

## Persistence

All state lives in:

- `~/.openclaw/` — config, credentials, session data
- `~/.openclaw/workspace/` — workspace (SOUL.md, memory, etc.)

These survive reboots. Back them up periodically:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Gateway watchdog (optional)

Your systemd user unit should already restart the gateway process when it crashes (`Restart=…`). A **watchdog** adds a second layer: if the unit is **active** but **nothing is listening**, if HTTP **`/healthz`** or **`/readyz`** fail, or if **`tailscaled` stopped**, the script can recover automatically.

Use the repo files (review before install):

- `scripts/droplet-gateway-watchdog.sh`
- `scripts/droplet-gateway-watchdog.service` + `scripts/droplet-gateway-watchdog.timer` (preferred schedule)
- Legacy: root **cron** every 2 minutes (still documented below if you prefer cron)

**Security model**

- No secrets; only **`curl` to loopback** and local checks (**`ss`** for the gateway port). It does **not** run `openclaw` or call any **LLM provider**.
- Restarts are **rate-limited** (see env vars in the script header) so a bad config cannot restart in a tight loop forever.
- Controls **`tailscaled`** with **`systemctl`** (same as normal Linux service management). If the node is **not logged in** to Tailscale (`tailscale up` never completed), the script logs a warning; it cannot complete interactive login for you.

**Tailscale and “hiding” the droplet IP**

- Tailscale adds a **tailnet address** (`100.x`) for clients on your tailnet. It does **not** remove the provider’s public IP from existing; you still choose whether SSH uses the public IP or Tailscale.
- When **`gateway.tailscale.mode`** is **`serve`** (or funnel), OpenClaw coordinates **`tailscale serve`** while the gateway binds **loopback**; the watchdog keeps **`tailscaled`** up so that path can work again after failures.

**Install on the droplet (systemd timer — recommended)**

```bash
sudo install -m 750 /root/openclaw/scripts/droplet-gateway-watchdog.sh /usr/local/sbin/openclaw-gateway-watchdog.sh
sudo mkdir -p /var/lib/openclaw
sudo chmod 700 /var/lib/openclaw
sudo install -m 644 /root/openclaw/scripts/droplet-gateway-watchdog.service /etc/systemd/system/openclaw-gateway-watchdog.service
sudo install -m 644 /root/openclaw/scripts/droplet-gateway-watchdog.timer /etc/systemd/system/openclaw-gateway-watchdog.timer
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway-watchdog.timer
```

After verifying logs (`journalctl -u openclaw-gateway-watchdog.service -n 50`), you can remove legacy cron if present: `sudo rm -f /etc/cron.d/openclaw-gateway-watchdog`.

**Alternative: root cron (every 2 minutes)**

```bash
sudo install -m 750 /root/openclaw/scripts/droplet-gateway-watchdog.sh /usr/local/sbin/openclaw-gateway-watchdog.sh
sudo mkdir -p /var/lib/openclaw
sudo chmod 700 /var/lib/openclaw
echo '*/2 * * * * root /usr/local/sbin/openclaw-gateway-watchdog.sh' | sudo tee /etc/cron.d/openclaw-gateway-watchdog
```

Optional tuning via environment: see comments in `scripts/droplet-gateway-watchdog.sh` for `OPENCLAW_WATCHDOG_*`, `OPENCLAW_GATEWAY_*`, and `OPENCLAW_TAILSCALED_UNIT`.

---

## Oracle Cloud Free Alternative

Oracle Cloud offers **Always Free** ARM instances that are significantly more powerful than any paid option here — for $0/month.

| What you get      | Specs                  |
| ----------------- | ---------------------- |
| **4 OCPUs**       | ARM Ampere A1          |
| **24GB RAM**      | More than enough       |
| **200GB storage** | Block volume           |
| **Forever free**  | No credit card charges |

**Caveats:**

- Signup can be finicky (retry if it fails)
- ARM architecture — most things work, but some binaries need ARM builds

For the full setup guide, see [Oracle Cloud](/platforms/oracle). For signup tips and troubleshooting the enrollment process, see this [community guide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Troubleshooting

### Gateway will not start

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Port already in use

```bash
lsof -i :18789
kill <PID>
```

### Out of memory

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## See Also

- [Hetzner guide](/install/hetzner) — cheaper, more powerful
- [Docker install](/install/docker) — containerized setup
- [Tailscale](/gateway/tailscale) — secure remote access
- [Configuration](/gateway/configuration) — full config reference
