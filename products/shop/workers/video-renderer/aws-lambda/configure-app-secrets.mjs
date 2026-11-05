import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { aws, ROOT } from "./local-tools.mjs";
import { cloudflareDevelopment } from "./cloudflare-development.mjs";
import { installAppSecrets } from "./app-secret-bootstrap.mjs";

// Never export personal SSO credentials. This new, invoke-only service key is
// transferred directly to the development Worker's encrypted secret store.
process.umask(0o077);
const directory = resolve(ROOT, ".data/aws-personal");
const path = resolve(directory, "lambda-worker-secrets.json");
await mkdir(directory, { recursive: true, mode: 0o700 });
async function durableWrite(target, value) {
  const file = await open(target, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
}
async function syncDirectory() {
  const file = await open(directory, "r");
  try { await file.sync(); } finally { await file.close(); }
}
await installAppSecrets({ aws, cf: await cloudflareDevelopment(),
  load: async () => {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw new Error("Cannot read the development service-key recovery file.");
    }
  },
  createRecovery: async value => { await durableWrite(path, value); await syncDirectory(); },
  replaceRecovery: async value => {
    const temporary = `${path}.${randomUUID()}.next`;
    await durableWrite(temporary, value);
    await rename(temporary, path);
    await syncDirectory();
  },
});
console.info("Development invoke-only credentials and the job-grant secret installed. Secret values were not logged.");
