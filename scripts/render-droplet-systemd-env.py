#!/usr/bin/env python3
"""Emit a systemd EnvironmentFile body for the droplet from local .env (exported).

Maps *_DROPLET model keys to canonical provider env names. Optionally includes
other non-local-only vars (same name on droplet).
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone


def opt(name: str) -> str | None:
    v = os.environ.get(name, "").strip()
    return v or None


def emit_line(key: str, value: str) -> None:
    # systemd EnvironmentFile: KEY=value; escape minimal newlines
    if "\n" in value:
        print(f"warning: {key} contains newline; may need manual quoting", file=sys.stderr)
    sys.stdout.write(f"{key}={value}\n")


def main() -> None:
    sys.stdout.write(
        f"# Droplet gateway env — generated {datetime.now(timezone.utc).isoformat()}Z\n"
        "# Do not commit. chmod 600 on the server.\n"
        "# OPENCLAW_AUTH_STORE_READONLY: do not persist provider keys back into agent auth-profiles.\n\n"
    )

    # Prefer env-based provider auth; keep auth store from re-writing secrets under agent dirs.
    emit_line("OPENCLAW_AUTH_STORE_READONLY", "1")

    pairs: list[tuple[str, str | None]] = [
        ("OPENAI_API_KEY", opt("OPENAI_API_KEY_DROPLET")),
        ("ANTHROPIC_API_KEY", opt("ANTHROPIC_API_KEY_DROPLET")),
        ("OPENROUTER_API_KEY", opt("OPENROUTER_API_KEY_DROPLET")),
        ("XAI_API_KEY", opt("GROK_API_KEY_DROPLET")),
        ("GEMINI_API_KEY", opt("GEMINI_API_KEY_DROPLET")),
        ("HF_TOKEN", opt("HUGGINGFACE_API_KEY_DROPLET")),
        ("KIMI_API_KEY", opt("KIMI_API_KEY_DROPLET") or opt("KIMI_API_KEY")),
        ("MOONSHOT_API_KEY", opt("MOONSHOT_API_KEY_DROPLET") or opt("MOONSHOT_API_KEY")),
        ("BASE_RPC_URL", opt("BASE_RPC_URL")),
        ("BINANCE_API_KEY", opt("BINANCE_API_KEY")),
        ("BINANCE_API_SECRET", opt("BINANCE_API_SECRET")),
        ("COINBASE_API_KEY", opt("COINBASE_API_KEY")),
        ("COINBASE_API_SECRET", opt("COINBASE_API_SECRET")),
        ("KRAKEN_API_KEY", opt("KRAKEN_API_KEY")),
        ("KRAKEN_API_SECRET", opt("KRAKEN_API_SECRET")),
        ("X_API_BEARER_TOKEN", opt("X_API_BEARER_TOKEN")),
        ("X_API_CONSUMER_KEY", opt("X_API_CONSUMER_KEY")),
        ("X_API_SECRET_KEY", opt("X_API_SECRET_KEY")),
        ("DISCORD_BOT_TOKEN", opt("DISCORD_BOT_TOKEN")),
        ("DISCORD_GUILD_IDS", opt("DISCORD_GUILD_IDS")),
        ("TELEGRAM_BOT_TOKEN", opt("TELEGRAM_BOT_TOKEN")),
        ("TELEGRAM_CHANNEL_IDS", opt("TELEGRAM_CHANNEL_IDS")),
        ("MESSARI_API_KEY", opt("MESSARI_API_KEY")),
        ("COIN_MARKET_CAP_API_KEY", opt("COIN_MARKET_CAP_API_KEY")),
        ("FREECRYPTOAPI_API_KEY", opt("FREECRYPTOAPI_API_KEY")),
    ]

    for key, val in pairs:
        if val:
            emit_line(key, val)


if __name__ == "__main__":
    main()
