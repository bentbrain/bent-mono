import { beforeEach, expect, it, vi } from "vitest";
import { getForeverTeeProduct } from "./product-data";
import type { QueriedProductData } from "./product-query";
import type * as NextServerModule from "next/server";
import { GET as getProductAvailability } from "@/app/api/product-availability/route";
import { BASE_PRODUCT_ID } from "@/lib/products";

const mocks = vi.hoisted(() => ({
  graphql: vi.fn<(query: string, options: unknown) => Promise<unknown>>(),
  client: vi.fn<(request: Pick<Request, "headers">, i18n?: { country: string; language: string }) => unknown>(),
  life: vi.fn(), tag: vi.fn(),
}));
vi.mock("next/cache", () => ({ cacheLife: mocks.life, cacheTag: mocks.tag }));
vi.mock("@/lib/shopify-config", () => ({ shopifyI18n: { country: "AU", language: "EN" } }));
vi.mock("@/lib/storefront", () => ({ createRequestStorefrontClient: mocks.client }));
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof NextServerModule>();
  return { ...original, connection: () => Promise.resolve() };
});
vi.mock("@/lib/product-record-data", () => ({
  getCachedProductRecord: () => Promise.resolve({
    id: BASE_PRODUCT_ID, baseProductId: BASE_PRODUCT_ID,
    designId: null, shopifyHandle: "bent-shirt",
  }),
}));

function variant(color: string, size: string, availableForSale = true): QueriedProductData["variants"]["nodes"][number] {
  return {
    id: `${color}-${size}`, title: `${color} / ${size}`, availableForSale,
    selectedOptions: [{ name: "Color", value: color }, { name: "Size", value: size }],
    price: { amount: "40.00", currencyCode: "AUD" }, compareAtPrice: null,
    product: { handle: "bent-shirt", title: "Shirt" }, sku: `${color}-${size}`,
  };
}
const whiteSmall = variant("White", "S");
const blackMedium = variant("Black", "M", false);
const product: QueriedProductData = {
  id: "shirt", handle: "bent-shirt", title: "Shirt", vendor: "bent.shop", requiresSellingPlan: false,
  encodedVariantExistence: null, encodedVariantAvailability: null,
  options: [{ name: "Color", optionValues: ["White", "Black"].map(name => ({ name, swatch: null, firstSelectableVariant: null })) },
    { name: "Size", optionValues: ["S", "M"].map(name => ({ name, swatch: null, firstSelectableVariant: null })) }],
  selectedOrFirstAvailableVariant: whiteSmall,
  variants: { nodes: [whiteSmall, variant("White", "M"), variant("Black", "S"), blackMedium], pageInfo: { hasNextPage: false } },
  priceRange: { minVariantPrice: whiteSmall.price },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.client.mockReturnValue({ storefrontClient: { graphql: mocks.graphql } });
  mocks.graphql.mockResolvedValue({ data: { product } });
});

it("queries the same anonymous, locale-qualified catalogue for different URL selections", async () => {
  const white = await getForeverTeeProduct({ Color: "White", Size: "S", utm_source: "one" });
  const black = await getForeverTeeProduct({ Color: "Black", Size: "M", utm_source: "two" });
  expect(white?.selectedOrFirstAvailableVariant).toEqual(whiteSmall);
  expect(black?.selectedOrFirstAvailableVariant).toEqual(blackMedium);
  expect(mocks.graphql.mock.calls.map(call => call[1])).toEqual([
    { variables: { handle: "bent-shirt", selectedOptions: [] } },
    { variables: { handle: "bent-shirt", selectedOptions: [] } },
  ]);
  expect(mocks.client.mock.calls.map(call => call[1])).toEqual([
    { country: "AU", language: "EN" }, { country: "AU", language: "EN" },
  ]);
  for (const [request] of mocks.client.mock.calls) expect([...request.headers]).toEqual([]);
  expect(mocks.life).toHaveBeenCalledWith({ stale: 0, revalidate: 30, expire: 60 });
  expect(mocks.tag).toHaveBeenCalledWith("product-records", "storefront-catalogue");
  expect(product.selectedOrFirstAvailableVariant).toEqual(whiteSmall);
});

it("keeps size explicit and accepts case-insensitive complete and sold-out selections", async () => {
  expect((await getForeverTeeProduct({ Color: "Black" }))?.selectedOrFirstAvailableVariant).toBeNull();
  expect((await getForeverTeeProduct({ color: "black", size: "m" }))?.selectedOrFirstAvailableVariant).toEqual(blackMedium);
  expect((await getForeverTeeProduct({ Color: "Black", Size: "XXL" }))?.selectedOrFirstAvailableVariant).toBeNull();
  expect((await getForeverTeeProduct({ Color: ["White", "Black"], Size: "S" }))?.selectedOrFirstAvailableVariant).toBeNull();
});

it("reports shirt availability before size selection without selecting a size", async () => {
  expect((await getForeverTeeProduct({}))?.selectedOrFirstAvailableVariant).toBeNull();
  await expect((await getProductAvailability()).json()).resolves.toEqual({ available: true });
});

it("reports unavailable when every shirt variant is sold out", async () => {
  mocks.graphql.mockResolvedValue({ data: { product: { ...product,
    selectedOrFirstAvailableVariant: blackMedium,
    variants: { ...product.variants, nodes: product.variants.nodes.map(value => ({ ...value, availableForSale: false })) },
  } } });
  await expect((await getProductAvailability()).json()).resolves.toEqual({ available: false });
});

it("selects a one-size product without adding a size decision", async () => {
  const tote = variant("Cream", "One size");
  mocks.graphql.mockResolvedValue({ data: { product: { ...product,
    options: [{ name: "Size", optionValues: [{ name: "One size", swatch: null, firstSelectableVariant: tote }] }],
    selectedOrFirstAvailableVariant: tote, variants: { nodes: [tote], pageInfo: { hasNextPage: false } },
  } } });
  expect((await getForeverTeeProduct({}))?.selectedOrFirstAvailableVariant).toEqual(tote);
});

it("uses live exact resolution when the catalogue exceeds the bounded matrix", async () => {
  const largeProduct = { ...product, variants: { ...product.variants, pageInfo: { hasNextPage: true } } };
  mocks.graphql.mockResolvedValueOnce({ data: { product: largeProduct } });
  mocks.graphql.mockResolvedValueOnce({ data: { product: { ...largeProduct, selectedOrFirstAvailableVariant: blackMedium } } });
  expect((await getForeverTeeProduct({ Color: "Black", Size: "M" }))?.selectedOrFirstAvailableVariant).toEqual(blackMedium);
  expect(mocks.graphql).toHaveBeenLastCalledWith(expect.any(String), { variables: {
    handle: "bent-shirt", selectedOptions: [{ name: "Color", value: "Black" }, { name: "Size", value: "M" }],
  } });
});

it("does not turn partial GraphQL failures into cached catalogue data or a missing product", async () => {
  mocks.graphql.mockResolvedValue({ data: { product }, errors: [{ message: "Unavailable" }] });
  await expect(getForeverTeeProduct({})).rejects.toThrow("Storefront product query failed.");
});
