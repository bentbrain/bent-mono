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
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  browserMatrix,
  comparison,
  includesPath,
  iosNativeInputs,
  iosNativeSelected,
  pathFilter,
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
    // Beside a root documentation change, the native selection names the
    // changed workspace, and Turbo adds its consumers.
    writeFileSync(join(cwd, "README.md"), "# Fixture\n");
    writeFileSync(
      join(cwd, "packages/tokens/index.css"),
      ":root { color: red }",
    );
    const documented = commit();
    const eventPath = join(cwd, "..", `${cwd.split("/").at(-1)}-event.json`);
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { base: { sha: head } } }),
    );
    try {
      const scope = workspaceScope(
        {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_SHA: documented,
          GITHUB_EVENT_PATH: eventPath,
        },
        (command, args, options) =>
          execFileSync(command === "git" ? command : turbo, args, {
            ...options,
            cwd,
          }),
        { rootInputs: ["package.json"] },
      );
      assert.deepEqual(scope.packages.map((item) => item.name).sort(), [
        "activity",
        "other",
        "tokens",
      ]);
    } finally {
      rmSync(eventPath, { force: true });
    }
    base = documented;
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

const fitnessIos = { name: "@bent/fitness-ios", path: "apps/fitness-ios" };
const contracts = {
  name: "@bent/fitness-contracts",
  path: "packages/fitness-contracts",
};
const fitness = { name: "@bent/fitness", path: "apps/fitness" };
const iosPackages = [...packages, fitnessIos, contracts, fitness];
// Turbo answers --affected and --filter=...<name> with `affected`: the
// changed workspaces and their consumers.
function iosExecute(files, affected, fail = false, calls = []) {
  return (command, args, options) => {
    if (command === "git") {
      assert.deepEqual(args.slice(-2), [base, head]);
      if (fail) throw new Error("Missing base history");
      return files.join("\0") + "\0";
    }
    calls.push(args);
    const scoped =
      args.includes("--affected") ||
      args.some((arg) => arg.startsWith("--filter="));
    return JSON.stringify({
      packages: { items: scoped ? affected : iosPackages },
    });
  };
}
const iosOptions = { rootInputs: iosNativeInputs };
const iosSelected = (env, files, affected, fail, calls) =>
  iosNativeSelected(
    workspaceScope(env, iosExecute(files, affected, fail, calls), iosOptions),
    env,
  );

test("the native iPhone suite runs for changes that reach the app, its contracts or Fitness", () =>
  fixture((env) => {
    const designTokens = packages[1];
    for (const [files, affected] of [
      [["apps/fitness-ios/src/app.tsx"], [fitnessIos]],
      [
        ["packages/fitness-contracts/src/index.ts"],
        [contracts, fitness, fitnessIos],
      ],
      [["apps/fitness/src/server/db.ts"], [fitness]],
      [["packages/design-tokens/src/index.css"], [designTokens, fitnessIos]],
      [["apps/fitness-ios/package.json", "bun.lock"], [fitnessIos]],
      [["scripts/ci-scope.mjs"], []],
      [[".github/workflows/quality.yml"], []],
    ])
      assert.equal(iosSelected(env, files, affected), true, files.join());
    assert.equal(iosSelected(env, [], [], true), true, "missing history");
    for (const event of ["schedule", "workflow_dispatch"])
      for (const ref of [undefined, "refs/heads/main"])
        assert.equal(
          iosSelected(
            { ...env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref },
            [],
            [],
          ),
          true,
          event,
        );
  }));

test("merge queue and branch pushes scope the native iPhone suite to their diff", () =>
  fixture((env) => {
    const directory = mkdtempSync(join(tmpdir(), "ci-scope-queue-"));
    const eventPath = join(directory, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({ before: base, merge_group: { base_sha: base } }),
    );
    try {
      for (const event of [
        { GITHUB_EVENT_NAME: "merge_group", GITHUB_REF: "refs/heads/main" },
        { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/feature" },
        { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/heads/main" },
      ]) {
        const current = { ...env, ...event, GITHUB_EVENT_PATH: eventPath };
        if (event.GITHUB_EVENT_NAME === "pull_request")
          current.GITHUB_EVENT_PATH = env.GITHUB_EVENT_PATH;
        const name = JSON.stringify(event);
        assert.equal(
          iosSelected(current, ["apps/fitness-ios/src/app.tsx"], [fitnessIos]),
          true,
          name,
        );
        assert.equal(
          iosSelected(current, ["apps/jp/src/content/post.md"], [blog]),
          false,
          name,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }));

test("the native iPhone suite is left out for changes to other products", () =>
  fixture((env) => {
    for (const [files, affected] of [
      [["apps/jp/src/content/post.md"], [blog]],
      [["apps/toolbar/src/index.ts"], [toolbar]],
      [["apps/trackmap/src/main.ts"], [packages[0]]],
      [["products/drive/apps/web/src/app.tsx"], [packages[3]]],
    ])
      assert.equal(iosSelected(env, files, affected), false, files.join());
  }));

test("main pushes leave the native iPhone suite to Fitness iOS Verification", () =>
  fixture((env) => {
    const directory = mkdtempSync(join(tmpdir(), "ci-scope-push-"));
    const eventPath = join(directory, "event.json");
    writeFileSync(eventPath, JSON.stringify({ before: base }));
    try {
      const push = {
        ...env,
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_PATH: eventPath,
      };
      for (const [files, affected, fail] of [
        [["apps/jp/src/content/post.md"], [blog]],
        [["apps/fitness-ios/src/app.tsx"], [fitnessIos]],
        [["packages/fitness-contracts/src/index.ts"], [contracts, fitnessIos]],
        [["apps/fitness/src/server/db.ts"], [fitness]],
        [["scripts/ci-scope.mjs"], []],
        [[".github/workflows/quality.yml"], []],
        [[], [], true],
      ])
        assert.equal(
          iosSelected(push, files, affected, fail),
          false,
          fail ? "missing history" : files.join(),
        );
      // A full scope still leaves the suite out of a main push.
      assert.equal(
        iosNativeSelected({ full: true, packages: iosPackages }, push),
        false,
      );
      // Main pushes still run every browser suite.
      const browser = workspaceScope(push, iosExecute([], []), browserOptions);
      assert.equal(browser.full, true);
      assert.ok(browserMatrix(browser).length > 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }));

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: repositoryRoot,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
// The workspaces Turbo lists: each tracked package.json directory that a root
// workspace pattern names.
const workspacePatterns = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
).workspaces.map(
  (pattern) => new RegExp(`^${pattern.replaceAll("*", "[^/]+")}$`),
);
const workspaces = tracked
  .filter((file) => file.endsWith("/package.json"))
  .map((file) => file.slice(0, -"/package.json".length))
  .filter((path) => workspacePatterns.some((pattern) => pattern.test(path)))
  .map((path) => ({ name: path, path }));
const insideWorkspace = (file) =>
  workspaces.some((item) => file.startsWith(`${item.path}/`));
// One example path for each root input pattern.
const rootInputs = iosNativeInputs
  .filter((pattern) => !insideWorkspace(pattern))
  .map((pattern) =>
    pattern.replace("/**", "/nested/example.yml").replace("*", "example"),
  );
// Documentation and root files that no native iPhone check reads.
const unrelatedRootFiles = [
  "README.md",
  "AGENTS.md",
  "LICENSE",
  ".gitignore",
  "docs/guide.md",
  "docs/ci/runners.md",
  "SOURCE_PROVENANCE.json",
  "deployments.json",
  "assets/icon.svg",
  ".github/workflows/deploy-jp.yml",
  ".github/workflows/deploy-toolbar.yml",
  ".github/workflows/deploy-fitness-ios.yml",
  "scripts/release-vercel.mjs",
  "scripts/check-public-source.mjs",
  "scripts/ci-scope.test.mjs",
];

test("the Fitness iOS Verification push paths are the shared native iPhone inputs", () => {
  const workflow = parse(
    readFileSync(
      join(repositoryRoot, ".github/workflows/fitness-ios-verify.yml"),
      "utf8",
    ),
  );
  assert.deepEqual(workflow.on.push, {
    branches: ["main"],
    paths: iosNativeInputs,
  });
  assert.ok(workspaces.some((item) => item.path === "apps/fitness-ios"));
  // Each root input names a tracked file, or a directory with tracked files.
  for (const pattern of iosNativeInputs.filter((p) => !insideWorkspace(p))) {
    const matches = pathFilter([pattern]);
    assert.ok(tracked.some(matches), `${pattern} matches no tracked file`);
  }
  const verified = pathFilter(iosNativeInputs);
  for (const file of [
    ...unrelatedRootFiles,
    "apps/jp/src/content/post.md",
    "apps/toolbar/src/index.ts",
    "packages/ui/src/button.tsx",
    "products/drive/apps/web/src/page.tsx",
    "apps/fitness/tests/x/ios-flow.ts",
  ])
    assert.equal(verified(file), false, file);
  for (const file of [
    ...rootInputs,
    "apps/fitness-ios/src/app.tsx",
    "apps/fitness/tests/ios-roundtrip.test.ts",
    "apps/fitness/src/server/db.ts",
    "packages/fitness-contracts/src/index.ts",
  ])
    assert.equal(verified(file), true, file);
});

test("a pull request selects the native iPhone suite for each native root input, and never for documentation alone", () =>
  fixture((env) => {
    const blogOnly = [{ name: blog.name, path: blog.path }];
    for (const file of unrelatedRootFiles) {
      const calls = [];
      assert.equal(iosSelected(env, [file], [], false, calls), false, file);
      // Documentation alone needs no workspace inventory beyond the list.
      assert.ok(!calls.some((args) => args.includes("--affected")), file);
      assert.equal(
        iosSelected(env, [file, "apps/jp/src/content/post.md"], blogOnly),
        false,
        `${file} with a JP change`,
      );
    }
    assert.equal(iosSelected(env, unrelatedRootFiles, []), false, "together");
    for (const file of rootInputs) {
      assert.equal(iosSelected(env, [file], []), true, file);
      assert.equal(
        iosSelected(env, ["README.md", file], []),
        true,
        `README.md with ${file}`,
      );
    }
    // Beside documentation, a workspace change still selects the suite
    // through the changed workspace and its consumers.
    const calls = [];
    assert.equal(
      iosSelected(
        env,
        ["README.md", "packages/design-tokens/src/index.css"],
        [packages[1], fitnessIos],
        false,
        calls,
      ),
      true,
    );
    assert.deepEqual(calls.at(-1), [
      "ls",
      "--filter=...@bent/design-tokens",
      "--output=json",
    ]);
    assert.equal(
      iosSelected(
        env,
        ["AGENTS.md", "apps/fitness-ios/src/app.tsx"],
        [fitnessIos],
      ),
      true,
    );
    // Every tracked root file selects the suite exactly when it is a native input.
    const native = pathFilter(iosNativeInputs);
    for (const file of tracked.filter((file) => !insideWorkspace(file)))
      assert.equal(iosSelected(env, [file], []), native(file), file);
    // Quality's other checks still select every workspace for a root change.
    for (const file of ["README.md", "docs/guide.md", "AGENTS.md"])
      assert.deepEqual(
        workspaceScope(env, iosExecute([file], []), browserOptions).packages,
        iosPackages,
        file,
      );
  }));
