import { Container, getContainer } from "@cloudflare/containers";
export { ContainerProxy } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";

import { isAuthorized } from "./server-auth.mjs";
import { runBatch, streamingBatch } from "./batch.mjs";
import { STORY_RENDERER_VERSION, requireRendererVersion } from "./version.mjs";
import { numericTimings, requestTimings, responseTimings } from "./timings.mjs";
import { STORY_MOCKUPS, videoSize } from "./storage-contract.mjs";
import { registerStorageHandler } from "./storage-proxy.mjs";
import { laneNumbers, renderConcurrency } from "./capacity.mjs";

const VIDEO_CONTENT_TYPE = "video/mp4";
const MAX_BATCH_SIZE = 4;

export class StoryVideoContainer extends Container {
  defaultPort = 8080;
  enableInternet = false;
  sleepAfter = "30s";

  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/health" && path !== "/render-stored") return super.fetch(request);
    const completion = (async () => {
      const response = await super.fetch(request);
      // These endpoints return small JSON acknowledgements, never video bytes.
      // Drain the SDK proxy inside the DO: an abandoned upstream response must
      // not leave its inflight counter elevated and renew idle forever.
      return new Response(await response.arrayBuffer(), response);
    })();
    this.ctx.waitUntil(completion.then(() => undefined, () => undefined));
    return completion;
  }

  async diagnosticState() {
    // SDK status is persisted and can lag the actual container lifecycle.
    // Reading the runtime flag does not start the container.
    return {
      ...await this.getState(), running: this.ctx.container.running,
      alarmAt: await this.ctx.storage.getAlarm(),
      // Diagnostics for the pinned SDK only, never shutdown decision inputs.
      sdkInflightRequests: this.inflightRequests,
      sdkIdleDeadline: this.sleepAfterMs,
    };
  }

  async onActivityExpired() {
    // The SDK invokes this only after proxied requests finish and the idle
    // window expires. Its default only sends SIGTERM, with no kill fallback.
    await this.destroy();
  }
}
registerStorageHandler(StoryVideoContainer);

function storyKey(request) {
  const value = request.headers.get("x-story-video-key");
  if (!value || !/^[a-z0-9][a-z0-9/_-]{1,220}\.mp4$/.test(value)) {
    return undefined;
  }
  return value;
}

function videoResponse(object, cacheStatus) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=0, must-revalidate");
  headers.set("content-length", String(object.size));
  headers.set("content-type", VIDEO_CONTENT_TYPE);
  headers.set("etag", object.httpEtag);
  headers.set("x-story-video-cache", cacheStatus);
  return new Response(object.body, { headers });
}

async function storeVideo(env, key, video, renderTime) {
  await env.STORY_VIDEOS.put(key, video, {
    httpMetadata: { contentType: VIDEO_CONTENT_TYPE },
    customMetadata: renderTime ? { renderTimeMs: renderTime } : undefined,
  });
  return { renderTime, size: video.byteLength };
}

async function storeRenderedVideo(env, key, rendered) {
  requireRendererVersion(rendered.headers);
  return storeVideo(
    env,
    key,
    await rendered.arrayBuffer(),
    rendered.headers.get("x-render-time-ms"),
  );
}

async function mockupInput(env, job) {
  if (typeof job.mockup === "string" && job.mockup.length > 0) {
    return job.mockup;
  }
  const path = STORY_MOCKUPS[`${String(job.baseProductSlug)}:${String(job.color)}`];
  if (!path || !env.STORY_VIDEO_ASSETS) {
    throw new Error("The product mockup is unavailable.");
  }
  const response = await env.STORY_VIDEO_ASSETS.fetch(
    new Request(`https://story-video-assets.internal${path}`),
  );
  if (!response.ok) throw new Error("The product mockup could not be loaded.");
  const contentType = response.headers.get("content-type") ??
    (path.endsWith(".webp") ? "image/webp" : "image/png");
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const chunkSize = 8_192;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

function batchId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{7,79}$/.test(value)
    ? value
    : undefined;
}

function batchContainer(env, lane = 0) {
  return getContainer(
    env.STORY_VIDEO_RENDERER,
    lane === 0 ? STORY_RENDERER_VERSION : `${STORY_RENDERER_VERSION}-lane-${String(lane)}`,
  );
}

async function batchState(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "A JSON body is required." }, { status: 400 });
  }
  const id = batchId(body?.batchId);
  if (!id) {
    return Response.json({ error: "A valid batchId is required." }, { status: 400 });
  }
  const states = await Promise.all(laneNumbers(env).map((lane) => batchContainer(env, lane).diagnosticState()));
  return Response.json({ state: states[0], states });
}

async function warmContainers(env) {
  try {
    await Promise.all(laneNumbers(env).map(async (lane) => {
      const response = await batchContainer(env, lane).fetch(
        new Request("https://story-video.internal/health"),
      );
      await response.arrayBuffer();
      if (!response.ok) throw new Error("Container warmup failed.");
    }));
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}

async function renderBatch(request, env) {
  const requestStartedAt = Date.now();
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "A JSON body is required." }, { status: 400 });
  }
  const id = batchId(body?.batchId);
  if (!body || typeof body !== "object" || Array.isArray(body) || !id ||
      !body.shared || typeof body.shared !== "object" ||
      !Array.isArray(body.jobs) || body.jobs.length < 1 ||
      body.jobs.length > MAX_BATCH_SIZE) {
    return Response.json(
      { error: `A batchId, shared input, and one to ${String(MAX_BATCH_SIZE)} jobs are required.` },
      { status: 400 },
    );
  }

  // Four lanes are a deployment-gated experiment, not client-selected capacity.
  const concurrency = renderConcurrency(body.concurrency, env);
  const batchTimings = { ...requestTimings(request), workerBodyReadMs: Date.now() - requestStartedAt };
  const jobs = [];
  const keys = new Set();
  for (const job of body.jobs) {
    if (!job || typeof job !== "object") {
      return Response.json({ error: "Every batch job must be an object." }, { status: 400 });
    }
    const key = storyKey(new Request(request.url, {
      headers: { "x-story-video-key": String(job.storyKey ?? "") },
    }));
    if (!key || keys.has(key)) {
      return Response.json({ error: "Every batch job requires a unique valid storyKey." }, { status: 400 });
    }
    keys.add(key);
    jobs.push({ job, key });
  }
  const renderUrl = new URL(request.url);
  renderUrl.pathname = "/render";
  const run = async (ready) => {
    const startedAt = Date.now();
    let shutdownTimeMs;
    const result = await runBatch({
      jobs,
      concurrency,
      cached: async ({ key }) => {
        const existing = await env.STORY_VIDEOS.head(key);
        return existing ? { cache: "hit", key, size: existing.size } : undefined;
      },
      ready: (item) => ready({ ...item, readyAfterMs: Date.now() - startedAt }),
      render: async ({ job, key }, lane) => {
        const jobStartedAt = Date.now();
        if (body.shared.artworkRef) {
          const payload = JSON.stringify({
            ...body.shared, baseProductSlug: job.baseProductSlug, color: job.color,
            storyKey: key, settings: job.settings ?? body.shared.settings,
          });
          const url = new URL(renderUrl);
          url.pathname = "/render-stored";
          const rendered = await batchContainer(env, lane).fetch(new Request(url, {
            body: payload, method: "POST", headers: { "content-type": "application/json" },
          }));
          if (!rendered.ok) throw new Error(`Direct renderer failed: ${rendered.status} ${(await rendered.text()).slice(0, 500)}`);
          requireRendererVersion(rendered.headers);
          const stored = await rendered.json();
          const size = videoSize(stored.size);
          if (typeof stored.etag !== "string" || !stored.etag) throw new Error("Missing stored video acknowledgement.");
          return {
            cache: "miss", lane, key, size, renderTimeMs: stored.renderTimeMs,
            instanceId: rendered.headers.get("x-instance-id"),
            instanceRequestSequence: Number(rendered.headers.get("x-instance-request-sequence")),
            timings: {
              ...batchTimings, ...numericTimings(stored.timings), directStorage: 1,
              workerBeforeJobMs: jobStartedAt - requestStartedAt,
              containerHeadersMs: Date.now() - jobStartedAt,
              requestBytes: new TextEncoder().encode(payload).byteLength, videoBytes: size,
            },
          };
        }
        const mockupStartedAt = Date.now();
        const mockup = await mockupInput(env, job);
        const mockupReadMs = Date.now() - mockupStartedAt;
        const stringifyStartedAt = Date.now();
        const payload = JSON.stringify({
          ...body.shared,
          baseProductSlug: job.baseProductSlug,
          mockup,
          settings: job.settings ?? body.shared.settings,
        });
        const stringifyMs = Date.now() - stringifyStartedAt;
        const rpcStartedAt = Date.now();
        const rendered = await batchContainer(env, lane).fetch(new Request(renderUrl, {
          body: payload,
          headers: {
            authorization: request.headers.get("authorization") ?? "",
            "content-type": "application/json",
          },
          method: "POST",
        }));
        const containerHeadersMs = Date.now() - rpcStartedAt;
        if (!rendered.ok) throw new Error(await rendered.text());
        requireRendererVersion(rendered.headers);
        const downloadStartedAt = Date.now();
        const video = await rendered.arrayBuffer();
        const videoDownloadMs = Date.now() - downloadStartedAt;
        const storageStartedAt = Date.now();
        // A ready event always means the complete immutable MP4 exists in R2.
        const stored = await storeVideo(env, key, video, rendered.headers.get("x-render-time-ms"));
        const timings = {
          ...batchTimings,
          ...responseTimings(rendered),
          workerBeforeJobMs: jobStartedAt - requestStartedAt,
          mockupReadMs, stringifyMs, containerHeadersMs, videoDownloadMs,
          r2WriteMs: Date.now() - storageStartedAt,
          requestBytes: new TextEncoder().encode(payload).byteLength,
          videoBytes: stored.size,
        };
        return {
          cache: "miss",
          lane,
          instanceId: rendered.headers.get("x-instance-id"),
          instanceRequestSequence: Number.parseInt(
            rendered.headers.get("x-instance-request-sequence") ?? "0",
            10,
          ),
          key,
          timings,
          renderTimeMs: stored.renderTime
            ? Number.parseInt(stored.renderTime, 10)
            : undefined,
          size: stored.size,
        };
      },
    });
    for (const failure of result.failures) {
      // Only the bounded render error, never the authenticated request.
      console.error("Story video render failed", { batchId: id, key: failure.key, error: failure.error.slice(0, 500) });
    }
    if (body.shutdownAfterBatch === true) {
      const shutdownStartedAt = Date.now();
      await Promise.all(Array.from({ length: concurrency }, (_, lane) => batchContainer(env, lane).destroy()));
      shutdownTimeMs = Date.now() - shutdownStartedAt;
    }
    return { batchId: id, ...result, shutdownTimeMs };
  };
  if (request.headers.get("accept") === "application/x-ndjson") {
    return streamingBatch(run);
  }
  const result = await run(() => {});
  return Response.json(result, { status: result.failures.length ? 502 : 200 });
}

async function storedVideo(request, env) {
  const key = storyKey(request);
  if (!key) {
    return Response.json(
      { error: "A valid x-story-video-key header is required." },
      { status: 400 },
    );
  }
  const object = await env.STORY_VIDEOS.get(key);
  return object ? videoResponse(object, "hit") : new Response(null, { status: 404 });
}

export class StoryVideoService extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/warm") {
      return warmContainers(this.env);
    }
    if (request.method === "POST" && url.pathname === "/render-batch") {
      return renderBatch(request, this.env);
    }
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname === "/video"
    ) {
      const response = await storedVideo(request, this.env);
      return request.method === "HEAD"
        ? new Response(null, {
            headers: response.headers,
            status: response.status,
            statusText: response.statusText,
          })
        : response;
    }
    return new Response("Not found.", { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (request.method !== "POST" ||
        !["/batch-state", "/render", "/render-batch", "/warm"].includes(url.pathname)) {
      return new Response("Not found.", { status: 404 });
    }
    if (!isAuthorized(
      request.headers.get("authorization"),
      env.BENCHMARK_TOKEN,
    )) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }

    if (url.pathname === "/render-batch") {
      return renderBatch(request, env);
    }
    if (url.pathname === "/warm") return warmContainers(env);
    if (url.pathname === "/batch-state") {
      return batchState(request, env);
    }

    const key = storyKey(request);
    if (!key) {
      return Response.json(
        { error: "A valid x-story-video-key header is required." },
        { status: 400 },
      );
    }
    const existing = await env.STORY_VIDEOS.get(key);
    if (existing) return videoResponse(existing, "hit");

    const rendered = await getContainer(
      env.STORY_VIDEO_RENDERER,
      STORY_RENDERER_VERSION,
    ).fetch(request);
    if (!rendered.ok) return rendered;
    await storeRenderedVideo(env, key, rendered);
    const stored = await env.STORY_VIDEOS.get(key);
    if (!stored) {
      return Response.json({ error: "The rendered video was not stored." }, {
        status: 502,
      });
    }
    const response = videoResponse(stored, "miss");
    for (const name of [
      "x-asset-load-time-ms",
      "x-canvas-time-ms",
      "x-encoder-drain-time-ms",
      "x-instance-age-ms",
      "x-instance-id",
      "x-instance-request-sequence",
      "x-pipe-time-ms",
      "x-render-time-ms",
      "x-render-frame-width",
      "x-unique-frame-count",
    ]) {
      const value = rendered.headers.get(name);
      if (value) response.headers.set(name, value);
    }
    return response;
  },
};
