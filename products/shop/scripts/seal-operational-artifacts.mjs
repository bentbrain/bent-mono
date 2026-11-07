import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PRODUCT_ROOT } from "./monorepo-source.mjs";
import { sealReleaseArchive } from "./release-evidence.mjs";

export const operationalArtifactPaths = Object.freeze({
  "operations.yml": [], "configure-printify-webhooks.yml": [],
  "product-lifecycle.yml": ["product-lifecycle-request.json", "product-lifecycle-result.json", "product-lifecycle-cache.json"],
  "featured-products.yml": ["featured-products-request.json", "featured-products-result.json"],
  "featured-video.yml": ["featured-video-output"],
  "featured-composition.yml": ["featured-composition-output"],
  "backup-renderer.yml": ["backup-renderer-output"],
});
async function regularTree(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new Error("Unexpected operational artifact path.");
  if (info.isDirectory()) for (const name of await readdir(path)) await regularTree(join(path, name));
}
export async function sealOperationalArtifacts(workflow, env = process.env, root = PRODUCT_ROOT) {
  const allowed = operationalArtifactPaths[workflow];
  if (!allowed || env.GITHUB_ACTIONS !== "true" || !env.RUNNER_TEMP?.startsWith("/") ||
      env.GITHUB_WORKFLOW_REF !== `bentbrain/bent-mono/.github/workflows/${workflow}@refs/heads/main`) throw new Error("Protected operational evidence context required.");
  process.umask(0o077);
  const paths = [];
  for (const path of allowed) {
    try { await regularTree(join(root, path)); paths.push(path); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!paths.length) return;
  const directory = join(env.RUNNER_TEMP, "sealed-operational-evidence");
  await mkdir(directory, { mode: 0o700 });
  const archive = join(env.RUNNER_TEMP, "private-operational-evidence.tar");
  try {
    await promisify(execFile)("tar", ["-cf", archive, ...paths], { cwd: root, timeout: 120000, maxBuffer: 65536 });
    await sealReleaseArchive(archive, join(directory, "operational-evidence.tar.enc"), {
      sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, filename: `${workflow.slice(0, -4)}-evidence.json`,
    }, env);
  } finally { await rm(archive, { force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workflow = /^bentbrain\/bent-mono\/\.github\/workflows\/([a-z-]+\.yml)@refs\/heads\/main$/.exec(process.env.GITHUB_WORKFLOW_REF ?? "")?.[1];
  await sealOperationalArtifacts(workflow);
}
