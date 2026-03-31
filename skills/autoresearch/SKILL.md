---
name: autoresearch
description: Work with the local autoresearch repository for autonomous LLM-training experiments. Use when asked to set up, run, modify, or extend https://github.com/cam-douglas/autoresearch, especially for OpenClaw integration, experiment orchestration, and repo initialization tasks.
---

# Autoresearch Skill

## Local repo location

- Use the cloned repo at: `/Users/camdouglas/.openclaw/workspace/skills/autoresearch`

## Core workflow

1. Read `README.md` and `program.md` first.
2. Keep `prepare.py` stable unless explicitly asked; make iterative changes in `train.py` and `program.md`.
3. For setup, prefer:
   - `uv sync`
   - `uv run prepare.py`
   - `uv run train.py`
4. If `uv` is missing, stop and ask the user to install it (or approve installation) before continuing.
5. Before any long training run, confirm hardware assumptions (single NVIDIA GPU) and expected runtime (~5 minutes per experiment).

## OpenClaw integration notes

- Keep orchestration logic in separate scripts/files (do not bloat core training files).
- Store run logs/results in project-local artifacts and summarize key outcomes in memory files when requested.
- Prefer explicit, reversible config changes for automation.

## Safety

- Do not start long-running training loops without user confirmation.
- Do not install system packages without explicit approval.
