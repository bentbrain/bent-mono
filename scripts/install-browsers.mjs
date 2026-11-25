import { includesPath, workspaceScope } from "./ci-scope.mjs";
import { installPlaywright } from "./install-playwright.mjs";

if (process.argv[2] !== "browser") throw new Error("Select browser.");
const scope = workspaceScope(undefined, undefined, { regression: true });
const applications = ["apps/jp", "apps/toolbar", "apps/trackmap", "apps/fitness"];
const selected = applications.filter((directory) => includesPath(scope, directory));
for (const application of selected) {
  // Each test runner must install its own matching browser revision.
  installPlaywright(application, ["chromium", "webkit"]);
}
