import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { comparison, includesPath, workspaceScope } from "./ci-scope.mjs";

const packages = [
  { name: "@bent/trackmap", path: "apps/trackmap" },
  { name: "@bent/design-tokens", path: "packages/design-tokens" },
  { name: "@bent/shop-product", path: "products/shop" },
  { name: "@forever-tee/web", path: "products/shop/apps/web" },
  { name: "@forever-tee/api", path: "products/shop/workers/api" },
];
packages.push(
  { name: "@bent/drive-product", path: "products/drive" },
  { name: "@bent/drive-web", path: "products/drive/apps/web" },
);
const base = "a".repeat(40),
  head = "b".repeat(40);
function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "ci-scope-"));
  const eventPath = join(directory, "event.json");
  writeFileSync(
    eventPath,
    JSON.stringify({ pull_request: { base: { sha: base } } }),
  );
  try {
    run({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA: head,
      GITHUB_EVENT_PATH: eventPath,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function execute(files, affected, fail = false) {
  return (command, args, options) => {
    if (command === "git") {
      assert.deepEqual(args.slice(-2), [base, head]);
      if (fail) throw new Error("Missing base history");
      return files.join("\0") + "\0";
    }
    if (args.includes("--affected")) {
      assert.equal(options.env.TURBO_SCM_BASE, base);
      assert.equal(options.env.TURBO_SCM_HEAD, head);
    }
    return JSON.stringify({
      packages: { items: args.includes("--affected") ? affected : packages },
    });
  };
}

test("PR, push and merge queue use explicit event bases; missing or zero history widens", () => {
  assert.deepEqual(
    comparison("pull_request", { pull_request: { base: { sha: base } } }, head),
    { base, head },
  );
  assert.deepEqual(comparison("push", { before: base }, head), { base, head });
  assert.deepEqual(
    comparison("merge_group", { merge_group: { base_sha: base } }, head),
    { base, head },
  );
  assert.equal(comparison("push", { before: "0".repeat(40) }, head), null);
  assert.equal(comparison("pull_request", {}, head), null);
});
test("an app-only dependency and lockfile update does not select Shop", () =>
  fixture((env) => {
    const scope = workspaceScope(
      env,
      execute(["apps/trackmap/package.json", "bun.lock"], [packages[0]]),
    );
    assert.deepEqual(scope.packages, [packages[0]]);
    assert.equal(includesPath(scope, "products/shop"), false);
  }));
test("shared consumers supplied by Turbo and Shop's relative imports are retained", () =>
  fixture((env) => {
    const scope = workspaceScope(
      env,
      execute(["packages/design-tokens/src/index.css"], packages.slice(1, 4)),
    );
    assert.equal(includesPath(scope, "products/shop/workers/api"), true);
    assert.equal(includesPath(scope, "products/shop/apps/web"), true);
  }));
test("Shop tooling, root changes, deleted workspace paths and missing history fail closed", () =>
  fixture((env) => {
    for (const files of [
      ["products/shop/scripts/check-ci.mjs"],
      ["package.json"],
      ["scripts/ci-check.mjs"],
      ["apps/removed/package.json"],
    ]) {
      const scope = workspaceScope(env, execute(files, [packages[2]]));
      assert.equal(includesPath(scope, "products/shop/apps/web"), true);
    }
    assert.deepEqual(
      workspaceScope(env, execute([], [], true)).packages,
      packages,
    );
    assert.deepEqual(
      workspaceScope({ ...env, GITHUB_EVENT_NAME: "schedule" }, execute([], []))
        .packages,
      packages,
    );
    assert.equal(
      workspaceScope(
        { ...env, GITHUB_EVENT_NAME: "workflow_dispatch" },
        execute([], []),
      ).full,
      true,
    );
  }));
test("the real runner skips unrelated Shop and preserves Shop static checks without nested suites", () =>
  fixture((env) => {
    function commands(task, shop, full = false) {
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import childProcess from "node:child_process";
      import {syncBuiltinESMExports} from "node:module";
      const packages = ${JSON.stringify(packages)};
      const calls = [];
      childProcess.execFileSync = (command, args) => command === "git" ? ${JSON.stringify(shop ? "products/shop/apps/web/src/page.tsx\0" : "apps/trackmap/src/main.ts\0")} : JSON.stringify({packages:{items:args.includes("--affected") ? packages.filter(item => ${shop} ? item.path.startsWith("products/shop") : item.path === "apps/trackmap") : packages}});
      childProcess.spawnSync = (command,args,options) => { calls.push({command,args,cwd:options.cwd}); return {status:0}; };
      syncBuiltinESMExports();
      process.argv[2] = ${JSON.stringify(task)};
      await import("./scripts/ci-check.mjs");
      console.log(JSON.stringify(calls));
    `,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            ...env,
            ...(full ? { GITHUB_EVENT_NAME: "schedule" } : {}),
          },
        },
      );
      return JSON.parse(output.trim().split("\n").at(-1));
    }
    assert.deepEqual(commands("shop", false), []);
    assert.equal(
      commands("browser", false).some((call) => call.cwd.endsWith("apps/jp")),
      false,
    );
    assert.deepEqual(
      commands("shop", true).map((call) => call.args),
      [["run", "test:smoke"]],
    );
    assert.equal(
      commands("typecheck", true)[0].args.includes("types:check"),
      true,
    );
    assert.equal(commands("lint", true)[0].args.includes("lint"), true);
    assert.equal(commands("build", true)[0].args.includes("build"), true);
    assert.deepEqual(commands("test", true).at(-1).args, ["run", "test:core"]);
    assert.equal(
      commands("test", true).some((call) =>
        call.args.includes("--filter=@forever-tee/web"),
      ),
      false,
    );
    assert.equal(
      commands("shop", true, true).some((call) =>
        call.args.includes("test:e2e:local"),
      ),
      true,
    );
  }));

test("real Turbo scopes dependency/lockfile updates and shared consumers", (context) => {
  const turbo = resolve("node_modules/.bin/turbo");
  if (!existsSync(turbo)) {
    context.skip(
      "Turbo integration is exercised by the installed workspace test job",
    );
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "ci-graph-"));
  const put = (file, value) =>
    writeFileSync(join(cwd, file), JSON.stringify(value));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  try {
    for (const path of ["apps/activity", "apps/shop", "packages/tokens"])
      mkdirSync(join(cwd, path), { recursive: true });
    put("package.json", {
      name: "fixture",
      private: true,
      packageManager: "bun@1.4.4",
      workspaces: ["apps/*", "packages/*"],
    });
    const configuration = JSON.parse(readFileSync("turbo.json", "utf8"));
    put("turbo.json", configuration);
    const activity = {
      name: "activity",
      dependencies: { "is-number": "^6.0.0", tokens: "workspace:*" },
    };
    const shop = { name: "shop", dependencies: { tokens: "workspace:*" } };
    const tokens = { name: "tokens" };
    put("apps/activity/package.json", activity);
    put("apps/shop/package.json", shop);
    put("packages/tokens/package.json", tokens);
    const lock = {
      lockfileVersion: 3,
      configVersion: 1,
      workspaces: {
        "": { name: "fixture" },
        "apps/activity": activity,
        "apps/shop": shop,
        "packages/tokens": tokens,
      },
      packages: {
        activity: ["activity@workspace:apps/activity"],
        shop: ["shop@workspace:apps/shop"],
        tokens: ["tokens@workspace:packages/tokens"],
        "is-number": ["is-number@6.0.0", "", {}],
      },
    };
    put("bun.lock", lock);
    git("init", "--quiet");
    let base = commit();
    const affected = (head) =>
      JSON.parse(
        execFileSync(turbo, ["ls", "--affected", "--output=json"], {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            TURBO_SCM_BASE: base,
            TURBO_SCM_HEAD: head,
            TURBO_TELEMETRY_DISABLED: "1",
          },
        }),
      )
        .packages.items.map((item) => item.name)
        .sort();
    lock.packages["is-number"] = ["is-number@6.0.1", "", {}];
    put("bun.lock", lock);
    let head = commit();
    assert.deepEqual(affected(head), ["activity"]);
    base = head;
    activity.dependencies["is-number"] = "7.0.0";
    lock.packages["is-number"] = ["is-number@7.0.0", "", {}];
    put("apps/activity/package.json", activity);
    put("bun.lock", lock);
    head = commit();
    assert.deepEqual(affected(head), ["activity"]);
    base = head;
    writeFileSync(
      join(cwd, "packages/tokens/index.css"),
      ":root { color: black }",
    );
    head = commit();
    assert.deepEqual(affected(head), ["activity", "shop", "tokens"]);
    base = head;
    put("package.json", {
      name: "fixture",
      private: true,
      packageManager: "bun@1.4.4",
      workspaces: ["apps/*", "packages/*"],
      overrides: { "is-number": "7.0.0" },
    });
    head = commit();
    assert.deepEqual(affected(head), ["activity", "shop", "tokens"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("product-root tooling validates its nested applications", () =>
  fixture((env) => {
    const scope = workspaceScope(
      env,
      execute(
        ["products/drive/scripts/build.mjs"],
        packages.filter((item) => item.path === "products/drive"),
      ),
    );
    assert.equal(includesPath(scope, "products/drive/apps/web"), true);
    assert.equal(includesPath(scope, "products/shop"), false);
  }));
