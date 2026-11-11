import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function installationArguments(version, browsers, {
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  read = readFileSync,
} = {}) {
  if (!browsers.length || browsers.some(browser => !["chromium", "webkit", "firefox", "--dry-run"].includes(browser))) {
    throw new Error("Select supported Playwright browsers.");
  }
  if (platform !== "linux" || env.GITHUB_ACTIONS !== "true") {
    return ["install", "--with-deps", ...browsers];
  }

  // Hosted CI uses the official image's installed OS dependencies. Fail before
  // invoking Playwright when its image differs from the application's version.
  const image = JSON.parse(read("/ms-playwright/.docker-info", "utf8"));
  if (arch !== "x64" || env.PLAYWRIGHT_BROWSERS_PATH !== "/ms-playwright" ||
      image.driverVersion !== version || image.dockerImageName !== `mcr.microsoft.com/playwright:v${version}-noble`) {
    throw new Error("Use the pinned Playwright container matching this application's version.");
  }
  return ["install", ...browsers];
}

export function installPlaywright(application, browsers, { run = spawnSync, ...runtime } = {}) {
  const require = createRequire(resolve(application, "package.json"));
  const version = require("@playwright/test/package.json").version;
  const args = installationArguments(version, browsers, runtime);
  const result = run(process.execPath, [require.resolve("@playwright/test/cli"), ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Playwright browser installation failed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [application, ...browsers] = process.argv.slice(2);
  if (!application) throw new Error("Select an application directory.");
  installPlaywright(application, browsers);
}
