import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntime } from "../runtime.js";

const resolveCleanupPlanFromDisk = vi.fn();
const removePath = vi.fn();
const removeStateAndLinkedPaths = vi.fn();
const removeWorkspaceDirs = vi.fn();
const serviceIsLoaded = vi.fn();
const serviceStop = vi.fn();
const serviceUninstall = vi.fn();

vi.mock("../config/config.js", () => ({
  isNixMode: false,
}));

vi.mock("./cleanup-plan.js", () => ({
  resolveCleanupPlanFromDisk,
}));

vi.mock("./cleanup-utils.js", () => ({
  removePath,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    isLoaded: serviceIsLoaded,
    stop: serviceStop,
    uninstall: serviceUninstall,
    notLoadedText: "is not installed",
  }),
}));

const { uninstallCommand } = await import("./uninstall.js");

describe("uninstallCommand", () => {
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
    removeStateAndLinkedPaths.mockResolvedValue(undefined);
    removeWorkspaceDirs.mockResolvedValue(undefined);
    serviceIsLoaded.mockReset();
    serviceStop.mockReset();
    serviceUninstall.mockReset();
    serviceIsLoaded.mockResolvedValue(false);
    serviceStop.mockResolvedValue(undefined);
    serviceUninstall.mockResolvedValue(undefined);
    vi.spyOn(runtime, "log").mockImplementation(() => {});
    vi.spyOn(runtime, "error").mockImplementation(() => {});
  });

  it("recommends creating a backup before removing state or workspaces", async () => {
    await uninstallCommand(runtime, {
      state: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("openclaw backup create"));
  });

  it("does not recommend backup for service-only uninstall", async () => {
    await uninstallCommand(runtime, {
      service: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("openclaw backup create"));
  });

  it("treats non-fatal systemd bus errors as not-loaded during service checks", async () => {
    serviceIsLoaded.mockRejectedValueOnce(
      new Error("systemctl is-enabled unavailable: Failed to connect to bus: No medium found"),
    );

    await uninstallCommand(runtime, {
      service: true,
      yes: true,
      nonInteractive: true,
      dryRun: false,
    });

    expect(runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("Gateway service check failed"),
    );
    expect(serviceStop).not.toHaveBeenCalled();
    expect(serviceUninstall).not.toHaveBeenCalled();
  });
});
