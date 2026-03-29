import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import { createSessionsDeleteTool } from "./sessions-delete-tool.js";

function buildConfig(): OpenClawConfig {
  return {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    tools: {
      sessions: {
        visibility: "all",
      },
      agentToAgent: {
        enabled: true,
      },
    },
  } as OpenClawConfig;
}

describe("sessions_delete tool", () => {
  it("deletes a specific session by key", async () => {
    const callGateway = vi.fn(async <T>(opts: unknown): Promise<T> => {
      const req = opts as { method?: string };
      if (req.method === "sessions.delete") {
        return { ok: true, deleted: true, archived: ["/tmp/archive"] } as T;
      }
      return {} as T;
    }) as unknown as typeof gatewayCall;
    const tool = createSessionsDeleteTool({
      agentSessionKey: "agent:main:main",
      config: buildConfig(),
      callGateway,
    });

    const result = await tool.execute("call-1", { sessionKey: "agent:main:old" });
    const details = result.details as { status?: string; deleted?: boolean };
    expect(details.status).toBe("ok");
    expect(details.deleted).toBe(true);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.delete",
        params: { key: "agent:main:old", deleteTranscript: true },
      }),
    );
  });

  it("deletes all except current and reports partial failures", async () => {
    const callGateway = vi.fn(async <T>(opts: unknown): Promise<T> => {
      const req = opts as { method?: string; params?: Record<string, unknown> };
      if (req.method === "sessions.list") {
        return {
          sessions: [
            { key: "agent:main:main" },
            { key: "agent:main:old-1" },
            { key: "agent:main:old-2" },
          ],
        } as T;
      }
      if (req.method === "sessions.delete") {
        if (req.params?.key === "agent:main:old-2") {
          throw new Error("delete failed");
        }
        return { ok: true, deleted: true } as T;
      }
      return {} as T;
    }) as unknown as typeof gatewayCall;
    const tool = createSessionsDeleteTool({
      agentSessionKey: "agent:main:main",
      config: buildConfig(),
      callGateway,
    });

    const result = await tool.execute("call-2", { action: "delete_all_except_current" });
    const details = result.details as {
      status?: string;
      deletedCount?: number;
      failedCount?: number;
      skippedCount?: number;
    };
    expect(details.status).toBe("partial");
    expect(details.deletedCount).toBe(1);
    expect(details.failedCount).toBe(1);
    expect(details.skippedCount).toBe(1);
  });
});
