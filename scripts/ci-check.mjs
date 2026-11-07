import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { includesPath, workspaceScope } from "./ci-scope.mjs";
import { validationEnvironment } from "../products/shop/scripts/validation-environment.mjs";

const scope = workspaceScope();
const affected = (directory) => includesPath(scope, directory);
console.log(
  `CI: ${scope.reason}: ${scope.packages.map((item) => item.name).join(", ") || "no affected workspaces"}`,
);
const task = process.argv[2];
const allowed = [
  "lint",
  "typecheck",
  "test",
  "knip",
  "build",
  "test:integration",
  "browser",
  "shop",
];
if (!allowed.includes(task)) throw new Error("Select a known workspace check.");

// Disposable CI fixtures only. This runner never reads a production environment.
const env = {
  ...validationEnvironment(process.env),
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

if (task === "browser") {
  application("apps/trackmap", "build");
  application("apps/trackmap", "test:browser");
  application("apps/jp", "test:e2e:coverage");
  application("apps/jp", "test:e2e");
  application("apps/toolbar", "build");
  application("apps/toolbar", "test:e2e");
  application("apps/home", "build");
  application("apps/home", "test:worker");
} else if (task === "shop") {
  if (scope.full) {
    application("products/shop", "test:pipeline");
    application("products/shop", "test:e2e:local");
  } else {
    application("products/shop", "test:smoke");
  }
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
  const packages = scope.packages.filter(
    (item) =>
      !(
        task === "test" &&
        !scope.full &&
        item.path.startsWith("products/shop")
      ),
  );
  if (packages.length)
    run(resolve("node_modules/.bin/turbo"), [
      "run",
      task,
      ...(task === "typecheck" ? ["check-types", "types:check"] : []),
      "--concurrency=2",
      ...packages.map((item) => `--filter=${item.name}`),
    ]);
  if (task === "test" && !scope.full) application("products/shop", "test:core");
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
