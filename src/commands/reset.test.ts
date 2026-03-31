import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntime } from "../runtime.js";

const resolveCleanupPlanFromDisk = vi.fn();
const removePath = vi.fn();
const listAgentSessionDirs = vi.fn();
const removeStateAndLinkedPaths = vi.fn();
const removeWorkspaceDirs = vi.fn();
const serviceIsLoaded = vi.fn();
const serviceStop = vi.fn();

vi.mock("../config/config.js", () => ({
  isNixMode: false,
}));

vi.mock("./cleanup-plan.js", () => ({
  resolveCleanupPlanFromDisk,
}));

vi.mock("./cleanup-utils.js", () => ({
  removePath,
  listAgentSessionDirs,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    isLoaded: serviceIsLoaded,
    stop: serviceStop,
    notLoadedText: "is not installed",
  }),
}));

const { resetCommand } = await import("./reset.js");

describe("resetCommand", () => {
  const runtime = createNonExitingRuntime();

  beforeEach(() => {
    vi.clearAllMocks();
    resolveCleanupPlanFromDisk.mockReturnValue({
      stateDir: "/tmp/.openclaw",
      configPath: "/tmp/.openclaw/openclaw.json",
      oauthDir: "/tmp/.openclaw/credentials",
      configInsideState: true,
      oauthInsideState: true,
      workspaceDirs: ["/tmp/.openclaw/workspace"],
    });
    removePath.mockResolvedValue({ ok: true });
    listAgentSessionDirs.mockResolvedValue(["/tmp/.openclaw/agents/main/sessions"]);
    removeStateAndLinkedPaths.mockResolvedValue(undefined);
    removeWorkspaceDirs.mockResolvedValue(undefined);
    serviceIsLoaded.mockReset();
    serviceStop.mockReset();
    serviceIsLoaded.mockResolvedValue(false);
    serviceStop.mockResolvedValue(undefined);
    vi.spyOn(runtime, "log").mockImplementation(() => {});
    vi.spyOn(runtime, "error").mockImplementation(() => {});
  });

  it("recommends creating a backup before state-destructive reset scopes", async () => {
    await resetCommand(runtime, {
      scope: "config+creds+sessions",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("openclaw backup create"));
  });

  it("does not recommend backup for config-only reset", async () => {
    await resetCommand(runtime, {
      scope: "config",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("openclaw backup create"));
  });

  it("treats non-fatal systemd bus errors as not-loaded during stop checks", async () => {
    serviceIsLoaded.mockRejectedValueOnce(
      new Error("systemctl is-enabled unavailable: Failed to connect to bus: No medium found"),
    );

    await resetCommand(runtime, {
      scope: "config+creds+sessions",
      yes: true,
      nonInteractive: true,
      dryRun: false,
    });

    expect(runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("Gateway service check failed"),
    );
    expect(serviceStop).not.toHaveBeenCalled();
  });
});
