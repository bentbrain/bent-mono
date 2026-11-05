import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "./contract.mjs";
import { ROOT, isMain } from "./local-tools.mjs";
import { infrastructure } from "./infrastructure.mjs";

// Explicit allowlist. Never include .data, .env, credentials, artwork, or the rest of the worktree.
export const SOURCE_FILES = [
  "src/renderer.mjs", "src/geometry.mjs", "src/product-mockup-geometry.mjs",
  "src/version.mjs", "src/storage-contract.mjs",
  ...["protected-config.mjs", "variants.mjs", "config.mjs", "contract.mjs", "handler-core.mjs", "entry.mjs", "s3-storage.mjs",
    "package.json", "package-lock.json", "Dockerfile", "cloud-build.sh", "verify-bundle.mjs",
    "handler.test.mjs", "storage.test.mjs", "runtime-smoke.mjs", "bootstrap.sh"].map((name) => `aws-lambda/${name}`),
];

export function sourceFilePath(path) {
  return path === "src/product-mockup-geometry.mjs"
    ? resolve(ROOT, "packages/contracts/src/product-mockup-geometry.js")
    : resolve(ROOT, "workers/video-renderer", path);
}

export async function packageSource(directory) {
  const destination = resolve(directory);
  await mkdir(destination, { recursive: true });
  const stage = await mkdtemp(resolve(destination, "source-"));
  const files = {};
  for (const path of SOURCE_FILES) {
    const bytes = await readFile(sourceFilePath(path));
    files[path] = sha256(bytes);
    await mkdir(resolve(stage, path.split("/")[0]), { recursive: true });
    await writeFile(resolve(stage, path), bytes, { flag: "wx" });
  }
  const manifest = `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`;
  const sourceDigest = sha256(manifest);
  await writeFile(resolve(stage, "bundle-manifest.json"), manifest, { flag: "wx" });
  const zip = resolve(destination, `${sourceDigest}.zip`);
  // zip receives only allowlisted file names, with no shell or wildcard expansion.
  // Using the unique stage destination avoids updating an existing zip with stale files.
  const stagedZip = resolve(stage, "source.zip");
  await promisify(execFile)("/usr/bin/zip", ["-q", "-0", stagedZip, "bundle-manifest.json", ...SOURCE_FILES], { cwd: stage });
  await writeFile(zip, await readFile(stagedZip), { flag: "wx" });
  const template = resolve(destination, "cloudformation.json");
  await writeFile(template, `${JSON.stringify(infrastructure(), null, 2)}\n`, { flag: "wx" });
  return { sourceDigest, zip, template, sourceKey: `source/${sourceDigest}.zip` };
}

if (isMain(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node package-source.mjs <new-output-directory>");
  console.info(JSON.stringify(await packageSource(process.argv[2]), null, 2));
}
