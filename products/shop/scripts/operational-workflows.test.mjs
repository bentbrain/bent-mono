import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operationalSchemas, sealOperationalInput, validateOperationalDispatch } from "./operational-dispatch-inputs.mjs";
import { activateShopWorkflows, operationalWorkflowNames } from "./activate-workflows.mjs";
import { sealOperationalArtifacts } from "./seal-operational-artifacts.mjs";
import { openReleaseArchive, openReleaseEvidence, sealReleaseEvidence } from "./release-evidence.mjs";
import { PRODUCT_ROOT } from "./monorepo-source.mjs";
import { protectedConfig } from "./protected-config.mjs";

const source = "a".repeat(40), id = "11111111-1111-4111-8111-111111111111";
const keys = { SHOP_EVIDENCE_KEY_VERSION: "v1", SHOP_EVIDENCE_ENCRYPTION_KEY: "07".repeat(32) };
const records = {
  "operations.yml": { reason: "Synthetic private operation reason\nsecond line", configured_product_id: "" },
  "product-lifecycle.yml": { configured_product_id: id, expected_state: "active", target_state: "suspended", reason: "Synthetic private reason", confirmation: "", command_id: id },
  "featured-products.yml": { expected_revision: "4", command_id: id, slot_1: id, slot_2: "", slot_3: "", slot_4: "", slot_5: "", slot_6: "" },
  "featured-video.yml": { final_product: id },
  "featured-composition.yml": { native_release: "native-123", qualified_source: "", cleanup_source: "" },
  "backup-renderer.yml": { recovery_source: "" },
  "configure-printify-webhooks.yml": {},
};
function fixture(workflow, operation = operationalSchemas[workflow].operations?.[0] ?? "render", environment = "development", record = records[workflow]) {
  const schema = operationalSchemas[workflow];
  if (schema.production) environment = "production";
  const env = { ...keys, PATH: process.env.PATH, SHOP_PROTECTED_CONFIG_JSON: process.env.SHOP_PROTECTED_CONFIG_JSON,
    GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", GITHUB_REPOSITORY: "bentbrain/bent-mono",
    GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"),
    GITHUB_ACTOR_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: `bentbrain/bent-mono/.github/workflows/${workflow}@refs/heads/main`, GITHUB_SHA: source, GITHUB_RUN_ID: "12345", GITHUB_JOB: "operate",
    SHOP_OPERATION_ENVIRONMENT: environment === "production" ? "Production" : "Preview" };
  const event = { ref: "main", inputs: { expected_source: source, ...(schema.production ? {} : { environment }),
    ...(schema.selector ? { [schema.selector]: operation } : { color: "default" }),
    ...(Object.keys(schema.fields).length ? { private_input: sealOperationalInput({ workflow, environment, operation, sourceCommit: source, inputs: record }, keys) } : {}) } };
  return { env, event, operation, environment };
}
const workflowText = name => readFile(join(PRODUCT_ROOT, ".github/workflows", name), "utf8");
function liveCommand(text) {
  return text.matchAll(/run: \|\n((?:          .*\n)+)/g);
}
function extractedOperation(text) {
  const matches = [...liveCommand(text)].map(match => match[1].split("\n").filter(Boolean).map(line => line.slice(10)).join("\n"));
  const commands = matches.filter(command => command.startsWith("node scripts/protected-command.mjs"));
  assert.equal(commands.length, 1);
  return commands[0];
}

test("each supported selector authenticates its complete private record and rejects altered authority or unknown fields", () => {
  for (const workflow of Object.keys(operationalSchemas)) {
    for (const operation of operationalSchemas[workflow].operations ?? ["render"]) {
      const f = fixture(workflow, operation);
      assert.deepEqual(validateOperationalDispatch(f.env, f.event).inputs, records[workflow]);
      for (const delta of [
        { GITHUB_SHA: "b".repeat(40) }, { GITHUB_REPOSITORY: "other/repository" }, { GITHUB_REPOSITORY_ID: "42" },
        { GITHUB_REPOSITORY_OWNER_ID: "42" }, { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_EVENT_NAME: "push" },
        { GITHUB_REF: "refs/heads/other" }, { RUNNER_ENVIRONMENT: "self-hosted" }, { SHOP_OPERATION_ENVIRONMENT: "Other" },
        { GITHUB_WORKFLOW_REF: f.env.GITHUB_WORKFLOW_REF.replace("main", "other") },
      ]) assert.throws(() => validateOperationalDispatch({ ...f.env, ...delta }, f.event), workflow);
      assert.throws(() => validateOperationalDispatch(f.env, { ...f.event, inputs: { ...f.event.inputs, injected: "private" } }));
      if (f.event.inputs.private_input) {
        assert.equal(f.event.inputs.private_input.includes(id), false);
        assert.throws(() => validateOperationalDispatch(f.env, { ...f.event, inputs: { ...f.event.inputs, private_input: JSON.stringify(records[workflow]) } }));
        assert.throws(() => sealOperationalInput({ workflow, environment: f.environment, operation, sourceCommit: source, inputs: { ...records[workflow], GH_TOKEN: "injection" } }, keys));
        const otherEnvironment = f.environment === "production" ? "development" : "production";
        assert.throws(() => validateOperationalDispatch({ ...f.env, SHOP_OPERATION_ENVIRONMENT: otherEnvironment === "production" ? "Production" : "Preview" },
          { ...f.event, inputs: { ...f.event.inputs, environment: otherEnvironment } }));
      }
      if (operationalSchemas[workflow].owner) assert.throws(() => validateOperationalDispatch({ ...f.env, GITHUB_ACTOR_ID: "42" }, f.event));
    }
  }
  const defaultVideo = fixture("featured-video.yml", "render", "development", {});
  assert.equal(validateOperationalDispatch(defaultVideo.env, defaultVideo.event).inputs.final_product, "1");
  const a = fixture("operations.yml"), b = fixture("featured-products.yml");
  assert.throws(() => validateOperationalDispatch(b.env, { ...b.event, inputs: { ...b.event.inputs, private_input: a.event.inputs.private_input } }));
  assert.throws(() => validateOperationalDispatch(a.env, { ...a.event, inputs: { ...a.event.inputs, action: "shell" } }));
  assert.throws(() => validateOperationalDispatch(a.env, { ...a.event, inputs: { ...a.event.inputs, action: "pause-sales" } }));
  const header = JSON.parse(a.event.inputs.private_input);
  const identity = { sourceCommit: source, runId: header.runId, filename: "operations-input.json" };
  const payload = openReleaseEvidence(a.event.inputs.private_input, identity, keys);
  payload.inputs.GH_TOKEN = "synthetic-injected-token";
  const unknownField = sealReleaseEvidence(payload, identity, keys);
  assert.throws(() => validateOperationalDispatch(a.env, { ...a.event, inputs: { ...a.event.inputs, private_input: unknownField } }));
});

test("reviewed preparation keeps the release default and checks canonical bytes for all continuing workflows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shop-operations-activation-"));
  try {
    assert.equal((await activateShopWorkflows({ check: false, destination: directory })).length, 8);
    await rm(directory, { recursive: true });
    const files = await activateShopWorkflows({ check: false, operations: true, destination: directory });
    assert.equal(files.length, 16);
    assert.equal(files.some(file => /schedule|recovery|bootstrap|cutover/.test(file.name)), false);
    await activateShopWorkflows({ operations: true, destination: directory });
    await writeFile(join(directory, "operations.yml"), "changed input guard");
    await assert.rejects(activateShopWorkflows({ operations: true, destination: directory }), /differs/);
    await activateShopWorkflows({ operations: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("active operations admit exact-main quality before the fixed consumer, install from root and upload ciphertext only", async () => {
  for (const name of operationalWorkflowNames.filter(name => name !== "email-notifications.yml")) {
    const text = await workflowText(name), command = extractedOperation(text);
    assert.match(text, /github\.repository_id == vars\.SHOP_REPOSITORY_ID/);
    assert.match(text, /github\.repository_owner_id == vars\.SHOP_OWNER_ID/);
    assert.match(text, /github\.run_attempt == 1/);
    assert.match(text, /actions: read/); assert.match(text, /checks: read/); assert.match(text, /statuses: read/); assert.match(text, /pull-requests: read/);
    const validation = text.indexOf("run: node scripts/operational-dispatch-guard.mjs");
    const admission = text.indexOf('run: node ../../scripts/require-release-checks.mjs --sha "$GITHUB_SHA"');
    assert.ok(validation > 0 && admission > validation && text.indexOf(command.split("\n")[0]) > admission);
    assert.match(command, /--import \.\/scripts\/decode-operational-dispatch\.mjs/);
    assert.match(command, /--import \.\/scripts\/public-release-logging\.mjs/);
    for (const line of text.split("\n").filter(line => line.includes("path:"))) assert.match(line, /runner\.temp.*(?:sealed-operational-evidence|shop-encrypted-diagnostics)/);
    for (const match of text.matchAll(/run: (bun install[^\n]+)\n([^\n]+)/g)) {
      assert.match(match[1], /--frozen-lockfile/); assert.match(match[2], /working-directory: \.$/);
    }
    assert.match(text, /if: always\(\)\n\s+run: node --import \.\/scripts\/public-release-logging\.mjs scripts\/seal-operational-artifacts.mjs/);
  }
  const email = await workflowText("email-notifications.yml");
  assert.match(email, /products\/shop\/shopify\/notifications\/\*\*/);
  assert.match(email, /bun.lock/); assert.match(email, /bun-version: 1\.4\.4/);
  assert.match(email, /working-directory: products\/shop\/shopify\/notifications/);
  assert.match(email, /path: products\/shop\/shopify\/notifications\/dist\//);
  assert.doesNotMatch(email, /npm |package-lock|cache: npm/);
});

test("the extracted lifecycle command retains one request on uncertain outcome and encrypts its full receipt before upload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shop-operation-command-"));
  const workflow = "product-lifecycle.yml";
  try {
    const f = fixture(workflow, "transition"), eventPath = join(directory, "event.json"), calls = join(directory, "calls.jsonl");
    const mock = join(directory, "mock.mjs");
    await writeFile(eventPath, JSON.stringify(f.event));
    await writeFile(mock, `import { appendFileSync } from "node:fs";
      globalThis.fetch = async (url, options) => {
        appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ url: String(url), body: options.body }) + "\\n");
        if (String(url).startsWith("https://identity.example.com/")) return Response.json({ value: "synthetic-oidc" });
        throw new Error("synthetic-private-response-lost");
      };`);
    // The consumer's relative imports and workflow cwd stay unchanged. Receipt
    // names are redirected only in the mock filesystem shim, with real wx flags.
    await writeFile(mock, (await readFile(mock, "utf8")) + `
      import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
      const original = fs.promises.writeFile;
      fs.promises.writeFile = (path, ...args) => original(typeof path === "string" && path.startsWith("product-lifecycle-") ? ${JSON.stringify(directory)} + "/" + path : path, ...args);
      syncBuiltinESMExports();`);
    const env = { ...f.env, RUNNER_TEMP: directory, GITHUB_EVENT_PATH: eventPath, NODE_OPTIONS: `--import=${mock}`,
      WORKER_URL: "https://api.example.com", WEB_ORIGIN: "https://web.example.com", BENT_SHIRT_OPERATIONS_SECRET: "synthetic-secret",
      FOREVER_TEE_API_SHARED_SECRET: "synthetic-service", ACTIONS_ID_TOKEN_REQUEST_URL: "https://identity.example.com/", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-identity" };
    const command = extractedOperation(await workflowText(workflow));
    const result = spawnSync("bash", ["-euc", command], { cwd: PRODUCT_ROOT, env, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-response-lost|Synthetic private reason|11111111/);
    const request = await readFile(join(directory, "product-lifecycle-request.json"));
    assert.equal(JSON.parse(request).commandId, id);
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 2);
    const again = spawnSync("bash", ["-euc", command], { cwd: PRODUCT_ROOT, env, encoding: "utf8", timeout: 30000 });
    assert.equal(again.status, 1);
    assert.deepEqual(await readFile(join(directory, "product-lifecycle-request.json")), request);
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 2, "uncertain operation cannot be sent twice in the same job");
    await sealOperationalArtifacts(workflow, env, directory);
    const encrypted = join(directory, "sealed-operational-evidence/operational-evidence.tar.enc");
    assert.equal((await readFile(encrypted)).includes(Buffer.from(id)), false);
    const restored = join(directory, "restored.tar");
    await openReleaseArchive(encrypted, restored, { sourceCommit: source, runId: "12345", filename: "product-lifecycle-evidence.json" }, keys);
    assert.deepEqual(execFileSync("tar", ["-xOf", restored, "product-lifecycle-request.json"]), request);
    await assert.rejects(access(join(directory, "private-operational-evidence.tar")), { code: "ENOENT" });
    assert.equal((await stat(encrypted)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("operational archive rejects symlinks and wrong workflow context without uploading plaintext", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shop-operation-archive-"));
  try {
    const f = fixture("backup-renderer.yml");
    await mkdir(join(directory, "backup-renderer-output"));
    await writeFile(join(directory, "private.json"), "synthetic-private-record");
    await symlink(join(directory, "private.json"), join(directory, "backup-renderer-output/receipt.json"));
    await assert.rejects(sealOperationalArtifacts("backup-renderer.yml", { ...f.env, RUNNER_TEMP: directory }, directory), /Unexpected/);
    await assert.rejects(sealOperationalArtifacts("featured-video.yml", { ...f.env, RUNNER_TEMP: directory }, directory), /context/);
    await assert.rejects(access(join(directory, "sealed-operational-evidence")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the extracted lifecycle transition invalidates the storefront with an optional bypass and keeps private results encrypted", async () => {
  for (const bypass of ["", "synthetic-bypass"]) {
    const directory = await mkdtemp(join(tmpdir(), "shop-lifecycle-invalidation-"));
    try {
      const f = fixture("product-lifecycle.yml", "transition"), eventPath = join(directory, "event.json"), mock = join(directory, "mock.mjs"), calls = join(directory, "calls.jsonl");
      await writeFile(eventPath, JSON.stringify(f.event));
      await writeFile(mock, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
        const original = fs.promises.writeFile;
        fs.promises.writeFile = (path, ...args) => original(typeof path === "string" && path.startsWith("product-lifecycle-") ? ${JSON.stringify(directory)} + "/" + path : path, ...args);
        syncBuiltinESMExports();
        globalThis.fetch = async (url, options) => {
          fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ url: String(url), headers: options.headers }) + "\\n");
          if (String(url).startsWith("https://identity.example.com/")) return Response.json({ value: "synthetic-oidc" });
          return Response.json({ private: "synthetic-private-result" });
        };`);
      const env = { ...f.env, RUNNER_TEMP: directory, GITHUB_EVENT_PATH: eventPath, NODE_OPTIONS: `--import=${mock}`,
        WORKER_URL: "https://api.example.com", WEB_ORIGIN: "https://web.example.com", BENT_SHIRT_OPERATIONS_SECRET: "synthetic-secret",
        FOREVER_TEE_API_SHARED_SECRET: "synthetic-service", VERCEL_AUTOMATION_BYPASS_SECRET: bypass,
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://identity.example.com/", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-identity" };
      const result = spawnSync("bash", ["-euc", extractedOperation(await workflowText("product-lifecycle.yml"))], { cwd: PRODUCT_ROOT, env, encoding: "utf8", timeout: 30000 });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-result|synthetic-service|synthetic-bypass/);
      const requests = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(requests.length, 3);
      assert.equal(requests[2].url, "https://web.example.com/api/internal/revalidate-products");
      assert.equal(requests[2].headers["x-forever-tee-service-secret"], "synthetic-service");
      assert.equal(requests[2].headers["x-vercel-protection-bypass"], bypass || undefined);
      assert.equal(JSON.parse(await readFile(join(directory, "product-lifecycle-result.json"), "utf8")).result.private, "synthetic-private-result");
      assert.equal((await stat(join(directory, "product-lifecycle-request.json"))).mode & 0o777, 0o600);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});


test("the actual featured render command keeps its fixed manifest private and protects it from overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shop-featured-manifest-"));
  try {
    const f = fixture("featured-video.yml"), eventPath = join(directory, "event.json"), mock = join(directory, "mock.mjs");
    await writeFile(eventPath, JSON.stringify(f.event));
    // Exercise the real input validation and manifest writer. Only the expensive
    // video renderer and HTTP transport use synthetic implementations.
    await writeFile(mock, `import { registerHooks } from "node:module";
      import { createHash } from "node:crypto";
      import { pathToFileURL } from "node:url";
      import assert from "node:assert/strict";
      const renderer = pathToFileURL(${JSON.stringify(join(PRODUCT_ROOT, "workers/video-renderer/custom/renderer.mjs"))}).href;
      registerHooks({ load(url, context, next) {
        if (url !== renderer) return next(url, context);
        return { format: "module", shortCircuit: true, source: 'import { mkdir, writeFile } from "node:fs/promises"; import { join } from "node:path"; export async function renderFeaturedVideo({outputDirectory}) { await mkdir(outputDirectory, {recursive:true}); const mp4=join(outputDirectory,"featured.mp4"); await writeFile(mp4,"synthetic video"); return {mp4, quality:{passed:true}, frameCount:1}; }' };
      }});
      const id = ${JSON.stringify(id)}, artwork = Buffer.from("synthetic artwork"), hash = createHash("sha256").update(artwork).digest("hex");
      globalThis.fetch = async (url, options) => {
        assert.equal(url.origin, "https://forever-tee-api-development.socialqueue.workers.dev");
        assert.equal(options.redirect, "error");
        assert.equal(options.headers["x-forever-tee-service-secret"], "synthetic-service");
        if (url.pathname === "/v2/internal/featured-products") return Response.json({products:[{slot:1,productId:id}]});
        if (url.pathname.endsWith("/artwork")) return new Response(artwork);
        if (url.pathname.startsWith("/v1/designs/")) return Response.json({id,status:"ready",artworkRevision:hash,settings:{cropX:0.5,cropY:0.5,cropZoom:1}});
        return Response.json({configuredProductId:id,designId:id,designRevisionId:id,baseProductSlug:"staple-tee",artworkSha256:hash,contentType:"image/png",byteSize:artwork.length,artworkUrl:"/v2/internal/design-revisions/"+id+"/artwork",placement:{x:0.2,y:0.3,width:0.4,depth:2}});
      };`);
    const env = { ...f.env, RUNNER_TEMP: directory, GITHUB_EVENT_PATH: eventPath, NODE_OPTIONS: `--import=${mock}`,
      WORKER_URL: "https://forever-tee-api-development.socialqueue.workers.dev", FOREVER_TEE_API_SHARED_SECRET: "synthetic-service",
      RENDER_COLOR: "default", GITHUB_STEP_SUMMARY: join(directory, "summary.md") };
    // Match the workflow imports while using a disposable cwd for its fixed output.
    const args = ["--import", join(PRODUCT_ROOT, "scripts/public-release-logging.mjs"), "--import", join(PRODUCT_ROOT, "scripts/decode-operational-dispatch.mjs"), join(PRODUCT_ROOT, "workers/video-renderer/custom/render.mjs")];
    const first = spawnSync(process.execPath, args, {cwd:directory,env,encoding:"utf8",timeout:30000});
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stdout + first.stderr + await readFile(env.GITHUB_STEP_SUMMARY, "utf8"), /11111111|synthetic-service/);
    const manifestPath = join(directory, "featured-video-output/manifest.json");
    const readManifest = async () => {
      const handle = await open(manifestPath, "r");
      try {
        assert.equal((await handle.stat()).mode & 0o777, 0o600);
        return await handle.readFile();
      } finally { await handle.close(); }
    };
    const bytes = await readManifest();
    assert.equal(JSON.parse(bytes).finalProductId, id);
    assert.equal(spawnSync(process.execPath, args, {cwd:directory,env,encoding:"utf8",timeout:30000}).status, 1);
    assert.deepEqual(await readManifest(), bytes);
    await sealOperationalArtifacts("featured-video.yml", env, directory);
    const restored = join(directory, "render-evidence.tar");
    await openReleaseArchive(join(directory, "sealed-operational-evidence/operational-evidence.tar.enc"), restored,
      { sourceCommit: source, runId: "12345", filename: "featured-video-evidence.json" }, keys);
    assert.deepEqual(execFileSync("tar", ["-xOf", restored, "featured-video-output/manifest.json"]), bytes);
  } finally { await rm(directory, {recursive:true,force:true}); }
});
