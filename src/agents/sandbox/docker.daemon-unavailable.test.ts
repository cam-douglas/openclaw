import { describe, expect, it } from "vitest";
import { createDockerDaemonUnavailableError, isDockerDaemonUnreachableMessage } from "./docker.js";

describe("isDockerDaemonUnreachableMessage", () => {
  it("detects typical macOS Docker Desktop socket errors", () => {
    expect(
      isDockerDaemonUnreachableMessage(
        "Cannot connect to the Docker daemon at unix:///Users/x/.docker/run/docker.sock. Is the docker daemon running?",
      ),
    ).toBe(true);
  });

  it("detects error during connect prefix", () => {
    expect(isDockerDaemonUnreachableMessage("error during connect: connection refused")).toBe(true);
  });

  it("returns false for missing image errors", () => {
    expect(isDockerDaemonUnreachableMessage("Error: No such image: foo:bar")).toBe(false);
  });
});

describe("createDockerDaemonUnavailableError", () => {
  it("includes remediation and optional detail", () => {
    const err = createDockerDaemonUnavailableError("cannot connect");
    expect(err.message).toContain("Docker daemon is not reachable");
    expect(err.message).toContain("agents.defaults.sandbox.mode=off");
    expect(err.message).toContain("cannot connect");
    expect((err as { code?: string }).code).toBe("DOCKER_DAEMON_UNAVAILABLE");
  });
});
