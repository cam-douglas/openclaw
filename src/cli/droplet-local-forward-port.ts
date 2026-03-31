import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * Picks the first TCP port starting at `preferred` on 127.0.0.1 that can be bound (same check SSH
 * will use for `-L`). Used so `openclaw tui droplet` does not fail when 18790 is already taken by
 * the bridge or another tunnel.
 */
export function findAvailableLocalForwardPortSync(preferred: number): number {
  const start = Math.floor(Math.max(1, Math.min(65_535, preferred)));
  const script = `
const net = require('net');
const start = ${start};
(async () => {
  for (let off = 0; off <= 64; off++) {
    const port = start + off;
    if (port > 65535) break;
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => {
        s.close(() => resolve(true));
      });
    });
    if (ok) {
      console.log(String(port));
      process.exit(0);
    }
  }
  process.exit(1);
})();
`;
  const r = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    throw new Error(
      `[openclaw] No free TCP port for SSH tunnel near ${start}. Set OPENCLAW_DROPLET_TUI_FORWARD_PORT to an unused port.`,
    );
  }
  const line = r.stdout?.trim();
  const chosen = Number.parseInt(line ?? "", 10);
  if (!Number.isFinite(chosen)) {
    throw new Error("[openclaw] Failed to resolve local forward port (unexpected output).");
  }
  return chosen;
}
