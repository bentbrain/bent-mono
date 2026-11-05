import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "../../..");
const endpoint = requiredEnvironment("REMOTE_BENCHMARK_URL").replace(/\/$/, "");
const token = requiredEnvironment("REMOTE_BENCHMARK_TOKEN");
const artworkPath = process.env.STORY_ARTWORK ?? "/tmp/forever-tee-saved-design.png";
const preset = process.env.STORY_FFMPEG_PRESET ?? "veryfast";
const runId = `${Date.now().toString(36)}-${crypto.randomUUID()}`;

const products = [
  {
    baseProductSlug: "staple-tee",
    id: "tee-black",
    mockupPath: resolve(root, "apps/web/public/mockups/tee-black-cutout-v1.png"),
  },
  {
    baseProductSlug: "staple-tee",
    id: "tee-white",
    mockupPath: resolve(root, "apps/web/public/mockups/tee-white-cutout-v1.png"),
  },
  {
    baseProductSlug: "cotton-tote",
    id: "tote-black",
    mockupPath: resolve(root, "apps/web/public/mockups/tote-black-print-bar-1001.webp"),
  },
  {
    baseProductSlug: "cotton-tote",
    id: "tote-cream",
    mockupPath: resolve(root, "apps/web/public/mockups/tote-cream-print-bar-1001.webp"),
  },
];

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function dataUrl(filePath) {
  const contentType = filePath.endsWith(".webp") ? "image/webp" : "image/png";
  const value = await readFile(filePath);
  return `data:${contentType};base64,${value.toString("base64")}`;
}

const shared = {
  artwork: await dataUrl(artworkPath),
  encoding: {
    crf: Number.parseInt(process.env.STORY_CRF ?? "21", 10),
    frameRate: Number.parseInt(process.env.STORY_FRAME_RATE ?? "30", 10),
    frameWidth: Number.parseInt(process.env.STORY_FRAME_WIDTH ?? "720", 10),
  },
  preset,
  settings: {
    cropX: 0.47,
    cropY: 0.62,
    cropZoom: 1.06,
    depth: 5,
    placementWidth: 0.42,
    placementX: 0.3,
    placementY: 0.3,
  },
  websiteLabel: "shop.bent.build",
};
const jobs = await Promise.all(products.map(async (product) => ({
  baseProductSlug: product.baseProductSlug,
  mockup: await dataUrl(product.mockupPath),
  storyKey: `benchmarks/${runId}/batch/${product.id}.mp4`,
})));

const startedAt = performance.now();
const response = await fetch(`${endpoint}/render-batch`, {
  body: JSON.stringify({ batchId: runId, jobs, shared, shutdownAfterBatch: true }),
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  method: "POST",
});
const body = await response.json();
const totalTimeMs = Math.round(performance.now() - startedAt);
if (!response.ok) {
  throw new Error(`Batch render failed with ${String(response.status)}: ${JSON.stringify(body)}`);
}

const stopWaitStartedAt = performance.now();
let stoppedState;
while (performance.now() - stopWaitStartedAt < 30_000) {
  const stateResponse = await fetch(`${endpoint}/batch-state`, {
    body: JSON.stringify({ batchId: runId }),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  const stateBody = await stateResponse.json();
  if (!stateResponse.ok) {
    throw new Error(`State read failed with ${String(stateResponse.status)}.`);
  }
  stoppedState = stateBody.state;
  if (["stopped", "stopped_with_code"].includes(stoppedState.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!["stopped", "stopped_with_code"].includes(stoppedState?.status)) {
  throw new Error(
    `The batch container did not stop within 30 seconds: ${JSON.stringify(stoppedState)}`,
  );
}
const stoppedAfterMs = Math.round(performance.now() - stopWaitStartedAt);

const cached = [];
for (let index = 0; index < jobs.length; index += 1) {
  const product = products[index];
  const job = jobs[index];
  const cacheStartedAt = performance.now();
  const cacheResponse = await fetch(`${endpoint}/render`, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-story-video-key": job.storyKey,
    },
    method: "POST",
  });
  const video = Buffer.from(await cacheResponse.arrayBuffer());
  if (!cacheResponse.ok) {
    throw new Error(`Cache read failed with ${String(cacheResponse.status)}.`);
  }
  const output = `/tmp/forever-tee-batch-${product.id}.mp4`;
  await writeFile(output, video);
  cached.push({
    bytes: video.byteLength,
    output,
    product: product.id,
    storyCache: cacheResponse.headers.get("x-story-video-cache"),
    totalTimeMs: Math.round(performance.now() - cacheStartedAt),
  });
}

const report = {
  batch: body,
  cached,
  endpoint,
  preset,
  stoppedAfterMs,
  stoppedState,
  totalTimeMs,
};
if (process.env.STORY_BENCHMARK_REPORT) {
  await writeFile(
    process.env.STORY_BENCHMARK_REPORT,
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
console.info(JSON.stringify(report, null, 2));
