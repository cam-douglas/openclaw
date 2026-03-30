import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentCompactionConfig } from "../../config/types.agent-defaults.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  type MessageCharEstimateCache,
  createMessageCharEstimateCache,
  estimateContextChars,
  estimateMessageCharsCached,
  getToolResultText,
  invalidateMessageCharsCacheEntry,
  isToolResultMessage,
} from "./tool-result-char-estimator.js";

/** Default ratio of context window used as estimated total char budget before preemptive tool-result compaction. */
const DEFAULT_CONTEXT_INPUT_HEADROOM_RATIO = 0.95;
/** Default max share of context window per single tool result (was 0.5). */
const DEFAULT_SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.62;
// High-water mark after tool-result compaction: must be **strictly above** `headroomRatio`
// so non-tool content can exceed the tool budget (e.g. 95% char budget) and still trigger
// full session compaction without equaling the same threshold as the tool budget.
const PREEMPTIVE_OVERFLOW_RATIO = 0.98;

/** Do not replace the last N tool outputs with the placeholder until older tool results are compacted. */
const DEFAULT_PRESERVE_RECENT_TOOL_RESULTS = 4;

export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "[truncated: output exceeded context limit]";
const CONTEXT_LIMIT_TRUNCATION_SUFFIX = `\n${CONTEXT_LIMIT_TRUNCATION_NOTICE}`;

export const PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER =
  "[compacted: tool output removed to free context]";

export const PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE =
  "Preemptive context overflow: estimated context size exceeds safe threshold during tool loop";

export type ToolResultContextGuardConfig = {
  preserveRecentToolResults: number;
  headroomRatio: number;
  singleResultShare: number;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function resolveToolResultContextGuardConfig(
  cfg: { agents?: { defaults?: { compaction?: AgentCompactionConfig } } } | undefined,
): ToolResultContextGuardConfig {
  const c = cfg?.agents?.defaults?.compaction;
  return {
    preserveRecentToolResults:
      typeof c?.toolResultPreserveRecent === "number"
        ? clamp(Math.floor(c.toolResultPreserveRecent), 0, 32)
        : DEFAULT_PRESERVE_RECENT_TOOL_RESULTS,
    headroomRatio:
      typeof c?.toolResultContextHeadroomRatio === "number"
        ? clamp(c.toolResultContextHeadroomRatio, 0.5, 0.95)
        : DEFAULT_CONTEXT_INPUT_HEADROOM_RATIO,
    singleResultShare:
      typeof c?.toolResultMaxSingleShare === "number"
        ? clamp(c.toolResultMaxSingleShare, 0.25, 0.9)
        : DEFAULT_SINGLE_TOOL_RESULT_CONTEXT_SHARE,
  };
}

type GuardableTransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgent = object;

type GuardableAgentRecord = {
  transformContext?: GuardableTransformContext;
};

function truncateTextToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars <= 0) {
    return CONTEXT_LIMIT_TRUNCATION_NOTICE;
  }

  const bodyBudget = Math.max(0, maxChars - CONTEXT_LIMIT_TRUNCATION_SUFFIX.length);
  if (bodyBudget <= 0) {
    return CONTEXT_LIMIT_TRUNCATION_NOTICE;
  }

  let cutPoint = bodyBudget;
  const newline = text.lastIndexOf("\n", bodyBudget);
  if (newline > bodyBudget * 0.7) {
    cutPoint = newline;
  }

  return text.slice(0, cutPoint) + CONTEXT_LIMIT_TRUNCATION_SUFFIX;
}

function replaceToolResultText(msg: AgentMessage, text: string): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  const replacementContent =
    typeof content === "string" || content === undefined ? text : [{ type: "text", text }];

  const sourceRecord = msg as unknown as Record<string, unknown>;
  const { details: _details, ...rest } = sourceRecord;
  return {
    ...rest,
    content: replacementContent,
  } as AgentMessage;
}

function truncateToolResultToChars(
  msg: AgentMessage,
  maxChars: number,
  cache: MessageCharEstimateCache,
): AgentMessage {
  if (!isToolResultMessage(msg)) {
    return msg;
  }

  const estimatedChars = estimateMessageCharsCached(msg, cache);
  if (estimatedChars <= maxChars) {
    return msg;
  }

  const rawText = getToolResultText(msg);
  if (!rawText) {
    return replaceToolResultText(msg, CONTEXT_LIMIT_TRUNCATION_NOTICE);
  }

  const truncatedText = truncateTextToBudget(rawText, maxChars);
  return replaceToolResultText(msg, truncatedText);
}

function listToolResultMessageIndices(messages: AgentMessage[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isToolResultMessage(messages[i])) {
      indices.push(i);
    }
  }
  return indices;
}

function compactToolResultsToPlaceholderInOrder(params: {
  messages: AgentMessage[];
  orderedIndices: number[];
  charsNeeded: number;
  cache: MessageCharEstimateCache;
}): number {
  const { messages, orderedIndices, charsNeeded, cache } = params;
  if (charsNeeded <= 0) {
    return 0;
  }

  let reduced = 0;
  for (const i of orderedIndices) {
    const msg = messages[i];
    if (!isToolResultMessage(msg)) {
      continue;
    }

    const before = estimateMessageCharsCached(msg, cache);
    if (before <= PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER.length) {
      continue;
    }

    const compacted = replaceToolResultText(msg, PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    applyMessageMutationInPlace(msg, compacted, cache);
    const after = estimateMessageCharsCached(msg, cache);
    if (after >= before) {
      continue;
    }

    reduced += before - after;
    if (reduced >= charsNeeded) {
      break;
    }
  }

  return reduced;
}

function compactExistingToolResultsInPlace(params: {
  messages: AgentMessage[];
  charsNeeded: number;
  cache: MessageCharEstimateCache;
  preserveRecentToolResults: number;
}): void {
  const { messages, charsNeeded, cache, preserveRecentToolResults } = params;
  if (charsNeeded <= 0) {
    return;
  }

  const toolIndices = listToolResultMessageIndices(messages);
  const protectedSet = new Set(
    preserveRecentToolResults > 0 ? toolIndices.slice(-preserveRecentToolResults) : [],
  );

  const unprotected = toolIndices.filter((i) => !protectedSet.has(i));
  let reduced = compactToolResultsToPlaceholderInOrder({
    messages,
    orderedIndices: unprotected,
    charsNeeded,
    cache,
  });

  if (reduced < charsNeeded && protectedSet.size > 0) {
    const protectedOrdered = toolIndices.filter((i) => protectedSet.has(i));
    compactToolResultsToPlaceholderInOrder({
      messages,
      orderedIndices: protectedOrdered,
      charsNeeded: charsNeeded - reduced,
      cache,
    });
  }
}

function applyMessageMutationInPlace(
  target: AgentMessage,
  source: AgentMessage,
  cache?: MessageCharEstimateCache,
): void {
  if (target === source) {
    return;
  }

  const targetRecord = target as unknown as Record<string, unknown>;
  const sourceRecord = source as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) {
    if (!(key in sourceRecord)) {
      delete targetRecord[key];
    }
  }
  Object.assign(targetRecord, sourceRecord);
  if (cache) {
    invalidateMessageCharsCacheEntry(cache, target);
  }
}

function enforceToolResultContextBudgetInPlace(params: {
  messages: AgentMessage[];
  contextBudgetChars: number;
  maxSingleToolResultChars: number;
  preserveRecentToolResults: number;
}): void {
  const { messages, contextBudgetChars, maxSingleToolResultChars, preserveRecentToolResults } =
    params;
  const estimateCache = createMessageCharEstimateCache();

  // Ensure each tool result has an upper bound before considering total context usage.
  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    const truncated = truncateToolResultToChars(message, maxSingleToolResultChars, estimateCache);
    applyMessageMutationInPlace(message, truncated, estimateCache);
  }

  let currentChars = estimateContextChars(messages, estimateCache);
  if (currentChars <= contextBudgetChars) {
    return;
  }

  // Compact oldest tool outputs first; prefer replacing older outputs before the last N tool results.
  compactExistingToolResultsInPlace({
    messages,
    charsNeeded: currentChars - contextBudgetChars,
    cache: estimateCache,
    preserveRecentToolResults,
  });
}

export function installToolResultContextGuard(params: {
  agent: GuardableAgent;
  contextWindowTokens: number;
  /** When omitted, uses defaults and optional `agents.defaults.compaction` overrides. */
  guardConfig?: ToolResultContextGuardConfig;
}): () => void {
  const g = params.guardConfig ?? resolveToolResultContextGuardConfig(undefined);
  const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const contextBudgetChars = Math.max(
    1_024,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * g.headroomRatio),
  );
  const maxSingleToolResultChars = Math.max(
    1_024,
    Math.floor(contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * g.singleResultShare),
  );
  const preemptiveOverflowChars = Math.max(
    contextBudgetChars,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * PREEMPTIVE_OVERFLOW_RATIO),
  );

  // Agent.transformContext is private in pi-coding-agent, so access it via a
  // narrow runtime view to keep callsites type-safe while preserving behavior.
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;

    const contextMessages = Array.isArray(transformed) ? transformed : messages;
    enforceToolResultContextBudgetInPlace({
      messages: contextMessages,
      contextBudgetChars,
      maxSingleToolResultChars,
      preserveRecentToolResults: g.preserveRecentToolResults,
    });

    // After tool-result compaction, check if context still exceeds the high-water mark.
    // If it does, non-tool-result content dominates and only full LLM-based session
    // compaction can reduce context size. Throwing a context overflow error triggers
    // the existing overflow recovery cascade in run.ts.
    const postEnforcementChars = estimateContextChars(
      contextMessages,
      createMessageCharEstimateCache(),
    );
    if (postEnforcementChars > preemptiveOverflowChars) {
      throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
    }

    return contextMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}
