import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const read = path => readFileSync(join(root, path), "utf8");
const trust = 'git config --global --add safe.directory "$GITHUB_WORKSPACE"';

test("the container checkout step admits only its exact mounted workspace", context => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "container-git-fixture-")));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, "global-config");
  writeFileSync(config, "", { mode: 0o600 });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0", GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GITHUB_WORKSPACE: root };
  const git = (args, cwd = root) => spawnSync("git", args, { env, cwd, encoding: "utf8" });
  const before = git(["rev-parse", "HEAD"]);
  assert.notEqual(before.status, 0);
  assert.match(before.stderr, /dubious ownership/);

  const command = /- name: Trust the mounted checkout\n\s+run: ([^\n]+)/.exec(read(".github/workflows/quality.yml"))?.[1];
  assert.equal(command, trust);
  execFileSync("bash", ["-euo", "pipefail", "-c", command], { env, cwd: root });
  const after = git(["rev-parse", "HEAD"]);
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout.trim(), /^[a-f0-9]{40}$/);
  assert.equal(git(["config", "--global", "--get-all", "safe.directory"]).stdout.trim(), root);

  const other = join(directory, "other-repository");
  mkdirSync(other);
  assert.equal(git(["init", "--quiet"], other).status, 0);
  const rejected = git(["status", "--porcelain"], other);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /dubious ownership/);
});

test("all container jobs establish workspace trust before checkout and source commands", () => {
  const paths = [".github/workflows/quality.yml"];
  for (const name of ["deploy.yml", "native-development.yml", "web-production.yml", "preview-smoke.yml", "ci.yml"]) {
    if (name !== "ci.yml") paths.push(`.github/workflows/${name}`);
    paths.push(`products/shop/.github/workflows/${name}`);
  }
  let containers = 0;
  for (const path of paths) {
    for (const block of read(path).split(/\n  [a-zA-Z][\w-]*:\n/)) {
      if (!block.includes("    container:\n")) continue;
      containers++;
      assert(block.includes(`    steps:\n      - name: Trust the mounted checkout\n        run: ${trust}\n        working-directory: .\n`), path);
    }
  }
  assert.equal(containers, 13);
});

test("pinned browser containers mount trusted archive tools at the absolute caller paths", () => {
  const workflows = [".github/workflows/quality.yml"];
  for (const name of ["deploy.yml", "native-development.yml", "web-production.yml", "preview-smoke.yml", "ci.yml"]) {
    if (name !== "ci.yml") workflows.push(`.github/workflows/${name}`);
    workflows.push(`products/shop/.github/workflows/${name}`);
  }
  let containers = 0;
  for (const path of workflows) {
    for (const block of read(path).split(/\n  [a-zA-Z][\w-]*:\n/)) {
      if (!block.includes("    container:\n")) continue;
      containers++;
      for (const executable of ["zip", "unzip"])
        assert.ok(block.includes(`        - /usr/bin/${executable}:/usr/bin/${executable}:ro\n`), `${path}: ${executable}`);
    }
  }
  assert.equal(containers, 13);
  for (const file of ["package-source.mjs", "package-app-source.mjs"])
    assert.match(read(`products/shop/workers/video-renderer/aws-lambda/${file}`), /execFile\)\("\/usr\/bin\/zip",/);
});
