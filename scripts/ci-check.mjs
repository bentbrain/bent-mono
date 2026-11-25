import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { browserMatrix, includesPath, workspaceScope } from "./ci-scope.mjs";

const [task, app, part, total] = process.argv.slice(2);
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

const selectedBrowser = task === "browser" && app ? `apps/${app}` : null;
if (selectedBrowser && !browserMatrix({ packages: [{ path: selectedBrowser }] })
  .some((entry) => String(entry.part) === part && String(entry.total) === total)) {
  throw new Error("Select a planned browser suite and shard.");
}
const scope = selectedBrowser ? null : workspaceScope(process.env, undefined, { browser: task === "browser" });
const affected = (directory) => scope ? includesPath(scope, directory) : directory === selectedBrowser;
console.log(scope
  ? `CI: ${scope.reason}: ${scope.packages.map((item) => item.name).join(", ") || "no affected workspaces"}`
  : `CI: ${selectedBrowser} (${part}/${total})`);

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

function application(directory, script, overrides, args = []) {
  if (affected(directory))
    run("bun", ["run", script, ...args], resolve(directory), overrides);
}

if (task === "browser") {
  const shard = selectedBrowser && total !== "1" ? [`--shard=${part}/${total}`] : [];
  application("apps/fitness", "test:browser", { VITE_CLERK_PUBLISHABLE_KEY: "", CLERK_SECRET_KEY: "", DATABASE_URL: "", FITNESS_ALLOWED_EMAILS: "" });
  application("apps/trackmap", "build");
  application("apps/trackmap", "test:browser");
  if (!selectedBrowser || part === "1") application("apps/jp", "test:e2e:coverage");
  application("apps/jp", "test:e2e", undefined, shard);
  application("apps/toolbar", "build");
  application("apps/toolbar", "test:e2e", undefined, shard);
  application("apps/home", "build");
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
    ]);
  const packages = scope.packages;
  if (packages.length)
    run(resolve("node_modules/.bin/turbo"), [
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
