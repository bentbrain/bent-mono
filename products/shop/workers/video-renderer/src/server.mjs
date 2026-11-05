import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";

import { renderStoryVideo } from "./renderer.mjs";
import { isAuthorized } from "./server-auth.mjs";
import { STORY_RENDERER_VERSION } from "./version.mjs";
import { renderStoredVideo } from "./stored-render.mjs";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const instanceId = randomUUID();
const instanceStartedAt = performance.now();
let renderRequestSequence = 0;

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      instanceAgeMs: Math.round(performance.now() - instanceStartedAt),
      instanceId,
      ok: true,
      rendererVersion: STORY_RENDERER_VERSION,
      renderRequestSequence,
    }));
    return;
  }
  if (request.method !== "POST" || !["/render", "/render-stored"].includes(request.url)) {
    response.writeHead(404).end();
    return;
  }
  const benchmarkToken = process.env.BENCHMARK_TOKEN;
  if (benchmarkToken && !isAuthorized(
    request.headers.authorization,
    benchmarkToken,
  )) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Unauthorized." }));
    return;
  }
  try {
    renderRequestSequence += 1;
    const requestSequence = renderRequestSequence;
    const requestStartedAt = performance.now();
    const input = await jsonBody(request);
    const requestReadTimeMs = Math.round(performance.now() - requestStartedAt);
    if (request.url === "/render-stored") {
      const result = await renderStoredVideo(input, renderStoryVideo);
      response.writeHead(200, {
        "content-type": "application/json",
        "x-story-renderer-version": STORY_RENDERER_VERSION,
        "x-instance-id": instanceId,
        "x-instance-request-sequence": String(requestSequence),
      });
      response.end(JSON.stringify({ ...result, timings: { ...result.timings, nodeBodyReadMs: requestReadTimeMs } }));
      return;
    }
    const result = await renderStoryVideo(input);
    response.writeHead(200, {
      "content-length": String(result.video.byteLength),
      "content-type": "video/mp4",
      "x-story-renderer-version": STORY_RENDERER_VERSION,
      "x-asset-load-time-ms": String(result.assetLoadTimeMs),
      "x-canvas-time-ms": String(result.canvasTimeMs),
      "x-encoder-drain-time-ms": String(result.encoderDrainTimeMs),
      "x-instance-age-ms": String(Math.round(performance.now() - instanceStartedAt)),
      "x-instance-id": instanceId,
      "x-instance-request-sequence": String(requestSequence),
      "x-pipe-time-ms": String(result.pipeTimeMs),
      "x-render-time-ms": String(result.renderTimeMs),
      "x-request-read-time-ms": String(requestReadTimeMs),
      "x-render-frame-width": String(result.encoding.frameWidth),
      "x-unique-frame-count": String(result.uniqueFrameCount),
    });
    response.end(result.video);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: message }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.info(`Story video renderer listening on ${String(port)}.`);
});
