import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { readRegularFile } from "./read-regular-file.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const require = createRequire(import.meta.url);
export const wranglerCli = () => join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");

// Configs live outside the checkout. Template bytes remain reviewable and the
// resolved bytes are separately sealed in the private release evidence.
export async function renderTerraformModule(source, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = (await readdir(source)).sort();
  const companion = new Set(["README.md", "development-candidate.json", "development-qualification.json", "production-promotion.json", "remote-state.example.hcl"]);
  const files = entries.filter(name => !companion.has(name));
  if (!files.length || files.some(name => !/^(?:[a-z][a-z0-9-]*\.tf|\.terraform\.lock\.hcl)$/.test(name))) {
    throw new Error("Only the reviewed Terraform module files may be rendered.");
  }
  const template = [], rendered = [];
  for (const name of files) {
    const bytes = await readRegularFile(join(source, name), { minBytes: 1, maxBytes: 1024 * 1024, message: "Invalid Terraform source file." });
    const resolved = resolveProtectedTemplate(bytes);
    template.push([name, hash(bytes)]);
    rendered.push([name, hash(resolved)]);
    await writeFile(join(destination, name), resolved, { flag: "wx", mode: 0o600 });
  }
  return { directory: destination, templateSha256: hash(JSON.stringify(template)), resolvedSha256: hash(JSON.stringify(rendered)) };
}

function absoluteWranglerPaths(config, base) {
  const output = structuredClone(config);
  const visit = value => {
    for (const key of ["main", "base_dir", "tsconfig"]) {
      if (typeof value[key] === "string") value[key] = resolve(base, value[key]);
    }
    if (value.assets && typeof value.assets.directory === "string") value.assets.directory = resolve(base, value.assets.directory);
    for (const database of value.d1_databases ?? []) {
      if (typeof database.migrations_dir === "string") database.migrations_dir = resolve(base, database.migrations_dir);
    }
  };
  visit(output);
  for (const environment of Object.values(output.env ?? {})) visit(environment);
  return output;
}

export async function renderWranglerConfig(source, destination) {
  const bytes = await readRegularFile(source, { minBytes: 1, maxBytes: 1024 * 1024, message: "Invalid Wrangler source file." });
  // The reviewed templates use whole-line comments only; unexpected syntax fails.
  const input = JSON.parse(resolveProtectedTemplate(bytes).replace(/^\s*\/\/.*$/gm, ""));
  const resolved = JSON.stringify(absoluteWranglerPaths(input, dirname(source)));
  await writeFile(destination, resolved, { flag: "wx", mode: 0o600 });
  return { path: destination, templateSha256: hash(bytes), resolvedSha256: hash(resolved) };
}

export const lambdaProtectedConfiguration = () => JSON.stringify({ awsAccountId: protectedConfig("awsAccountId") });
const workerConfigurationKeys = [
  "awsAccountId", "cloudflareAccountId", "githubRepositoryId", "githubOwnerId", "previewRendererOrigin",
  "resource_fb377032d2f5", "resource_1a1378f0d1dc", "resource_5df53ebae4ae", "resource_211886fbc19e",
  "order1003ProviderProductId", "resource_1b4cc40f0983", "resource_837385716250", "order1003ProviderOrderId",
  "resource_04473478c366", "resource_5ba68fa39a92", "resource_d590174029ce", "order1004ProviderOrderId", "resource_c7bc487d56fd",
];
export function workerProtectedConfiguration() {
  return JSON.stringify(Object.fromEntries(workerConfigurationKeys.map(key => [key, protectedConfig(key)])));
}
