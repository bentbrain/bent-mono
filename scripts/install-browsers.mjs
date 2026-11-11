import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { includesPath, workspaceScope } from "./ci-scope.mjs";
import { prepareUbuntuArchive } from "./prepare-ubuntu-archive.mjs";

const scope = workspaceScope();
const group = process.argv[2];
const applications =
  group === "shop"
    ? ["products/shop/apps/web"]
    : group === "browser"
      ? ["apps/jp", "apps/toolbar", "apps/trackmap"]
      : null;
if (!applications) throw new Error("Select browser or shop.");
const selected = applications.filter((directory) => includesPath(scope, directory));
if (selected.length) prepareUbuntuArchive();
for (const application of selected) {
  // Each test runner must install its own matching browser revision.
  const require = createRequire(resolve(application, "package.json"));
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("@playwright/test/cli"),
      "install",
      "--with-deps",
      "chromium",
      ...(group === "shop" ? [] : ["webkit"]),
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
