import { artworkReference, STORY_MOCKUPS, videoKey, videoSize } from "./storage-contract.mjs";

export function registerStorageHandler(ContainerClass) {
  // The SDK's inherited setter populates its proxy registry. A static class
  // field would shadow that setter and silently leave the registry empty.
  ContainerClass.outboundByHost = {
    "story-storage.internal": (request, env) => storageRequest(request, env),
  };
}

// Called only by the private container outbound handler, never the public Worker.
// The process has no general Internet access or Cloudflare credentials.
export async function storageRequest(request, env, fixedStream = (size) => new FixedLengthStream(size)) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/artwork") {
    const ref = artworkReference({
      key: url.searchParams.get("key"), sha256: url.searchParams.get("sha256"),
      size: Number(url.searchParams.get("size")),
    });
    const object = await env.DESIGN_ARTWORK.get(ref.key);
    if (!object || object.size !== ref.size) throw new Error("Revision artwork unavailable.");
    return new Response(object.body, { headers: { "content-length": String(object.size) } });
  }
  if (request.method === "GET" && url.pathname === "/mockup") {
    const path = STORY_MOCKUPS[`${url.searchParams.get("product")}:${url.searchParams.get("color")}`];
    if (!path) return new Response(null, { status: 404 });
    return env.STORY_VIDEO_ASSETS.fetch(new Request(`https://story-video-assets.internal${path}`));
  }
  if (request.method === "PUT" && url.pathname === "/video") {
    const key = videoKey(request.headers.get("x-story-video-key"));
    if (!key || !request.body) throw new Error("Invalid video storage request.");
    const size = videoSize(request.headers.get("content-length"));
    const renderMs = Number(request.headers.get("x-render-time-ms"));
    if (!Number.isFinite(renderMs) || renderMs <= 0) throw new Error("Invalid render timing.");
    const { readable, writable } = fixedStream(size);
    const abort = new AbortController();
    const transfer = request.body.pipeTo(writable, { signal: abort.signal });
    try {
      const [object] = await Promise.all([
        env.STORY_VIDEOS.put(key, readable, {
          httpMetadata: { contentType: "video/mp4" },
          customMetadata: { renderTimeMs: String(renderMs) },
        }),
        transfer,
      ]);
      if (!object || object.size !== size) throw new Error("Incomplete video storage.");
      return Response.json({ size: object.size, etag: object.httpEtag });
    } finally {
      abort.abort();
      // A rejected put may never consume the readable side; release any
      // backpressured write before waiting for pipeTo to settle.
      await readable.cancel().catch(() => undefined);
      await transfer.catch(() => undefined);
    }
  }
  return new Response(null, { status: 404 });
}
