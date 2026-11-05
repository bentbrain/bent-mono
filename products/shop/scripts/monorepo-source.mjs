import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const PRODUCT_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PRODUCT_PREFIX = "products/shop/";
const WORKSPACE_PREFIX = "@monorepo/";

// Product policy retains its own vocabulary. Every external repository input
// remains distinguishable, so it cannot masquerade as a product-local leaf.
export function releasePath(path) {
  return path.startsWith(PRODUCT_PREFIX) ? path.slice(PRODUCT_PREFIX.length) : `${WORKSPACE_PREFIX}${path}`;
}
export function repositoryPath(path) {
  return path.startsWith(WORKSPACE_PREFIX) ? path.slice(WORKSPACE_PREFIX.length) : `${PRODUCT_PREFIX}${path}`;
}
export function releaseTree(source) {
  return execFileSync("git", ["ls-tree", "--full-tree", "-r", "-z", source], {
    cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean).map(record => {
    const separator = record.indexOf("\t");
    return `${record.slice(0, separator + 1)}${releasePath(record.slice(separator + 1))}`;
  }).join("\0") + "\0";
}
export function releaseBlob(source, path) {
  return execFileSync("git", ["show", `${source}:${repositoryPath(path)}`], {
    cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
  });
}
export async function storefrontSourceManifest() {
  const paths = execFileSync("git", ["ls-files", "--cached", "-z"], {
    cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean).sort();
  const files = [];
  for (const path of paths) {
    files.push({ path, sha256: createHash("sha256").update(await readFile(join(REPOSITORY_ROOT, path))).digest("hex") });
  }
  return files;
}
