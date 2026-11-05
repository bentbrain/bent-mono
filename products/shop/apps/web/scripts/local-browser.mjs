import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export function localBrowserCommands(env = process.env, args = []) {
  const shard = env.PLAYWRIGHT_SHARD;
  if (shard && !/^[1-9][0-9]*\/[1-9][0-9]*$/.test(shard)) throw Error("Invalid browser shard.");
  const [index, total] = shard ? shard.split("/").map(Number) : [1, 1];
  if (index > total || total > 64) throw Error("Invalid browser shard.");
  return [
    ["test", "--config", "playwright.local.config.ts", ...(shard ? [`--shard=${shard}`] : []), ...args],
    // This separate analytics server has two tests in one file. Run it once.
    ...(index === 1 ? [["test", "--config", "playwright.posthog.config.ts", ...args]] : []),
  ];
}

if (import.meta.main) {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  for (const args of localBrowserCommands(process.env, process.argv.slice(2))) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env: process.env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
}
