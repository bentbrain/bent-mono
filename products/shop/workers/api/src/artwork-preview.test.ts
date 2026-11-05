import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

import { prepareInlineArtworkPreview } from "./artwork-preview";
import type { ImageProcessingBinding } from "./image-processing";

afterEach(() => vi.useRealTimers());

describe("inline artwork preview critical path", () => {
  it.each([false, true])("does not hold the reveal for a slow cache write, failure=%s", async (failCache) => {
    vi.useFakeTimers();
    const images: ImageProcessingBinding = {
      info: () => Promise.resolve({ format: "image/png", width: 100, height: 100 }),
      input: () => {
        const transformer = {
          transform() { return transformer; },
          async output() {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            return { response: () => new Response(new Uint8Array([1, 2, 3])) };
          },
        };
        return transformer;
      },
    };
    const pending: Promise<unknown>[] = [];
    let cacheStarted: () => void = () => undefined;
    const cacheReady = new Promise<void>(resolve => { cacheStarted = resolve; });
    const put = vi.fn(async () => {
      cacheStarted();
      await new Promise<void>((resolve) => setTimeout(resolve, 4_000));
      if (failCache) throw new Error("Cache unavailable");
      return {
        key: "preview", version: "1", size: 3, etag: "etag", httpEtag: '"etag"',
        uploaded: new Date(), storageClass: "Standard",
        checksums: { toJSON: () => ({}) },
        writeHttpMetadata: () => undefined,
      };
    });
    const completed = vi.fn();
    const preview = Effect.runPromise(prepareInlineArtworkPreview(
      { IMAGES: images, DESIGN_ARTWORK: { put } },
      "design", "sha", new Uint8Array([137, 80, 78, 71]),
      { waitUntil: (promise) => { pending.push(promise); } },
    ));
    void preview.then(completed);

    await vi.advanceTimersByTimeAsync(100);
    expect(completed).toHaveBeenCalledWith({ contentType: "image/webp", base64: "AQID" });
    // Native SHA-256 completion is independent of the fake timer clock.
    await cacheReady;
    expect(put).toHaveBeenCalledOnce();
    expect(pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });
});
