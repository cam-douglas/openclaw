---
summary: "CLI reference for `openclaw tui` (terminal UI connected to the Gateway)"
read_when:
  - You want a terminal UI for the Gateway (remote-friendly)
  - You want to pass url/token/session from scripts
title: "tui"
---

# `openclaw tui`

Open the terminal UI connected to the Gateway.

Related:

- TUI guide: [TUI](/web/tui)

Notes:

- `tui` resolves configured gateway auth SecretRefs for token/password auth when possible (`env`/`file`/`exec` providers).
- When launched from inside a configured agent workspace directory, TUI auto-selects that agent for the session key default (unless `--session` is explicitly `agent:<id>:...`).

## Examples

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
# when run inside an agent workspace, infers that agent automatically
openclaw tui --session bugfix
```

## macOS completion sound

On **macOS**, when a chat run reaches a final state (assistant reply finished), the TUI plays the system sound **Funk** (`Funk.aiff`, often described as “funky” in Sound Effects) locally—same family of settings as `openclaw … droplet` (see [DigitalOcean](/platforms/digitalocean)). Set `OPENCLAW_COMPLETION_SOUND_NAME=funky` to pick that alias, or `OPENCLAW_COMPLETION_SOUND_PATH` for a full path. The remote gateway or droplet does **not** call your Mac; only the **local** TUI process runs `afplay`. Disable with `OPENCLAW_COMPLETION_SOUND=0` or TUI-only with `OPENCLAW_TUI_COMPLETION_SOUND=0`.
