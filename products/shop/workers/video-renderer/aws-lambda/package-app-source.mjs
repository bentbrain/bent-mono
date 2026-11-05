import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sha256 } from "./contract.mjs";
import { ROOT, isMain } from "./local-tools.mjs";
import { VARIANTS } from "./config.mjs";

const APP_SOURCE_FILES = [
  "src/renderer.mjs", "src/geometry.mjs", "src/product-mockup-geometry.mjs",
  "src/product-image-renderer.mjs", "src/lifestyle.mjs", "src/lifestyle-template.mjs", "aws-lambda/product-image-handler.mjs", "aws-lambda/product-image-handler.test.mjs",
  "src/version.mjs", "src/storage-contract.mjs",
  ...["protected-config.mjs", "variants.mjs", "config.mjs", "contract.mjs", "app-environment.mjs", "app-environment.test.mjs", "app-handler.mjs", "app-entry.mjs", "app-handler.test.mjs", "failure-entry.mjs", "failure-entry.test.mjs", "bootstrap.sh",
    "runtime-smoke.mjs", "package.json", "package-lock.json", "Dockerfile.app", "cloud-build-app.sh", "verify-bundle.mjs"].map(file => `aws-lambda/${file}`),
];
export async function packageAppSource(directory) {
  const destination = resolve(directory);
  await mkdir(destination, { recursive: true });
  const stage = await mkdtemp(resolve(destination, "app-source-"));
  const paths = APP_SOURCE_FILES.map(file => [
    file,
    file === "src/product-mockup-geometry.mjs"
      ? resolve(ROOT, "packages/contracts/src/product-mockup-geometry.js")
      : resolve(ROOT, "workers/video-renderer", file),
  ]);
  for (const variant of Object.values(VARIANTS)) paths.push([`product-assets/${variant.file}`, resolve(ROOT, "apps/web/public/mockups", variant.file)]);
  for (const [file,source] of [["lifestyle-white.png","featured-blank-white.png"],["lifestyle-black.png","featured-blank-black.png"],["lifestyle.json","featured.json"],
    ["featured-mask-white.svg","featured-mask-white.svg"],["featured-mask-black.svg","featured-mask-black.svg"]])
    paths.push([`product-assets/${file}`,resolve(ROOT,"assets/lifestyle",source)]);
  const files = {};
  for (const [path, source] of paths) {
    const bytes = await readFile(source);
    files[path] = sha256(bytes);
    await mkdir(dirname(resolve(stage, path)), { recursive: true });
    await writeFile(resolve(stage, path), bytes, { flag: "wx" });
  }
  const manifest = `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`;
  const sourceDigest = sha256(manifest);
  await writeFile(resolve(stage, "bundle-manifest.json"), manifest, { flag: "wx" });
  const zip = resolve(stage, `${sourceDigest}.zip`);
  await promisify(execFile)("/usr/bin/zip", ["-q", "-0", zip, "bundle-manifest.json", ...Object.keys(files)], { cwd: stage });
  return { sourceDigest, zip, sourceKey: `source/${sourceDigest}.zip` };
}
if (isMain(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Supply a private output directory.");
  console.info(JSON.stringify(await packageAppSource(process.argv[2]), null, 2));
}
