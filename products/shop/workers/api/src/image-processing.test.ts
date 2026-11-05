import { describe, expect, it } from "vitest";

import {
  deriveModerationPreview,
  MAX_OUTPUT_BYTES,
  MODERATION_PREVIEW_MAX_BYTES,
  MODERATION_PREVIEW_MAX_EDGE,
  processJpeg,
} from "./image-processing";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function images(
  info: { format: string; height: number; width: number },
  output = new Uint8Array([137, 80, 78, 71]),
) {
  return {
    info() {
      return Promise.resolve({ ...info, fileSize: JPEG.byteLength });
    },
    input() {
      const transformer = {
        transform() {
          return transformer;
        },
        output() {
          return Promise.resolve({
            response() {
              return new Response(output, {
                headers: { "content-type": "image/png" },
              });
            },
          });
        },
      };
      return transformer;
    },
  };
}

describe("bounded image processing", () => {
  it("rejects MIME/magic mismatches before a paid transform", async () => {
    let quotaChecks = 0;
    const result = await processJpeg(
      images({ format: "image/png", height: 1, width: 1 }),
      JPEG,
      "print",
      () => { quotaChecks += 1; return Promise.resolve(true); },
    );
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(quotaChecks).toBe(0);
    expect(await processJpeg(
      images({ format: "image/jpeg", height: 1, width: 1 }),
      new Uint8Array([1, 2, 3, 4]),
      "print",
      () => Promise.resolve(true),
    )).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects excessive dimensions before consuming quota", async () => {
    let quotaChecks = 0;
    const result = await processJpeg(
      images({ format: "image/jpeg", height: 8_192, width: 8_192 }),
      JPEG,
      "preview",
      () => { quotaChecks += 1; return Promise.resolve(true); },
    );
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(quotaChecks).toBe(0);
  });

  it("consumes quota immediately before transforming and bounds output", async () => {
    let quotaChecks = 0;
    const accepted = await processJpeg(
      images({ format: "image/jpeg", height: 1_000, width: 1_000 }),
      JPEG,
      "preview",
      () => { quotaChecks += 1; return Promise.resolve(true); },
    );
    expect(accepted).toEqual({
      ok: true,
      bytes: new Uint8Array([137, 80, 78, 71]),
      height: 1_000,
      width: 1_000,
    });
    expect(quotaChecks).toBe(1);
    const tooLarge = await processJpeg(
      images(
        { format: "image/jpeg", height: 1, width: 1 },
        new Uint8Array(MAX_OUTPUT_BYTES + 1),
      ),
      JPEG,
      "print",
      () => Promise.resolve(true),
    );
    expect(tooLarge).toEqual({ ok: false, reason: "output-too-large" });
  });

  it("derives a bounded JPEG moderation preview without segmentation", async () => {
    const transforms: ImageTransform[] = [];
    const binding = {
      info() {
        return Promise.resolve({
          format: "image/jpeg",
          height: 2_000,
          width: 1_500,
        });
      },
      input() {
        const transformer = {
          transform(options: ImageTransform) {
            transforms.push(options);
            return transformer;
          },
          output() {
            return Promise.resolve({
              response() {
                return new Response(JPEG, {
                  headers: { "content-type": "image/jpeg" },
                });
              },
            });
          },
        };
        return transformer;
      },
    };

    await expect(deriveModerationPreview(binding, JPEG)).resolves.toEqual({
      ok: true,
      preview: { bytes: JPEG, contentType: "image/jpeg" },
    });
    expect(transforms).toEqual([{
      fit: "scale-down",
      height: MODERATION_PREVIEW_MAX_EDGE,
      width: MODERATION_PREVIEW_MAX_EDGE,
    }]);
    await expect(deriveModerationPreview(
      images(
        { format: "image/jpeg", height: 1, width: 1 },
        new Uint8Array(MODERATION_PREVIEW_MAX_BYTES + 1),
      ),
      JPEG,
    )).resolves.toEqual({ ok: false, reason: "output-too-large" });
  });
});
