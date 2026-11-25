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
import {
  browserMatrix,
  comparison,
  includesPath,
  workspaceScope,
} from "./ci-scope.mjs";

const blog = { name: "japan-blog", path: "apps/jp" };
const toolbar = { name: "feedback-toolbar", path: "apps/toolbar" };
const packages = [
  { name: "@bent/trackmap", path: "apps/trackmap" },
  { name: "@bent/design-tokens", path: "packages/design-tokens" },
  { name: "@bent/drive-product", path: "products/drive" },
  { name: "@bent/drive-web", path: "products/drive/apps/web" },
  blog,
  toolbar,
];
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
function execute(files, affected, fail = false, mode = "100644") {
  return (command, args, options) => {
    if (command === "git") {
      assert.deepEqual(args.slice(-2), [base, head]);
      if (fail) throw new Error("Missing base history");
      if (args.includes("--raw"))
        return files
          .map((file) => `:100644 ${mode} 0000000 0000000 M\0${file}\0`)
          .join("");
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

const browserOptions = { browser: true };

test("only browser selection skips PRs limited to allowlisted documentation", () =>
  fixture((env) => {
    const diff = execute(
      [
        "apps/jp/README.md",
        "apps/jp/LICENSE",
        "apps/toolbar/README.md",
        "apps/toolbar/LICENSE",
      ],
      [blog, toolbar],
    );
    assert.deepEqual(
      browserMatrix(workspaceScope(env, diff, browserOptions)),
      [],
    );
    assert.deepEqual(workspaceScope(env, diff).packages, [blog, toolbar]);
  }));

test("runtime, fixture, served and unknown paths retain browser coverage", () =>
  fixture((env) => {
    for (const path of [
      "apps/jp/src/content/post.md",
      "apps/jp/public/LICENSE",
      "apps/jp/tests/fixtures/README.md",
      "apps/jp/tests/browser-coverage.json",
      "apps/jp/src/styles/globals.css",
      "apps/jp/mockups/assets/tool.js",
      "bun.lock",
    ]) {
      const diff = execute(["apps/jp/README.md", path], [blog]);
      assert.equal(
        browserMatrix(workspaceScope(env, diff, browserOptions)).length,
        4,
        path,
      );
    }
    const link = execute(["apps/jp/README.md"], [blog], false, "120000");
    assert.equal(
      browserMatrix(workspaceScope(env, link, browserOptions)).length,
      4,
    );
    const rootChange = execute([".github/workflows/quality.yml"], [blog]);
    assert.deepEqual(
      workspaceScope(env, rootChange, browserOptions).packages,
      packages,
    );
    assert.deepEqual(
      workspaceScope(env, execute([], [], true), browserOptions).packages,
      packages,
    );
  }));

test("main pushes, weekly runs and manual dispatches select full browser coverage", () =>
  fixture((env) => {
    for (const event of ["push", "schedule", "workflow_dispatch"]) {
      const scope = workspaceScope(
        { ...env, GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/main" },
        (command, args, options) => {
          assert.notEqual(command, "git");
          assert.ok(!args.includes("--affected"));
          return execute([], [])(command, args, options);
        },
        browserOptions,
      );
      assert.equal(scope.full, true);
      assert.deepEqual(scope.packages, packages);
    }
  }));

test("the browser matrix lists each selected suite and each shard once", () => {
  assert.deepEqual(browserMatrix({ packages: [blog, toolbar, packages[0]] }), [
    { app: "trackmap", part: 1, total: 1, name: "Browser trackmap (1/1)" },
    { app: "jp", part: 1, total: 4, name: "Browser jp (1/4)" },
    { app: "jp", part: 2, total: 4, name: "Browser jp (2/4)" },
    { app: "jp", part: 3, total: 4, name: "Browser jp (3/4)" },
    { app: "jp", part: 4, total: 4, name: "Browser jp (4/4)" },
    { app: "toolbar", part: 1, total: 3, name: "Browser toolbar (1/3)" },
    { app: "toolbar", part: 2, total: 3, name: "Browser toolbar (2/3)" },
    { app: "toolbar", part: 3, total: 3, name: "Browser toolbar (3/3)" },
  ]);
});

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
test("an app-only dependency and lockfile update retains its affected scope", () =>
  fixture((env) => {
    const scope = workspaceScope(
      env,
      execute(["apps/trackmap/package.json", "bun.lock"], [packages[0]]),
    );
    assert.deepEqual(scope.packages, [packages[0]]);
    assert.equal(includesPath(scope, "products/drive"), false);
  }));
test("shared consumers supplied by Turbo are retained", () =>
  fixture((env) => {
    const scope = workspaceScope(
      env,
      execute(["packages/design-tokens/src/index.css"], packages.slice(1, 4)),
    );
    assert.equal(includesPath(scope, "products/drive"), true);
    assert.equal(includesPath(scope, "products/drive/apps/web"), true);
  }));
test("root changes, deleted workspace paths and missing history select every workspace", () =>
  fixture((env) => {
    for (const files of [
      ["scripts/ci-scope.mjs"],
      ["package.json"],
      ["scripts/ci-check.mjs"],
      ["apps/removed/package.json"],
    ]) {
      const scope = workspaceScope(env, execute(files, [packages[2]]));
      assert.deepEqual(scope.packages, packages);
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
    for (const path of ["apps/activity", "apps/other", "packages/tokens"])
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
    const other = { name: "other", dependencies: { tokens: "workspace:*" } };
    const tokens = { name: "tokens" };
    put("apps/activity/package.json", activity);
    put("apps/other/package.json", other);
    put("packages/tokens/package.json", tokens);
    const lock = {
      lockfileVersion: 3,
      configVersion: 1,
      workspaces: {
        "": { name: "fixture" },
        "apps/activity": activity,
        "apps/other": other,
        "packages/tokens": tokens,
      },
      packages: {
        activity: ["activity@workspace:apps/activity"],
        other: ["other@workspace:apps/other"],
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
    assert.deepEqual(affected(head), ["activity", "other", "tokens"]);
    base = head;
    put("package.json", {
      name: "fixture",
      private: true,
      packageManager: "bun@1.4.4",
      workspaces: ["apps/*", "packages/*"],
      overrides: { "is-number": "7.0.0" },
    });
    head = commit();
    assert.deepEqual(affected(head), ["activity", "other", "tokens"]);
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
    assert.equal(includesPath(scope, "apps/trackmap"), false);
  }));
