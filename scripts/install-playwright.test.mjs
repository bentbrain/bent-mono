import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { installationArguments, installPlaywright } from "./install-playwright.mjs";

const version = "1.62.1";
const imageName = version => `mcr.microsoft.com/playwright:v${version}-noble`;
const hosted = {
  platform: "linux", arch: "x64",
  env: { GITHUB_ACTIONS: "true", PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright" },
  read: (path, encoding) => {
    assert.equal(path, "/ms-playwright/.docker-info");
    assert.equal(encoding, "utf8");
    return JSON.stringify({ driverVersion: version, dockerImageName: imageName(version) });
  },
};
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const job = (path, name) => {
  const text = read(path).split(`\n  ${name}:\n`)[1];
  assert(text, `${path} requires job ${name}`);
  return text.split(/\n  [a-zA-Z][\w-]*:\n/)[0];
};

test("the matched official image installs exact browsers without invoking apt", () => {
  assert.deepEqual(installationArguments(version, ["chromium", "webkit"], hosted), ["install", "chromium", "webkit"]);
  let calls = 0;
  installPlaywright("products/shop/apps/web", ["chromium"], { ...hosted,
    run: (command, args) => {
      calls++;
      assert.equal(command, process.execPath);
      assert.match(args[0], /playwright/);
      assert.deepEqual(args.slice(1), ["install", "chromium"]);
      return { status: 0 };
    },
  });
  assert.equal(calls, 1);
});

test("missing or mismatched containers fail before any install or privileged command", () => {
  const invalid = [
    { read: () => { throw new Error("missing image"); } },
    { read: () => "{}" },
    { read: () => "not JSON" },
    { read: () => JSON.stringify({ driverVersion: "1.64.1", dockerImageName: imageName("1.64.1") }) },
    { read: () => JSON.stringify({ driverVersion: version, dockerImageName: imageName(version) + ".invalid" }) },
    { arch: "arm64" },
    { env: { GITHUB_ACTIONS: "true", PLAYWRIGHT_BROWSERS_PATH: "/other-cache" } },
  ];
  for (const overrides of invalid) {
    assert.throws(() => installPlaywright("products/shop/apps/web", ["chromium"], {
      ...hosted, ...overrides, run: () => assert.fail("unexpected install"),
    }));
  }
});

test("local browser setup retains dependency installation and propagates CLI failures", () => {
  for (const options of [{ platform: "darwin", env: {} }, { platform: "linux", env: {} }]) {
    assert.deepEqual(installationArguments(version, ["chromium"], {
      ...options, read: () => assert.fail("unexpected container read"),
    }), ["install", "--with-deps", "chromium"]);
  }
  assert.throws(() => installPlaywright("products/shop/apps/web", ["chromium"], {
    ...hosted, run: () => ({ status: 1 }),
  }), /installation failed/);
  assert.throws(() => installPlaywright("products/shop/apps/web", ["chromium"], {
    ...hosted, run: () => ({ status: null, error: new Error("spawn failed") }),
  }), /spawn failed/);
});

test("every active browser job pins the official image to its installed Playwright version", () => {
  const pins = {
    "1.62.1": "c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
    "1.64.1": "ee15712262f017b8157421b212b12099146645f44b1bc5c0514cbbe6a229b1d0",
  };
  const requireImage = (text, version) => {
    assert(text.includes("    runs-on: ubuntu-24.04\n"));
    assert(text.includes(`    container:\n      image: ${imageName(version)}@sha256:${pins[version]}\n      options: --ipc=host --init\n`));
    assert(text.includes("    defaults:\n      run:\n        shell: bash\n"));
  };
  requireImage(job(".github/workflows/quality.yml", "shop"), version);
  requireImage(job(".github/workflows/quality.yml", "browser"), "1.64.1");
  for (const directory of ["apps/jp", "apps/toolbar", "apps/trackmap"]) {
    assert.equal(JSON.parse(read(`${directory}/package.json`)).devDependencies["@playwright/test"].replace(/^\^/, ""), "1.64.1");
  }
  assert.equal(JSON.parse(read("products/shop/apps/web/package.json")).devDependencies["@playwright/test"], version);
  for (const [name, jobs] of Object.entries({ "deploy.yml": ["validate", "e2e"], "native-development.yml": ["check"], "web-production.yml": ["validate"], "preview-smoke.yml": ["smoke"] })) {
    assert.equal(read(`.github/workflows/${name}`), read(`products/shop/.github/workflows/${name}`));
    for (const jobName of jobs) {
      const config = job(`.github/workflows/${name}`, jobName);
      requireImage(config, version);
      assert(config.includes("        shell: bash\n        working-directory: products/shop\n"));
    }
  }
  requireImage(job("products/shop/.github/workflows/ci.yml", "browser"), version);
});

test("release and fallback browser installers use the shared version guard", () => {
  for (const [file, job] of [["deploy.yml", "e2e"], ["preview-smoke.yml", "smoke"]]) {
    const steps = read(`.github/workflows/${file}`).split(`\n  ${job}:\n`)[1];
    assert(steps.includes("      - run: node ../../scripts/install-playwright.mjs apps/web chromium"));
    assert(!steps.includes("install --with-deps"));
  }
  const action = read("products/shop/.github/actions/check/action.yml");
  const install = action.split("    - name: Install local browser and OS dependencies\n")[1].split("    - name:")[0];
  assert(install.includes("      run: node ../../../../scripts/install-playwright.mjs . chromium"));
  assert(install.includes("      working-directory: products/shop/apps/web"));
  assert(read("scripts/install-browsers.mjs").includes("installPlaywright(application,"));
});
