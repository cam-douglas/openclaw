import { callGateway } from "../../gateway/call.js";
import { ErrorCodes } from "../../gateway/protocol/index.js";
import { logVerbose } from "../../globals.js";
import type { ExecApprovalDecision } from "../../plugin-sdk/approval-runtime.js";
import {
  isDiscordExecApprovalApprover,
  isDiscordExecApprovalClientEnabled,
} from "../../plugin-sdk/discord-surface.js";
import {
  isTelegramExecApprovalAuthorizedSender,
  isTelegramExecApprovalApprover,
} from "../../plugin-sdk/telegram-runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { requireGatewayClientScopeForInternalChannel } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND_REGEX = /^\/approve(?:\s|$)/i;
const FOREIGN_COMMAND_MENTION_REGEX = /^\/approve@([^\s]+)(?:\s|$)/i;
const APPROVE_BATCH_COMMAND_REGEX = /^\/approve-batch(?:\s|$)/i;
const APPROVE_BATCH_FOREIGN_COMMAND_MENTION_REGEX = /^\/approve-batch@([^\s]+)(?:\s|$)/i;

const DECISION_ALIASES: Record<string, "allow-once" | "allow-always" | "deny"> = {
  allow: "allow-once",
  once: "allow-once",
  "allow-once": "allow-once",
  allowonce: "allow-once",
  always: "allow-always",
  "allow-always": "allow-always",
  allowalways: "allow-always",
  deny: "deny",
  reject: "deny",
  block: "deny",
};

type ParsedApproveCommand =
  | { ok: true; id: string; decision: "allow-once" | "allow-always" | "deny" }
  | { ok: false; error: string };

type ParsedApproveBatchCommand =
  | { ok: true; action: "start" | "review" | "run" | "deny" }
  | { ok: false; error: string };

function parseApproveQuickDecision(raw: string): ExecApprovalDecision | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("/")) {
    return null;
  }
  if (trimmed === "yes" || trimmed === "y") {
    return "allow-once";
  }
  if (trimmed === "no" || trimmed === "n") {
    return "deny";
  }
  return null;
}

function parseApproveCommand(raw: string): ParsedApproveCommand | null {
  const trimmed = raw.trim();
  if (FOREIGN_COMMAND_MENTION_REGEX.test(trimmed)) {
    return { ok: false, error: "❌ This /approve command targets a different Telegram bot." };
  }
  const commandMatch = trimmed.match(COMMAND_REGEX);
  if (!commandMatch) {
    return null;
  }
  const rest = trimmed.slice(commandMatch[0].length).trim();
  if (!rest) {
    return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
  }

  const first = tokens[0].toLowerCase();
  const second = tokens[1].toLowerCase();

  if (DECISION_ALIASES[first]) {
    return {
      ok: true,
      decision: DECISION_ALIASES[first],
      id: tokens.slice(1).join(" ").trim(),
    };
  }
  if (DECISION_ALIASES[second]) {
    return {
      ok: true,
      decision: DECISION_ALIASES[second],
      id: tokens[0],
    };
  }
  return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
}

function parseApproveBatchCommand(raw: string): ParsedApproveBatchCommand | null {
  const trimmed = raw.trim();
  if (APPROVE_BATCH_FOREIGN_COMMAND_MENTION_REGEX.test(trimmed)) {
    return { ok: false, error: "❌ This /approve-batch command targets a different Telegram bot." };
  }
  const commandMatch = trimmed.match(APPROVE_BATCH_COMMAND_REGEX);
  if (!commandMatch) {
    return null;
  }
  const rest = trimmed.slice(commandMatch[0].length).trim();
  if (!rest) {
    return { ok: false, error: "Usage: /approve-batch start|review|run|deny" };
  }
  const action = rest.split(/\s+/).filter(Boolean)[0]?.toLowerCase();
  if (action === "start" || action === "review" || action === "run" || action === "deny") {
    return { ok: true, action };
  }
  return { ok: false, error: "Usage: /approve-batch start|review|run|deny" };
}

function buildResolvedByLabel(params: Parameters<CommandHandler>[0]): string {
  const channel = params.command.channel;
  const sender = params.command.senderId ?? "unknown";
  return `${channel}:${sender}`;
}

function readErrorCode(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readApprovalNotFoundDetailsReason(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason : null;
}

function isApprovalNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode = readErrorCode((err as { gatewayCode?: unknown }).gatewayCode);
  if (gatewayCode === ErrorCodes.APPROVAL_NOT_FOUND) {
    return true;
  }

  const detailsReason = readApprovalNotFoundDetailsReason((err as { details?: unknown }).details);
  if (
    gatewayCode === ErrorCodes.INVALID_REQUEST &&
    detailsReason === ErrorCodes.APPROVAL_NOT_FOUND
  ) {
    return true;
  }

  // Legacy server/client combinations may only include the message text.
  return /unknown or expired approval id/i.test(err.message);
}

export const handleApproveCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const parsed = parseApproveCommand(normalized);
  if (!parsed) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }
  const isPluginId = parsed.id.startsWith("plugin:");
  let discordExecApprovalDeniedReply: { shouldContinue: false; reply: { text: string } } | null =
    null;
  let isTelegramExplicitApprover = false;

  if (params.command.channel === "telegram") {
    const telegramApproverContext = {
      cfg: params.cfg,
      accountId: params.ctx.AccountId,
      senderId: params.command.senderId,
    };
    isTelegramExplicitApprover = isTelegramExecApprovalApprover(telegramApproverContext);

    if (!isPluginId && !isTelegramExecApprovalAuthorizedSender(telegramApproverContext)) {
      return {
        shouldContinue: false,
        reply: { text: "❌ You are not authorized to approve exec requests on Telegram." },
      };
    }

    if (isPluginId && !isTelegramExplicitApprover) {
      return {
        shouldContinue: false,
        reply: { text: "❌ You are not authorized to approve plugin requests on Telegram." },
      };
    }
  }

  if (params.command.channel === "discord" && !isPluginId) {
    const discordApproverContext = {
      cfg: params.cfg,
      accountId: params.ctx.AccountId,
      senderId: params.command.senderId,
    };
    if (!isDiscordExecApprovalClientEnabled(discordApproverContext)) {
      discordExecApprovalDeniedReply = {
        shouldContinue: false,
        reply: { text: "❌ Discord exec approvals are not enabled for this bot account." },
      };
    }
    if (!discordExecApprovalDeniedReply && !isDiscordExecApprovalApprover(discordApproverContext)) {
      discordExecApprovalDeniedReply = {
        shouldContinue: false,
        reply: { text: "❌ You are not authorized to approve exec requests on Discord." },
      };
    }
  }

  // Keep plugin-ID routing independent from exec approval client enablement so
  // forwarded plugin approvals remain resolvable, but still require explicit
  // Discord approver membership for security parity.
  if (
    params.command.channel === "discord" &&
    isPluginId &&
    !isDiscordExecApprovalApprover({
      cfg: params.cfg,
      accountId: params.ctx.AccountId,
      senderId: params.command.senderId,
    })
  ) {
    return {
      shouldContinue: false,
      reply: { text: "❌ You are not authorized to approve plugin requests on Discord." },
    };
  }

  const missingScope = requireGatewayClientScopeForInternalChannel(params, {
    label: "/approve",
    allowedScopes: ["operator.approvals", "operator.admin"],
    missingText: "❌ /approve requires operator.approvals for gateway clients.",
  });
  if (missingScope) {
    return missingScope;
  }

  const resolvedBy = buildResolvedByLabel(params);
  const callApprovalMethod = async (method: string): Promise<void> => {
    await callGateway({
      method,
      params: { id: parsed.id, decision: parsed.decision },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat approval (${resolvedBy})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
  };

  // Plugin approval IDs are kind-prefixed (`plugin:<uuid>`); route directly when detected.
  // Unprefixed IDs try exec first, then fall back to plugin for backward compat.
  if (isPluginId) {
    try {
      await callApprovalMethod("plugin.approval.resolve");
    } catch (err) {
      return {
        shouldContinue: false,
        reply: { text: `❌ Failed to submit approval: ${String(err)}` },
      };
    }
  } else {
    if (discordExecApprovalDeniedReply) {
      // Preserve the legacy unprefixed plugin fallback on Discord even when
      // exec approvals are unavailable to this sender.
      try {
        await callApprovalMethod("plugin.approval.resolve");
      } catch (pluginErr) {
        if (isApprovalNotFoundError(pluginErr)) {
          return discordExecApprovalDeniedReply;
        }
        return {
          shouldContinue: false,
          reply: { text: `❌ Failed to submit approval: ${String(pluginErr)}` },
        };
      }
      return {
        shouldContinue: false,
        reply: { text: `✅ Approval ${parsed.decision} submitted for ${parsed.id}.` },
      };
    }
    try {
      await callApprovalMethod("exec.approval.resolve");
    } catch (err) {
      if (isApprovalNotFoundError(err)) {
        if (params.command.channel === "telegram" && !isTelegramExplicitApprover) {
          return {
            shouldContinue: false,
            reply: { text: `❌ Failed to submit approval: ${String(err)}` },
          };
        }
        try {
          await callApprovalMethod("plugin.approval.resolve");
        } catch (pluginErr) {
          return {
            shouldContinue: false,
            reply: { text: `❌ Failed to submit approval: ${String(pluginErr)}` },
          };
        }
      } else {
        return {
          shouldContinue: false,
          reply: { text: `❌ Failed to submit approval: ${String(err)}` },
        };
      }
    }
  }

  return {
    shouldContinue: false,
    reply: { text: `✅ Approval ${parsed.decision} submitted for ${parsed.id}.` },
  };
};

export const handleApproveQuickCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const decision = parseApproveQuickDecision(params.command.commandBodyNormalized);
  if (!decision) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    return null;
  }
  const missingScope = requireGatewayClientScopeForInternalChannel(params, {
    label: "yes/no approval",
    allowedScopes: ["operator.approvals", "operator.admin"],
    missingText: "❌ yes/no exec approval requires operator.approvals for gateway clients.",
  });
  if (missingScope) {
    return missingScope;
  }
  const resolvedBy = buildResolvedByLabel(params);
  try {
    const peek = (await callGateway({
      method: "exec.approval.peekSession",
      params: { sessionKey: params.sessionKey },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat approval (${resolvedBy})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    })) as {
      latest?: {
        id?: unknown;
      } | null;
      pendingCount?: unknown;
    };
    const latestId =
      peek?.latest && typeof peek.latest === "object" && typeof peek.latest.id === "string"
        ? peek.latest.id
        : "";
    if (!latestId) {
      return null;
    }
    await callGateway({
      method: "exec.approval.resolve",
      params: { id: latestId, decision },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat approval (${resolvedBy})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
    const pendingCount =
      typeof peek?.pendingCount === "number" && Number.isFinite(peek.pendingCount)
        ? Math.max(0, Math.floor(peek.pendingCount))
        : undefined;
    const remainingHint =
      typeof pendingCount === "number" && pendingCount > 1
        ? ` (${pendingCount - 1} more pending in this session)`
        : "";
    if (decision === "allow-once") {
      return {
        shouldContinue: false,
        reply: { text: `✅ Approved latest exec request.${remainingHint}` },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `✅ Denied latest exec request.${remainingHint}` },
    };
  } catch (err) {
    return {
      shouldContinue: false,
      reply: { text: `❌ Failed to process yes/no approval: ${String(err)}` },
    };
  }
};

function formatBatchCommand(command: string): string {
  if (!command.includes("\n") && !command.includes("`")) {
    return `\`${command}\``;
  }
  let fence = "```";
  while (command.includes(fence)) {
    fence += "`";
  }
  return `${fence}\n${command}\n${fence}`;
}

export const handleApproveBatchCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const parsed = parseApproveBatchCommand(normalized);
  if (!parsed) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /approve-batch from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }
  const missingScope = requireGatewayClientScopeForInternalChannel(params, {
    label: "/approve-batch",
    allowedScopes: ["operator.approvals", "operator.admin"],
    missingText: "❌ /approve-batch requires operator.approvals for gateway clients.",
  });
  if (missingScope) {
    return missingScope;
  }

  const callBatchMethod = async (method: string): Promise<unknown> => {
    return await callGateway({
      method,
      params: { sessionKey: params.sessionKey },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat approval batch (${buildResolvedByLabel(params)})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
  };

  try {
    if (parsed.action === "start") {
      const payload = (await callBatchMethod("exec.approval.batch.start")) as {
        queuedCount?: unknown;
      };
      const queuedCount =
        typeof payload?.queuedCount === "number" && Number.isFinite(payload.queuedCount)
          ? payload.queuedCount
          : 0;
      return {
        shouldContinue: false,
        reply: {
          text:
            queuedCount > 0
              ? `✅ Batch approval mode started. ${queuedCount} pending approval(s) queued for this session.`
              : "✅ Batch approval mode started. New exec approvals will be queued for this session.",
        },
      };
    }

    if (parsed.action === "review") {
      const payload = (await callBatchMethod("exec.approval.batch.review")) as {
        active?: unknown;
        queued?: unknown;
      };
      const active = payload?.active === true;
      const queued = Array.isArray(payload?.queued) ? payload.queued : [];
      if (!active) {
        return {
          shouldContinue: false,
          reply: {
            text: "ℹ️ Batch approval mode is not active for this session. Run /approve-batch start first.",
          },
        };
      }
      if (queued.length === 0) {
        return {
          shouldContinue: false,
          reply: { text: "📦 Batch approval queue is empty for this session." },
        };
      }
      const lines: string[] = [`📦 Queued approvals (${queued.length}):`];
      for (let index = 0; index < queued.length; index += 1) {
        const item = queued[index] as { id?: unknown; command?: unknown };
        const id = typeof item.id === "string" ? item.id : "<unknown>";
        const command = typeof item.command === "string" ? item.command : "<unknown command>";
        lines.push(`${index + 1}. ${id}`);
        lines.push(`   ${formatBatchCommand(command)}`);
      }
      return {
        shouldContinue: false,
        reply: { text: lines.join("\n") },
      };
    }

    if (parsed.action === "run") {
      const payload = (await callBatchMethod("exec.approval.batch.run")) as {
        resolvedCount?: unknown;
      };
      const resolvedCount =
        typeof payload?.resolvedCount === "number" && Number.isFinite(payload.resolvedCount)
          ? payload.resolvedCount
          : 0;
      return {
        shouldContinue: false,
        reply: {
          text:
            resolvedCount > 0
              ? `✅ Batch approved. Executed ${resolvedCount} queued command(s) in order. Batch mode ended.`
              : "✅ Batch mode ended. No queued commands were waiting.",
        },
      };
    }

    const payload = (await callBatchMethod("exec.approval.batch.deny")) as {
      resolvedCount?: unknown;
    };
    const resolvedCount =
      typeof payload?.resolvedCount === "number" && Number.isFinite(payload.resolvedCount)
        ? payload.resolvedCount
        : 0;
    return {
      shouldContinue: false,
      reply: {
        text:
          resolvedCount > 0
            ? `✅ Batch denied. Rejected ${resolvedCount} queued command(s). Batch mode ended.`
            : "✅ Batch mode ended. No queued commands were waiting.",
      },
    };
  } catch (err) {
    return {
      shouldContinue: false,
      reply: { text: `❌ Failed to process /approve-batch ${parsed.action}: ${String(err)}` },
    };
  }
};
