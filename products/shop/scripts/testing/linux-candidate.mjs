import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readRegularFile as readFile } from "../read-regular-file.mjs";
import { verifyProductImageV5Capsule } from "./product-image-v5-capsule.mjs";
import { assertNoIgnoredBuildInputs } from "../release-v2/source-inventory.mjs";
import { sourceInventory as captureRootSource } from "../release-v2/source-inventory.mjs";
import { packagePortableBundle } from "../release-v2/portable-bundle.mjs";

const execute = promisify(execFile);
export const checkout = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
const recipePath = fileURLToPath(new URL("./linux-candidate-recipe.json", import.meta.url));
export const recipe = JSON.parse((await readFile(recipePath)).toString("utf8"));
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";

export function assertLinuxRuntime(runtime = { platform: process.platform, arch: process.arch, node: process.version, nodeAbi: process.versions.modules }) {
  for (const key of ["platform", "arch", "node", "nodeAbi"]) assert.equal(runtime[key], recipe[key], `Linux candidate requires ${key}=${recipe[key]}`);
}

const identityFields = ["dev", "ino", "mode", "nlink", "size", "mtimeMs", "ctimeMs"];
const sameFile = (before, after) => identityFields.every(key => before[key] === after[key]);
async function stableFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    assert.ok(before.isFile(), "A regular source file is required");
    const bytes = await handle.readFile(), after = await handle.stat();
    assert.ok(sameFile(before, after) && sameFile(after, await lstat(path)), "File identity changed during inventory");
    assert.equal(bytes.length, after.size);
    return { bytes, info: after };
  } finally { await handle.close(); }
}
async function gitPaths(root) {
  const result = await execute("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
}
export async function sourceInventory(root = checkout) {
  await assertNoIgnoredBuildInputs(root);
  const paths = await gitPaths(root), files = [];
  for (const path of paths) {
    assert.ok(!isAbsolute(path) && !path.split("/").includes(".."), "Source path must remain in checkout");
    const target = join(root, path), entry = await lstat(target);
    let bytes, mode, kind;
    if (entry.isSymbolicLink()) {
      // Inventory the link text itself. It is never traversed as a source input.
      const link = await readlink(target), after = await lstat(target);
      assert.ok(sameFile(entry, after) && link === await readlink(target), "Source symlink changed during inventory");
      bytes = Buffer.from(link); mode = "120000"; kind = "symlink";
    } else {
      const file = await stableFile(target);
      bytes = file.bytes; mode = file.info.mode & 0o111 ? "100755" : "100644"; kind = "file";
    }
    files.push({ path, kind, mode, bytes: bytes.length, sha256: sha256(bytes) });
  }
  assert.deepEqual(await gitPaths(root), paths, "Source path list changed during inventory");
  return { schema: "shop.linux-source-inventory/v1", files, sha256: sha256(json(files)) };
}

export async function fileInventory(directory, prefix = "") {
  const names = (await readdir(join(directory, prefix))).sort(), files = [];
  for (const name of names) {
    const path = join(prefix, name), entry = await lstat(join(directory, path));
    assert.ok(!entry.isSymbolicLink(), "Candidate files must be materialized");
    if (entry.isDirectory()) files.push(...await fileInventory(directory, path));
    else {
      const { bytes, info } = await stableFile(join(directory, path));
      files.push({ path, bytes: bytes.length, sha256: sha256(bytes), executable: Boolean(info.mode & 0o111) });
    }
  }
  assert.deepEqual((await readdir(join(directory, prefix))).sort(), names, "Candidate directory changed during inventory");
  return files;
}

async function copy(source, target, executable = false) {
  const { bytes } = await stableFile(source);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try { await writeFile(target, bytes, { mode: executable ? 0o700 : 0o600, flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert.deepEqual(await readFile(target), bytes, "Conflicting materialized candidate file");
  }
}
async function materializeTree(directory, output, prefix = "") {
  const names = (await readdir(join(directory, prefix))).sort();
  for (const name of names) {
    if (name === "node_modules") continue;
    const path = join(prefix, name), source = join(directory, path), info = await lstat(source);
    assert.ok(!info.isSymbolicLink(), "Installed package files must be materialized");
    if (info.isDirectory()) await materializeTree(directory, output, path);
    else await copy(source, join(output, path), Boolean(info.mode & 0o111));
  }
  assert.deepEqual((await readdir(join(directory, prefix))).sort(), names, "Installed package changed during materialization");
}

async function copyDependency(name, from, output, dependencies, installed = new Map(), optional = false) {
  const resolver = createRequire(from);
  let metadataPath;
  for (const base of resolver.resolve.paths(name) ?? []) {
    try { await readFile(join(base, name, "package.json")); metadataPath = join(base, name, "package.json"); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!metadataPath) { if (optional) return; throw new Error(`Linux dependency unavailable: ${name}`); }
  const directory = await realpath(dirname(metadataPath)), metadataBytes = await readFile(metadataPath), metadata = JSON.parse(metadataBytes.toString("utf8"));
  if (installed.has(name)) { assert.equal(installed.get(name), directory, "Conflicting Linux dependency resolution"); return; }
  installed.set(name, directory);
  dependencies.push({ name, version: metadata.version, packageSha256: sha256(metadataBytes) });
  await materializeTree(directory, join(output, "node_modules", name));
  for (const dep of Object.keys(metadata.dependencies ?? {}).sort()) await copyDependency(dep, metadataPath, output, dependencies, installed);
  for (const dep of Object.keys(metadata.optionalDependencies ?? {}).sort()) await copyDependency(dep, metadataPath, output, dependencies, installed, true);
}

export function sharedLibraries(output) {
  assert.doesNotMatch(output, /not found/, "Linux shared library is unavailable");
  const paths = [...output.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(0x[a-f0-9]+\)/gm)].map(match => match[1]);
  assert.ok(paths.some(path => basename(path) === "ld-linux-x86-64.so.2"), "Linux x64 dynamic loader required");
  return [...new Set(paths)].sort();
}

async function packageExecutables(runtime) {
  const libraries = new Map(), executables = [];
  for (const [name, binary] of [["node", process.execPath], ["ffmpeg", "/usr/bin/ffmpeg"], ["ffprobe", "/usr/bin/ffprobe"]]) {
    await copy(binary, join(runtime, "bin", `${name}.real`), true);
    const ldd = await execute("ldd", [binary], { maxBuffer: 1024 * 1024 });
    for (const path of sharedLibraries(ldd.stdout)) {
      const materialized = await realpath(path), bytes = await readFile(materialized), key = basename(path), hash = sha256(bytes);
      assert.ok(!libraries.has(key) || libraries.get(key) === hash, "Conflicting shared library basenames");
      libraries.set(key, hash);
      await copy(materialized, join(runtime, "lib", key), key === "ld-linux-x86-64.so.2");
    }
    const script = '#!/bin/sh\nset -eu\nruntime="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$runtime/lib/ld-linux-x86-64.so.2" --library-path "$runtime/lib" "$runtime/bin/' + name + '.real" "$@"\n';
    const launcher = name === "node" ? script.replace('exec "$runtime/lib/ld-linux-x86-64.so.2" --library-path "$runtime/lib"', 'export LD_LIBRARY_PATH="$runtime/lib"\nexec') : script;
    await writeFile(join(runtime, "bin", name), launcher, { mode: 0o700, flag: "wx" });
    executables.push({ name, sha256: sha256(await readFile(binary)) });
  }
  return { executables, libraries: [...libraries].map(([name, hash]) => ({ name, sha256: hash })) };
}

export async function verifyLinuxCandidate(directory, { identityDirectory = directory } = {}) {
  assertLinuxRuntime();
  const root = await realpath(directory), receipt = JSON.parse((await readFile(join(identityDirectory, "linux-candidate.json"))).toString("utf8"));
  assert.equal(receipt.schema, "shop.linux-candidate/v1");
  assert.equal(receipt.qualification, recipe.qualification);
  assert.equal(receipt.awsImageQualified, false);
  assert.equal(receipt.recipeSha256, sha256(await readFile(recipePath)));
  assert.deepEqual(receipt.recipe, recipe);
  assertLinuxRuntime(receipt.runtime);
  assert.equal(receipt.runtime.executableSha256, sha256(await readFile(process.execPath)));
  assert.deepEqual(await fileInventory(join(root, "runtime")), receipt.runtimeFiles);
  assert.equal(sha256(json(receipt.runtimeFiles)), receipt.runtimeFilesSha256);
  const manifestBytes = await readFile(join(root, "native-image", "capsule-manifest.json"));
  assert.equal(sha256(manifestBytes), receipt.capsuleManifestSha256);
  const capsule = await verifyProductImageV5Capsule(join(root, "native-image"));
  assert.equal(capsule.runtime.sharp.sharp, recipe.sharp);
  assert.equal(capsule.runtime.sharp.vips, recipe.libvips);
  assert.ok(capsule.dependencies.some(dep => dep.name === recipe.sharpNativePackage && dep.version === recipe.sharp));
  assert.ok(capsule.dependencies.some(dep => dep.name === recipe.libvipsPackage && dep.version === recipe.libvipsPackageVersion));
  assert.equal(receipt.lockSha256, recipe.lockSha256);
  assert.equal(sha256(await readFile(join(checkout, "bun.lock"))), recipe.lockSha256);
  const assets = capsule.files.filter(file => file.path.startsWith("assets/lifestyle-v4/")).map(file => ({ ...file, path: file.path.slice("assets/lifestyle-v4/".length) }));
  assert.equal(sha256(JSON.stringify(assets)), recipe.lifestyleAssetsSha256);
  assert.equal(capsule.files.find(file => file.path.endsWith("/assets/displacement.wasm"))?.sha256, recipe.wasmSha256);
  const inputs = await readFile(join(identityDirectory, "source-inventory.json"));
  assert.equal(sha256(inputs), receipt.sourceInventorySha256);
  assert.deepEqual(JSON.parse(inputs.toString("utf8")), await sourceInventory());
  return receipt;
}

// Inspect retained Linux bytes on the importing host without executing them.
async function inspectLinuxCandidate(directory) {
  const root = await realpath(directory), bytes = await readFile(join(root, "linux-candidate.json")), receipt = JSON.parse(bytes.toString("utf8"));
  assert.equal(receipt.schema, "shop.linux-candidate/v1"); assert.equal(receipt.awsImageQualified, false); assertLinuxRuntime(receipt.runtime);
  assert.deepEqual(receipt.recipe, recipe); assert.equal(receipt.recipeSha256, sha256(await readFile(recipePath)));
  assert.deepEqual(await fileInventory(join(root, "runtime")), receipt.runtimeFiles);
  assert.equal(sha256(json(receipt.runtimeFiles)), receipt.runtimeFilesSha256);
  const capsuleBytes = await readFile(join(root, "native-image/capsule-manifest.json"));
  assert.equal(sha256(capsuleBytes), receipt.capsuleManifestSha256);
  const capsule = JSON.parse(capsuleBytes.toString("utf8"));
  const files = (await fileInventory(join(root, "native-image"))).filter(file => file.path !== "capsule-manifest.json")
    .map(({ path, bytes, sha256 }) => ({ path, size: bytes, sha256 }));
  assert.deepEqual(files, capsule.files); assert.equal(sha256(JSON.stringify(files)), capsule.filesSha256);
  assert.equal(capsule.runtime.sharp.sharp, recipe.sharp); assert.equal(capsule.runtime.sharp.vips, recipe.libvips);
  assert.equal(capsule.awsImageQualified, false); assertLinuxRuntime(capsule.runtime);
  const sourceBytes = await readFile(join(root, "source-inventory.json")); assert.equal(sha256(sourceBytes), receipt.sourceInventorySha256);
  const source = JSON.parse(sourceBytes.toString("utf8"));
  assert.equal(sha256(json(source.files)), source.sha256);
  return { root, receipt, manifestSha256: sha256(bytes), source };
}

export async function packageShopPortableBundle({ candidate, destination, lineage, originSourceCommit,
    storefront = join(checkout, "products/shop/apps/storefront/dist"), business = join(checkout, "products/shop/workers/api/dist/local") }) {
  const native = await inspectLinuxCandidate(candidate), source = await captureRootSource(checkout);
  assert.equal((await execute("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim(), originSourceCommit);
  const sources = [{ originSourceCommit, inventory: source, directory: checkout }];
  if (native.receipt.sourceCommit !== originSourceCommit) sources.push({ originSourceCommit: native.receipt.sourceCommit,
    inventory: { files: native.source.files }, readSource: async path => (await execute("git", ["show", `${native.receipt.sourceCommit}:${path}`],
      { cwd: checkout, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 })).stdout });
  else assert.deepEqual(native.source.files.map(({ path, sha256, mode }) => ({ path, sha256, mode })), source.files);
  const startConfig = JSON.parse((await readFile(join(storefront, "server/wrangler.json"))).toString("utf8"));
  const apiConfigText = (await readFile(join(checkout, "products/shop/workers/api/wrangler.jsonc"))).toString("utf8");
  const apiConfig = JSON.parse(apiConfigText.replace(/^\s*\/\/.*$/gm, ""));
  const workerRuntime = config => ({ kind: "cloudflare-module-worker", compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags, awsImageQualified: false });
  const bundle = await packagePortableBundle({ destination, originSourceCommit, lineage, sources, components: [
    { id: "business", directory: business, entrypoint: "index.js", originSourceCommit,
      runtime: { ...workerRuntime(apiConfig), sourceEntry: "products/shop/workers/api/src/index.ts" } },
    { id: "storefront", directory: storefront, entrypoint: "server/index.js", originSourceCommit,
      runtime: { ...workerRuntime(startConfig), assetsDirectory: "client", noBundle: true } },
    { id: "native", directory: native.root, identityFiles: ["linux-candidate.json", "source-inventory.json"], entrypoint: "native-image/product-image-v5-entry.mjs", originSourceCommit: native.receipt.sourceCommit,
      runtime: { kind: "linux-native-payload", ...native.receipt.runtime, identityDirectory: "metadata/native-candidate",
        capsuleManifestSha256: native.receipt.capsuleManifestSha256, runtimeFilesSha256: native.receipt.runtimeFilesSha256, awsImageQualified: false } },
  ] });
  if (lineage.kind === "github-actions") {
    assert.deepEqual(await captureRootSource(checkout), source, "Source changed during portable bundle retention");
    assert.equal((await execute("git", ["status", "--porcelain"], { cwd: checkout })).stdout.trim(), "", "Hosted artifact requires clean exact source");
  }
  return bundle;
}

export async function packageLinuxCandidate(destination) {
  assertLinuxRuntime();
  const output = resolve(destination);
  assert.ok(output !== checkout && !output.startsWith(`${checkout}/`), "Use a new private candidate directory outside checkout");
  await mkdir(output, { mode: 0o700 });
  assert.ok(!(await realpath(output)).startsWith(`${await realpath(checkout)}/`), "Candidate parent must remain outside checkout");
  const before = await sourceInventory(), runtime = join(output, "runtime");
  await mkdir(runtime, { mode: 0o700 });
  await writeFile(join(runtime, "package.json"), json({ private: true, type: "module" }), { mode: 0o600 });
  await execute(process.execPath, [fileURLToPath(new URL("./product-image-v5-capsule.mjs", import.meta.url)), join(output, "native-image")], { cwd: checkout, maxBuffer: 1024 * 1024 });
  const src = "products/shop/workers/video-renderer";
  for (const file of ["src/renderer.mjs", "src/geometry.mjs", "src/product-mockup-geometry.mjs", "src/version.mjs", "aws-lambda/app-handler.mjs", "aws-lambda/protected-config.mjs", "aws-lambda/config.mjs", "aws-lambda/contract.mjs", "aws-lambda/app-environment.mjs", "aws-lambda/variants.mjs"])
    await copy(join(checkout, src, file), join(runtime, src, file));
  for (const file of ["products/shop/packages/contracts/package.json", "products/shop/packages/contracts/src/product-mockup-geometry.js"])
    await copy(join(checkout, file), join(runtime, file));
  for (const file of ["tee-black-cutout-v1.png", "tee-white-cutout-v1.png", "tote-black-print-bar-1001.webp", "tote-cream-print-bar-1001.webp"])
    await copy(join(checkout, "products/shop/apps/web/public/mockups", file), join(runtime, "assets", file));
  const dependencies = [], installed = new Map();
  for (const name of ["@napi-rs/canvas", "@fontsource-variable/geist-mono"])
    await copyDependency(name, join(checkout, src, "package.json"), runtime, dependencies, installed);
  assert.ok(dependencies.some(dep => dep.name === "@napi-rs/canvas" && dep.version === recipe.canvas));
  assert.ok(dependencies.some(dep => dep.name === "@napi-rs/canvas-linux-x64-gnu" && dep.version === recipe.canvas));
  const binaries = await packageExecutables(runtime);
  const ffmpegPackage = (await execute("dpkg-query", ["-W", "-f=${Version}", "ffmpeg"])).stdout;
  assert.equal(ffmpegPackage, recipe.ffmpeg.packageVersion, "Pinned FFmpeg package required");
  const bun = (await execute("bun", ["--version"])).stdout.trim();
  assert.equal(bun, recipe.bun);
  const capsuleBytes = await readFile(join(output, "native-image/capsule-manifest.json"));
  const capsuleManifest = JSON.parse(capsuleBytes.toString("utf8"));
  const smoke = [];
  for (const name of ["node", "ffmpeg", "ffprobe"]) {
    const result = await execute(join(runtime, "bin", name), [name === "node" ? "--version" : "-version"], { maxBuffer: 1024 * 1024 });
    if (name === "node") assert.equal(result.stdout.trim(), recipe.node);
    else assert.match(result.stdout, /^ff(?:mpeg|probe) version 6\.1\.1/);
    smoke.push({ name, stdoutSha256: sha256(result.stdout), stderrSha256: sha256(result.stderr) });
  }
  const runtimeFiles = await fileInventory(runtime), sourceBytes = Buffer.from(json(before));
  await writeFile(join(output, "source-inventory.json"), sourceBytes, { mode: 0o600 });
  const receipt = { schema: "shop.linux-candidate/v1", qualification: recipe.qualification, awsImageQualified: false, recipe, recipeSha256: sha256(await readFile(recipePath)),
    runtime: { platform: process.platform, arch: process.arch, node: process.version, nodeAbi: process.versions.modules, executableSha256: sha256(await readFile(process.execPath)), glibc: process.report.getReport().header.glibcVersionRuntime },
    toolchain: { bun, ffmpegPackage, ...binaries, smoke }, dependencies: dependencies.sort((a, b) => a.name.localeCompare(b.name)),
    nativeAssets: capsuleManifest.files.filter(file => file.path.startsWith("assets/") || file.path.endsWith(".wasm") || file.path.endsWith("displacement-build.json")),
    sourceInventorySha256: sha256(sourceBytes), lockSha256: sha256(await readFile(join(checkout, "bun.lock"))),
    capsuleManifestSha256: sha256(capsuleBytes), runtimeFiles, runtimeFilesSha256: sha256(json(runtimeFiles)),
    sourceCommit: (await execute("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim(),
    dirtySnapshot: Boolean((await execute("git", ["status", "--porcelain"], { cwd: checkout })).stdout.trim()) };
  await writeFile(join(output, "linux-candidate.json"), json(receipt), { mode: 0o600 });
  assert.deepEqual(before, await sourceInventory(), "Source changed during Linux packaging");
  await verifyLinuxCandidate(output);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--portable") {
    assert.equal(process.argv.length, 5, "Usage: node linux-candidate.mjs --portable <candidate> <new-private-directory>");
    const originSourceCommit = (await execute("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const lineage = process.env.GITHUB_ACTIONS === "true" ? { kind: "github-actions", repository: process.env.GITHUB_REPOSITORY,
      sourceCommit: originSourceCommit, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      workflowRef: process.env.GITHUB_WORKFLOW_REF, jobId: process.env.GITHUB_JOB } : { kind: "local-source-build", sourceCommit: originSourceCommit,
      dirtySnapshot: Boolean((await execute("git", ["status", "--porcelain"], { cwd: checkout })).stdout.trim()) };
    const bundle = await packageShopPortableBundle({ candidate: process.argv[3], destination: process.argv[4], lineage, originSourceCommit });
    console.info(JSON.stringify({ manifestSha256: bundle.manifestSha256, originSourceCommit, lineage, awsImageQualified: false }));
  } else {
    assert.equal(process.argv.length, 3, "Usage: node linux-candidate.mjs <new-private-directory>");
    const receipt = await packageLinuxCandidate(process.argv[2]);
    console.info(JSON.stringify({ schema: receipt.schema, sourceCommit: receipt.sourceCommit, runtimeFilesSha256: receipt.runtimeFilesSha256, awsImageQualified: false }));
  }
}
