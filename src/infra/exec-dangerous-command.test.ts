import { describe, expect, it } from "vitest";
import { analyzeShellCommand } from "./exec-approvals-analysis.js";
import { detectDangerousExecCommand } from "./exec-dangerous-command.js";

function detect(command: string) {
  const analysis = analyzeShellCommand({ command, cwd: "/tmp" });
  return detectDangerousExecCommand({
    command,
    segments: analysis.ok ? analysis.segments : [],
  });
}

describe("detectDangerousExecCommand", () => {
  it("flags destructive file and git operations", () => {
    expect(detect("rm -rf ./tmp").detected).toBe(true);
    expect(detect("git reset --hard HEAD~1").detected).toBe(true);
    expect(detect("git push --force-with-lease origin main").detected).toBe(true);
  });

  it("flags shell redirection overwrite patterns", () => {
    const result = detect("echo test > out.txt");
    expect(result.detected).toBe(true);
    expect(result.reasons.some((reason) => reason.includes("redirection"))).toBe(true);
  });

  it("does not flag normal read-only commands", () => {
    expect(detect("ls -la").detected).toBe(false);
    expect(detect("git status").detected).toBe(false);
    expect(detect("pnpm test -- --help").detected).toBe(false);
  });
});
