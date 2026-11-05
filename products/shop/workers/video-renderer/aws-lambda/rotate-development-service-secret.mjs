// Run only with explicit approval to rotate the development service credential.
// No production values, AWS credentials or command-line secret arguments.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { ROOT } from "./local-tools.mjs";
import { API_ORIGIN, cloudflareDevelopment } from "./cloudflare-development.mjs";

process.umask(0o077);
const key = "FOREVER_TEE_API_SHARED_SECRET";
const project = "prj_qJ3JwcSlVixLNHRxfwnvfxp8dMBS";
const team = "team_ru36uQa1rhHA6N5wW0lblUkz";
const repository = "bentbrain/bent-mono";
const clean = { ...process.env };
for (const name of Object.keys(clean)) if (/^(AWS_|GH_TOKEN$|GITHUB_TOKEN$)/.test(name)) delete clean[name];
function run(command, args, input = "", env = clean) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", diagnostic = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { diagnostic += chunk; });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.on("error", () => { clearTimeout(timer); reject(new Error(`${command} could not start.`)); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) { accept(output); return; }
      // Only known administrative error categories may leave this process.
      const categories = ["already exists", "not found", "permission", "required", "invalid", "sensitive", "duplicate", "request body", "stdin", "JSON"];
      const signal = categories.filter(word => `${diagnostic}\n${output}`.toLowerCase().includes(word.toLowerCase()));
      reject(new Error(`${command} failed (${code}); categories=${signal.join(",")}; secret output suppressed.`));
    });
  });
}
const personalToken = (await run("gh", ["auth", "token", "--hostname", "github.com", "--user", "bentbrain"])).trim();
assert.ok(personalToken);
const personal = { ...clean, GH_TOKEN: personalToken };
assert.equal(JSON.parse(await run("gh", ["api", "user"], "", personal)).login, "bentbrain");
const githubEnvironment = JSON.parse(await run("gh", ["api", `repos/${repository}/environments/Preview`], "", personal));
assert.equal(githubEnvironment.name, "Preview");
assert.equal(githubEnvironment.id, 19777877265);
const api = async (path, method = "GET", body) => JSON.parse(await run("vercel",
  ["api", `${path}?teamId=${team}`, "--method", method, "--raw", ...(body ? ["--input", "-"] : []),
    ...(method === "DELETE" ? ["--dangerously-skip-permissions"] : [])], body ? JSON.stringify(body) : ""));
const before = (await api(`/v9/projects/${project}/env`)).envs;
const preview = before.filter(entry => entry.key === key && entry.target?.length === 1 && entry.target[0] === "preview");
assert.ok(preview.length === 1 || preview.length === 2, "Review the exact preview targets before rotating.");
assert.ok(preview.some(entry => entry.id === "Qil8zmh8Qjkqwz6f"));
assert.ok(preview.every(entry => ["Qil8zmh8Qjkqwz6f", "usz5mbza3WC1QCBP"].includes(entry.id)));
assert.ok(preview.every(entry => entry.type === "sensitive" && !entry.gitBranch));
const productionMetadata = entries => entries.filter(entry => entry.target?.includes("production"))
  .map(entry => ({ id: entry.id, key: entry.key, target: entry.target, type: entry.type, updatedAt: entry.updatedAt }));
const production = productionMetadata(before);
const cf = await cloudflareDevelopment();
const workerSecrets = await cf("/workers/scripts/forever-tee-api-development/secrets");
assert.ok(workerSecrets.some(secret => secret.name === key));

const directory = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(resolve(ROOT, ".data/aws-lambda/development-service-credential-"));
assert.ok(directory.startsWith(resolve(ROOT, ".data/aws-lambda/development-service-credential-")));
const path = resolve(directory, "development.env");
let secret;
if (process.argv[2]) {
  const saved = parseEnv(await readFile(path, "utf8"));
  assert.equal(saved.FOREVER_TEE_API_URL, API_ORIGIN);
  secret = saved[key];
} else {
  secret = randomBytes(32).toString("base64url");
  await writeFile(path, `${key}=${secret}\nFOREVER_TEE_API_URL=${API_ORIGIN}\n`, { mode: 0o600, flag: "wx" });
}
assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
console.info(JSON.stringify({ event: "rotation-prepared", path }));
// Vercel rejects updates while the legacy duplicate exists. Remove only the
// reviewed older Preview record as part of this approved credential rotation.
if (preview.some(entry => entry.id === "usz5mbza3WC1QCBP")) {
  await api(`/v9/projects/${project}/env/usz5mbza3WC1QCBP`, "DELETE");
  console.info("Removed the older duplicate Preview secret entry; replacing it with the retained entry.");
}
for (const entry of preview.filter(entry => entry.id === "Qil8zmh8Qjkqwz6f")) {
  const updated = await api(`/v9/projects/${project}/env/${entry.id}`, "PATCH", { value: secret });
  assert.equal(updated.id, entry.id);
  assert.deepEqual(updated.target, ["preview"]);
  assert.equal(updated.type, "sensitive");
  console.info(JSON.stringify({ event: "preview-entry-updated", id: entry.id }));
}
await run("gh", ["secret", "set", key, "--repo", repository, "--env", "Preview"], secret, personal);
console.info("GitHub Preview deployment source updated using bentbrain.");
await cf("/workers/scripts/forever-tee-api-development/secrets", { name: key, text: secret, type: "secret_text" }, "PUT");
const after = (await api(`/v9/projects/${project}/env`)).envs;
assert.deepEqual(productionMetadata(after), production, "Production environment metadata must remain unchanged.");
const check = await fetch(`${API_ORIGIN}/v2/design-drafts/${crypto.randomUUID()}`, { headers: {
  "x-forever-tee-service-secret": secret, "x-forever-tee-owner-id": randomBytes(32).toString("hex") },
  redirect: "error", signal: AbortSignal.timeout(10_000) });
await check.body?.cancel();
assert.equal(check.status, 404, "The new credential must authenticate without accessing a customer's draft.");
await writeFile(resolve(directory, "receipt.json"), JSON.stringify({ completedAt: new Date().toISOString(),
  project, githubEnvironment: "Preview", worker: "forever-tee-api-development", previewIds: ["Qil8zmh8Qjkqwz6f"],
  authenticated: true, productionUnchanged: true }, null, 2), { mode: 0o600 });
console.info(JSON.stringify({ event: "rotation-complete", path, authenticated: true, productionUnchanged: true }));
