import { Type } from "@sinclair/typebox";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveVisibleSessionReference,
  resolveSandboxedSessionToolContext,
} from "./sessions-helpers.js";

const SESSION_DELETE_ACTIONS = ["delete", "delete_all_except_current"] as const;
type SessionsDeleteAction = (typeof SESSION_DELETE_ACTIONS)[number];

const SessionsDeleteToolSchema = Type.Object({
  action: optionalStringEnum(SESSION_DELETE_ACTIONS),
  sessionKey: Type.Optional(Type.String()),
  deleteTranscript: Type.Optional(Type.Boolean()),
});

type GatewayCaller = typeof callGateway;
type SessionListEntry = { key?: unknown };

export function createSessionsDeleteTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Session Delete",
    name: "sessions_delete",
    description:
      "Delete one session, or delete all sessions except the current session (current is always protected).",
    parameters: SessionsDeleteToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "delete") as SessionsDeleteAction;
      const deleteTranscript =
        typeof params.deleteTranscript === "boolean" ? params.deleteTranscript : true;
      const cfg = opts?.config ?? loadConfig();
      const gatewayCall = opts?.callGateway ?? callGateway;
      const { mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "delete",
        requesterSessionKey: effectiveRequesterKey,
        visibility,
        a2aPolicy,
      });

      if (action === "delete") {
        const sessionKeyParam = readStringParam(params, "sessionKey", { required: true });
        const resolvedSession = await resolveSessionReference({
          sessionKey: sessionKeyParam,
          alias,
          mainKey,
          requesterInternalKey: effectiveRequesterKey,
          restrictToSpawned,
        });
        if (!resolvedSession.ok) {
          return jsonResult({ status: resolvedSession.status, error: resolvedSession.error });
        }
        const visibleSession = await resolveVisibleSessionReference({
          resolvedSession,
          requesterSessionKey: effectiveRequesterKey,
          restrictToSpawned,
          visibilitySessionKey: sessionKeyParam,
        });
        if (!visibleSession.ok) {
          return jsonResult({
            status: visibleSession.status,
            error: visibleSession.error,
          });
        }
        const targetKey = visibleSession.key;
        if (targetKey === effectiveRequesterKey) {
          return jsonResult({
            status: "forbidden",
            error: "Cannot delete the current active session.",
            sessionKey: visibleSession.displayKey,
          });
        }
        const access = visibilityGuard.check(targetKey);
        if (!access.allowed) {
          return jsonResult({
            status: access.status,
            error: access.error,
            sessionKey: visibleSession.displayKey,
          });
        }
        try {
          const result = await gatewayCall<{
            ok?: boolean;
            key?: string;
            deleted?: boolean;
            archived?: string[];
          }>({
            method: "sessions.delete",
            params: { key: targetKey, deleteTranscript },
          });
          return jsonResult({
            status: "ok",
            action,
            sessionKey: visibleSession.displayKey,
            deleted: result?.deleted === true,
            archived: Array.isArray(result?.archived) ? result.archived : [],
          });
        } catch (err) {
          return jsonResult({
            status: "error",
            action,
            sessionKey: visibleSession.displayKey,
            error: String(err),
          });
        }
      }

      let listed: SessionListEntry[] = [];
      try {
        const result = await gatewayCall<{ sessions?: SessionListEntry[] }>({
          method: "sessions.list",
          params: {
            includeGlobal: !restrictToSpawned,
            includeUnknown: !restrictToSpawned,
            spawnedBy: restrictToSpawned ? effectiveRequesterKey : undefined,
          },
        });
        listed = Array.isArray(result?.sessions) ? result.sessions : [];
      } catch (err) {
        return jsonResult({
          status: "error",
          action,
          error: `failed to list sessions: ${String(err)}`,
        });
      }

      const deleted: string[] = [];
      const skipped: Array<{ sessionKey: string; reason: string }> = [];
      const failed: Array<{ sessionKey: string; error: string }> = [];

      for (const entry of listed) {
        const key = typeof entry?.key === "string" ? entry.key.trim() : "";
        if (!key) {
          continue;
        }
        if (key === effectiveRequesterKey) {
          skipped.push({ sessionKey: key, reason: "current-session" });
          continue;
        }
        if (key === mainKey || key === alias) {
          skipped.push({ sessionKey: key, reason: "main-session-protected" });
          continue;
        }
        const access = visibilityGuard.check(key);
        if (!access.allowed) {
          skipped.push({ sessionKey: key, reason: access.error });
          continue;
        }
        try {
          const result = await gatewayCall<{ deleted?: boolean }>({
            method: "sessions.delete",
            params: { key, deleteTranscript },
          });
          if (result?.deleted === true) {
            deleted.push(key);
          } else {
            skipped.push({ sessionKey: key, reason: "not-found-or-not-deleted" });
          }
        } catch (err) {
          failed.push({ sessionKey: key, error: String(err) });
        }
      }

      return jsonResult({
        status: failed.length > 0 ? "partial" : "ok",
        action,
        currentSessionKey: effectiveRequesterKey,
        deletedCount: deleted.length,
        skippedCount: skipped.length,
        failedCount: failed.length,
        deleted,
        skipped,
        failed,
      });
    },
  };
}
