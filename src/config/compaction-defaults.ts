/**
 * Default compaction / context tuning when `agents.defaults.compaction` omits fields.
 * Tuned to reduce per-request token bursts (TPM pressure) on large-context models.
 */
export const DEFAULT_COMPACTION_MAX_HISTORY_SHARE = 0.15;
export const DEFAULT_COMPACTION_RECENT_TURNS_PRESERVE = 8;
export const DEFAULT_TOOL_RESULT_CONTEXT_HEADROOM_RATIO = 0.78;
export const DEFAULT_TOOL_RESULT_PRESERVE_RECENT = 3;
export const DEFAULT_TOOL_RESULT_MAX_SINGLE_SHARE = 0.35;

/**
 * When `agents.defaults.contextTokens` is unset, cap the effective context window at this
 * value when the catalog window is larger (reduces prompt size before auto-compaction).
 */
export const DEFAULT_AGENT_CONTEXT_TOKEN_CAP = 200_000;
