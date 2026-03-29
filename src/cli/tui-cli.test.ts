import { describe, expect, it } from "vitest";
import { normalizeTuiHistoryLimit } from "./tui-cli.js";

describe("normalizeTuiHistoryLimit", () => {
  it("defaults to 200 when unset", () => {
    expect(normalizeTuiHistoryLimit(undefined)).toBe(200);
  });

  it("clamps 0 and negatives to 1", () => {
    expect(normalizeTuiHistoryLimit(0)).toBe(1);
    expect(normalizeTuiHistoryLimit("-5")).toBe(1);
  });

  it("keeps positive values", () => {
    expect(normalizeTuiHistoryLimit(1)).toBe(1);
    expect(normalizeTuiHistoryLimit("250")).toBe(250);
  });

  it("returns undefined for invalid numbers", () => {
    expect(normalizeTuiHistoryLimit("nope")).toBeUndefined();
  });
});
