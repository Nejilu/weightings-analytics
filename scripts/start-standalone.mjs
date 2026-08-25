import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { prepareStandaloneAssets } from "./start-standalone-assets.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = resolve(projectRoot, ".next", "standalone", "server.js");

export function startStandalone() {
  if (!existsSync(serverPath)) {
    console.error("Standalone server is missing. Run npm run build first.");
    process.exitCode = 1;
    return;
  }
  const assets = prepareStandaloneAssets(projectRoot);
  if (!assets.staticCopied) {
    console.error("Standalone static assets are missing. Run npm run build first.");
    process.exitCode = 1;
    return;
  }

  const child = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOSTNAME: "0.0.0.0",
      DRIZZLE_MIGRATIONS_PATH: process.env.DRIZZLE_MIGRATIONS_PATH ??
        resolve(projectRoot, "drizzle"),
    },
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(`Unable to start standalone server: ${error.message}`);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  startStandalone();
}
