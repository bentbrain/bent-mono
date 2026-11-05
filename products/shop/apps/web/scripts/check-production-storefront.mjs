import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL("../", import.meta.url));

// Optional fixture-only qualification, not another routine CI gate. The build
// and server entrypoints replace inherited application credentials and disable
// external network access. Playwright runs directly, without the CI task cache.
for (const args of [
  [fileURLToPath(new URL("../e2e/local/start.mjs", import.meta.url)), "build"],
  [require.resolve("@playwright/test/cli"), "test", "--config", "playwright.local.config.ts",
    "--project", "local-desktop", "--grep", "configured product streams estimates"],
]) {
  const result = spawnSync(process.execPath, args, {
    cwd, env: { ...process.env, E2E_LOCAL_PRODUCTION: "1" },
    encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "Production storefront fixture failed");
  // A page can still return 200 after Next turns a failed cache warm into a
  // dynamic hole. The DOM assertions alone cannot catch that regression.
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`,
    /Unexpected cache miss after cache warming/,
    "Estimate invalidation must not break Shipping-page prefetch");
}
