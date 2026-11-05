import { beforeEach, describe, expect, it, vi } from "vitest";

import { storyVideoBff, storyVideoEventsBff } from "@/server/story-video-bff";

vi.mock("@/env", () => ({
  env: {
    FOREVER_TEE_API_SHARED_SECRET: "shared-secret",
    FOREVER_TEE_API_URL: "https://api.example.com",
  },
}));

describe("story-video BFF", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    "https://attacker.invalid/api/configured-product-video/%2f%2fattacker.invalid/white.mp4",
    "https://attacker.invalid/api/configured-product-video/47cba7a2-498e-44cc-9769-b37641e6a63a%5cattacker.invalid/white.mp4",
    "https://attacker.invalid/api/configured-product-video/47cba7a2-498e-44cc-9769-b37641e6a63a/%2f%2fattacker.invalid.mp4",
  ])("rejects path components that could change the upstream destination: %s", async url => {
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);
    expect((await storyVideoBff(new Request(url))).status).toBe(404);
    expect((await storyVideoEventsBff(new Request(url.replace(/white\.mp4$/, "events")))).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps a hostile request origin and query out of the upstream origin and path", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302,
      headers: { location: "https://attacker.invalid/collect", "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", upstream);
    const prefix = "https://attacker.invalid/api/configured-product-video/47cba7a2-498e-44cc-9769-b37641e6a63a";
    const video = await storyVideoBff(new Request(`${prefix}/white.mp4?url=https://attacker.invalid`));
    const events = await storyVideoEventsBff(new Request(`${prefix}/events?url=https://attacker.invalid`));
    expect(video.headers.has("location")).toBe(false);
    expect(events.headers.has("location")).toBe(false);
    expect(upstream).toHaveBeenNthCalledWith(1,
      new URL("https://api.example.com/v2/internal/configured-products/47cba7a2-498e-44cc-9769-b37641e6a63a/story-videos/white"),
      expect.objectContaining({ redirect: "manual" }));
    expect(upstream).toHaveBeenNthCalledWith(2,
      new URL("https://api.example.com/v2/internal/configured-products/47cba7a2-498e-44cc-9769-b37641e6a63a/story-video-events"),
      expect.objectContaining({ redirect: "manual" }));
  });

  it("forwards readiness without exposing service authentication", async () => {
    const upstreamFetch = vi.fn(() =>
      Promise.resolve(Response.json(
        { status: "rendering" },
        { headers: { "retry-after": "2" }, status: 202 },
      ))
    );
    vi.stubGlobal("fetch", upstreamFetch);

    const response = await storyVideoBff(new Request(
      "https://shop.bent.build/api/configured-product-video/47cba7a2-498e-44cc-9769-b37641e6a63a/black.mp4",
      { method: "HEAD" },
    ));

    expect(response.status).toBe(202);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.has("x-forever-tee-service-secret")).toBe(false);
    expect(upstreamFetch).toHaveBeenCalledWith(
      new URL(
        "https://api.example.com/v2/internal/configured-products/47cba7a2-498e-44cc-9769-b37641e6a63a/story-videos/black",
      ),
      {
        cache: "no-store",
        headers: { "x-forever-tee-service-secret": "shared-secret" },
        method: "HEAD",
        redirect: "manual",
      },
    );
  });

  it("streams the MP4 without caching past an owner deletion and rejects malformed paths", async () => {
    const video = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    const upstreamFetch = vi.fn(() =>
      Promise.resolve(new Response(video, {
        headers: {
          "cache-control": "public, max-age=31536000, immutable",
          "content-length": String(video.byteLength),
          "content-type": "video/mp4",
          etag: '"story-video"',
        },
      }))
    );
    vi.stubGlobal("fetch", upstreamFetch);

    const valid = await storyVideoBff(new Request(
      "https://shop.bent.build/api/configured-product-video/47cba7a2-498e-44cc-9769-b37641e6a63a/white.mp4?v=%22story-video%22",
    ));
    const invalid = await storyVideoBff(new Request(
      "https://shop.bent.build/api/configured-product-video/not-a-product/white.mp4",
    ));

    expect(valid.status).toBe(200);
    expect(valid.headers.get("content-type")).toBe("video/mp4");
    expect(valid.headers.get("cache-control"))
      .toBe("private, no-store");
    expect(new Uint8Array(await valid.arrayBuffer())).toEqual(video);
    expect(invalid.status).toBe(404);
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it.each([
    { method: "HEAD", query: "" },
    { method: "GET", query: "" },
    { method: "GET", query: "?v=%22older-video%22" },
  ])("does not cache mutable media discovery: $method $query", async ({ method, query }) => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        etag: '"story-video"',
      },
    }))));

    const response = await storyVideoBff(new Request(
      `https://shop.bent.build/api/configured-product-video/47cba7a2-498e-44cc-9769-b37641e6a63a/white.mp4${query}`,
      { method },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"story-video"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("passes events through before completion and forwards cancellation", async () => {
    const release = Promise.withResolvers<undefined>();
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("event: video\ndata: {}\n\n"));
        await release.promise;
        controller.close();
      },
    });
    const upstreamFetch = vi.fn(() => Promise.resolve(new Response(upstream, {
      headers: { "content-type": "text/event-stream", "x-forever-tee-service-secret": "not-public" },
    })));
    vi.stubGlobal("fetch", upstreamFetch);
    const controller = new AbortController();
    const request = new Request(
      "https://shop.bent.build/api/configured-product-video/47cba7a2-498e-44cc-9769-b37641e6a63a/events",
      { signal: controller.signal },
    );
    const response = await storyVideoEventsBff(request);
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(response.headers.has("x-forever-tee-service-secret")).toBe(false);
    expect(upstreamFetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ signal: request.signal }));
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain("event: video");
    controller.abort();
    expect(request.signal.aborted).toBe(true);
    release.resolve(undefined);
    expect((await reader?.read())?.done).toBe(true);
  });
});
