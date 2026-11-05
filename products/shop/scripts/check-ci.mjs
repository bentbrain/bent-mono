import { validationEnvironment } from "./validation-environment.mjs";
import { spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";
const executable = isWindows ? "cmd.exe" : "bun";
const args = isWindows ? ["/d", "/s", "/c", "bun run shop:check"] : ["run", "shop:check"];
const result = spawnSync(executable, args, {
  env: validationEnvironment(),
  stdio: "inherit",
});

if (result.error) {
  console.error(`Unable to start Bun: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
