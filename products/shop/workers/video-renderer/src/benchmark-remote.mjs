import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "../../..");
const endpoint = requiredEnvironment(
  "REMOTE_BENCHMARK_URL",
  "VERCEL_BENCHMARK_URL",
).replace(/\/$/, "");
const token = requiredEnvironment(
  "REMOTE_BENCHMARK_TOKEN",
  "VERCEL_BENCHMARK_TOKEN",
);
const artworkPath = process.env.STORY_ARTWORK ?? "/tmp/forever-tee-saved-design.png";
const warmIterations = positiveInteger(process.env.STORY_WARM_ITERATIONS ?? "5");
const preset = process.env.STORY_FFMPEG_PRESET ?? "medium";
const benchmarkScenario = process.env.STORY_BENCHMARK_SCENARIO ?? "matrix";
const singleProductOnly = benchmarkScenario === "single";
const sequentialOnly = benchmarkScenario === "sequential";
const benchmarkR2 = process.env.STORY_BENCHMARK_R2 === "1";
const reportPath = process.env.STORY_BENCHMARK_REPORT;
const encoding = {
  crf: Number.parseInt(process.env.STORY_CRF ?? "21", 10),
  frameRate: Number.parseInt(process.env.STORY_FRAME_RATE ?? "30", 10),
  frameWidth: Number.parseInt(process.env.STORY_FRAME_WIDTH ?? "1080", 10),
};
const runId = `${Date.now().toString(36)}-${crypto.randomUUID()}`;

const settings = {
  cropX: 0.47,
  cropY: 0.62,
  cropZoom: 1.06,
  depth: 5,
  placementWidth: 0.42,
  placementX: 0.3,
  placementY: 0.3,
};

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

function requiredEnvironment(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`${names.join(" or ")} is required.`);
}

function positiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("STORY_WARM_ITERATIONS must be a positive integer.");
  }
  return parsed;
}

async function dataUrl(filePath) {
  const contentType = filePath.endsWith(".webp") ? "image/webp" : "image/png";
  const value = await readFile(filePath);
  return `data:${contentType};base64,${value.toString("base64")}`;
}

function numericHeader(headers, name) {
  const value = headers.get(name);
  return value === null ? undefined : Number.parseInt(value, 10);
}

async function render(product, artwork, label) {
  const mockup = await dataUrl(product.mockupPath);
  const storyKey = `benchmarks/${runId}/${label}/${product.id}.mp4`;
  const startedAt = performance.now();
  const response = await fetch(`${endpoint}/render`, {
    body: JSON.stringify({
      artwork,
      baseProductSlug: product.baseProductSlug,
      encoding,
      mockup,
      preset,
      settings,
      websiteLabel: "shop.bent.build",
    }),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-story-video-key": storyKey,
    },
    method: "POST",
  });
  const headersAt = performance.now();
  const video = Buffer.from(await response.arrayBuffer());
  const completedAt = performance.now();
  if (!response.ok) {
    throw new Error(`Render failed with ${String(response.status)}: ${video.toString("utf8")}`);
  }
  const output = `/tmp/forever-tee-vercel-${label}-${product.id}.mp4`;
  await writeFile(output, video);
  return {
    assetLoadTimeMs: numericHeader(response.headers, "x-asset-load-time-ms"),
    bytes: video.byteLength,
    canvasTimeMs: numericHeader(response.headers, "x-canvas-time-ms"),
    encoderDrainTimeMs: numericHeader(response.headers, "x-encoder-drain-time-ms"),
    instanceAgeMs: numericHeader(response.headers, "x-instance-age-ms"),
    instanceId: response.headers.get("x-instance-id"),
    label,
    output,
    product: product.id,
    pipeTimeMs: numericHeader(response.headers, "x-pipe-time-ms"),
    renderTimeMs: numericHeader(response.headers, "x-render-time-ms"),
    renderFrameWidth: numericHeader(response.headers, "x-render-frame-width"),
    requestSequence: numericHeader(response.headers, "x-instance-request-sequence"),
    storyCache: response.headers.get("x-story-video-cache"),
    storyKey,
    timeToHeadersMs: Math.round(headersAt - startedAt),
    totalTimeMs: Math.round(completedAt - startedAt),
    transferTimeMs: Math.round(completedAt - headersAt),
  };
}

async function cachedRender(storyKey) {
  const startedAt = performance.now();
  const response = await fetch(`${endpoint}/render`, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-story-video-key": storyKey,
    },
    method: "POST",
  });
  const headersAt = performance.now();
  const video = Buffer.from(await response.arrayBuffer());
  const completedAt = performance.now();
  if (!response.ok) {
    throw new Error(`Cached render failed with ${String(response.status)}: ${video.toString("utf8")}`);
  }
  return {
    bytes: video.byteLength,
    storyCache: response.headers.get("x-story-video-cache"),
    timeToHeadersMs: Math.round(headersAt - startedAt),
    totalTimeMs: Math.round(completedAt - startedAt),
    transferTimeMs: Math.round(completedAt - headersAt),
  };
}

const artwork = await dataUrl(artworkPath);
const healthStartedAt = performance.now();
const healthResponse = await fetch(`${endpoint}/health`);
const health = await healthResponse.json();
const healthTimeMs = Math.round(performance.now() - healthStartedAt);

const firstProduct = products[1];
const warm = [];
for (let iteration = 0; iteration < warmIterations; iteration += 1) {
  warm.push(await render(firstProduct, artwork, `warm-${String(iteration + 1)}`));
}
const cache = benchmarkR2 ? await cachedRender(warm[0].storyKey) : undefined;

const sequential = [];
if (!singleProductOnly) {
  for (const product of products) {
    sequential.push(await render(product, artwork, "sequential"));
  }
}

const concurrent = singleProductOnly || sequentialOnly
  ? []
  : await Promise.all(
      products.map((product) => render(product, artwork, "concurrent")),
    );

const report = {
  concurrent,
  cache,
  endpoint,
  encoding,
  health,
  healthTimeMs,
  preset,
  sequential,
  warm,
};

if (reportPath) {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

console.info(JSON.stringify(report, null, 2));
