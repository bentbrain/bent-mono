import { openReleaseEvidence } from "./release-evidence.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectDevelopmentWorker } from "./native-ci-worker.mjs";
import { prepareWorkerUpload, readWorkerUpload, preserveWorkerUpload, readSealedWorkerUpload, verifyWorkerUpload,
  workerContentManifest, workerContentResponse, historicalWorkerUpload, verifyWorkerUploadEvidence, verifySourceMap } from "./native-worker-content.mjs";

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
    schemaVersion: 3, bundleSha256: upload.content.modules[0].sha256, bundleBytes: code.length, content: upload.content };
  assert.equal(artifacts.candidateMapArtifact.key, "candidate-worker-map.json");
  const restored = await prepareWorkerUpload({ run, directory: join(directory, "restored"), environment: "development", sealed: { artifacts, review, store } });
  assert.deepEqual(restored, upload);
  assert.equal(builds, 1);
  saved.set("candidate-worker-map.json", Buffer.from(map.toString().replace("src.ts", "bad.ts")));
  await assert.rejects(readSealedWorkerUpload(store, artifacts, review), /complete source map data/);
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

test("v3 provider readback accepts object serialization changes and seals every source-map value", async () => {
  const raw = JSON.parse(map), reordered = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(raw).reverse()), null, 2));
  const original = await workerContentManifest(workerContentResponse({ code, map }), { sourceMapData: true });
  const observed = await workerContentManifest(workerContentResponse({ code, map: reordered }), { sourceMapData: true });
  assert.notEqual(original.sha256, observed.sha256);
  const review = { schemaVersion: 3, content: original, bundleSha256: original.modules[0].sha256, bundleBytes: code.length };
  verifyWorkerUpload(observed, review);
  assert.throws(() => verifyWorkerUpload(observed, { ...review, schemaVersion: 2 }), /complete content/);
  for (const [key, value] of Object.entries({ mappings: "AAAA", sources: ["other.ts"], sourcesContent: ["changed"], names: ["changed"], file: "other.js", version: 2, extension: { anything: [1, 2] } })) {
    await assert.rejects(async () => verifyWorkerUpload(await workerContentManifest(workerContentResponse({ code, map: Buffer.from(JSON.stringify({ ...raw, [key]: value })) }), { sourceMapData: true }), review));
  }
});

test("map data seal preserves array order and extension fields and rejects ambiguous JSON", async () => {
  const value = { ...JSON.parse(map), sources: ["one.ts", "two.ts"], sourcesContent: ["one", "two"], names: ["one", "two"], extension: { enabled: true, value: null, list: [1, 2] } };
  const content = await workerContentManifest(workerContentResponse({ code, map: Buffer.from(JSON.stringify(value)) }), { sourceMapData: true });
  const review = { schemaVersion: 3, content, bundleSha256: content.modules[0].sha256, bundleBytes: code.length };
  for (const delta of [{ sources: [...value.sources].reverse() }, { names: [...value.names].reverse() }, { sourcesContent: [...value.sourcesContent].reverse() },
    { extension: { ...value.extension, list: [2, 1] } }, { extension: { ...value.extension, enabled: false } }])
    await assert.rejects(async () => verifyWorkerUpload(await workerContentManifest(workerContentResponse({ code, map: Buffer.from(JSON.stringify({ ...value, ...delta })) }), { sourceMapData: true }), review));
  for (const invalid of ['{"version":3,"version":3}', '{"nested":{"a":1,"\\u0061":2}}', '{"n":9007199254740993}', '{"n":1.0000000000000001}', '{"n":-0}', '{"n":1e999}', '{"n":}', '{"x":[1,]}', '{} trailing'])
    assert.throws(() => verifySourceMap(Buffer.from(invalid), code, { sourceMapData: true }), /source map/);
  assert.throws(() => verifySourceMap(Buffer.from([0xff, 0xfe]), code, { sourceMapData: true }), /UTF-8/);
  assert.throws(() => workerContentResponse({ code: Buffer.from('import("./index.js.map?module")'), map }), /executable/);
});

test("V3 map parsing accepts sixteen MiB and rejects larger UTF-8 payloads before parsing", async () => {
  const limit = 16 * 1024 * 1024;
  const value = { ...JSON.parse(map), sourcesContent: [""] };
  const padding = limit - Buffer.byteLength(JSON.stringify(value));
  value.sourcesContent[0] = "é".repeat(Math.floor(padding / 2)) + "x".repeat(padding % 2);
  const bytes = Buffer.from(JSON.stringify(value));
  assert.equal(bytes.byteLength, limit);
  assert.ok(bytes.toString().length < bytes.byteLength);
  const content = await workerContentManifest(workerContentResponse({ code, map: bytes }), { sourceMapData: true });
  assert.equal(content.modules.find(part => part.name === "index.js.map").bytes, limit);
  await assert.rejects(workerContentManifest(workerContentResponse({ code, map: Buffer.concat([bytes, Buffer.from(" ")]) }), { sourceMapData: true }), /bounded source map JSON/);
  assert.throws(() => verifySourceMap(Buffer.alloc(limit + 1), code, { sourceMapData: true }), /bounded source map JSON/);
});

test("V3 immutable reads still reject raw map reserialization while provider readback accepts it", async () => {
  const content = await workerContentManifest(workerContentResponse({ code, map }), { sourceMapData: true });
  const review = { schemaVersion: 3, content, bundleSha256: content.modules[0].sha256, bundleBytes: code.length };
  const artifacts = { candidateArtifact: { key: "code" }, candidateMapArtifact: { key: "map" } };
  await assert.rejects(readSealedWorkerUpload({ read: async ref => ref.key === "code" ? code : Buffer.from(JSON.stringify(JSON.parse(map), null, 2)) }, artifacts, review), /immutable raw artifact/);
});

test("historical V2 reads preserve decimal map extensions and exact raw artifacts", async () => {
  for (const extension of [0.5, 1.25]) {
    const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(map), extension }));
    const content = await workerContentManifest(workerContentResponse({ code, map: bytes }));
    const review = { schemaVersion: 2, content, bundleSha256: content.modules[0].sha256, bundleBytes: code.length };
    const artifacts = { candidateArtifact: { key: "code" }, candidateMapArtifact: { key: "map" } };
    const store = value => ({ read: async ref => ref.key === "code" ? code : value });
    assert.deepEqual((await readSealedWorkerUpload(store(bytes), artifacts, review)).map, bytes);
    const changed = Buffer.from(JSON.stringify({ ...JSON.parse(bytes), extension: extension + 0.25 }));
    await assert.rejects(readSealedWorkerUpload(store(changed), artifacts, review), /complete content/);
    await assert.rejects(readSealedWorkerUpload(store(Buffer.from(JSON.stringify(JSON.parse(bytes), null, 2))), artifacts, review), /complete content/);
    await assert.rejects(workerContentManifest(workerContentResponse({ code, map: bytes }), { sourceMapData: true }), /valid and unambiguous/);
  }
});

test("content mismatches retain encrypted bounded expected and actual manifests", async () => {
  const expected = await workerContentManifest(workerContentResponse({ code, map }), { sourceMapData: true });
  const actual = await workerContentManifest(workerContentResponse({ code, map: Buffer.from(map.toString().replace("src.ts", "other.ts")) }), { sourceMapData: true });
  const review = { schemaVersion: 3, content: expected, bundleSha256: expected.modules[0].sha256, bundleBytes: code.length };
  let encrypted;
  const filename = "content-diagnostic.json", env = { ...process.env, GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123" };
  await assert.rejects(verifyWorkerUploadEvidence(actual, review, { env, filename, store: { save: async (name, bytes) => {
    assert.equal(name, filename); encrypted = bytes.toString();
  } } }), /source map data/);
  assert.equal(encrypted.includes(actual.sourceMapData.sha256), false);
  const opened = openReleaseEvidence(encrypted, { sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, filename }, env);
  assert.deepEqual(opened.expected, expected); assert.deepEqual(opened.actual, actual);
  assert.equal(JSON.stringify(opened).includes("sourcesContent"), false);
});
