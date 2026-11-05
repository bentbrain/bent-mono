import type { ProductDto } from "@forever-tee/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFamily: vi.fn<(id: string) => Promise<readonly ProductDto[] | undefined>>(),
  getProduct: vi.fn<(id: string) => Promise<ProductDto | undefined>>(),
  render: vi.fn<(
    request: Request,
    product: ProductDto,
    color: string,
  ) => Promise<Response | undefined>>(),
}));

vi.mock("@/lib/product-record-data", () => ({
  getCachedProductFamilyRecords: mocks.getFamily,
  getCachedProductRecord: mocks.getProduct,
}));

vi.mock("@/server/social-card-image", () => ({
  socialCardImageResponse: mocks.render,
}));

import { GET as getFeaturedCard } from "@/app/api/social-card/v4/featured/[baseProduct]/[color]/route";
import { GET as getProductCard } from "@/app/api/social-card/v4/product/[productId]/[color]/route";
import {
  COTTON_TOTE_BASE_PRODUCT_ID,
  STAPLE_TEE_BASE_PRODUCT_ID,
} from "@forever-tee/contracts/product-projection";

const shirt: ProductDto = {
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
const tote: ProductDto = {
  ...shirt,
  baseProductId: COTTON_TOTE_BASE_PRODUCT_ID,
  id: "33333333-3333-4333-8333-333333333333",
  shopifyHandle: "cotton-tote",
};

describe("social card routes", () => {
  beforeEach(() => {
    mocks.getFamily.mockReset();
    mocks.getProduct.mockReset();
    mocks.render.mockReset();
  });

  it("renders the configured product and colour named by a shared product URL", async () => {
    const request = new Request(
      `https://shop.bent.build/api/social-card/v4/product/${shirt.id}/black.png`,
    );
    const image = new Response("image");
    mocks.getProduct.mockResolvedValue(shirt);
    mocks.render.mockResolvedValue(image);

    const response = await getProductCard(request, {
      params: Promise.resolve({ color: "black.png", productId: shirt.id }),
    });

    expect(response).toBe(image);
    expect(mocks.getProduct).toHaveBeenCalledWith(shirt.id);
    expect(mocks.render).toHaveBeenCalledWith(request, shirt, "black");
  });

  it("selects the featured product family member named by the landing URL", async () => {
    const request = new Request(
      "https://shop.bent.build/api/social-card/v4/featured/cotton-tote/cream.png",
    );
    const image = new Response("image");
    mocks.getFamily.mockResolvedValue([shirt, tote]);
    mocks.render.mockResolvedValue(image);

    const response = await getFeaturedCard(request, {
      params: Promise.resolve({
        baseProduct: "cotton-tote",
        color: "cream.png",
      }),
    });

    expect(response).toBe(image);
    expect(mocks.render).toHaveBeenCalledWith(request, tote, "cream");
  });

  it("rejects malformed image requests", async () => {
    const response = await getProductCard(
      new Request("https://shop.bent.build/api/social-card/v4/product/id/black"),
      {
        params: Promise.resolve({ color: "black", productId: shirt.id }),
      },
    );

    expect(response.status).toBe(404);
    expect(mocks.getProduct).not.toHaveBeenCalled();
  });
});
