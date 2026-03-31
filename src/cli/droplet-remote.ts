/**
 * Trailing `droplet` runs the same OpenClaw CLI on the SSH host (see DROPLET_IP / SSH_USER).
 * Requires local sudo refresh before SSH and revoke after (matches repo SSH policy; single
 * `sudo -v` so macOS/PAM does not double-prompt).
 * Limits and mitigations: docs/platforms/digitalocean.md → "Security model, limits, and mitigations".
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { resolveStateDir } from "../config/paths.js";
import { loadWorkspaceDotEnvFile } from "../infra/dotenv.js";
import {
  DEFAULT_OPENCLAW_COMPLETION_SOUND_PATH,
  playMacCompletionChime,
} from "../infra/mac-completion-chime.js";
import { findAvailableLocalForwardPortSync } from "./droplet-local-forward-port.js";
import { buildDropletSshClientOptions } from "./droplet-ssh-options.js";

/** Re-export for compatibility; same path as `DEFAULT_OPENCLAW_COMPLETION_SOUND_PATH`. */
export const DEFAULT_DROPLET_COMPLETION_SOUND_PATH = DEFAULT_OPENCLAW_COMPLETION_SOUND_PATH;

/** Refresh sudo timestamp for droplet helpers; skip with OPENCLAW_DROPLET_SUDO_GATE=0. */
export function refreshDropletLocalSudoGate(): void {
  if (process.env.OPENCLAW_DROPLET_SUDO_GATE?.trim() === "0") {
    return;
  }
  const sudoV = spawnSync("sudo", ["-v"], { stdio: "inherit" });
  if (sudoV.error) {
    console.error("[openclaw] sudo -v failed:", sudoV.error.message);
    process.exit(1);
  }
  if (sudoV.status !== 0) {
    process.exit(sudoV.status ?? 1);
  }
}

export function revokeDropletLocalSudoGate(): void {
  if (process.env.OPENCLAW_DROPLET_SUDO_GATE?.trim() === "0") {
    return;
  }
  spawnSync("sudo", ["-k"], { stdio: "ignore" });
}

/** Alias for `playMacCompletionChime` (see `src/infra/mac-completion-chime.ts`). */
export const playDropletRemoteCompletionChime = playMacCompletionChime;

/** Default matches historical droplet tunnel; often collides with the local bridge (18790). */
const DEFAULT_DROPLET_TUI_FORWARD_PORT = 18_790;

function getDropletTuiForwardPortPreference(): { preferred: number; explicit: boolean } {
  const raw = process.env.OPENCLAW_DROPLET_TUI_FORWARD_PORT?.trim();
  if (!raw) {
    return { preferred: DEFAULT_DROPLET_TUI_FORWARD_PORT, explicit: false };
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65_535) {
    console.warn(`[openclaw] OPENCLAW_DROPLET_TUI_FORWARD_PORT ignored (invalid): ${raw}`);
    return { preferred: DEFAULT_DROPLET_TUI_FORWARD_PORT, explicit: false };
  }
  return { preferred: parsed, explicit: true };
}

/**
 * SSH destination host: prefer `DROPLET_SSH_HOST` (Tailscale 100.x or MagicDNS name) over public
 * `DROPLET_IP` so you can route SSH over tailnet after firewall hardening.
 */
export function resolveDropletSshTargetHost(env: NodeJS.ProcessEnv = process.env): string {
  const sshHost = env.DROPLET_SSH_HOST?.trim();
  if (sshHost) {
    return sshHost;
  }
  const ip = env.DROPLET_IP?.trim();
  if (ip) {
    return ip;
  }
  return "";
}

/**
 * Remote host for `ssh -L local:host:18789` (where the gateway listens on the VPS).
 * When `gateway.tailscale.mode` is `serve` (or funnel), the gateway binds loopback; use
 * `127.0.0.1`. When `gateway.bind` is `tailnet`, set this to the droplet Tailscale IPv4 (for example
 * from `tailscale ip -4` on the server).
 */
export function resolveDropletSshForwardHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OPENCLAW_DROPLET_SSH_FORWARD_HOST?.trim();
  if (!raw) {
    return "127.0.0.1";
  }
  if (isIPv4(raw)) {
    return raw;
  }
  if (isIPv6(raw)) {
    return `[${raw}]`;
  }
  if (raw === "localhost") {
    return raw;
  }
  if (/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(raw)) {
    return raw;
  }
  console.warn(`[openclaw] OPENCLAW_DROPLET_SSH_FORWARD_HOST ignored (invalid host): ${raw}`);
  return "127.0.0.1";
}

function runDropletLocalTuiViaSshTunnel(params: {
  target: string;
  sshOpts: string[];
  forward: string[];
}): never {
  const cfg = getDropletTuiForwardPortPreference();
  let localPort: number;
  try {
    const firstFree = findAvailableLocalForwardPortSync(cfg.preferred);
    if (cfg.explicit && firstFree !== cfg.preferred) {
      console.error(
        `[openclaw] OPENCLAW_DROPLET_TUI_FORWARD_PORT=${cfg.preferred} is already in use. Set it to a free port or stop the process using that port.`,
      );
      process.exit(1);
    }
    if (!cfg.explicit && firstFree !== cfg.preferred) {
      console.warn(
        `[openclaw] Local port ${cfg.preferred} is in use (often the bridge uses ${cfg.preferred}). Using ${firstFree} for the SSH tunnel. Set OPENCLAW_DROPLET_TUI_FORWARD_PORT to pin a port.`,
      );
    }
    localPort = firstFree;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const url = `ws://127.0.0.1:${localPort}`;
  const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  const password = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim();
  const forwardHost = resolveDropletSshForwardHost();

  // Keep the SSH tunnel open while local `openclaw tui` runs so the macOS completion chime
  // (Funk by default) can play when an agent reply finalizes.
  // LogLevel=QUIET: without it, OpenSSH spams stderr ("channel N: open failed: Connection refused")
  // on every local reconnect while the remote gateway is down, which obscures the TUI.
  const ssh = spawn(
    "ssh",
    [
      ...params.sshOpts,
      "-o",
      "LogLevel=QUIET",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `${localPort}:${forwardHost}:18789`,
      params.target,
      "-N",
    ],
    { stdio: "inherit" },
  );

  if (ssh.pid === undefined) {
    console.error("[openclaw] droplet: failed to start SSH tunnel");
    process.exit(1);
  }

  const tuiArgv = [
    "tui",
    "--url",
    url,
    ...(token ? ["--token", token] : []),
    ...(password ? ["--password", password] : []),
    ...params.forward.slice(1),
  ];

  try {
    // Run local TUI (interactive). No LLM calls from this helper — local `openclaw tui` talks to
    // the gateway WebSocket only.
    const env = { ...process.env };
    // Droplet-exclusive: ensure the macOS completion sound is enabled for the tunneled TUI,
    // even if the user disabled it for local gateway runs.
    delete env.OPENCLAW_TUI_COMPLETION_SOUND;
    delete env.OPENCLAW_COMPLETION_SOUND;
    env.OPENCLAW_TUI_COMPLETION_SOUND = "1";
    env.OPENCLAW_DROPLET_COMPLETION_SOUND = "1";
    env.OPENCLAW_DROPLET_COMPLETION_SOUND_NAME =
      env.OPENCLAW_DROPLET_COMPLETION_SOUND_NAME || "Funk";
    const local = spawnSync("openclaw", tuiArgv, { stdio: "inherit", env });
    if (local.error) {
      console.error("[openclaw] droplet: failed to run local tui:", local.error.message);
      revokeDropletLocalSudoGate();
      process.exit(1);
    }
    const code = local.status ?? 1;
    revokeDropletLocalSudoGate();
    process.exit(code);
  } finally {
    ssh.kill("SIGTERM");
  }
}

/**
 * Global npm installs may not yet include `~/openclaw/.env` in the main CLI dotenv pass.
 * Load it here so `openclaw tui droplet` works from $HOME with secrets only in the checkout.
 */
export function tryLoadDropletIpFromHomeCheckoutEnv(): void {
  if (process.env.DROPLET_IP?.trim() || process.env.DROPLET_SSH_HOST?.trim()) {
    return;
  }
  const homeCheckoutEnv = path.join(os.homedir(), "openclaw", ".env");
  loadWorkspaceDotEnvFile(homeCheckoutEnv, { quiet: true });
}

/**
 * Resolves `OPENCLAW_GATEWAY_*` for SSH forwarding after `loadCliDotEnv`.
 *
 * - `loadCliDotEnv` applies the first `.env` wins per key, so a repo `./.env` can shadow `~/.openclaw/.env`.
 * - This pass scans the same locations in **priority order** and applies **last non-empty wins** so
 *   `~/.openclaw/.env` and `OPENCLAW_ENV_FILE` override the repo. If no file defines a key, the
 *   existing `process.env` value (shell or prior load) is kept.
 */
export function mergeDropletForwardGatewayEnvFromEnvFiles(env: NodeJS.ProcessEnv): void {
  if (env.OPENCLAW_DROPLET_FORWARD_GATEWAY_AUTH?.trim() === "0") {
    return;
  }
  const seen = new Set<string>();
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), "openclaw", ".env"),
    path.join(resolveStateDir(env), ".env"),
    env.OPENCLAW_ENV_FILE?.trim(),
  ].filter((p): p is string => Boolean(p));

  let token: string | undefined;
  let password: string | undefined;

  for (const filePath of candidates) {
    if (seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    let parsed: Record<string, string>;
    try {
      parsed = dotenv.parse(content);
    } catch {
      continue;
    }
    for (const [rawKey, value] of Object.entries(parsed)) {
      const key = rawKey.trim();
      if (key === "OPENCLAW_GATEWAY_TOKEN" && value?.trim()) {
        token = value.trim();
      }
      if (key === "OPENCLAW_GATEWAY_PASSWORD" && value?.trim()) {
        password = value.trim();
      }
    }
  }

  if (token) {
    env.OPENCLAW_GATEWAY_TOKEN = token;
  }
  if (password) {
    env.OPENCLAW_GATEWAY_PASSWORD = password;
  }
}

export function stripTrailingDroplet(argv: string[]): { ok: boolean; argv: string[] } {
  if (argv.length < 3) {
    return { ok: false, argv };
  }
  if (argv.at(-1) !== "droplet") {
    return { ok: false, argv };
  }
  return { ok: true, argv: argv.slice(0, -1) };
}

/**
 * True when `tryHandleDropletRemoteCli` will take this invocation (argv ends with `droplet`).
 * Used to avoid stacking `OPENCLAW_REQUIRE_LOCAL_SUDO` (sudo -v then sudo -k) with the droplet
 * helper's own `sudo -v` before SSH, which would otherwise prompt twice.
 */
export function isTrailingDropletRemoteInvocation(argv: string[]): boolean {
  return stripTrailingDroplet(argv).ok;
}

/**
 * Preserve continuity by defaulting remote TUI runs to the primary session unless
 * the caller explicitly chose one.
 */
export function applyDropletTuiDefaultSession(forward: string[]): string[] {
  if (forward[0] !== "tui") {
    return forward;
  }
  let hasHistoryLimit = false;
  for (let i = 1; i < forward.length; i += 1) {
    if (forward[i] === "--session") {
      const next = forward[i + 1];
      if (next?.trim()) {
        // Caller explicitly set the session; keep it.
      } else {
        // Malformed `--session` should still be patched with a sane fallback.
        return [...forward, "--session", "main"];
      }
    }
    if (forward[i] === "--history-limit") {
      hasHistoryLimit = true;
    }
  }
  const next = [...forward];
  const hasSession = forward.some(
    (value, index) => value === "--session" && forward[index + 1]?.trim(),
  );
  if (!hasSession) {
    next.push("--session", "main");
  }
  if (!hasHistoryLimit) {
    // Keep remote context usage bounded by default while still preserving full transcripts on disk.
    next.push("--history-limit", process.env.OPENCLAW_DROPLET_TUI_HISTORY_LIMIT?.trim() || "40");
  }
  return next;
}

function remoteOpenClawBin(): string {
  return process.env.OPENCLAW_REMOTE_BIN?.trim() || "openclaw";
}

/** One shell word for `bash --noprofile --norc -c '…'` on the remote (POSIX single-quote escaping). */
export function bashSingleQuoteWord(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Export lines for gateway auth on the remote: non-login SSH does not load `~/.profile`, and the
 * gateway may only inject secrets into the systemd unit — so the CLI on the droplet often lacks
 * `OPENCLAW_GATEWAY_*` unless we copy them from the local env (already loaded via `loadCliDotEnv`).
 */
export function buildDropletRemoteEnvPrefix(env: NodeJS.ProcessEnv): string {
  if (env.OPENCLAW_DROPLET_FORWARD_GATEWAY_AUTH?.trim() === "0") {
    return "";
  }
  const keys = ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"] as const;
  const parts: string[] = [];
  for (const key of keys) {
    const raw = env[key];
    if (raw === undefined) {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    parts.push(`export ${key}=${bashSingleQuoteWord(trimmed)}`);
  }
  return parts.length > 0 ? `${parts.join("; ")}; ` : "";
}

/** Minimal HOME for SSH `user` (used with `env -i` on the remote). */
export function dropletRemoteHomeForUser(sshUser: string): string {
  return sshUser === "root" ? "/root" : `/home/${sshUser}`;
}

/**
 * Single argv for `ssh host <cmd>`: run OpenClaw in a clean environment so we do not inherit
 * sshd-injected noise (e.g. `BASH_ENV`) or a huge environment dump. Inner command still uses
 * `bash --noprofile --norc` for the actual CLI.
 */
export function buildDropletRemoteSshShellCommand(
  innerBashLcLine: string,
  params: { sshUser: string; term: string },
): string {
  const home = dropletRemoteHomeForUser(params.sshUser);
  const term = params.term.trim() || "xterm-256color";
  const innerQuoted = bashSingleQuoteWord(innerBashLcLine);
  const pathList = [
    `${home}/.local/share/pnpm`,
    `${home}/.local/bin`,
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
    "/snap/bin",
  ].join(":");
  return [
    "env",
    "-i",
    `HOME=${bashSingleQuoteWord(home)}`,
    `USER=${bashSingleQuoteWord(params.sshUser)}`,
    `LOGNAME=${bashSingleQuoteWord(params.sshUser)}`,
    "SHELL=/bin/bash",
    `TERM=${bashSingleQuoteWord(term)}`,
    "LANG=C.UTF-8",
    `PATH=${bashSingleQuoteWord(pathList)}`,
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-c",
    innerQuoted,
  ].join(" ");
}

/**
 * Single argument for `bash --noprofile --norc -c` on the remote. Must be **one** `-c` string so
 * subcommands are not parsed as `$0` (e.g. `bash -c 'openclaw' 'doctor'` runs only `openclaw`
 * and sets `$0` to `doctor`, yielding errors like `doctor: line 1: openclaw: command not found`).
 *
 * When `remoteBin` has no `/`, we resolve a **regular file** executable. A directory named
 * `openclaw` on the server (e.g. `~/openclaw` repo) can appear in PATH before the real CLI
 * and yields `exec: openclaw: cannot execute: Is a directory`.
 *
 * If `remoteBin` is an absolute path, it is passed through to `exec` as-is.
 *
 * @param env - Defaults to `process.env`; inject `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`
 *   here so remote `openclaw tui` can reach the local gateway on the VPS.
 */
export function buildDropletRemoteBashLcLine(
  remoteBin: string,
  forward: string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const envPrefix = buildDropletRemoteEnvPrefix(env);
  const pathExport = `export PATH="$HOME/.local/share/pnpm:$HOME/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/sbin:$PATH"`;
  const forwardQuoted = forward.map(bashSingleQuoteWord).join(" ");

  if (remoteBin.includes("/")) {
    const argvQuoted = [remoteBin, ...forward].map(bashSingleQuoteWord).join(" ");
    return `${envPrefix}${pathExport}; exec ${argvQuoted}`;
  }

  const nameQuoted = bashSingleQuoteWord(remoteBin);
  // Single statement (no `"; ".join` after `do` — that produced `do;` which is a syntax error).
  // Echo message avoids `[…]` inside double quotes (can confuse nested `bash -c` on some setups).
  return `${envPrefix}${pathExport}; _name=${nameQuoted}; _bin=; for _c in "$HOME/.local/share/pnpm/$_name" "$HOME/.local/bin/$_name" "$(npm config get prefix 2>/dev/null)/bin/$_name" "$(command -v "$_name" 2>/dev/null)" "/usr/local/bin/$_name" "/usr/bin/$_name"; do [ -n "$_c" ] && [ -f "$_c" ] && [ -x "$_c" ] && _bin=$_c && break; done; [ -z "$_bin" ] && { echo "openclaw: no executable for $_name; set OPENCLAW_REMOTE_BIN to the binary path" >&2; exit 127; }; exec "$_bin" ${forwardQuoted}`;
}

/**
 * If argv ends with `droplet`, run `sudo -v`, SSH to `DROPLET_SSH_HOST` or `DROPLET_IP`, run `openclaw <args>` on the
 * server, then `sudo -k`. Exits the process.
 * @returns true if handled (caller should return)
 */
export function tryHandleDropletRemoteCli(argv: string[]): boolean {
  const { ok, argv: stripped } = stripTrailingDroplet(argv);
  if (!ok) {
    return false;
  }

  if (process.platform === "win32") {
    console.error(
      "[openclaw] Trailing `droplet` is not supported on Windows (requires OpenSSH `ssh` in PATH). Use WSL or run SSH manually.",
    );
    process.exit(2);
    return true;
  }

  tryLoadDropletIpFromHomeCheckoutEnv();
  mergeDropletForwardGatewayEnvFromEnvFiles(process.env);

  const targetHost = resolveDropletSshTargetHost();
  if (!targetHost) {
    console.error(
      "[openclaw] Trailing `droplet` requires DROPLET_SSH_HOST or DROPLET_IP. Add one to ~/.openclaw/.env, ~/openclaw/.env, or export it (or OPENCLAW_ENV_FILE pointing at an env file). Use DROPLET_SSH_HOST for Tailscale (100.x or MagicDNS) when SSH is not exposed on the public IP.",
    );
    process.exit(2);
    return true;
  }

  const user = process.env.SSH_USER?.trim() || "root";
  const target = `${user}@${targetHost}`;
  const forward = applyDropletTuiDefaultSession(stripped.slice(2));
  const remoteBin = remoteOpenClawBin();

  if (
    forward[0] === "tui" &&
    process.env.OPENCLAW_DROPLET_FORWARD_GATEWAY_AUTH?.trim() !== "0" &&
    !process.env.OPENCLAW_GATEWAY_TOKEN?.trim() &&
    !process.env.OPENCLAW_GATEWAY_PASSWORD?.trim()
  ) {
    console.error(
      "[openclaw] droplet: No OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD found (environment and .env files). The remote TUI will get HTTP 401 against the gateway. Set one of them in ~/.openclaw/.env, $PWD/.env, ~/openclaw/.env, or OPENCLAW_ENV_FILE.",
    );
  }

  let sshOpts: string[];
  try {
    sshOpts = buildDropletSshClientOptions(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
    return true;
  }

  // Local sudo gate must run before any SSH (including the macOS tunneled TUI path).
  refreshDropletLocalSudoGate();

  if (forward[0] === "tui" && process.platform === "darwin") {
    runDropletLocalTuiViaSshTunnel({ target, sshOpts, forward });
  }

  const remoteLine = buildDropletRemoteBashLcLine(remoteBin, forward);
  const sshRemoteArgv = buildDropletRemoteSshShellCommand(remoteLine, {
    sshUser: user,
    term: process.env.TERM ?? "xterm-256color",
  });
  // Non-login, no-rc, clean env: avoids noisy /root/.profile, `BASH_ENV`, and inherited env dumps.
  const ssh = spawnSync("ssh", ["-t", ...sshOpts, target, sshRemoteArgv], { stdio: "inherit" });

  const shouldPlaySshExitChime = (() => {
    const override = process.env.OPENCLAW_DROPLET_SSH_EXIT_CHIME?.trim();
    if (override === "1") {
      return true;
    }
    if (override === "0") {
      return false;
    }
    // Remote `openclaw tui` keeps SSH open until you quit; playing only on SSH
    // exit is not "when the agent finished" — use local `openclaw tui` (same
    // gateway URL/token) for per-reply chime, or set OPENCLAW_DROPLET_SSH_EXIT_CHIME=1
    // to keep the old behavior.
    if (forward[0] === "tui") {
      return false;
    }
    return true;
  })();

  if (!ssh.error && shouldPlaySshExitChime) {
    playMacCompletionChime(ssh.status ?? null);
  }

  revokeDropletLocalSudoGate();

  if (ssh.error) {
    console.error("[openclaw] ssh failed:", ssh.error.message);
    process.exit(1);
    return true;
  }

  const code = ssh.status ?? 1;
  if (code === 127 || code === 126) {
    console.error(
      "[openclaw] Remote shell could not run the OpenClaw CLI. On the droplet run `ls -la /usr/local/bin/openclaw` and `command -v openclaw`. If you have a repo at ~/openclaw, set OPENCLAW_REMOTE_BIN to the real binary (not that directory). Install: https://openclaw.ai/install.sh",
    );
  }

  process.exit(code);
  return true;
}
