import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { findAvailableLocalForwardPortSync } from "./droplet-local-forward-port.js";

describe("findAvailableLocalForwardPortSync", () => {
  it("returns preferred when it is bindable", () => {
    const p = findAvailableLocalForwardPortSync(45_678);
    expect(p).toBe(45_678);
  });

  it("returns the next free port when preferred is taken", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(45_679, "127.0.0.1", () => resolve());
    });
    try {
      const p = findAvailableLocalForwardPortSync(45_679);
      expect(p).toBe(45_680);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
