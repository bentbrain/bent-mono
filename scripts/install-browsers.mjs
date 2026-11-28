import { includesPath, workspaceScope } from "./ci-scope.mjs";
import { installPlaywright } from "./install-playwright.mjs";

if (process.argv[2] !== "browser") throw new Error("Select browser.");
const applications = [
  "apps/jp",
  "apps/toolbar",
  "apps/trackmap",
  "apps/fitness",
];
const app = process.argv[3];
const scope = app
  ? null
  : workspaceScope(process.env, undefined, { browser: true });
const selected = applications.filter((directory) =>
  scope ? includesPath(scope, directory) : directory === `apps/${app}`,
);
for (const application of selected) {
  // Each test runner must install its own matching browser revision.
  installPlaywright(application, ["chromium", "webkit"]);
}
