/**
 * macOS completion chime (`afplay`) for local UX: `openclaw … droplet` (SSH) and TUI run completion.
 * The droplet/VPS never invokes the Mac; only local processes call this.
 *
 * Default system effect is **Funk** (`Funk.aiff` under `/System/Library/Sounds/`). In System Settings
 * it may be described informally as "funky"; use `OPENCLAW_COMPLETION_SOUND_NAME=funky` if you want
 * that alias, or set `OPENCLAW_COMPLETION_SOUND_NAME=Funk` explicitly.
 */
import { spawnSync } from "node:child_process";
import process from "node:process";

export const DEFAULT_OPENCLAW_COMPLETION_SOUND_PATH = "/System/Library/Sounds/Funk.aiff";

const SYSTEM_SOUNDS_DIR = "/System/Library/Sounds";

/** Map informal / UI names to the on-disk `.aiff` basename (case-sensitive for the file). */
const SYSTEM_SOUND_BASENAME_ALIASES: Record<string, string> = {
  funky: "Funk",
  funk: "Funk",
};

function resolveSystemSoundBasename(raw: string | undefined): string {
  if (!raw?.trim()) {
    return "Funk";
  }
  const trimmed = raw.trim();
  const alias = SYSTEM_SOUND_BASENAME_ALIASES[trimmed.toLowerCase()];
  if (alias) {
    return alias;
  }
  return trimmed;
}

/**
 * Resolves which file `afplay` should use. Explicit `*_SOUND_PATH` wins; otherwise builds
 * `SYSTEM_SOUNDS_DIR/<name>.aiff` from `OPENCLAW_COMPLETION_SOUND_NAME` or
 * `OPENCLAW_DROPLET_COMPLETION_SOUND_NAME` (default basename Funk).
 */
export function resolveMacCompletionSoundPathFromEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const explicit =
    env.OPENCLAW_COMPLETION_SOUND_PATH?.trim() ||
    env.OPENCLAW_DROPLET_COMPLETION_SOUND_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  const nameRaw =
    env.OPENCLAW_COMPLETION_SOUND_NAME?.trim() ||
    env.OPENCLAW_DROPLET_COMPLETION_SOUND_NAME?.trim();
  const base = resolveSystemSoundBasename(nameRaw);
  return `${SYSTEM_SOUNDS_DIR}/${base}.aiff`;
}

function isCompletionSoundGloballyDisabled(): boolean {
  if (process.env.OPENCLAW_COMPLETION_SOUND?.trim() === "0") {
    return true;
  }
  if (process.env.OPENCLAW_DROPLET_COMPLETION_SOUND?.trim() === "0") {
    return true;
  }
  return false;
}

export type PlayMacCompletionChimeOptions = {
  /**
   * When set, `OPENCLAW_TUI_COMPLETION_SOUND=0` disables this call only (SSH/droplet chime unchanged).
   */
  tui?: boolean;
};

/**
 * @param exitStatus — 0 = success; non-zero skips when `OPENCLAW_DROPLET_COMPLETION_SOUND_SUCCESS_ONLY=1`.
 */
export function playMacCompletionChime(
  exitStatus: number | null,
  opts?: PlayMacCompletionChimeOptions,
): void {
  if (isCompletionSoundGloballyDisabled()) {
    return;
  }
  if (opts?.tui && process.env.OPENCLAW_TUI_COMPLETION_SOUND?.trim() === "0") {
    return;
  }
  if (process.platform !== "darwin") {
    return;
  }
  if (process.env.OPENCLAW_DROPLET_COMPLETION_SOUND_SUCCESS_ONLY?.trim() === "1") {
    if (exitStatus !== 0) {
      return;
    }
  }
  const soundPath = resolveMacCompletionSoundPathFromEnv(process.env);
  if (!soundPath) {
    return;
  }
  try {
    spawnSync("afplay", [soundPath], { stdio: "ignore" });
  } catch {
    // Missing afplay or unreadable path: ignore.
  }
}
