import path from "node:path";
import type { ExecCommandSegment } from "./exec-approvals-analysis.js";
import { resolveExecutionTargetResolution } from "./exec-approvals-analysis.js";

export type DangerousExecDetection = {
  detected: boolean;
  reasons: string[];
};

function toBinName(segment: ExecCommandSegment): string {
  const execution = resolveExecutionTargetResolution(segment.resolution);
  const raw = execution?.executableName ?? execution?.rawExecutable ?? segment.argv[0] ?? "";
  return path.basename(String(raw)).trim().toLowerCase();
}

function hasFlag(argv: string[], exact: string): boolean {
  return argv.some((token) => token === exact);
}

function hasShortFlag(argv: string[], shortFlag: string): boolean {
  return argv.some((token) => token.startsWith("-") && token.includes(shortFlag));
}

function hasOutputRedirection(command: string): boolean {
  return /(^|[^\w\\])(>>?|[0-2]>>?|[0-2]>|&>|1>&2|2>&1)(\s|$)/.test(command);
}

function pushUnique(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function detectDangerousSegment(segment: ExecCommandSegment, reasons: string[]): void {
  const argv = segment.resolution?.effectiveArgv ?? segment.argv;
  const bin = toBinName(segment);
  if (!bin || argv.length === 0) {
    return;
  }

  if (bin === "rm" || bin === "unlink" || bin === "shred" || bin === "truncate" || bin === "srm") {
    pushUnique(reasons, "destructive file delete/truncate command");
    return;
  }

  if (
    bin === "dd" ||
    bin === "fdisk" ||
    bin === "parted" ||
    bin === "wipefs" ||
    bin.startsWith("mkfs")
  ) {
    pushUnique(reasons, "disk/partition destructive command");
    return;
  }

  if (
    bin === "shutdown" ||
    bin === "reboot" ||
    bin === "halt" ||
    bin === "poweroff" ||
    (bin === "systemctl" && (argv[1] === "reboot" || argv[1] === "halt" || argv[1] === "poweroff"))
  ) {
    pushUnique(reasons, "system shutdown/reboot command");
    return;
  }

  if (bin === "git") {
    const sub = (argv[1] ?? "").toLowerCase();
    if (sub === "merge" || sub === "rebase" || sub === "cherry-pick") {
      pushUnique(reasons, `git history/state rewrite command (${sub})`);
      return;
    }
    if (sub === "reset" && hasFlag(argv, "--hard")) {
      pushUnique(reasons, "git reset --hard");
      return;
    }
    if (sub === "clean" && (hasFlag(argv, "-f") || hasShortFlag(argv, "f"))) {
      pushUnique(reasons, "git clean with force");
      return;
    }
    if (sub === "push" && (hasFlag(argv, "--force") || hasFlag(argv, "--force-with-lease"))) {
      pushUnique(reasons, "git push --force/--force-with-lease");
      return;
    }
    if (sub === "checkout" && hasFlag(argv, "--")) {
      pushUnique(reasons, "git checkout -- <paths> overwrite");
      return;
    }
    if (sub === "restore" && (hasFlag(argv, "--staged") || hasFlag(argv, "--worktree"))) {
      pushUnique(reasons, "git restore staged/worktree overwrite");
      return;
    }
  }
}

export function detectDangerousExecCommand(params: {
  command: string;
  segments: ExecCommandSegment[];
}): DangerousExecDetection {
  const reasons: string[] = [];
  for (const segment of params.segments) {
    detectDangerousSegment(segment, reasons);
  }
  if (hasOutputRedirection(params.command)) {
    pushUnique(reasons, "shell output redirection can overwrite files");
  }
  return { detected: reasons.length > 0, reasons };
}
