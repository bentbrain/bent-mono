import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./vercel-bun.mjs", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const version = manifest.packageManager.slice(4);

function fixture(
  t,
  { installedVersion = version, npmStatus = 0, commandStatus = 0 } = {},
) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "vercel-bootstrap-test-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const app = join(root, "app");
  const temporary = join(root, "tmp");
  for (const directory of [bin, app, temporary]) mkdirSync(directory);
  const report = join(root, "bootstrap.json");
  const executable = `#!/usr/bin/env node
if (process.argv[2] === "--version") console.log(${JSON.stringify(installedVersion)});
else {
  console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),ignoreScripts:process.env.npm_config_ignore_scripts}));
  process.exitCode = ${commandStatus};
}
`;
  const install = `const fs = require("node:fs");
fs.writeFileSync(require("node:path").join(__dirname,"bin","bun.exe"),${JSON.stringify(executable)},{mode:0o755});`;
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));
if (${npmStatus}) process.exit(${npmStatus});
fs.mkdirSync("node_modules/bun/bin",{recursive:true});
fs.writeFileSync("node_modules/bun/bin/bun.exe","uninitialised placeholder",{mode:0o755});
fs.writeFileSync("node_modules/bun/install.js",${JSON.stringify(install)});
`,
    { mode: 0o755 },
  );
  return {
    root,
    app,
    temporary,
    report,
    run: (args) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: app,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: temporary,
          npm_config_ignore_scripts: "true",
        },
        encoding: "utf8",
      }),
  };
}

for (const args of [
  ["install", "--frozen-lockfile"],
  ["run", "build"],
]) {
  test(`initialises the pinned wrapper before ${args.join(" ")} despite inherited script suppression`, (t) => {
    const f = fixture(t);
    const result = f.run(args);
    assert.equal(result.status, 0, result.stderr);
    const application = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.deepEqual(application, { args, cwd: f.app, ignoreScripts: "true" });
    const bootstrap = JSON.parse(readFileSync(f.report, "utf8"));
    assert.deepEqual(bootstrap.args, [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-save",
      "--no-audit",
      "--no-fund",
      manifest.packageManager,
    ]);
    assert.ok(bootstrap.cwd.startsWith(f.temporary));
    assert.deepEqual(readdirSync(f.temporary), []);
    assert.deepEqual(readdirSync(f.app), []);
  });
}

test("refuses a mismatched native tool and cleans bootstrap files", (t) => {
  const f = fixture(t, { installedVersion: "0.0.0" });
  const result = f.run(["install", "--frozen-lockfile"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed its version check/);
  assert.doesNotMatch(result.stdout, /"args"/);
  assert.deepEqual(readdirSync(f.temporary), []);
});

for (const options of [{ npmStatus: 7 }, { commandStatus: 8 }]) {
  test(`propagates ${options.npmStatus ? "bootstrap" : "application"} failure and cleans bootstrap files`, (t) => {
    const f = fixture(t, options);
    const result = f.run(["run", "build"]);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      new RegExp(`failed with ${options.npmStatus ?? options.commandStatus}`),
    );
    assert.deepEqual(readdirSync(f.temporary), []);
  });
}

test("rejects non-frozen install commands before bootstrapping", (t) => {
  const f = fixture(t);
  const result = f.run(["install"]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Expected install --frozen-lockfile or run build/,
  );
  assert.deepEqual(readdirSync(f.temporary), []);
});

test("all ordinary Vercel apps use the shared bootstrap and Node 24 without changing Functions runtime", () => {
  for (const directory of [
    "apps/www",
    "apps/stay",
    "apps/collage",
    "products/drive/apps/web",
  ]) {
    const configUrl = new URL(`../${directory}/vercel.json`, import.meta.url);
    const config = JSON.parse(readFileSync(configUrl, "utf8"));
    const app = JSON.parse(
      readFileSync(new URL("./package.json", configUrl), "utf8"),
    );
    const relative = directory.startsWith("products/")
      ? "../../../../"
      : "../../";
    assert.equal(
      config.installCommand,
      `node ${relative}scripts/vercel-bun.mjs install --frozen-lockfile`,
    );
    assert.equal(
      config.buildCommand,
      `node ${relative}scripts/vercel-bun.mjs run build`,
    );
    assert.equal(app.engines.node, "24.x");
    assert.ok(!Object.hasOwn(config, "bunVersion"));
  }
  assert.equal(manifest.engines.node, "24.x");
});
