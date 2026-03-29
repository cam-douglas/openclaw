#!/usr/bin/env python3
"""Remove env-backed API key profiles from auth-profiles.json so auth resolves from env only.

Provider keys must live in systemd EnvironmentFile (not under ~/.openclaw/agents/...).
Reads JSON path from argv[1], prints updated JSON to stdout.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

# Profiles supplied via gateway-secrets.env — do not keep inline keys on disk.
STRIP_PROFILE_IDS = frozenset(
    {
        "openai:default",
        "anthropic:default",
        "openrouter:default",
        "xai:default",
    }
)


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: strip-droplet-auth-profiles.py <auth-profiles.json>", file=sys.stderr)
        sys.exit(2)
    path = Path(sys.argv[1])
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    profiles: dict[str, Any] = data.setdefault("profiles", {})

    for pid in STRIP_PROFILE_IDS:
        profiles.pop(pid, None)

    last_good = data.get("lastGood")
    if isinstance(last_good, dict):
        drop_providers: list[str] = []
        for prov, prof_id in list(last_good.items()):
            if prof_id in STRIP_PROFILE_IDS:
                drop_providers.append(str(prov))
        for prov in drop_providers:
            last_good.pop(prov, None)

    usage = data.get("usageStats")
    if isinstance(usage, dict):
        for pid in STRIP_PROFILE_IDS:
            usage.pop(pid, None)

    sys.stdout.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
