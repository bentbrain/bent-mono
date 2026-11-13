import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const excluded = new Set([
  "node_modules",
  "dist",
  ".wrangler",
  ".tanstack",
  ".next",
  ".git",
]);
export async function captureInputs(root, artifact) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const next = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile()) files.push(next);
    }
  }
  for (const directory of [
    "products/shop/apps/storefront",
    "products/shop/apps/web/src",
    "products/shop/apps/web/public",
    "products/shop/packages/contracts",
    "products/shop/packages/product-image-renderer",
    "products/shop/workers/api/src",
    "products/shop/workers/api/drizzle",
    "products/shop/workers/video-renderer/src",
    "products/shop/workers/video-renderer/aws-lambda",
    "packages/ui",
    "packages/design-tokens",
  ])
    await visit(resolve(root, directory));
  for (const file of [
    "bun.lock",
    "package.json",
    "products/shop/apps/web/package.json",
    "products/shop/workers/api/package.json",
    "products/shop/workers/video-renderer/package.json",
    "products/shop/scripts/protected-config.fixtures.json",
    "products/shop/scripts/testing/product-image-v5-fixtures.mjs",
  ])
    files.push(resolve(root, file));
  const subjects = [];
  for (const path of [...new Set(files)].sort()) {
    const bytes = await readFile(path);
    subjects.push({
      path: relative(root, path),
      sha256: digest(bytes),
      bytes: bytes.length,
    });
  }
  const bytes = Buffer.from(
    JSON.stringify(
      { schemaVersion: 1, scope: "local-journey-source-inputs", subjects },
      null,
      2,
    ),
  );
  await writeFile(resolve(artifact, "source-inputs.json"), bytes, {
    mode: 0o600,
  });
  return {
    path: "source-inputs.json",
    sha256: digest(bytes),
    bytes: bytes.length,
    count: subjects.length,
  };
}
