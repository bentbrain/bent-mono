import "server-only";

import { env } from "@/env";

const STORY_VIDEO_PATH = /^\/api\/configured-product-video\/([0-9a-f-]{36})\/(black|cream|white)\.mp4$/;
const STORY_EVENTS_PATH = /^\/api\/configured-product-video\/([0-9a-f-]{36})\/events$/;

export async function storyVideoEventsBff(request: Request) {
  const productId = STORY_EVENTS_PATH.exec(new URL(request.url).pathname)?.[1];
  if (!productId) return new Response(null, { status: 404 });
  try {
    const response = await fetch(new URL(
      `/v2/internal/configured-products/${productId}/story-video-events`,
      env.FOREVER_TEE_API_URL,
    ), {
      cache: "no-store",
      headers: { "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET },
      redirect: "manual",
      signal: request.signal,
    });
    if (!response.ok) return new Response(null, { status: response.status });
    if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
      return new Response(null, { status: 502 });
    }
    return new Response(response.body, {
      headers: {
        "cache-control": "private, no-store, no-transform",
        "content-type": "text/event-stream",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}

export async function storyVideoBff(request: Request) {
  const url = new URL(request.url);
  const match = STORY_VIDEO_PATH.exec(url.pathname);
  const productId = match?.[1];
  const colour = match?.[2];
  if (!productId || !colour) return new Response(null, { status: 404 });

  const upstream = new URL(
    `/v2/internal/configured-products/${productId}/story-videos/${colour}`,
    `${env.FOREVER_TEE_API_URL.replace(/\/$/, "")}/`,
  );
  let response: Response;
  try {
    response = await fetch(upstream, {
      cache: "no-store",
      headers: {
        "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET,
      },
      method: request.method,
      redirect: "manual",
    });
  } catch {
    return Response.json(
      { error: { code: "UPSTREAM_UNAVAILABLE", message: "Story video is unavailable." } },
      { status: 502 },
    );
  }

  const headers = new Headers();
  for (const name of [
    "cache-control",
    "content-length",
    "content-type",
    "etag",
    "retry-after",
    "x-content-type-options",
  ]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Even a versioned file becomes unavailable when its owner deletes it.
  headers.set("cache-control", "private, no-store");
  return new Response(request.method === "HEAD" ? null : response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
