import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { validationEnvironment } from "./validation-environment.mjs";

// Routine prelaunch coverage. The complete test commands remain the release and
// scheduled regression suite; no external service or production data is needed.
const checks = [
  [
    ".",
    [
      "node",
      "--import",
      "./scripts/test-protected-config.mjs",
      "--test",
      "scripts/protected-config.test.mjs",
      "scripts/contract-consumers.test.mjs",
      "scripts/local-browser.test.mjs",
    ],
  ],
  ["apps/web", ["bun", "run", "test"]],
  ["workers/api", ["node", "scripts/check-revision-migration.mjs"]],
  [
    "workers/api",
    [
      "bun",
      "x",
      "--no-install",
      "vitest",
      "run",
      "src/immutable-product-contract.test.ts",
      "src/cart-line-capability.test.ts",
      "src/cart-line-capabilities.test.ts",
      "src/product-purchase-readiness.test.ts",
    ],
  ],
  [
    "workers/video-renderer",
    [
      "node",
      "--import",
      "../../scripts/test-protected-config.mjs",
      "--test",
      "src/geometry.test.mjs",
      "src/filters.test.mjs",
      "src/server-auth.test.mjs",
      "custom/inputs.test.mjs",
    ],
  ],
];
for (const [directory, [command, ...args]] of checks) {
  const result = spawnSync(command, args, {
    cwd: resolve(directory),
    env: validationEnvironment(process.env),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
