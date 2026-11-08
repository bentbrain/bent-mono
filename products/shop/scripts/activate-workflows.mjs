import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PRODUCT_ROOT, REPOSITORY_ROOT } from "./monorepo-source.mjs";

export const releaseWorkflowNames = Object.freeze([
  "native-ci-identity.yml", "native-production-identity.yml", "native-development.yml", "native-production.yml",
  "native-production-foundation.yml", "deploy.yml", "web-production.yml", "preview-smoke.yml",
]);
export const operationalWorkflowNames = Object.freeze([
  "operations.yml", "product-lifecycle.yml", "configure-printify-webhooks.yml", "featured-products.yml",
  "featured-video.yml", "featured-composition.yml", "backup-renderer.yml", "email-notifications.yml",
]);
// Source generation is a PR preparation tool, never a release-time rewrite.
// Schedule activation is a separate reviewed choice after fresh qualification.
export async function activateShopWorkflows({ check = true, schedule = false, operations = false, destination = join(REPOSITORY_ROOT, ".github/workflows") } = {}) {
  const names = [...releaseWorkflowNames, ...(operations ? operationalWorkflowNames : []), ...(schedule ? ["native-qualification-schedule.yml"] : [])];
  if (!check) await mkdir(destination, { recursive: true });
  const files = [];
  for (const name of names) {
    const source = await readFile(join(PRODUCT_ROOT, ".github/workflows", name));
    if (source.includes("{{SHOP:")) throw new Error("A release workflow contains unresolved protected markers.");
    const target = join(destination, name);
    if (check) {
      if (!(await readFile(target)).equals(source)) throw new Error(`Shop workflow differs from its reviewed source: ${name}`);
    } else if (operations) {
      // Explicit operations preparation can add the continuing workflows beside
      // already reviewed release copies. Existing bytes must still match.
      let existing;
      try { existing = await readFile(target); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (existing && !existing.equals(source)) throw new Error(`Shop workflow differs from its reviewed source: ${name}`);
      if (!existing) await writeFile(target, source, { flag: "wx", mode: 0o644 });
    } else await writeFile(target, source, { flag: "wx", mode: 0o644 });
    files.push({ name, sha256: createHash("sha256").update(source).digest("hex") });
  }
  return files;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--check", "--write", "--with-schedule", "--with-operations"].includes(arg)) || args.includes("--write") && args.includes("--check")) throw new Error("Choose --check or --write, optionally --with-schedule or --with-operations.");
  console.info(JSON.stringify(await activateShopWorkflows({ check: !args.includes("--write"), schedule: args.includes("--with-schedule"), operations: args.includes("--with-operations") })));
}
