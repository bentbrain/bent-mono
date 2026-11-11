import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareUbuntuArchive } from "./prepare-ubuntu-archive.mjs";

const hosted = {
  platform: "linux", arch: "x64",
  env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" },
};
const mirrors = "http://azure.archive.ubuntu.com/ubuntu\tpriority:1\nhttps://archive.ubuntu.com/ubuntu\tpriority:2\nhttps://security.ubuntu.com/ubuntu\tpriority:3\n";

test("the hosted Azure mirror list becomes the signed primary archive before installation", () => {
  let writes = 0;
  assert.equal(prepareUbuntuArchive({ ...hosted,
    read: (path, encoding) => {
      assert.equal(path, "/etc/apt/apt-mirrors.txt");
      assert.equal(encoding, "utf8");
      return mirrors;
    },
    run: (command, args, options) => {
      writes++;
      assert.equal(command, "sudo");
      assert.deepEqual(args, ["-n", "tee", "/etc/apt/apt-mirrors.txt"]);
      assert.equal(options.input, "https://archive.ubuntu.com/ubuntu\n");
      assert.deepEqual(options.stdio, ["pipe", "ignore", "inherit"]);
      return { status: 0 };
    },
  }), true);
  assert.equal(writes, 1);
});

test("local machines, ARM and self-hosted runners never read or change system sources", () => {
  for (const options of [
    { ...hosted, platform: "darwin" }, { ...hosted, platform: "win32" },
    { ...hosted, arch: "arm64" }, { ...hosted, env: {} },
    { ...hosted, env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" } },
  ]) {
    assert.equal(prepareUbuntuArchive({ ...options,
      read: () => assert.fail("unexpected system read"),
      run: () => assert.fail("unexpected privileged command"),
    }), false);
  }
});

test("other source configurations remain intact and unexpected read failures stop setup", () => {
  const run = () => assert.fail("unexpected privileged command");
  for (const content of ["https://archive.ubuntu.com/ubuntu\n", "https://ports.ubuntu.com/ubuntu-ports\n", "https://azure.archive.ubuntu.com.evil.test/ubuntu\n"]) {
    assert.equal(prepareUbuntuArchive({ ...hosted, read: () => content, run }), false);
  }
  assert.equal(prepareUbuntuArchive({ ...hosted, read: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, run }), false);
  assert.throws(() => prepareUbuntuArchive({ ...hosted, read: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, run }), /denied/);
});

test("a failed privileged write stops browser setup", () => {
  assert.throws(() => prepareUbuntuArchive({ ...hosted, read: () => mirrors, run: () => ({ status: 1 }) }), /Could not configure/);
  assert.throws(() => prepareUbuntuArchive({ ...hosted, read: () => mirrors, run: () => ({ status: null, error: new Error("spawn failed") }) }), /spawn failed/);
});

test("all browser install entry points prepare the archive before apt runs", () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const shared = read("scripts/install-browsers.mjs");
  assert(shared.includes("prepareUbuntuArchive();"));
  assert(shared.indexOf("prepareUbuntuArchive();") < shared.indexOf("const result = spawnSync("));
  for (const prefix of [".github/workflows/", "products/shop/.github/workflows/"]) {
    for (const name of ["deploy.yml", "preview-smoke.yml"]) {
      const workflow = read(prefix + name);
      const install = workflow.indexOf("bunx --no-install playwright install --with-deps chromium");
      const prepare = workflow.lastIndexOf("node ../../scripts/prepare-ubuntu-archive.mjs", install);
      assert(prepare >= 0 && prepare < install, `${prefix}${name}`);
    }
  }
  const composite = read("products/shop/.github/actions/check/action.yml");
  assert(composite.indexOf("node scripts/prepare-ubuntu-archive.mjs") >= 0);
  assert(composite.indexOf("node scripts/prepare-ubuntu-archive.mjs") < composite.indexOf("bunx --no-install playwright install --with-deps chromium"));
});
