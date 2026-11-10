import { sealReleaseEvidence } from "./release-evidence.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (value, reason) => { if (!value) throw Error(`Worker content verification failed: ${reason}`); };

// This parser describes every provider part. Admission of supported upload
// parts belongs to the sealed contract below, never to this evidence parser.
export async function workerContentManifest(response, { sourceMapData = false } = {}) {
  check(response.ok, "content download.");
  const modules = [], bodies = new Map();
  let entrypoint = response.headers.get("cf-entrypoint") ?? "index.js";
  if (response.headers.get("content-type")?.startsWith("multipart/")) {
    entrypoint = response.headers.get("cf-entrypoint");
    check(typeof entrypoint === "string" && entrypoint.length > 0, "module entrypoint header.");
    for (const [name, value] of await response.formData()) {
      check(typeof value !== "string" && !modules.some(item => item.name === name), "unique binary module parts.");
      const bytes = Buffer.from(await value.arrayBuffer());
      modules.push({ name, bytes: bytes.length, sha256: hash(bytes) });
      bodies.set(name, bytes);
    }
  } else {
    const bytes = Buffer.from(await response.arrayBuffer());
    modules.push({ name: entrypoint, bytes: bytes.length, sha256: hash(bytes) });
  }
  check(modules.length > 0 && modules.some(item => item.name === entrypoint), "entrypoint module present.");
  modules.sort((a, b) => a.name.localeCompare(b.name));
  const content = { entrypoint, modules, sha256: hash(JSON.stringify({ entrypoint, modules })) };
  if (sourceMapData && bodies.has("index.js.map")) {
    const map = verifySourceMap(bodies.get("index.js.map"), bodies.get("index.js") ?? Buffer.alloc(0), { sourceMapData: true });
    content.sourceMapData = { algorithm: "complete-json-data-v1", sha256: hash(canonicalMap(map)) };
  }
  return content;
}

// JSON object order and whitespace have no map meaning. Arrays, unknown fields,
// strings and every scalar do. Reject duplicate keys and lossy numeric parsing
// before producing this explicitly versioned data seal.
function parseMapData(bytes) {
  check(bytes.byteLength <= 16 * 1024 * 1024, "bounded source map JSON.");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { check(false, "source map UTF-8."); }
  let at = 0;
  const whitespace = () => { while (/[\t\r\n ]/.test(text[at] ?? "!") && at < text.length) at++; };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      if (text[at++] === '"') return JSON.parse(text.slice(start, at));
      if (text[at - 1] === "\\") at++;
    }
    throw Error("unterminated string");
  };
  const value = depth => {
    check(depth <= 64, "source map JSON depth.");
    whitespace();
    if (text[at] === '"') return string();
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at++] === "{", close = object ? "}" : "]", keys = new Set();
      whitespace();
      if (text[at] === close) { at++; return; }
      for (;;) {
        whitespace();
        if (object) {
          check(text[at] === '"', "source map JSON key.");
          const key = string();
          check(!keys.has(key), "duplicate source map JSON key."); keys.add(key);
          whitespace(); check(text[at++] === ":", "source map JSON colon.");
        }
        value(depth + 1); whitespace();
        if (text[at] === close) { at++; return; }
        check(text[at++] === ",", "source map JSON separator.");
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at))?.[0];
    check(token, "source map JSON value."); at += token.length;
    if (!/^(?:true|false|null)$/.test(token)) {
      const number = Number(token);
      check(Number.isSafeInteger(number) && !Object.is(number, -0) && token === String(number), "ambiguous source map JSON number.");
    }
  };
  try { value(0); whitespace(); check(at === text.length, "source map trailing JSON."); return JSON.parse(text); }
  catch { check(false, "source map JSON must be valid and unambiguous."); }
}
const canonicalMap = value => Array.isArray(value) ? `[${value.map(canonicalMap).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalMap(value[key])}`).join(",")}}`
    : JSON.stringify(value);
export const workerContentOptions = review => ({ sourceMapData: review?.schemaVersion === 3 || Boolean(review?.sourceMapData) });

export function verifySourceMap(bytes, code, { sourceMapData = false } = {}) {
  // Historical contracts pin raw bytes. Their JSON admission stays unchanged;
  // only the explicit V3 data seal requires strict canonical numeric inputs.
  let map;
  if (sourceMapData) map = parseMapData(bytes);
  else {
    try { map = JSON.parse(bytes); }
    catch { check(false, "source map JSON."); }
  }
  check(map?.version === 3 && map.file === "index.js" && Array.isArray(map.sources) &&
    map.sources.every(source => typeof source === "string") && Array.isArray(map.names) &&
    map.names.every(name => typeof name === "string") && typeof map.mappings === "string" &&
    (sourceMapData ? !Object.hasOwn(map, "sections") : !map.sections) &&
    ((sourceMapData ? !Object.hasOwn(map, "sourcesContent") : !map.sourcesContent) || Array.isArray(map.sourcesContent) && map.sourcesContent.length === map.sources.length &&
      map.sourcesContent.every(source => source === null || typeof source === "string")), "supported v3 source map for index.js.");
  // A sidecar is data. It cannot participate in the module's executable imports.
  check(!/(?:\bimport\s*\(|\brequire\s*\(|\bfrom\s*|\bimport\s*)["'`]([^"'`]*\.map(?:[?#][^"'`]*)?)["'`]/.test(code.toString()), "executable source-map import.");
  return map;
}

export function supportedWorkerContent(content) {
  check(content?.entrypoint === "index.js" && Array.isArray(content.modules) &&
    [1, 2].includes(content.modules.length) && content.modules[0].name === "index.js" &&
    (content.modules.length === 1 || content.modules[1].name === "index.js.map") &&
    content.modules.every(part => Number.isSafeInteger(part.bytes) && part.bytes > 0 && /^[a-f0-9]{64}$/.test(part.sha256)), "supported complete module manifest.");
  const digest = hash(JSON.stringify({ entrypoint: content.entrypoint, modules: content.modules }));
  check(!content.sha256 || content.sha256 === digest, "manifest digest.");
  return content;
}

export function workerContentResponse({ code, map }) {
  if (!map) return new Response(code);
  verifySourceMap(map, code);
  const parts = new FormData();
  parts.append("index.js", new Blob([code]), "index.js");
  parts.append("index.js.map", new Blob([map]), "index.js.map");
  return new Response(parts, { headers: { "cf-entrypoint": "index.js" } });
}

export async function readWorkerUpload(directory, review) {
  const files = await readdir(directory);
  check(files.includes("index.js") && files.every(name => ["index.js", "index.js.map", "README.md"].includes(name)), "unrecorded upload output module.");
  const code = await readFile(join(directory, "index.js"));
  const map = files.includes("index.js.map") ? await readFile(join(directory, "index.js.map")) : undefined;
  const content = supportedWorkerContent(await workerContentManifest(workerContentResponse({ code, map }), workerContentOptions(review)));
  return { code, map, content };
}

// --outfile contains Wrangler's actual multipart upload, including its source
// map transformation. The raw esbuild map is not necessarily the uploaded map.
async function captureWorkerUpload(run, entrypoint, output, environment, review) {
  await run(["deploy", entrypoint, "--no-bundle", "--dry-run", "--upload-source-maps",
    ...(environment ? ["--env", environment] : []), "--outfile", output]);
  const bytes = await readFile(output), firstLine = bytes.subarray(0, bytes.indexOf("\r\n")).toString();
  check(/^--[A-Za-z0-9_-]{1,100}$/.test(firstLine), "upload multipart boundary.");
  const form = await new Response(bytes, { headers: { "content-type": `multipart/form-data; boundary=${firstLine.slice(2)}` } }).formData();
  check(form.getAll("metadata").length === 1 && typeof form.get("metadata") === "string", "single upload metadata part.");
  const metadata = JSON.parse(form.get("metadata"));
  check(metadata.main_module === "index.js" && !metadata.body_part, "exact upload entrypoint.");
  const parts = new FormData();
  for (const [name, value] of form) if (name !== "metadata") parts.append(name, value);
  const content = supportedWorkerContent(await workerContentManifest(new Response(parts, { headers: { "cf-entrypoint": metadata.main_module } }), workerContentOptions(review)));
  const binary = async name => {
    const value = parts.get(name);
    check(value && typeof value !== "string", "binary upload part.");
    return Buffer.from(await value.arrayBuffer());
  };
  const code = await binary("index.js"), map = parts.has("index.js.map") ? await binary("index.js.map") : undefined;
  if (map) verifySourceMap(map, code, workerContentOptions(review));
  return { code, map, content };
}

export async function prepareWorkerUpload({ run, directory, environment, sealed }) {
  const entrypoint = join(directory, "index.js"), contract = sealed?.review ?? { schemaVersion: 3 };
  let original;
  if (sealed) {
    original = await readSealedWorkerUpload(sealed.store, sealed.artifacts, sealed.review);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(entrypoint, original.code, { flag: "wx", mode: 0o600 });
    if (original.map) await writeFile(join(directory, "index.js.map"), original.map, { flag: "wx", mode: 0o600 });
  } else {
    await run(["deploy", "--dry-run", "--upload-source-maps", ...(environment ? ["--env", environment] : []), "--outdir", directory]);
    const files = await readdir(directory);
    check(files.includes("index.js") && files.every(name => ["index.js", "index.js.map", "README.md"].includes(name)), "unrecorded bundled output module.");
  }
  const upload = await captureWorkerUpload(run, entrypoint, `${directory}-upload.bin`, environment, contract);
  check(equal(upload.code, await readFile(entrypoint)), "Wrangler changed prepared code bytes.");
  if (original) check(equal(upload.content, original.content), "rehydrated upload differs from the reviewed plan.");
  // Retain the exact upload map beside its module. Wrangler's no-bundle map
  // normalization must be idempotent, proved by a second actual dry-run below.
  if (upload.map) await writeFile(join(directory, "index.js.map"), upload.map, { mode: 0o600 });
  const checked = await captureWorkerUpload(run, entrypoint, `${directory}-checked-upload.bin`, environment, contract);
  check(equal(checked.content, upload.content), "upload transformation is not stable.");
  check(equal((await readWorkerUpload(directory, contract)).content, upload.content), "local parts differ from exact upload.");
  return upload;
}

export function verifyWorkerUpload(content, review) {
  supportedWorkerContent(content);
  check([undefined, 1, 2, 3].includes(review.schemaVersion), "supported upload evidence schema required.");
  check(content.modules[0].sha256 === review.bundleSha256 &&
    (review.bundleBytes === undefined || content.modules[0].bytes === review.bundleBytes), "code bytes differ from immutable bundle.");
  if (review.content) {
    check([2, 3].includes(review.schemaVersion) && /^[a-f0-9]{64}$/.test(review.content.sha256 ?? ""), "complete versioned content manifest required.");
    supportedWorkerContent(review.content);
    check(equal(content.modules[0], review.content.modules[0]), "complete executable code bytes differ.");
    if (review.schemaVersion === 3) {
      for (const manifest of [content, review.content]) check(Object.keys(manifest).sort().join() === (manifest.modules.length === 2 ? "entrypoint,modules,sha256,sourceMapData" : "entrypoint,modules,sha256") &&
        manifest.modules.every(part => Object.keys(part).sort().join() === "bytes,name,sha256"), "exact v3 content contract.");
      check(content.modules.length === review.content.modules.length, "complete part set differs.");
      if (content.modules.length === 2) {
        for (const manifest of [content, review.content]) check(manifest.sourceMapData?.algorithm === "complete-json-data-v1" &&
          Object.keys(manifest.sourceMapData).sort().join() === "algorithm,sha256" && /^[a-f0-9]{64}$/.test(manifest.sourceMapData.sha256), "complete source map data seal required.");
        check(equal(content.sourceMapData, review.content.sourceMapData), "complete source map data differs from sealed manifest.");
      }
    } else check(equal(content, review.content), "complete content differs from sealed manifest.");
  } else check(![2, 3].includes(review.schemaVersion) && content.modules.length === 1, "unsealed upload part.");
  return content;
}

export async function preserveWorkerUpload(store, upload, stem) {
  check(["candidate-worker", "candidate-print-executor"].includes(stem), "explicit upload artifact name.");
  return { candidateArtifact: await store.save(`${stem}.js`, upload.code),
    ...(upload.map ? { candidateMapArtifact: await store.save(`${stem}-map.json`, upload.map) } : {}) };
}

export async function readSealedWorkerUpload(store, artifacts, review) {
  const code = await store.read(artifacts.candidateArtifact);
  const map = artifacts.candidateMapArtifact ? await store.read(artifacts.candidateMapArtifact) : undefined;
  const content = verifyWorkerUpload(await workerContentManifest(workerContentResponse({ code, map }), workerContentOptions(review)), review);
  if (review.content) check(equal(content, review.content), "immutable raw artifact differs from sealed manifest.");
  return { code, map, content };
}

export async function historicalWorkerUpload(before, upload) {
  const response = workerContentResponse(upload);
  return { before, body: Buffer.from(await response.arrayBuffer()).toString("base64"),
    contentType: response.headers.get("content-type") ?? "application/javascript", entrypoint: "index.js" };
}

export async function readPreservedWorkerUpload(artifact) {
  const response = new Response(Buffer.from(artifact.body, "base64"), {
    headers: { "content-type": artifact.contentType, "cf-entrypoint": artifact.entrypoint },
  });
  const content = supportedWorkerContent(await workerContentManifest(response.clone(), workerContentOptions(artifact.before?.content)));
  if (!artifact.contentType?.startsWith("multipart/")) return { code: Buffer.from(await response.arrayBuffer()), content };
  const parts = await response.formData(), codePart = parts.get("index.js"), mapPart = parts.get("index.js.map");
  check(codePart && typeof codePart !== "string", "preserved executable entrypoint required.");
  const code = Buffer.from(await codePart.arrayBuffer()), map = mapPart ? Buffer.from(await mapPart.arrayBuffer()) : undefined;
  if (map) verifySourceMap(map, code, workerContentOptions(artifact.before?.content));
  return { code, map, content };
}

// Only bounded manifests enter encrypted diagnostic storage. Map source text and
// provider response bodies remain outside public logs and diagnostic records.
export async function verifyWorkerUploadEvidence(content, review, { store, env, filename }) {
  try { return verifyWorkerUpload(content, review); }
  catch (error) {
    check(store && /^[a-z-]+\.json$/.test(filename), "private diagnostic destination required.");
    const evidence = { schemaVersion: 1, contract: review.schemaVersion, expected: review.content, actual: content };
    const encoded = sealReleaseEvidence(evidence, { sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, filename }, env);
    await store.save(filename, Buffer.from(encoded));
    throw error;
  }
}

export function verifyWorkerContentEquivalent(content, expected) {
  if (!expected.sourceMapData) { check(equal(content, expected), "complete historical Worker bytes differ."); return content; }
  return verifyWorkerUpload(content, { schemaVersion: 3, content: expected, bundleSha256: expected.modules[0].sha256, bundleBytes: expected.modules[0].bytes });
}
