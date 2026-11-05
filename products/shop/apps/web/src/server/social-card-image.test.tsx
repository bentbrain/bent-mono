import type { ProductDto } from "@forever-tee/contracts";
import { STAPLE_TEE_BASE_PRODUCT_ID } from "@forever-tee/contracts/product-projection";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SOCIAL_CARD_FONT_FAMILY,
  socialCardImageResponse,
} from "@/server/social-card-image";

const product: ProductDto = {
  baseProductId: STAPLE_TEE_BASE_PRODUCT_ID,
  createdAt: "2026-08-31T00:00:00.000Z",
  defaultColor: "White",
  designId: "11111111-1111-4111-8111-111111111111",
  designRevisionId: "a".repeat(64),
  id: "22222222-2222-4222-8222-222222222222",
  placement: { depth: 4, width: 0.3, x: 0.2, y: 0.2 },
  projectionVersion: "safe-margin-v1",
  shopifyHandle: "bent-shirt",
};

describe("social card image", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([0, 1])("renders the PNG card after %i pending image responses", async (pendingResponses) => {
    const runtimeFetch = globalThis.fetch;
    const productImage = await sharp({
      create: {
        background: { alpha: 1, b: 0, g: 0, r: 255 },
        channels: 4,
        height: 20,
        width: 20,
      },
    }).webp().toBuffer();
    const responseBody = new Uint8Array(productImage.byteLength);
    responseBody.set(productImage);
    let imageRequests = 0;
    const fetchProductImage = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.includes("/api/configured-product-image/")) {
        if (imageRequests++ < pendingResponses) {
          return new Response(null, { status: 202, headers: { "Retry-After": "2" } });
        }
        return new Response(responseBody.buffer, {
          headers: { "Content-Type": "image/webp" },
        });
      }
      return runtimeFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchProductImage);

    const response = await socialCardImageResponse(
      new Request(
        `https://shop.bent.build/api/social-card/v4/product/${product.id}/black.png`,
      ),
      product,
      "black",
    );

    if (!response) throw new Error("Expected a social card image response.");
    const card = new Uint8Array(await response.arrayBuffer());
    const panel = await sharp(card)
      .extract({ height: 496, left: 644, top: 67, width: 496 })
      .stats();

    const productRequest = fetchProductImage.mock.calls.find(
      ([input]) =>
        input instanceof URL &&
        input.pathname.includes("/api/configured-product-image/"),
    );
    if (!productRequest) throw new Error("Expected a configured product request.");
    const [productUrl, productOptions] = productRequest;
    if (!(productUrl instanceof URL)) throw new Error("Expected a product URL.");
    expect(productUrl.pathname).toContain("/api/configured-product-image/");
    expect(productOptions).toMatchObject({ cache: "no-store" });
    expect(imageRequests).toBe(pendingResponses + 1);
    expect(SOCIAL_CARD_FONT_FAMILY).toBe("Geist Mono");
    expect(panel.channels.some((channel) => channel.mean < 250)).toBe(true);
  });

  it("returns a retryable response when the configured image remains pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const fetchProductImage = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 202 })));
    vi.stubGlobal("fetch", fetchProductImage);
    const pending = socialCardImageResponse(new Request("https://shop.bent.build/card.png"), product, "black");
    await vi.runAllTimersAsync();
    const response = await pending;
    expect(response?.status).toBe(503);
    expect(response?.headers.get("Retry-After")).toBe("2");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(fetchProductImage).toHaveBeenCalledTimes(5);
  });
});
