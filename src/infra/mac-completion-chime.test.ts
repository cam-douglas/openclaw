import { describe, expect, it } from "vitest";
import { resolveMacCompletionSoundPathFromEnv } from "./mac-completion-chime.js";

describe("resolveMacCompletionSoundPathFromEnv", () => {
  it("defaults to Funk (funky / Funk system effect)", () => {
    expect(resolveMacCompletionSoundPathFromEnv({})).toBe("/System/Library/Sounds/Funk.aiff");
  });

  it("aliases funky and funk to Funk", () => {
    expect(resolveMacCompletionSoundPathFromEnv({ OPENCLAW_COMPLETION_SOUND_NAME: "funky" })).toBe(
      "/System/Library/Sounds/Funk.aiff",
    );
    expect(resolveMacCompletionSoundPathFromEnv({ OPENCLAW_COMPLETION_SOUND_NAME: "FUNK" })).toBe(
      "/System/Library/Sounds/Funk.aiff",
    );
  });

  it("uses explicit path when set", () => {
    expect(
      resolveMacCompletionSoundPathFromEnv({
        OPENCLAW_COMPLETION_SOUND_PATH: "/custom/x.aiff",
        OPENCLAW_COMPLETION_SOUND_NAME: "Ping",
      }),
    ).toBe("/custom/x.aiff");
  });

  it("uses DROPLET name when COMPLETION name unset", () => {
    expect(
      resolveMacCompletionSoundPathFromEnv({ OPENCLAW_DROPLET_COMPLETION_SOUND_NAME: "Glass" }),
    ).toBe("/System/Library/Sounds/Glass.aiff");
  });
});
