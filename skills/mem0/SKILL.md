---
name: mem0
description: Use Mem0 CLI to save, search, and manage long-term memory for users and agents.
metadata:
  openclaw:
    requires:
      bins: [mem0]
---

# Mem0 Skill

Use this skill when the user asks to save, retrieve, update, or delete long-term memory.

## Preconditions

- `mem0` CLI is installed.
- `MEM0_API_KEY` is set, or Mem0 CLI has already been initialized.

## Chain aliases (multi-memory lanes)

- Store chain aliases in `~/.openclaw/mem0-user-chains.json`.
- Use this file to map natural-language chain names to Mem0 `user_id` values.
- Default aliases:
  - `system:project:main` -> `system:project:main`
  - `system:project:main:wa` -> `system:project:main:wa`

Example file:

```json
{
  "active": "system:project:main",
  "aliases": {
    "system:project:main": "system:project:main",
    "system:project:main:wa": "system:project:main:wa"
  }
}
```

If the file is missing, create it with the default aliases above.

## Setup and health check

1. Check CLI availability and auth:
   - `mem0 --version`
   - `mem0 status`
2. If auth is missing and `MEM0_API_KEY` exists, initialize:
   - `mem0 init --api-key "$MEM0_API_KEY" --user-id "$MEM0_USER_ID"`
3. Resolve a target chain alias:
   - If the user names a chain, use that alias.
   - Otherwise use `active` from `~/.openclaw/mem0-user-chains.json`.
4. Resolve `TARGET_USER_ID` from the alias map.
5. If no alias resolves, ask the user what chain/user id to use.

## Common operations

- Add memory:
  - `mem0 add "User prefers concise replies." --user-id "$TARGET_USER_ID"`
- Search memory:
  - `mem0 search "response preferences" --user-id "$TARGET_USER_ID" --output json`
- List memory:
  - `mem0 list --user-id "$TARGET_USER_ID" --output json`
- Update memory:
  - `mem0 update <memory-id> "Updated memory text"`
- Delete memory:
  - `mem0 delete <memory-id>`

## Natural-language chain management

When user asks things like:

- "use memory chain X"
- "set chain X to Y"
- "create a memory lane for Z"

Update `~/.openclaw/mem0-user-chains.json`:

- Add/replace alias mapping under `aliases`.
- Set `active` when user asks to switch default chain.
- Confirm the resulting alias and resolved `user_id`.

## Safety rules

- Do not store secrets (API keys, passwords, tokens).
- Confirm before destructive operations (`delete --all`, entity deletes).
- Use `--output json` when results should be parsed programmatically.
