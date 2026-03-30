---
summary: "Context window + compaction: how OpenClaw keeps sessions under model limits"
read_when:
  - You want to understand auto-compaction and /compact
  - You are debugging long sessions hitting context limits
title: "Compaction"
---

# Context Window & Compaction

Every model has a **context window** (max tokens it can see). Long-running chats accumulate messages and tool results; once the window is tight, OpenClaw **compacts** older history to stay within limits.

## What compaction is

Compaction **summarizes older conversation** into a compact summary entry and keeps recent messages intact. The summary is stored in the session history, so future requests use:

- The compaction summary
- Recent messages after the compaction point

Compaction **persists** in the session’s JSONL history.

## Configuration

Use the `agents.defaults.compaction` setting in your `openclaw.json` to configure compaction behavior (mode, target tokens, etc.).
Compaction summarization preserves opaque identifiers by default (`identifierPolicy: "strict"`). You can override this with `identifierPolicy: "off"` or provide custom text with `identifierPolicy: "custom"` and `identifierInstructions`.

You can optionally specify a different model for compaction summarization via `agents.defaults.compaction.model`. This is useful when your primary model is a local or small model and you want compaction summaries produced by a more capable model. The override accepts any `provider/model-id` string:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "model": "openrouter/anthropic/claude-sonnet-4-6"
      }
    }
  }
}
```

This also works with local models, for example a second Ollama model dedicated to summarization or a fine-tuned compaction specialist:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "model": "ollama/llama3.1:8b"
      }
    }
  }
}
```

When unset, compaction uses the agent's primary model.

## Auto-compaction (default on)

When a session nears or exceeds the model’s context window, OpenClaw triggers auto-compaction and may retry the original request using the compacted context.

You’ll see:

- `🧹 Auto-compaction complete` in verbose mode
- `/status` showing `🧹 Compactions: <count>`

Before compaction, OpenClaw can run a **silent memory flush** turn to store
durable notes to disk (a dedicated handover step so important state can be written
before the summarization pass). See [Memory](/concepts/memory) for details and config.

## Manual compaction

Use `/compact` (optionally with instructions) to force a compaction pass:

```
/compact Focus on decisions and open questions
```

## Context window source

Context window is model-specific. OpenClaw uses the model definition from the configured provider catalog to determine limits.

For **Anthropic Claude** models, the API **context window** is **200,000 tokens** for current Sonnet/Opus-class models unless you have enabled a larger context tier (see Anthropic model and pricing documentation). OpenClaw falls back to **200,000** tokens when the catalog entry does not specify `contextWindow`.

**Important:** the per-response **max output tokens** (`maxTokens` on the model) is **not** the context window. OpenClaw must not use output limits when estimating how full the session is; otherwise a typical ~16k output cap would make a healthy session look like **>200%** usage and trigger compaction far too early.

If you set `agents.defaults.contextTokens` in `openclaw.json`, it **caps** the budget when the value is **lower** than the model’s catalog window (it does not raise the limit above the catalog). When unset, OpenClaw applies a **200,000** token cap on large-window models so prompts stay smaller and rate limits (TPM) are less likely to spike.

## Tool-result headroom (default ~78%)

Preemptive **tool-result** compaction (replacing older tool output with placeholders) runs when estimated context exceeds the configured fraction of the resolved window. Tune with `agents.defaults.compaction.toolResultContextHeadroomRatio` (range `0.5`–`0.95`; default **`0.78`**). After tool outputs are compacted, if estimated context still exceeds **~98%** of the resolved window (non-tool content dominates), the run throws into the overflow recovery path so **session** compaction (LLM summary / handover) can run.

## Default compaction tuning (TPM / large windows)

When `agents.defaults.compaction` omits fields, OpenClaw merges **safeguard** mode plus conservative defaults: lower **`maxHistoryShare`** (0.15), **`recentTurnsPreserve`** (8), tighter tool-result settings, and a **`contextTokens`** cap of **200,000** when unset. Override any key in `openclaw.json` if you need deeper history or looser tool retention.

## Compaction vs pruning

- **Compaction**: summarises and **persists** in JSONL.
- **Session pruning**: trims old **tool results** only, **in-memory**, per request.

See [/concepts/session-pruning](/concepts/session-pruning) for pruning details.

## OpenAI server-side compaction

OpenClaw also supports OpenAI Responses server-side compaction hints for
compatible direct OpenAI models. This is separate from local OpenClaw
compaction and can run alongside it.

- Local compaction: OpenClaw summarizes and persists into session JSONL.
- Server-side compaction: OpenAI compacts context on the provider side when
  `store` + `context_management` are enabled.

See [OpenAI provider](/providers/openai) for model params and overrides.

## Custom context engines

Compaction behavior is owned by the active
[context engine](/concepts/context-engine). The legacy engine uses the built-in
summarization described above. Plugin engines (selected via
`plugins.slots.contextEngine`) can implement any compaction strategy — DAG
summaries, vector retrieval, incremental condensation, etc.

When a plugin engine sets `ownsCompaction: true`, OpenClaw delegates all
compaction decisions to the engine and does not run built-in auto-compaction.

When `ownsCompaction` is `false` or unset, OpenClaw may still use Pi's
built-in in-attempt auto-compaction, but the active engine's `compact()` method
still handles `/compact` and overflow recovery. There is no automatic fallback
to the legacy engine's compaction path.

If you are building a non-owning context engine, implement `compact()` by
calling `delegateCompactionToRuntime(...)` from `openclaw/plugin-sdk/core`.

## Tips

- Use `/compact` when sessions feel stale or context is bloated.
- Large tool outputs are already truncated; pruning can further reduce tool-result buildup.
- If you need a fresh slate, `/new` or `/reset` starts a new session id.
