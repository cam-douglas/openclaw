import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * OpenSSH client `-o` options for `openclaw … droplet` (parity with scripts/droplet-ssh-common.sh).
 */
export function buildDropletSshClientOptions(env: NodeJS.ProcessEnv): string[] {
  const opts: string[] = [
    "-o",
    "ConnectTimeout=20",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
  ];

  const explicitKh = env.OPENCLAW_DROPLET_KNOWN_HOSTS?.trim();
  const strict = env.OPENCLAW_DROPLET_SSH_STRICT === "1";

  if (explicitKh && !existsSync(explicitKh)) {
    throw new Error(
      `[openclaw] OPENCLAW_DROPLET_KNOWN_HOSTS points to missing file: ${explicitKh}\n` +
        `hint: run ./scripts/droplet-record-host-key.sh or unset OPENCLAW_DROPLET_KNOWN_HOSTS`,
    );
  }

  let kh = explicitKh;
  if (!kh) {
    const cwdKh = join(process.cwd(), ".droplet", "known_hosts");
    if (existsSync(cwdKh)) {
      kh = cwdKh;
    }
  }

  if (kh && existsSync(kh)) {
    opts.push(
      "-o",
      `UserKnownHostsFile=${kh}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "StrictHostKeyChecking=yes",
    );
  } else if (strict) {
    opts.push("-o", "StrictHostKeyChecking=yes");
  } else {
    opts.push("-o", "StrictHostKeyChecking=accept-new");
  }

  // Optional: disable ssh-agent for this connection so an encrypted key prompts for passphrase
  // (use with OPENCLAW_DROPLET_SSH_IDENTITY). Does not affect server-side auth policy.
  if (env.OPENCLAW_DROPLET_SSH_IDENTITY_AGENT_NONE?.trim() === "1") {
    opts.push("-o", "IdentityAgent=none");
  }

  const identity = env.OPENCLAW_DROPLET_SSH_IDENTITY?.trim();
  if (identity) {
    opts.push("-o", `IdentityFile=${identity}`);
  }

  return opts;
}
