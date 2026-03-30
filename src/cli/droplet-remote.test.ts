import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  const real = mod.spawnSync.bind(mod);
  return {
    ...mod,
    spawn: vi.fn(() => ({ pid: 123, kill: vi.fn() })) as unknown as typeof mod.spawn,
    spawnSync: vi.fn(
      (
        command: string,
        args?: readonly string[],
        options?: import("node:child_process").SpawnSyncOptions,
      ) => {
        if (command === "afplay") {
          return {
            status: 0,
            pid: 1,
            output: [] as Array<Buffer | null>,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            signal: null,
          };
        }
        if (command === "openclaw") {
          return {
            status: 0,
            pid: 2,
            output: [] as Array<Buffer | null>,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            signal: null,
          };
        }
        if (command === "ssh") {
          return {
            status: 0,
            pid: 3,
            output: [] as Array<Buffer | null>,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            signal: null,
          };
        }
        return real(command, args as string[], options);
      },
    ) as unknown as typeof mod.spawnSync,
  };
});

import * as childProcess from "node:child_process";
import {
  applyDropletTuiDefaultSession,
  bashSingleQuoteWord,
  buildDropletRemoteBashLcLine,
  buildDropletRemoteEnvPrefix,
  buildDropletRemoteSshShellCommand,
  DEFAULT_DROPLET_COMPLETION_SOUND_PATH,
  dropletRemoteHomeForUser,
  mergeDropletForwardGatewayEnvFromEnvFiles,
  playDropletRemoteCompletionChime,
  isTrailingDropletRemoteInvocation,
  resolveDropletSshForwardHost,
  stripTrailingDroplet,
  tryLoadDropletIpFromHomeCheckoutEnv,
  tryHandleDropletRemoteCli,
} from "./droplet-remote.js";

const mockedSpawnSync = vi.mocked(childProcess.spawnSync);
const mockedSpawn = vi.mocked(childProcess.spawn);

describe("playDropletRemoteCompletionChime", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockedSpawnSync.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    delete process.env.OPENCLAW_DROPLET_COMPLETION_SOUND;
    delete process.env.OPENCLAW_DROPLET_COMPLETION_SOUND_PATH;
    delete process.env.OPENCLAW_DROPLET_COMPLETION_SOUND_SUCCESS_ONLY;
  });

  it("does not call afplay on non-darwin", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    playDropletRemoteCompletionChime(0);
    expect(mockedSpawnSync).not.toHaveBeenCalledWith(
      "afplay",
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not call afplay when OPENCLAW_DROPLET_COMPLETION_SOUND=0", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.OPENCLAW_DROPLET_COMPLETION_SOUND = "0";
    playDropletRemoteCompletionChime(0);
    expect(mockedSpawnSync).not.toHaveBeenCalledWith(
      "afplay",
      expect.anything(),
      expect.anything(),
    );
  });

  it("calls afplay with Funk path on darwin by default", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    playDropletRemoteCompletionChime(0);
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "afplay",
      [DEFAULT_DROPLET_COMPLETION_SOUND_PATH],
      {
        stdio: "ignore",
      },
    );
  });

  it("skips when SUCCESS_ONLY and non-zero exit", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.OPENCLAW_DROPLET_COMPLETION_SOUND_SUCCESS_ONLY = "1";
    playDropletRemoteCompletionChime(1);
    expect(mockedSpawnSync).not.toHaveBeenCalledWith(
      "afplay",
      expect.anything(),
      expect.anything(),
    );
  });

  it("uses custom path when set", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.OPENCLAW_DROPLET_COMPLETION_SOUND_PATH = "/custom/sound.aiff";
    playDropletRemoteCompletionChime(0);
    expect(mockedSpawnSync).toHaveBeenCalledWith("afplay", ["/custom/sound.aiff"], {
      stdio: "ignore",
    });
  });
});

describe("stripTrailingDroplet", () => {
  it("does not strip without droplet suffix", () => {
    const argv = ["node", "openclaw", "status"];
    expect(stripTrailingDroplet(argv)).toEqual({ ok: false, argv });
  });

  it("strips trailing droplet", () => {
    const argv = ["node", "openclaw", "status", "droplet"];
    expect(stripTrailingDroplet(argv)).toEqual({
      ok: true,
      argv: ["node", "openclaw", "status"],
    });
  });

  it("strips for nested commands", () => {
    const argv = ["node", "openclaw", "models", "status", "--probe", "droplet"];
    expect(stripTrailingDroplet(argv)).toEqual({
      ok: true,
      argv: ["node", "openclaw", "models", "status", "--probe"],
    });
  });
});

describe("isTrailingDropletRemoteInvocation", () => {
  it("is true when argv ends with droplet (same as stripTrailingDroplet ok)", () => {
    expect(isTrailingDropletRemoteInvocation(["node", "openclaw", "tui", "droplet"])).toBe(true);
    expect(isTrailingDropletRemoteInvocation(["node", "openclaw", "status", "droplet"])).toBe(true);
  });

  it("is false without trailing droplet or too-short argv", () => {
    expect(isTrailingDropletRemoteInvocation(["node", "openclaw", "status"])).toBe(false);
    expect(isTrailingDropletRemoteInvocation(["openclaw", "droplet"])).toBe(false);
  });
});

describe("applyDropletTuiDefaultSession", () => {
  it("adds --session main for tui when missing", () => {
    expect(applyDropletTuiDefaultSession(["tui"])).toEqual([
      "tui",
      "--session",
      "main",
      "--history-limit",
      "40",
    ]);
    expect(applyDropletTuiDefaultSession(["tui", "--token", "abc"])).toEqual([
      "tui",
      "--token",
      "abc",
      "--session",
      "main",
      "--history-limit",
      "40",
    ]);
  });

  it("does not override explicit --session", () => {
    expect(applyDropletTuiDefaultSession(["tui", "--session", "authcheck"])).toEqual([
      "tui",
      "--session",
      "authcheck",
      "--history-limit",
      "40",
    ]);
  });

  it("does nothing for non-tui commands", () => {
    expect(applyDropletTuiDefaultSession(["status"])).toEqual(["status"]);
  });

  it("does not override explicit --history-limit", () => {
    expect(applyDropletTuiDefaultSession(["tui", "--history-limit", "200"])).toEqual([
      "tui",
      "--history-limit",
      "200",
      "--session",
      "main",
    ]);
  });

  it("uses OPENCLAW_DROPLET_TUI_HISTORY_LIMIT when set", () => {
    const previous = process.env.OPENCLAW_DROPLET_TUI_HISTORY_LIMIT;
    process.env.OPENCLAW_DROPLET_TUI_HISTORY_LIMIT = "80";
    try {
      expect(applyDropletTuiDefaultSession(["tui"])).toEqual([
        "tui",
        "--session",
        "main",
        "--history-limit",
        "80",
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_DROPLET_TUI_HISTORY_LIMIT;
      } else {
        process.env.OPENCLAW_DROPLET_TUI_HISTORY_LIMIT = previous;
      }
    }
  });
});

describe("tryLoadDropletIpFromHomeCheckoutEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DROPLET_IP;
  });

  it("loads DROPLET_IP from ~/openclaw/.env when unset", () => {
    delete process.env.DROPLET_IP;
    const fakeHome = mkdtempSync(join(tmpdir(), "oc-home-"));
    const envPath = join(fakeHome, "openclaw", ".env");
    mkdirSync(join(fakeHome, "openclaw"), { recursive: true });
    writeFileSync(envPath, "DROPLET_IP=198.51.100.10\n");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    tryLoadDropletIpFromHomeCheckoutEnv();
    expect(process.env.DROPLET_IP).toBe("198.51.100.10");
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("does not override existing DROPLET_IP", () => {
    process.env.DROPLET_IP = "203.0.113.1";
    const fakeHome = mkdtempSync(join(tmpdir(), "oc-home-"));
    const envPath = join(fakeHome, "openclaw", ".env");
    mkdirSync(join(fakeHome, "openclaw"), { recursive: true });
    writeFileSync(envPath, "DROPLET_IP=198.51.100.10\n");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    tryLoadDropletIpFromHomeCheckoutEnv();
    expect(process.env.DROPLET_IP).toBe("203.0.113.1");
    rmSync(fakeHome, { recursive: true, force: true });
  });
});

describe("mergeDropletForwardGatewayEnvFromEnvFiles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads OPENCLAW_GATEWAY_TOKEN from ~/.openclaw/.env when missing", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "oc-gw-"));
    const envPath = join(fakeHome, ".openclaw", ".env");
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, "OPENCLAW_GATEWAY_TOKEN=from-state-env\n");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    vi.spyOn(process, "cwd").mockReturnValue(fakeHome);
    const env = {} as NodeJS.ProcessEnv;
    mergeDropletForwardGatewayEnvFromEnvFiles(env);
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("from-state-env");
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("replaces empty OPENCLAW_GATEWAY_TOKEN from file", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "oc-gw-"));
    const envPath = join(fakeHome, ".openclaw", ".env");
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, "OPENCLAW_GATEWAY_TOKEN=file-token\n");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    vi.spyOn(process, "cwd").mockReturnValue(fakeHome);
    const env = { OPENCLAW_GATEWAY_TOKEN: "" } as NodeJS.ProcessEnv;
    mergeDropletForwardGatewayEnvFromEnvFiles(env);
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("file-token");
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("lets ~/.openclaw/.env override a repo .env token (last wins)", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "oc-gw-"));
    writeFileSync(join(fakeHome, ".env"), "OPENCLAW_GATEWAY_TOKEN=wrong-from-cwd\n");
    const stateEnv = join(fakeHome, ".openclaw", ".env");
    mkdirSync(dirname(stateEnv), { recursive: true });
    writeFileSync(stateEnv, "OPENCLAW_GATEWAY_TOKEN=right-from-state\n");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    vi.spyOn(process, "cwd").mockReturnValue(fakeHome);
    const env = { OPENCLAW_GATEWAY_TOKEN: "wrong-from-cwd" } as NodeJS.ProcessEnv;
    mergeDropletForwardGatewayEnvFromEnvFiles(env);
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("right-from-state");
    rmSync(fakeHome, { recursive: true, force: true });
  });
});

describe("dropletRemoteHomeForUser", () => {
  it("maps root and non-root users", () => {
    expect(dropletRemoteHomeForUser("root")).toBe("/root");
    expect(dropletRemoteHomeForUser("ubuntu")).toBe("/home/ubuntu");
  });
});

describe("buildDropletRemoteSshShellCommand", () => {
  it("wraps inner bash -c with env -i and /bin/bash --noprofile --norc", () => {
    const inner = "export PATH=foo; exec openclaw tui";
    const cmd = buildDropletRemoteSshShellCommand(inner, {
      sshUser: "root",
      term: "xterm-256color",
    });
    expect(cmd.startsWith("env -i ")).toBe(true);
    expect(cmd).toContain("HOME=" + bashSingleQuoteWord("/root"));
    expect(cmd).toContain("USER=" + bashSingleQuoteWord("root"));
    expect(cmd).toContain("TERM=" + bashSingleQuoteWord("xterm-256color"));
    expect(cmd).toContain("/bin/bash --noprofile --norc -c " + bashSingleQuoteWord(inner));
  });
});

describe("buildDropletRemoteEnvPrefix", () => {
  it("is empty when gateway env vars are unset", () => {
    expect(buildDropletRemoteEnvPrefix({} as NodeJS.ProcessEnv)).toBe("");
  });

  it("exports gateway token and password with safe quoting", () => {
    const s = buildDropletRemoteEnvPrefix({
      OPENCLAW_GATEWAY_TOKEN: "tok",
      OPENCLAW_GATEWAY_PASSWORD: "p'a",
    } as NodeJS.ProcessEnv);
    expect(s).toBe(
      `export OPENCLAW_GATEWAY_TOKEN=${bashSingleQuoteWord("tok")}; export OPENCLAW_GATEWAY_PASSWORD=${bashSingleQuoteWord("p'a")}; `,
    );
  });

  it("is empty when OPENCLAW_DROPLET_FORWARD_GATEWAY_AUTH=0", () => {
    expect(
      buildDropletRemoteEnvPrefix({
        OPENCLAW_DROPLET_FORWARD_GATEWAY_AUTH: "0",
        OPENCLAW_GATEWAY_TOKEN: "tok",
      } as NodeJS.ProcessEnv),
    ).toBe("");
  });
});

describe("buildDropletRemoteBashLcLine", () => {
  it("quotes apostrophes in words", () => {
    expect(bashSingleQuoteWord("a'b")).toBe("'a'\"'\"'b'");
  });

  it("resolves bare bin name to a real file before exec (avoids openclaw repo dir)", () => {
    const line = buildDropletRemoteBashLcLine(
      "openclaw",
      ["doctor", "--non-interactive"],
      {} as NodeJS.ProcessEnv,
    );
    expect(line).toContain("_name='openclaw'");
    expect(line).toContain('for _c in "$HOME/.local/share/pnpm/$_name"');
    expect(line).toContain("npm config get prefix");
    expect(line).toContain('do [ -n "$_c" ]');
    expect(line).not.toContain("do;");
    expect(line).toContain(`exec "$_bin" 'doctor' '--non-interactive'`);
  });

  it("uses direct exec when remote bin is an absolute path", () => {
    expect(
      buildDropletRemoteBashLcLine("/usr/local/bin/openclaw", ["doctor"], {} as NodeJS.ProcessEnv),
    ).toBe(
      `export PATH="$HOME/.local/share/pnpm:$HOME/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/sbin:$PATH"; exec '/usr/local/bin/openclaw' 'doctor'`,
    );
  });

  it("prepends forwarded gateway env before PATH when set locally", () => {
    const line = buildDropletRemoteBashLcLine("/usr/local/bin/openclaw", ["tui"], {
      OPENCLAW_GATEWAY_TOKEN: "abc",
    } as NodeJS.ProcessEnv);
    expect(line).toMatch(/^export OPENCLAW_GATEWAY_TOKEN='abc'; export PATH=/);
  });
});

describe("resolveDropletSshForwardHost", () => {
  it("defaults to loopback when unset", () => {
    expect(resolveDropletSshForwardHost({})).toBe("127.0.0.1");
  });

  it("accepts IPv4", () => {
    expect(
      resolveDropletSshForwardHost({ OPENCLAW_DROPLET_SSH_FORWARD_HOST: "100.126.96.38" }),
    ).toBe("100.126.96.38");
  });

  it("brackets IPv6 literals for OpenSSH", () => {
    expect(resolveDropletSshForwardHost({ OPENCLAW_DROPLET_SSH_FORWARD_HOST: "::1" })).toBe(
      "[::1]",
    );
  });

  it("accepts localhost", () => {
    expect(resolveDropletSshForwardHost({ OPENCLAW_DROPLET_SSH_FORWARD_HOST: "localhost" })).toBe(
      "localhost",
    );
  });

  it("accepts a hostname", () => {
    expect(
      resolveDropletSshForwardHost({ OPENCLAW_DROPLET_SSH_FORWARD_HOST: "my-host.internal" }),
    ).toBe("my-host.internal");
  });

  it("falls back on invalid values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveDropletSshForwardHost({ OPENCLAW_DROPLET_SSH_FORWARD_HOST: "bad;rm" })).toBe(
      "127.0.0.1",
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("tryHandleDropletRemoteCli (tui droplet)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockedSpawn.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    delete process.env.DROPLET_IP;
    delete process.env.SSH_USER;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_DROPLET_TUI_FORWARD_PORT;
    delete process.env.OPENCLAW_DROPLET_SSH_FORWARD_HOST;
    vi.restoreAllMocks();
    mockedSpawnSync.mockClear();
  });

  it("runs local tui (so completion chime can play)", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.DROPLET_IP = "203.0.113.10";
    process.env.SSH_USER = "root";
    process.env.OPENCLAW_GATEWAY_TOKEN = "tok";
    process.env.OPENCLAW_DROPLET_TUI_FORWARD_PORT = "18791";
    process.env.OPENCLAW_DROPLET_SUDO_GATE = "0";

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? "unknown"})`);
    }) as never);

    expect(() =>
      tryHandleDropletRemoteCli(["node", "openclaw", "tui", "--session", "main", "droplet"]),
    ).toThrow(/process\.exit/);

    expect(mockedSpawn).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining(["-L", "18791:127.0.0.1:18789"]),
      expect.objectContaining({ stdio: "inherit" }),
    );

    // Local TUI invocation.
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "openclaw",
      expect.arrayContaining(["tui", "--url", "ws://127.0.0.1:18791", "--session", "main"]),
      expect.objectContaining({
        stdio: "inherit",
        env: expect.any(Object),
      }),
    );
    expect(exitSpy).toHaveBeenCalled();
  });

  it("uses OPENCLAW_DROPLET_SSH_FORWARD_HOST in the SSH tunnel", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.DROPLET_IP = "203.0.113.10";
    process.env.SSH_USER = "root";
    process.env.OPENCLAW_GATEWAY_TOKEN = "tok";
    process.env.OPENCLAW_DROPLET_TUI_FORWARD_PORT = "18791";
    process.env.OPENCLAW_DROPLET_SSH_FORWARD_HOST = "100.126.96.38";
    process.env.OPENCLAW_DROPLET_SUDO_GATE = "0";

    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? "unknown"})`);
    }) as never);

    expect(() =>
      tryHandleDropletRemoteCli(["node", "openclaw", "tui", "--session", "main", "droplet"]),
    ).toThrow(/process\.exit/);

    expect(mockedSpawn).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining(["-L", "18791:100.126.96.38:18789"]),
      expect.objectContaining({ stdio: "inherit" }),
    );
  });
});
