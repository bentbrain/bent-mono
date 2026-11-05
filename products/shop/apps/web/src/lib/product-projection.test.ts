import { readFile } from "node:fs/promises";

import { PRODUCT_MOCKUP_GEOMETRY_VERSION } from "@forever-tee/contracts/product-mockup-geometry";
import { productMockupArtworkLayout } from "@forever-tee/contracts/product-projection";
import { describe, expect, it } from "vitest";

import {
  configuredProductImagePath,
  productImagePath,
} from "@/lib/product-image";
import { productProjectionArtworkStyle } from "@/lib/product-projection";

describe("product mockup projection", () => {
  it("uses the Staple Tee provider print-area aspect ratio", () => {
    expect(productMockupArtworkLayout("staple-tee")).toEqual({
      height: 0.546_378_563_772_775_9,
      left: 0.283,
      top: 0.25,
      width: 0.436,
    });
    expect(productProjectionArtworkStyle("staple-tee")).toMatchObject({
      aspectRatio: "0.436 / 0.5463785637727759",
      top: "25%",
    });
  });

  it("uses the Cotton Tote provider print-area aspect ratio", () => {
    const layout = productMockupArtworkLayout("cotton-tote");
    expect(layout).toMatchObject({
      left: 0.37,
      top: 0.52,
      width: 0.275,
    });
    expect(layout.height).toBeCloseTo(0.332_231_040_564_373_9, 15);
    expect(productProjectionArtworkStyle("cotton-tote")).toMatchObject({
      aspectRatio: "0.275 / 0.33223104056437397",
      top: "52%",
    });
  });

  it("versions immutable mockup URLs with the physical geometry contract", () => {
    expect(PRODUCT_MOCKUP_GEOMETRY_VERSION).toBe("physical-print-area-v1");
    expect(configuredProductImagePath({
      color: "Cream",
      productId: "product-id",
    })).toBe(
      "/api/configured-product-image/current/product-id/cream.webp?geometry=physical-print-area-v1&access=revocable-v1",
    );
    expect(productImagePath({
      baseProductSlug: "staple-tee",
      color: "White",
      designId: "design-id",
      revision: "revision-id",
    })).toBe(
      "/api/product-image/design-id/revision-id/white.webp?geometry=physical-print-area-v1&access=revocable-v1",
    );
  });

  it("keeps every product renderer on the shared physical geometry", async () => {
    const [editorMinimap, serverProductImage, storyGeometry] =
      await Promise.all([
        readFile(
          new URL("../components/editor-minimap.tsx", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../../../../workers/video-renderer/src/product-image-renderer.mjs", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL(
            "../../../../workers/video-renderer/src/geometry.mjs",
            import.meta.url,
          ),
          "utf8",
        ),
      ]);

    expect(editorMinimap).toContain("productProjectionSpecification");
    expect(editorMinimap).toContain(
      'productProjectionArtworkStyle("staple-tee")',
    );
    expect(editorMinimap).toContain(
      'productProjectionArtworkStyle("cotton-tote")',
    );
    expect(serverProductImage).toContain("PRODUCT_MOCKUP_GEOMETRY");
    expect(serverProductImage).not.toContain("PREVIEW_HEIGHT");
    expect(serverProductImage).not.toContain("PREVIEW_WIDTH");
    expect(storyGeometry).toContain("PRODUCT_MOCKUP_GEOMETRY");
    expect(storyGeometry).not.toContain("495 / 395");
  });
});
