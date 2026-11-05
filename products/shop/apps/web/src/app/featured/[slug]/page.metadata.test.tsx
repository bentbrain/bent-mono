import { beforeEach, expect, it, vi } from "vitest";

import { STAPLE_TEE_BASE_PRODUCT_ID } from "@forever-tee/contracts/product-projection";

import { SAMPLE_PRODUCT_ID } from "@/lib/products";

import { generateMetadata } from "./page";

const mocks = vi.hoisted(() => ({
  family: vi.fn(),
  featured: vi.fn(),
}));

vi.mock("@/lib/product-record-data", () => ({
  getCachedProductFamilyRecords: mocks.family,
}));
vi.mock("@/server/featured-product", () => ({
  featuredProductsForRequest: mocks.featured,
}));
vi.mock("@/components/product-page-content", () => ({
  ProductPageData: () => null,
}));
vi.mock("@/components/route-skeletons", () => ({
  ProductPageSkeleton: () => null,
}));

const productId = "d09442a5-74b9-43a7-9ec3-e14231dd7b07";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.featured.mockResolvedValue([{ productId, slot: 2 }]);
  mocks.family.mockResolvedValue([{
    id: productId,
    baseProductId: STAPLE_TEE_BASE_PRODUCT_ID,
    defaultColor: "White",
  }]);
});

it("uses the featured product default colour and stable canonical route", async () => {
  const metadata = await generateMetadata({
    params: Promise.resolve({ slug: productId }),
    searchParams: Promise.resolve({}),
  });

  expect(metadata).toMatchObject({
    alternates: { canonical: `/featured/${productId}` },
    openGraph: {
      images: [{
        alt: "White T-shirt with the featured bent.shop design",
        url: `/api/social-card/v4/product/${productId}/white.png`,
      }],
      url: `/featured/${productId}?shirtColor=White&product=shirt`,
    },
  });
});

it("keeps original design sharing on its own featured route", async () => {
  mocks.featured.mockResolvedValue([{ productId: SAMPLE_PRODUCT_ID, slot: 1 }]);

  const metadata = await generateMetadata({
    params: Promise.resolve({ slug: SAMPLE_PRODUCT_ID }),
    searchParams: Promise.resolve({
      product: "shirt",
      shirtColor: "Black",
    }),
  });

  expect(mocks.family).toHaveBeenCalledWith(SAMPLE_PRODUCT_ID);
  expect(metadata).toMatchObject({
    openGraph: {
      images: [{
        alt: "Black T-shirt with the featured bent.shop design",
        url: "/api/social-card/v4/featured/staple-tee/black.png",
      }],
      url: `/featured/${SAMPLE_PRODUCT_ID}?shirtColor=Black&product=shirt`,
    },
  });
});

it("keeps legacy colour selection in the featured share card", async () => {
  const metadata = await generateMetadata({
    params: Promise.resolve({ slug: productId }),
    searchParams: Promise.resolve({ Color: "Black" }),
  });
  expect(metadata).toMatchObject({ openGraph: {
    images: [{ url: `/api/social-card/v4/product/${productId}/black.png` }],
    url: `/featured/${productId}?shirtColor=Black&product=shirt`,
  } });
});
