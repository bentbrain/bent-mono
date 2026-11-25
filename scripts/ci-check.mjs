import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { includesPath, workspaceScope } from "./ci-scope.mjs";
import {
  playwrightFileFilters,
  reportTestSelection,
  selectTestFiles,
  testSelectionContext,
} from "./ci-test-selection.mjs";

const task = process.argv[2];
const allowed = [
  "lint",
  "typecheck",
  "test",
  "knip",
  "build",
  "test:integration",
  "browser",
];
if (!allowed.includes(task)) throw new Error("Select a known workspace check.");

const regression = ["browser", "test", "test:integration"].includes(task);
const scope = workspaceScope(undefined, undefined, { regression });
const affected = (directory) => includesPath(scope, directory);
console.log(
  `CI: ${scope.reason}: ${scope.packages.map((item) => item.name).join(", ") || "no affected workspaces"}`,
);
const selection = regression ? testSelectionContext() : null;
function testPlan(directory) {
  const plan = selectTestFiles(directory, task, selection);
  reportTestSelection(directory, task, plan);
  return plan;
}

// Disposable CI fixtures only. This runner never reads a production environment.
const env = {
  ...process.env,
  CI: "true",
  SKIP_ENV_VALIDATION: "1",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
    "pk_test_" + Buffer.from("example.invalid$").toString("base64"),
  CLERK_SECRET_KEY: "sk_test_" + "placeholder",
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
  PAYLOAD_SECRET: "synthetic-build-fixture",
  DATABASE_URI: "postgresql://test:test@127.0.0.1:9/test",
  UPLOADTHING_TOKEN: Buffer.from(
    JSON.stringify({
      apiKey: "sk_" + "fixture",
      appId: "fixture",
      regions: ["sea1"],
    }),
  ).toString("base64"),
  FITNESS_TEST_DATABASE_URL: process.env.PAYLOAD_MIGRATION_TEST_DATABASE_URI ?? "",
  PUBLIC_HOME_LATITUDE: "0",
  PUBLIC_HOME_LONGITUDE: "0",
  PUBLIC_HOME_BALCONY_BEARING: "90",
  PUBLIC_HOME_ALTITUDE_METRES: "1",
};

function run(command, args, cwd = process.cwd(), overrides = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, ...overrides },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function application(directory, script, overrides) {
  if (affected(directory))
    run("bun", ["run", script], resolve(directory), overrides);
}

function browser(directory, script, overrides) {
  if (!affected(directory)) return;
  const plan = testPlan(directory);
  const metrics = directory === "apps/jp" && plan.files
    ? { BROWSER_METRICS_DIR: "artifacts/browser/selected" }
    : {};
  run(
    "bun",
    ["run", script, ...playwrightFileFilters(plan.files ?? [])],
    resolve(directory),
    { ...overrides, ...metrics },
  );
}

if (task === "browser") {
  browser("apps/fitness", "test:browser", { VITE_CLERK_PUBLISHABLE_KEY: "", CLERK_SECRET_KEY: "", DATABASE_URL: "", FITNESS_ALLOWED_EMAILS: "" });
  application("apps/trackmap", "build");
  browser("apps/trackmap", "test:browser");
  application("apps/jp", "test:e2e:coverage");
  browser("apps/jp", "test:e2e", { E2E_TIER: "full" });
  application("apps/toolbar", "build");
  browser("apps/toolbar", "test:e2e");
  application("apps/home", "build");
  if (affected("apps/home")) testPlan("apps/home");
  application("apps/home", "test:worker");
} else {
  if (task === "lint") {
    application("apps/toolbar", "format:check");
    application("apps/stay", "format:check");
  }
  if (task === "test")
    run("node", [
      "--test",
      "scripts/public-source.test.mjs",
      "scripts/workspace.test.mjs",
      "scripts/ci-scope.test.mjs",
      "scripts/ci-test-selection.test.mjs",
    ]);
  const turbo = resolve("node_modules/.bin/turbo");
  const packages = scope.packages.filter((item) => {
    if (!regression) return true;
    const { scripts } = JSON.parse(
      readFileSync(resolve(item.path, "package.json"), "utf8"),
    );
    if (typeof scripts?.[task] !== "string") return true;
    const plan = testPlan(item.path);
    if (!plan.files) return true;
    run(turbo, ["run", "test:files", `--filter=${item.name}`, "--", ...plan.files]);
    return false;
  });
  if (packages.length)
    run(turbo, [
      "run",
      task,
      ...(task === "typecheck" ? ["check-types", "types:check"] : []),
      "--concurrency=2",
      ...packages.map((item) => `--filter=${item.name}`),
    ]);
  if (task === "build") {
    application("apps/home", "build:card");
    application("apps/toolbar", "worker:check");
    // Exercise immutable asset paths separately from the unversioned fixture
    // builds. This checks packaging integrity; it never qualifies a release.
    const toolbarVersion = {
      GITHUB_SHA: process.env.GITHUB_SHA || "0".repeat(40),
    };
    application("apps/toolbar", "build", toolbarVersion);
    application("apps/toolbar", "build:vercel", toolbarVersion);
    if (affected("apps/toolbar"))
      run(
        "bun",
        ["run", "deploy:vercel", "--dry-run"],
        resolve("apps/toolbar"),
        toolbarVersion,
      );
  }
}
