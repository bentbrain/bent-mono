import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkout, fileInventory, sha256, sourceInventory, verifyLinuxCandidate } from "./linux-candidate.mjs";
import { createProductImageV5Fixture, fixtureBinding, fixtureContext, fixtureEvent } from "./product-image-v5-fixtures.mjs";

const json = value => JSON.stringify(value, null, 2) + "\n";
const operations = ["built-start-create", "foreign-owner-draft-and-source-denied", "direct-editor-gesture", "editor-reload",
  "sse-first-bytes", "unready-print-checkout-denied", "prepared-source-verified", "stored-image-verified", "stored-print-verified",
  "sse-complete-and-reconnect", "stored-video-verified", "inert-checkout-handoff", "manual-pause-checkout-denied",
  "wrong-image-callback-denied", "actual-business-scheduled", "product-controls", "journey"];

export function verifyJourneyEvents(value) {
  assert.ok(Array.isArray(value.events) && Array.isArray(value.blocked));
  assert.equal(value.blocked.filter(item => !item.boundary).length, 0, "Unexpected journey outbound request");
  for (const operation of operations) assert.ok(value.events.some(event => event.operation === operation), `Missing actual J01 operation: ${operation}`);
  const source = value.events.find(event => event.operation === "synthetic-source");
  assert.equal(source.width * source.height, 50_000_000);
  assert.equal(source.format, "jpeg");
  assert.equal(source.exifOrientation, 6);
  assert.equal(value.events.filter(event => event.operation === "stored-video-verified").length, 4);
  assert.ok(value.events.filter(event => event.operation === "stored-print-verified").length > 0);
  assert.ok(value.events.filter(event => event.operation === "native-v5").length > 0);
  assert.ok(value.events.filter(event => event.operation === "native-video").length > 0);
  const checkout = value.events.find(event => event.operation === "inert-checkout-handoff");
  assert.equal(checkout.location, "https://checkout.example.invalid/cart/c/J01");
  const controls = value.events.find(event => event.operation === "product-controls");
  assert.equal(controls.cameraCalls, 0);
  return operations;
}

export async function nativeLimits(candidate) {
  const receipt = await verifyLinuxCandidate(candidate), capsule = join(candidate, "native-image");
  const sharp = createRequire(join(capsule, "package.json"))("sharp");
  const { renderProductDisplay } = await import(pathToFileURL(join(capsule, "node_modules/@forever-tee/product-image-renderer/src/index.mjs")).href);
  const { fixtureRecipe } = await import("./product-image-v5-fixtures.mjs");
  const accepted = [];
  for (const format of ["jpeg", "png"]) {
    const source = await sharp({ create: { width: 10000, height: 5000, channels: 4, background: "#126acc" } }).toFormat(format).toBuffer();
    const fixture = await createProductImageV5Fixture({ source });
    try {
      process.env.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON = JSON.stringify(fixtureBinding(fixture.origin, receipt.capsuleManifestSha256));
      const { handler } = await import(`${pathToFileURL(join(capsule, "product-image-v5-entry.mjs")).href}?boundary=${format}`);
      const result = await handler(fixtureEvent(), fixtureContext());
      assert.equal(fixture.publications.length, 1);
      const output = fixture.publications[0].bytes, metadata = await sharp(output).metadata();
      assert.equal(metadata.width, 768); assert.equal(metadata.height, 768);
      assert.equal(result.sha256, sha256(output));
      accepted.push({ format, sourceWidth: 10000, sourceHeight: 5000, sourceSha256: sha256(source), sourceBytes: source.length,
        outputSha256: sha256(output), outputWidth: metadata.width, outputHeight: metadata.height, path: "packaged-entry-loopback-claim-and-publication" });
    } finally { await fixture.close(); delete process.env.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON; }
  }
  const oversized = await sharp({ create: { width: 10000, height: 5001, channels: 3, background: "#126acc" } }).jpeg().toBuffer();
  await assert.rejects(renderProductDisplay(oversized, fixtureRecipe(), join(capsule, "assets/lifestyle-v4")), /pixel limit/);
  const fixture = await createProductImageV5Fixture({ source: oversized });
  try {
    process.env.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON = JSON.stringify(fixtureBinding(fixture.origin, receipt.capsuleManifestSha256));
    const { handler } = await import(`${pathToFileURL(join(capsule, "product-image-v5-entry.mjs")).href}?boundary=oversized`);
    await assert.rejects(handler(fixtureEvent(), fixtureContext()), /execution unavailable/);
    assert.equal(fixture.publications.length, 0);
    assert.equal(fixture.failures.length, 1);
  } finally { await fixture.close(); delete process.env.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON; }
  return { accepted, rejected: { sourceWidth: 10000, sourceHeight: 5001, sourceSha256: sha256(oversized), publications: 0, ownedFailureCallbacks: 1 } };
}

async function runActual(candidate, directory) {
  const stdout = await open(join(directory, "stdout.private.log"), "wx", 0o600);
  const stderr = await open(join(directory, "stderr.private.log"), "wx", 0o600);
  try {
    return await new Promise((accept, reject) => {
      const env = { PATH: `${join(candidate, "runtime/bin")}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? "/tmp",
        CI: "true", PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/ms-playwright" };
      const child = spawn(join(candidate, "runtime/bin/node"), [join(checkout, "products/shop/apps/storefront/scripts/local-proof.mjs"),
        directory, join(candidate, "native-image"), "jpeg", candidate], { cwd: checkout, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      let overflow = false;
      const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") reject(error); } };
      const timer = setTimeout(stop, 240000);
      for (const [name, limit] of [["stdout", 8 * 1024 * 1024], ["stderr", 1024 * 1024]]) child[name].on("data", bytes => {
        if (buffers[name].length + bytes.length > limit) { overflow = true; stop(); }
        else buffers[name] = Buffer.concat([buffers[name], bytes]);
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", async (code, signal) => {
        clearTimeout(timer);
        try { await stdout.write(buffers.stdout); await stderr.write(buffers.stderr); accept({ code, signal, overflow }); }
        catch (error) { reject(error); }
      });
    });
  } finally { await stdout.close(); await stderr.close(); }
}

export async function linuxJourney(candidatePath, outputPath) {
  process.umask(0o077);
  const candidate = resolve(candidatePath), output = resolve(outputPath);
  assert.ok(output !== checkout && !output.startsWith(`${checkout}/`), "Use a new private journey directory outside checkout");
  await mkdir(output, { mode: 0o700 });
  const startedAt = new Date().toISOString(), before = await sourceInventory(), receipt = await verifyLinuxCandidate(candidate);
  const candidateSha256 = sha256(await readFile(join(candidate, "linux-candidate.json")));
  const summary = { schema: "shop.linux-j01/v1", qualification: "linux-candidate-execution", awsImageQualified: false, productionQualified: false,
    providerScope: "inactive-local-fixtures", actualBusinessRuntime: "workerd-d1-r2-durable-objects", candidateSha256,
    sourceCommit: receipt.sourceCommit, dirtySnapshot: receipt.dirtySnapshot, startedAt, complete: false };
  try {
    const storefront = join(checkout, "products/shop/apps/storefront/dist");
    summary.storefrontFiles = await fileInventory(storefront);
    summary.storefrontFilesSha256 = sha256(json(summary.storefrontFiles));
    summary.nativeLimits = await nativeLimits(candidate);
    const execution = await runActual(candidate, output);
    summary.execution = execution;
    assert.deepEqual(execution, { code: 0, signal: null, overflow: false }, "Actual built Linux J01 failed; inspect encrypted diagnostics");
    const events = JSON.parse(await readFile(join(output, "events.json"), "utf8"));
    summary.operations = verifyJourneyEvents(events);
    const services = JSON.parse(await readFile(join(output, "service-identity.json"), "utf8"));
    assert.equal(services.nativeBuildId, receipt.capsuleManifestSha256);
    assert.equal(services.nativeVideoRuntimeSha256, receipt.runtimeFilesSha256);
    assert.equal(services.linuxCandidateManifestSha256, candidateSha256);
    assert.equal(services.lockSha256, receipt.lockSha256);
    assert.equal(services.nodeVersion, receipt.runtime.node);
    assert.deepEqual(before, await sourceInventory(), "Source changed during Linux J01");
    assert.deepEqual(summary.storefrontFiles, await fileInventory(storefront), "Built Start files changed during Linux J01");
    await verifyLinuxCandidate(candidate);
    summary.businessWorkerSha256 = sha256(await readFile(join(output, "business-worker.mjs")));
    summary.eventsSha256 = sha256(await readFile(join(output, "events.json")));
    summary.sourceInventorySha256 = receipt.sourceInventorySha256;
    summary.runtimeFilesSha256 = receipt.runtimeFilesSha256;
    summary.complete = true;
  } catch (error) {
    summary.failure = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    summary.finishedAt = new Date().toISOString();
    await writeFile(join(output, "linux-j01.private.json"), json(summary), { mode: 0o600, flag: "wx" });
  }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, "Usage: node linux-journey.mjs <verified-candidate> <new-private-output>");
  const summary = await linuxJourney(process.argv[2], process.argv[3]);
  console.info(JSON.stringify({ schema: summary.schema, sourceCommit: summary.sourceCommit, candidateSha256: summary.candidateSha256, complete: summary.complete, awsImageQualified: false }));
}
