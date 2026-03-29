import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDropletSshClientOptions } from "./droplet-ssh-options.js";

describe("buildDropletSshClientOptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses accept-new when no strict mode and no known_hosts", () => {
    const opts = buildDropletSshClientOptions({});
    expect(opts).toEqual(
      expect.arrayContaining([
        "-o",
        "ConnectTimeout=20",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "StrictHostKeyChecking=accept-new",
      ]),
    );
  });

  it("uses strict when OPENCLAW_DROPLET_SSH_STRICT=1", () => {
    const opts = buildDropletSshClientOptions({ OPENCLAW_DROPLET_SSH_STRICT: "1" });
    expect(opts).toContain("StrictHostKeyChecking=yes");
    expect(opts).not.toContain("StrictHostKeyChecking=accept-new");
  });

  it("pins UserKnownHostsFile when path exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-droplet-"));
    const kh = join(dir, "kh");
    writeFileSync(kh, "test.example.com ssh-ed25519 AAAAC3...\n");
    try {
      const opts = buildDropletSshClientOptions({
        OPENCLAW_DROPLET_KNOWN_HOSTS: kh,
      });
      expect(opts).toContain(`UserKnownHostsFile=${kh}`);
      expect(opts).toContain("GlobalKnownHostsFile=/dev/null");
      expect(opts).toContain("StrictHostKeyChecking=yes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when OPENCLAW_DROPLET_KNOWN_HOSTS is missing on disk", () => {
    expect(() =>
      buildDropletSshClientOptions({
        OPENCLAW_DROPLET_KNOWN_HOSTS: "/nonexistent/droplet-known_hosts",
      }),
    ).toThrow(/missing file/);
  });

  it("uses .droplet/known_hosts under cwd when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-droplet-cwd-"));
    const kh = join(dir, ".droplet", "known_hosts");
    mkdirSync(join(dir, ".droplet"), { recursive: true });
    writeFileSync(kh, "127.0.0.1 ssh-ed25519 AAAAC3...\n");
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      const opts = buildDropletSshClientOptions({});
      expect(opts.some((o) => o === `UserKnownHostsFile=${kh}`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
