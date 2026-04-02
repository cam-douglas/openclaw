---
name: paperclip
description: Manage local and droplet Paperclip setup, health, and runtime.
metadata:
  openclaw:
    requires:
      bins: [npx, pnpm]
---

# Paperclip Skill

Use this skill when the user asks to set up, initialize, run, or troubleshoot Paperclip.

## Install locations

- Local clone: `/Users/camdouglas/paperclip`
- Droplet clone (root-owned): `/root/paperclip`
- Droplet runtime user clone: `/home/paperclip/paperclip`

## Important droplet runtime note

- Embedded Postgres does not run as `root`.
- Run Paperclip on droplet as user `paperclip`:
  - `su - paperclip -c 'bash -lc "cd ~/paperclip && npx paperclipai run"'`

## One-time setup

### Local

1. Clone:
   - `git clone https://github.com/cam-douglas/paperclip.git /Users/camdouglas/paperclip`
2. Install:
   - `cd /Users/camdouglas/paperclip && pnpm install`
3. Initialize:
   - `cd /Users/camdouglas/paperclip && npx paperclipai onboard --yes`

### Droplet

1. Root clone and deps (optional maintenance checkout):
   - `git clone https://github.com/cam-douglas/paperclip.git /root/paperclip`
   - `cd /root/paperclip && pnpm install`
2. Create runtime user checkout:
   - `id -u paperclip >/dev/null 2>&1 || useradd -m -s /bin/bash paperclip`
   - `su - paperclip -c 'bash -lc "[ -d ~/paperclip ] || git clone https://github.com/cam-douglas/paperclip.git ~/paperclip"'`
   - `su - paperclip -c 'bash -lc "cd ~/paperclip && pnpm install"'`
3. Initialize as runtime user:
   - `su - paperclip -c 'bash -lc "cd ~/paperclip && npx paperclipai onboard --yes"'`

## Health checks

### Local

- `cd /Users/camdouglas/paperclip && npx paperclipai doctor`
- `cd /Users/camdouglas/paperclip && timeout 25s npx paperclipai run`

### Droplet

- `su - paperclip -c 'bash -lc "cd ~/paperclip && npx paperclipai doctor"'`
- `su - paperclip -c 'bash -lc "cd ~/paperclip && timeout 25s npx paperclipai run"'`

## Typical runtime commands

- Start:
  - `npx paperclipai run`
- Reconfigure:
  - `npx paperclipai configure`
- Diagnose:
  - `npx paperclipai doctor`

## Completion criteria

- `onboard --yes` completed.
- `doctor` passes.
- `run` reaches `Server listening on 127.0.0.1:3100`.
