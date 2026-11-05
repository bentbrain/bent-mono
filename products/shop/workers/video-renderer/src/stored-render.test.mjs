import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { renderStoredVideo } from "./stored-render.mjs";
import { registerStorageHandler, storageRequest } from "./storage-proxy.mjs";

test("storage registration invokes the SDK-style inherited setter", async () => {
  const registry = new Map();
  class ContainerBase {
    static set outboundByHost(handlers) { registry.set(this.name, handlers); }
  }
  class RendererContainer extends ContainerBase {}
  registerStorageHandler(RendererContainer);
  assert.equal(Object.hasOwn(RendererContainer, "outboundByHost"), false);
  const handler = registry.get("RendererContainer")["story-storage.internal"];
  const response = await handler(new Request("http://story-storage.internal/unknown"), {});
  assert.equal(response.status, 404);
});

const artwork = Buffer.from("saved artwork bytes");
const sha256 = createHash("sha256").update(artwork).digest("hex");
const key = `designs/9bbac861-76bf-4818-957d-12770401474a/artwork/${sha256}`;
const storyKey = "story-videos/v7/revision/product/black.mp4";
const input = { artworkRef: { key, sha256, size: artwork.length }, storyKey,
  baseProductSlug: "staple-tee", color: "Black", settings: { depth: 5 }, encoding: { crf: 21 } };
const video = Buffer.from("exact encoded MP4 bytes");
const result = { video, renderTimeMs: 5000, assetLoadTimeMs: 100, canvasTimeMs: 2400,
  pipeTimeMs: 1200, encoderDrainTimeMs: 1200 };

test("direct storage passes identical source/settings to the encoder and waits for R2", async () => {
  let release;
  const committed = new Promise((resolve) => { release = resolve; });
  let uploaded;
  let finished = false;
  const running = renderStoredVideo(input, async (value) => {
    assert.deepEqual(value.artwork, artwork);
    assert.deepEqual(value.mockup, Buffer.from("garment"));
    assert.deepEqual(value.settings, input.settings);
    assert.deepEqual(value.encoding, input.encoding);
    return result;
  }, async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/artwork") return new Response(artwork);
    if (path === "/mockup") return new Response("garment");
    assert.equal(options.method, "PUT");
    assert.equal(options.headers["x-story-video-key"], storyKey);
    uploaded = options.body;
    await committed;
    return Response.json({ size: video.length, etag: "stored-etag" });
  }).then((value) => { finished = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(uploaded, video);
  assert.equal(finished, false);
  release();
  const stored = await running;
  assert.equal(stored.size, video.length);
  assert.equal(stored.timings.renderMs, 5000);
});

test("checksum mismatch cannot render or publish a video", async () => {
  let rendered = false;
  await assert.rejects(renderStoredVideo(input, async () => { rendered = true; },
    async () => new Response("wrong artwork")), /checksum/);
  assert.equal(rendered, false);
});

test("retained original artwork can render a recursive video with the same checksum checks", async () => {
  const originalInput = { ...input, artworkRef: { ...input.artworkRef, key: key.replace('/artwork/', '/original/') } };
  let rendered = false;
  await renderStoredVideo(originalInput, async value => {
    assert.deepEqual(value.artwork, artwork);
    rendered = true;
    return result;
  }, async url => new URL(url).pathname === '/video'
    ? Response.json({ size: video.length, etag: 'stored-etag' }) : new Response(artwork));
  assert.equal(rendered, true);
  await assert.rejects(renderStoredVideo(originalInput, async () => result,
    async () => new Response('wrong original')), /checksum/);
});

test("failed storage is not reported ready", async () => {
  await assert.rejects(renderStoredVideo(input, async () => result, async (url) => {
    if (new URL(url).pathname === "/video") return new Response(null, { status: 503 });
    return new Response(artwork);
  }), /storage failed/);
});

function fixedLength(size) {
  let count = 0;
  return new TransformStream({
    transform(chunk, controller) {
      count += chunk.byteLength;
      if (count > size) throw new Error("Length mismatch");
      controller.enqueue(chunk);
    },
    flush() { if (count !== size) throw new Error("Length mismatch"); },
  });
}

function upload(body = video, length = body.length) {
  return new Request("http://story-storage.internal/video", { method: "PUT", body,
    headers: { "content-length": String(length), "x-story-video-key": storyKey, "x-render-time-ms": "5000" } });
}

test("private proxy streams identical MP4 bytes with metadata into R2", async () => {
  const response = await storageRequest(upload(), { STORY_VIDEOS: {
    async put(outputKey, stream, options) {
      assert.equal(outputKey, storyKey);
      assert.deepEqual(Buffer.from(await new Response(stream).arrayBuffer()), video);
      assert.deepEqual(options.customMetadata, { renderTimeMs: "5000" });
      return { size: video.length, httpEtag: "stored-etag" };
    },
  } }, fixedLength);
  assert.deepEqual(await response.json(), { size: video.length, etag: "stored-etag" });
});

test("private proxy rejects truncated streams and failed writes", async () => {
  await assert.rejects(storageRequest(upload(video, video.length + 1), { STORY_VIDEOS: {
    async put(_key, stream) { await new Response(stream).arrayBuffer(); },
  } }, fixedLength), /Length mismatch/);
  await assert.rejects(storageRequest(upload(), { STORY_VIDEOS: {
    async put() { throw new Error("R2 unavailable"); },
  } }, fixedLength), /R2 unavailable/);
});

test("private proxy does not expose arbitrary R2 keys or asset URLs", async () => {
  await assert.rejects(storageRequest(new Request("http://story-storage.internal/artwork?key=secrets"), {}), /Invalid immutable/);
  const response = await storageRequest(new Request("http://story-storage.internal/mockup?product=../../secrets"), {});
  assert.equal(response.status, 404);
  assert.equal((await storageRequest(new Request("http://story-storage.internal/anything"), {})).status, 404);
});

test("direct transport verifies and passes a distinct inset without substituting the outer source", async () => {
  const nested = Buffer.from("inset portrait"), hash = createHash("sha256").update(nested).digest("hex");
  const composed = { ...input, recursiveArtworkRef: { key: `designs/9bbac861-76bf-4818-957d-12770401474a/artwork/${hash}`, sha256: hash, size: nested.length },
    recursiveCrop: { cropX: 0.5, cropY: 0.4, cropZoom: 1 },
    recursivePlacement: { placementX: .267994, placementY: .48, placementWidth: .455717 } };
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.pathname === "/artwork") return new Response(parsed.searchParams.get("sha256") === hash ? nested : artwork);
    if (parsed.pathname === "/video") return Response.json({ size: video.length, etag: "stored" });
    return new Response("garment");
  };
  await renderStoredVideo(composed, async scene => {
    assert.deepEqual(scene.artwork, artwork); assert.deepEqual(scene.recursiveArtwork, nested);
    assert.deepEqual(scene.recursiveCrop, composed.recursiveCrop);
    assert.deepEqual(scene.recursivePlacement, composed.recursivePlacement); return result;
  }, fetcher);
  await assert.rejects(renderStoredVideo(composed, async () => { throw new Error("must not render"); }, async url =>
    new URL(url).searchParams.get("sha256") === hash ? new Response(Buffer.alloc(nested.length)) : fetcher(url)), /Recursive artwork checksum/);
});
