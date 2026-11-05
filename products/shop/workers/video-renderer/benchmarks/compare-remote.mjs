import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const endpoint = process.env.REMOTE_BENCHMARK_URL;
const token = process.env.REMOTE_BENCHMARK_TOKEN;
const artworkPath = process.env.STORY_ARTWORK;
const outputDirectory = process.env.STORY_BENCHMARK_OUTPUT;
assert.ok(endpoint && token && artworkPath && outputDirectory,
  "REMOTE_BENCHMARK_URL, REMOTE_BENCHMARK_TOKEN, STORY_ARTWORK and STORY_BENCHMARK_OUTPUT are required.");
assert.match(endpoint, /^https:\/\/forever-tee-story-video-benchmark[\w-]*\.socialqueue\.workers\.dev$/,
  "Only the isolated benchmark Worker is allowed.");
const label = process.env.STORY_BENCHMARK_LABEL ?? "baseline";
assert.match(label, /^[a-z0-9-]+$/);
const rounds = Number(process.env.STORY_BENCHMARK_ROUNDS ?? "3");
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
const root = resolve(import.meta.dirname, "../../..");
const artwork = await readFile(artworkPath);
const settings = {
  cropX: 0.48020833333333335,
  cropY: 0.61328125,
  cropZoom: 1.1683569979716024,
  depth: 5,
};
const products = [
  { id: "tee-black", baseProductSlug: "staple-tee", image: "tee-black-cutout-v1.png" },
  { id: "tee-white", baseProductSlug: "staple-tee", image: "tee-white-cutout-v1.png" },
  { id: "tote-black", baseProductSlug: "cotton-tote", image: "tote-black-print-bar-1001.webp" },
  { id: "tote-cream", baseProductSlug: "cotton-tote", image: "tote-cream-print-bar-1001.webp" },
];
async function request(path, body, headers = {}) {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    signal: AbortSignal.timeout(180_000),
  });
  if (response.status !== 200) {
    throw new Error(`${path}: ${response.status}: ${(await response.text()).slice(0, 2000)}`);
  }
  return response;
}
await mkdir(outputDirectory, { recursive: true });
const report = { label, endpoint, artworkSha256: createHash("sha256").update(artwork).digest("hex"), rounds: [] };
let previousInstance;
for (let round = 0; round < rounds; round += 1) {
  const batchId = `${label}-${randomUUID()}`;
  // Rotate the first product so cold-process work does not always fall on the black tee.
  const ordered = [...products.slice(round % 4), ...products.slice(0, round % 4)];
  const jobs = await Promise.all(ordered.map(async (product) => {
    const bytes = await readFile(resolve(root, "apps/web/public/mockups", product.image));
    return {
      baseProductSlug: product.baseProductSlug,
      mockup: `data:image/${product.image.endsWith("webp") ? "webp" : "png"};base64,${bytes.toString("base64")}`,
      settings: {
        ...settings,
        ...(product.baseProductSlug === "staple-tee"
          ? { placementX: 0.27167119387154753, placementY: 0.22145055477692505, placementWidth: 0.48 }
          : { placementX: 0.290678, placementY: 0.244638, placementWidth: 0.440042 }),
      },
      storyKey: `benchmarks/${batchId}/${product.id}.mp4`,
    };
  }));
  const startedAt = performance.now();
  const response = await request("/render-batch", {
    batchId, jobs, shutdownAfterBatch: true,
    shared: {
      artwork: `data:image/png;base64,${artwork.toString("base64")}`,
      encoding: { frameWidth: 720, frameRate: 30, crf: 21, scaleBeforeHold: process.env.STORY_SCALE_BEFORE_HOLD === "1" },
      preset: "veryfast", settings, websiteLabel: "shop.bent.build",
    },
  });
  const batch = await response.json();
  const totalTimeMs = Math.round(performance.now() - startedAt);
  assert.equal(batch.results.length, 4);
  const instanceId = batch.results[0].instanceId;
  assert.notEqual(instanceId, previousInstance, "Every round must start a fresh renderer process.");
  previousInstance = instanceId;
  for (const [index, result] of batch.results.entries()) {
    assert.equal(result.cache, "miss");
    assert.equal(result.instanceId, instanceId);
    assert.equal(result.instanceRequestSequence, index + 1);
    assert.ok(result.renderTimeMs > 0);
  }
  const state = await (await request("/batch-state", { batchId })).json();
  assert.ok(["stopped", "stopped_with_code"].includes(state.state.status), "Renderer must stop after the batch.");
  const outputs = [];
  for (const [index, job] of jobs.entries()) {
    const cached = await request("/render", undefined, { "x-story-video-key": job.storyKey });
    assert.equal(cached.headers.get("x-story-video-cache"), "hit");
    const video = Buffer.from(await cached.arrayBuffer());
    assert.equal(video.byteLength, batch.results[index].size);
    const output = resolve(outputDirectory, `${label}-${round + 1}-${ordered[index].id}.mp4`);
    await writeFile(output, video);
    outputs.push({ product: ordered[index].id, output, sha256: createHash("sha256").update(video).digest("hex") });
  }
  report.rounds.push({ batch, totalTimeMs, state: state.state.status, outputs });
  await writeFile(resolve(outputDirectory, `${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.info(JSON.stringify({ label, round: round + 1, totalTimeMs, workerTimeMs: batch.workerTimeMs, renderTimes: batch.results.map(result => result.renderTimeMs), stopped: true }));
}
