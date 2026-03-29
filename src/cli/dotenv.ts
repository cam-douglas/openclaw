import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadRuntimeDotEnvFile, loadWorkspaceDotEnvFile } from "../infra/dotenv.js";

export function loadCliDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;
  const explicitEnvPath = process.env.OPENCLAW_ENV_FILE?.trim();
  if (explicitEnvPath) {
    loadWorkspaceDotEnvFile(explicitEnvPath, { quiet });
  }
  const cwdEnvPath = path.join(process.cwd(), ".env");
  loadWorkspaceDotEnvFile(cwdEnvPath, { quiet });

  // Typical git clone at ~/openclaw/.env so `openclaw … droplet` works outside the repo cwd.
  const homeDir = process.env.HOME?.trim() || os.homedir();
  const homeCheckoutEnvPath = path.join(homeDir, "openclaw", ".env");
  loadWorkspaceDotEnvFile(homeCheckoutEnvPath, { quiet });

  // Then load the global fallback from the active state dir without overriding
  // any env vars that were already set or loaded from CWD.
  const globalEnvPath = path.join(resolveStateDir(process.env), ".env");
  loadRuntimeDotEnvFile(globalEnvPath, { quiet });
}
