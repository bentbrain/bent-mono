import { beforeEach, describe, expect, it, vi } from "vitest";

import { STAPLE_TEE_BASE_PRODUCT_ID } from "@forever-tee/contracts/product-projection";

import { generateMetadata } from "./page";

const mocks = vi.hoisted(() => ({ family: vi.fn() }));

vi.mock("@/lib/product-record-data", () => ({
  getCachedProductFamilyRecords: mocks.family,
}));
vi.mock("@/components/product-page-content", () => ({
  ProductPageContent: () => null,
}));

const productId = "d09442a5-74b9-43a7-9ec3-e14231dd7b07";
const whiteDefaultProduct = {
  id: productId,
  baseProductId: STAPLE_TEE_BASE_PRODUCT_ID,
  createdAt: "2026-09-07T00:00:00.000Z",
  defaultColor: "White",
  designId: "5430ea6f-0bed-4615-adca-e25fbb1c5f9d",
  designRevisionId: "162c3ded-5984-4389-9e00-f0670b68616e",
  placement: null,
  projectionVersion: "safe-margin-v1",
  shopifyHandle: "configured-staple-tee",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.family.mockResolvedValue([whiteDefaultProduct]);
});

describe.each(["White", "Black"])("product metadata with %s default", (defaultColor) => {
  beforeEach(() => {
    mocks.family.mockResolvedValue([{ ...whiteDefaultProduct, defaultColor }]);
  });

  it("uses the configured product default when the URL omits Color", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ id: productId }),
      searchParams: Promise.resolve({}),
    });

    expect(metadata).toMatchObject({
      openGraph: {
        images: [{
          alt: `${defaultColor} product with a bent.shop design`,
          url: `/api/social-card/v4/product/${productId}/${defaultColor.toLowerCase()}.png`,
        }],
        url: `/product/${productId}?Color=${defaultColor}`,
      },
    });
  });

  it.each(["White", "Black"])("keeps an explicit %s selection", async (color) => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ id: productId }),
      searchParams: Promise.resolve({ Color: color }),
    });

    expect(metadata).toMatchObject({
      openGraph: {
        images: [{
          alt: `${color} product with a bent.shop design`,
          url: `/api/social-card/v4/product/${productId}/${color.toLowerCase()}.png`,
        }],
        url: `/product/${productId}?Color=${color}`,
      },
    });
  });
});
