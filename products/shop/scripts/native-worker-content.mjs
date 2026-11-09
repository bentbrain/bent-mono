import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (value, reason) => { if (!value) throw Error(`Worker content verification failed: ${reason}`); };

// This parser describes every provider part. Admission of supported upload
// parts belongs to the sealed contract below, never to this evidence parser.
export async function workerContentManifest(response) {
  check(response.ok, "content download.");
  const modules = [];
  let entrypoint = response.headers.get("cf-entrypoint") ?? "index.js";
  if (response.headers.get("content-type")?.startsWith("multipart/")) {
    entrypoint = response.headers.get("cf-entrypoint");
    check(typeof entrypoint === "string" && entrypoint.length > 0, "module entrypoint header.");
    for (const [name, value] of await response.formData()) {
      check(typeof value !== "string" && !modules.some(item => item.name === name), "unique binary module parts.");
      const bytes = Buffer.from(await value.arrayBuffer());
      modules.push({ name, bytes: bytes.length, sha256: hash(bytes) });
    }
  } else {
    const bytes = Buffer.from(await response.arrayBuffer());
    modules.push({ name: entrypoint, bytes: bytes.length, sha256: hash(bytes) });
  }
  check(modules.length > 0 && modules.some(item => item.name === entrypoint), "entrypoint module present.");
  modules.sort((a, b) => a.name.localeCompare(b.name));
  return { entrypoint, modules, sha256: hash(JSON.stringify({ entrypoint, modules })) };
}

export function verifySourceMap(bytes, code) {
  let map;
  try { map = JSON.parse(bytes); } catch { check(false, "source map JSON."); }
  check(map?.version === 3 && map.file === "index.js" && Array.isArray(map.sources) &&
    map.sources.every(source => typeof source === "string") && Array.isArray(map.names) &&
    map.names.every(name => typeof name === "string") && typeof map.mappings === "string" && !map.sections &&
    (!map.sourcesContent || Array.isArray(map.sourcesContent) && map.sourcesContent.length === map.sources.length &&
      map.sourcesContent.every(source => source === null || typeof source === "string")), "supported v3 source map for index.js.");
  // A sidecar is data. It cannot participate in the module's executable imports.
  check(!/(?:\bimport\s*\(|\brequire\s*\(|\bfrom\s*|\bimport\s*)["'`]([^"'`]*\.map)["'`]/.test(code.toString()), "executable source-map import.");
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

export async function readWorkerUpload(directory) {
  const files = await readdir(directory);
  check(files.includes("index.js") && files.every(name => ["index.js", "index.js.map", "README.md"].includes(name)), "unrecorded upload output module.");
  const code = await readFile(join(directory, "index.js"));
  const map = files.includes("index.js.map") ? await readFile(join(directory, "index.js.map")) : undefined;
  const content = supportedWorkerContent(await workerContentManifest(workerContentResponse({ code, map })));
  return { code, map, content };
}

// --outfile contains Wrangler's actual multipart upload, including its source
// map transformation. The raw esbuild map is not necessarily the uploaded map.
async function captureWorkerUpload(run, entrypoint, output, environment) {
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
  const content = supportedWorkerContent(await workerContentManifest(new Response(parts, { headers: { "cf-entrypoint": metadata.main_module } })));
  const binary = async name => {
    const value = parts.get(name);
    check(value && typeof value !== "string", "binary upload part.");
    return Buffer.from(await value.arrayBuffer());
  };
  const code = await binary("index.js"), map = parts.has("index.js.map") ? await binary("index.js.map") : undefined;
  if (map) verifySourceMap(map, code);
  return { code, map, content };
}

export async function prepareWorkerUpload({ run, directory, environment, sealed }) {
  const entrypoint = join(directory, "index.js");
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
  const upload = await captureWorkerUpload(run, entrypoint, `${directory}-upload.bin`, environment);
  check(equal(upload.code, await readFile(entrypoint)), "Wrangler changed prepared code bytes.");
  if (original) check(equal(upload.content, original.content), "rehydrated upload differs from the reviewed plan.");
  // Retain the exact upload map beside its module. Wrangler's no-bundle map
  // normalization must be idempotent, proved by a second actual dry-run below.
  if (upload.map) await writeFile(join(directory, "index.js.map"), upload.map, { mode: 0o600 });
  const checked = await captureWorkerUpload(run, entrypoint, `${directory}-checked-upload.bin`, environment);
  check(equal(checked.content, upload.content), "upload transformation is not stable.");
  check(equal((await readWorkerUpload(directory)).content, upload.content), "local parts differ from exact upload.");
  return upload;
}

export function verifyWorkerUpload(content, review) {
  supportedWorkerContent(content);
  check([undefined, 1, 2].includes(review.schemaVersion), "supported upload evidence schema required.");
  check(content.modules[0].sha256 === review.bundleSha256 &&
    (review.bundleBytes === undefined || content.modules[0].bytes === review.bundleBytes), "code bytes differ from immutable bundle.");
  if (review.content) {
    check(review.schemaVersion === 2 && /^[a-f0-9]{64}$/.test(review.content.sha256 ?? ""), "complete versioned content manifest required.");
    supportedWorkerContent(review.content);
    check(equal(content, review.content), "complete content differs from sealed manifest.");
  } else check(review.schemaVersion !== 2 && content.modules.length === 1, "unsealed upload part.");
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
  const content = verifyWorkerUpload(await workerContentManifest(workerContentResponse({ code, map })), review);
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
  const content = supportedWorkerContent(await workerContentManifest(response.clone()));
  if (!artifact.contentType?.startsWith("multipart/")) return { code: Buffer.from(await response.arrayBuffer()), content };
  const parts = await response.formData(), codePart = parts.get("index.js"), mapPart = parts.get("index.js.map");
  check(codePart && typeof codePart !== "string", "preserved executable entrypoint required.");
  const code = Buffer.from(await codePart.arrayBuffer()), map = mapPart ? Buffer.from(await mapPart.arrayBuffer()) : undefined;
  if (map) verifySourceMap(map, code);
  return { code, map, content };
}
