import { Effect } from "effect";

import { MAX_INLINE_ARTWORK_PREVIEW_BYTES } from "@forever-tee/contracts/limits";
import { ArtworkStorageFailure } from "./design-errors";
import type { ImageProcessingBinding } from "./image-processing";

const PREVIEW_VERSION = "display-1600-v2";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function artworkPreviewKey(designId: string, sha256: string) {
  return `designs/${designId}/artwork-preview-${sha256}-${PREVIEW_VERSION}.webp`;
}

export function generateArtworkPreview(images: ImageProcessingBinding, artwork: Uint8Array) {
  return Effect.tryPromise({
    try: async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(artwork); controller.close(); },
      });
      const output = await images.input(stream)
        .transform({ width: 1_600, height: 1_600, fit: "scale-down" })
        .output({ format: "image/webp", quality: 90 });
      const response = output.response();
      if (!response.ok) throw new Error("Preview transformation failed.");
      return new Uint8Array(await response.arrayBuffer());
    },
    catch: (cause) => new ArtworkStorageFailure({ operation: "transform preview", cause }),
  }).pipe(Effect.withSpan("design.preparePreview"));
}

export function storeArtworkPreview(bucket: Pick<R2Bucket, "put">, designId: string, sha256: string, bytes: Uint8Array) {
  return Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
      const previewSha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
      return bucket.put(artworkPreviewKey(designId, sha256), bytes, {
        httpMetadata: { cacheControl: IMMUTABLE_CACHE_CONTROL, contentType: "image/webp" },
        customMetadata: { designId, source: `artwork-preview-${PREVIEW_VERSION}`, sha256: previewSha256 },
        sha256: digest,
      });
    },
    catch: (cause) => new ArtworkStorageFailure({ operation: "put preview", cause }),
  });
}

// Only call after screening has allowed the portrait. Preparation overlaps
// the authoritative artwork commit and never turns that commit into a failure.
export function prepareInlineArtworkPreview(
  env: { IMAGES: ImageProcessingBinding; DESIGN_ARTWORK: Pick<R2Bucket, "put"> },
  designId: string,
  sha256: string,
  artwork: Uint8Array,
  context?: Pick<ExecutionContext, "waitUntil">,
) {
  return generateArtworkPreview(env.IMAGES, artwork).pipe(
    Effect.tap((bytes) => {
      const cache = storeArtworkPreview(env.DESIGN_ARTWORK, designId, sha256, bytes).pipe(
        Effect.timeout("5 seconds"),
        Effect.catchAll(() => Effect.void),
      );
      // This is a reproducible cache, not the authoritative print-artwork commit.
      // Keep it alive after the response without holding up the inline preview.
      return context
        ? Effect.sync(() => { context.waitUntil(Effect.runPromise(cache)); })
        : cache;
    }),
    Effect.map((bytes) => {
      if (bytes.byteLength > MAX_INLINE_ARTWORK_PREVIEW_BYTES) return undefined;
      let binary = "";
      for (let offset = 0; offset < bytes.byteLength; offset += 8_192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
      }
      return { contentType: "image/webp", base64: btoa(binary) };
    }),
    Effect.timeout("5 seconds"),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );
}
