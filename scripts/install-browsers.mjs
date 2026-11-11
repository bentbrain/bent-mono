import { includesPath, workspaceScope } from "./ci-scope.mjs";
import { installPlaywright } from "./install-playwright.mjs";

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
for (const application of selected) {
  // Each test runner must install its own matching browser revision.
  installPlaywright(application, ["chromium", ...(group === "shop" ? [] : ["webkit"])]);
}
