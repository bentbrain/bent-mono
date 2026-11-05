// Fixture configuration is confined to nondeploying build and generated-type checks.
import "./test-protected-config.mjs";
import { resolveProtectedTemplate } from "./protected-config.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [operation, environment = "", output = "dist/check"] = process.argv.slice(2);
if (!["build", "types", "types:check", "dev"].includes(operation)) throw new Error("Only local development, dry-run and generated-type checks are supported.");
const root = process.cwd();
const source = await readFile(join(root, "wrangler.jsonc"), "utf8");
const config = JSON.parse(resolveProtectedTemplate(source).replace(/^\s*\/\/.*$/gm, ""));
function absolutePaths(value) {
  if (!value || typeof value !== "object") return;
  if (typeof value.main === "string") value.main = resolve(root, value.main);
  if (value.assets?.directory) value.assets.directory = resolve(root, value.assets.directory);
  for (const item of value.d1_databases ?? []) {
    if (item.migrations_dir) item.migrations_dir = resolve(root, item.migrations_dir);
  }
  for (const item of value.containers ?? []) {
    if (item.image?.startsWith(".")) item.image = resolve(root, item.image);
  }
  for (const child of Object.values(value.env ?? {})) absolutePaths(child);
}
absolutePaths(config);
const destination = join(root, ".wrangler", "local-validation", "wrangler.json");
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify(config), { mode: 0o600 });
const require = createRequire(join(root, "package.json"));
const executable = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
const args = operation === "dev" ? ["dev", "--local", "--env", ""] : operation === "build"
  ? ["deploy", "--dry-run", "--env", environment, "--outdir", resolve(root, output), ...(config.containers ? ["--containers-rollout=none"] : [])]
  : ["types", ...(operation === "types:check" ? ["--check"] : []), "--env-file", "wrangler-types.env"];
const result = spawnSync(process.execPath, [executable, ...args, "--config", ".wrangler/local-validation/wrangler.json"], {
  cwd: root, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
