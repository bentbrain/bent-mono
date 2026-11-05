import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PRODUCT_ROOT } from "./monorepo-source.mjs";
import { sealReleaseArchive } from "./release-evidence.mjs";

const env = process.env;
if (!env.RUNNER_TEMP?.startsWith("/") || env.GITHUB_ACTIONS !== "true") throw new Error("Browser evidence sealing requires the protected runner.");
process.umask(0o077);
const paths = [];
for (const path of ["apps/web/playwright-report", "apps/web/test-results"]) {
  try {
    const info = await lstat(join(PRODUCT_ROOT, path));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unexpected browser evidence path.");
    paths.push(path);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
if (paths.length) {
  const directory = join(env.RUNNER_TEMP, "sealed-browser-evidence");
  await mkdir(directory, { mode: 0o700 });
  const archive = join(env.RUNNER_TEMP, "private-browser-evidence.tar");
  try {
    await promisify(execFile)("tar", ["-cf", archive, ...paths], { cwd: PRODUCT_ROOT, timeout: 120000, maxBuffer: 65536 });
    await sealReleaseArchive(archive, join(directory, "browser-evidence.tar.enc"), { sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, filename: "browser-evidence.json" });
  } finally { await rm(archive, { force: true }); }
}
