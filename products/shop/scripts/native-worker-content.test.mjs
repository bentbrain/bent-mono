import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectDevelopmentWorker } from "./native-ci-worker.mjs";
import { prepareWorkerUpload, readWorkerUpload, preserveWorkerUpload, readSealedWorkerUpload, verifyWorkerUpload,
  workerContentManifest, workerContentResponse, historicalWorkerUpload } from "./native-worker-content.mjs";

const code = Buffer.from('export default {};\n//# sourceMappingURL=index.js.map\n');
const map = Buffer.from(JSON.stringify({ version: 3, file: "index.js", sources: ["src.ts"], sourcesContent: ["export default {}"], names: [], mappings: "" }));
const manifest = () => workerContentManifest(workerContentResponse({ code, map }));

test("complete upload readback rejects changed, missing, duplicate, unsealed and unknown parts", async () => {
  const content = await manifest(), review = { schemaVersion: 2, bundleSha256: content.modules[0].sha256, bundleBytes: code.length, content };
  verifyWorkerUpload(content, review);
  async function checkParts(parts) { assert.throws(() => verifyWorkerUpload(parts, review)); }
  for (const parts of [{ code: Buffer.from("changed"), map }, { code, map: Buffer.from(map.toString().replace("src.ts", "bad.ts")) }, { code }])
    await checkParts(await workerContentManifest(workerContentResponse(parts)));
  assert.throws(() => verifyWorkerUpload(content, { bundleSha256: review.bundleSha256 }), /unsealed/);
  for (const extra of ["index.js", "index.js.map", "execute.wasm", "extra.js"]) {
    const parts = new FormData();
    parts.append("index.js", new Blob([code]), "index.js");
    parts.append("index.js.map", new Blob([map]), "index.js.map");
    parts.append(extra, new Blob(["extra"]), extra);
    const response = new Response(parts, { headers: { "cf-entrypoint": "index.js" } });
    if (["index.js", "index.js.map"].includes(extra)) await assert.rejects(workerContentManifest(response), /unique/);
    else {
      const unknown = await workerContentManifest(response);
      assert.throws(() => verifyWorkerUpload(unknown, review), /supported/);
    }
  }
  assert.throws(() => verifyWorkerUpload({ ...content, entrypoint: "other.js" }, review), /supported/);
  assert.throws(() => workerContentResponse({ code: Buffer.from('import "./index.js.map"'), map }), /executable/);
  assert.throws(() => workerContentResponse({ code, map: Buffer.from('{"version":2}') }), /source map/);
});

test("actual dry-run multipart parts are sealed before upload and rehydrated without a build", async t => {
  const directory = await mkdtemp(join(tmpdir(), "sealed-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let builds = 0;
  const run = async args => {
    if (args.includes("--outdir")) {
      builds++;
      const out = args[args.indexOf("--outdir") + 1];
      await mkdir(out); await writeFile(join(out, "index.js"), code); await writeFile(join(out, "index.js.map"), map);
    } else {
      const form = new FormData();
      form.append("metadata", JSON.stringify({ main_module: "index.js" }));
      form.append("index.js", new Blob([await readFile(args[1])]), "index.js");
      form.append("index.js.map", new Blob([await readFile(join(args[1], "..", "index.js.map"))]), "index.js.map");
      await writeFile(args.at(-1), Buffer.from(await new Response(form).arrayBuffer()));
    }
  };
  const upload = await prepareWorkerUpload({ run, directory: join(directory, "prepared"), environment: "development" });
  const saved = new Map(), store = { save: async (name, bytes) => { saved.set(name, bytes); return { key: name }; }, read: async ref => saved.get(ref.key) };
  const artifacts = await preserveWorkerUpload(store, upload, "candidate-worker"), review = {
    schemaVersion: 2, bundleSha256: upload.content.modules[0].sha256, bundleBytes: code.length, content: upload.content };
  assert.equal(artifacts.candidateMapArtifact.key, "candidate-worker-map.json");
  const restored = await prepareWorkerUpload({ run, directory: join(directory, "restored"), environment: "development", sealed: { artifacts, review, store } });
  assert.deepEqual(restored, upload);
  assert.equal(builds, 1);
  saved.set("candidate-worker-map.json", Buffer.from(map.toString().replace("src.ts", "bad.ts")));
  await assert.rejects(readSealedWorkerUpload(store, artifacts, review), /complete content/);
  await writeFile(join(directory, "prepared", "unexpected.wasm"), "unknown executable");
  await assert.rejects(readWorkerUpload(join(directory, "prepared")), /unrecorded/);
});

test("historical executor/API inspection reconstructs complete sealed content while active resources remain exact", async () => {
  const content = await manifest(), before = { workerVersion: "11111111-1111-4111-8111-111111111111", content };
  const resources = { bindings: [], script_runtime: {} };
  const { versionResourcesDigest } = await import("./native-ci-worker.mjs");
  before.versionResourcesSha256 = versionResourcesDigest({ resources });
  const cf = { deployments: async () => ({ deployments: [{ versions: [{ version_id: before.workerVersion, percentage: 100 }] }] }),
    versions: async () => ({ items: [{ id: "22222222-2222-4222-8222-222222222222" }] }),
    version: async id => ({ id, resources }), content: () => assert.fail("latest content cannot prove a historical version") };
  const historical = await historicalWorkerUpload(before, { code, map });
  assert.deepEqual((await inspectDevelopmentWorker(cf, historical)).content, content);
  await assert.rejects(inspectDevelopmentWorker(cf, await historicalWorkerUpload(before, { code })), /historical Worker bytes/);
  resources.bindings.push({ name: "FOREIGN", type: "service", service: "other" });
  await assert.rejects(inspectDevelopmentWorker(cf, historical), /immutable Worker resources/);
});
