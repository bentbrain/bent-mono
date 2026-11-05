import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as NextServerModule from "next/server";

const mocks = vi.hoisted(() => ({
  getForeverTeeProduct: vi.fn(),
  getCachedProductRecord: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof NextServerModule>();
  return { ...original, connection: vi.fn(() => Promise.resolve()) };
});

vi.mock("@/lib/product-data", () => ({
  getForeverTeeProduct: mocks.getForeverTeeProduct,
}));
vi.mock("@/lib/product-record-data", () => ({
  getCachedProductRecord: mocks.getCachedProductRecord,
}));

import { GET } from "@/app/api/product-availability/route";
import { BASE_PRODUCT_ID } from "@/lib/products";

const BASE_PRODUCT = {
  baseProductId: BASE_PRODUCT_ID,
  createdAt: "2026-08-16T00:00:00.000Z",
  designId: null,
  id: BASE_PRODUCT_ID,
  shopifyHandle: "forever-tee",
};

describe("product availability preflight", () => {
  beforeEach(() => {
    mocks.getCachedProductRecord.mockReset();
    mocks.getForeverTeeProduct.mockReset();
    mocks.getCachedProductRecord.mockResolvedValue(BASE_PRODUCT);
  });

  it("confirms the configured base product and an available Shopify variant", async () => {
    mocks.getForeverTeeProduct.mockResolvedValue({
      selectedOrFirstAvailableVariant: null,
      adjacentVariants: [{ availableForSale: true }],
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ available: true });
    expect(mocks.getForeverTeeProduct).toHaveBeenCalledWith(
      {},
      "forever-tee",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects a configured record in place of the base product", async () => {
    mocks.getCachedProductRecord.mockResolvedValue({
      ...BASE_PRODUCT,
      designId: "d68acf3c-bb3b-43e1-b33a-8dc678bb004c",
    });

    const response = await GET();

    await expect(response.json()).resolves.toEqual({ available: false });
    expect(mocks.getForeverTeeProduct).not.toHaveBeenCalled();
  });

  it("keeps purchase unavailable when Shopify has no available variant", async () => {
    mocks.getForeverTeeProduct.mockResolvedValue({
      selectedOrFirstAvailableVariant: null,
      adjacentVariants: [{ availableForSale: false }],
    });

    const response = await GET();

    await expect(response.json()).resolves.toEqual({ available: false });
  });

  it("returns a retryable failure when the preflight dependency fails", async () => {
    mocks.getForeverTeeProduct.mockRejectedValue(new Error("offline"));

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ available: false });
  });
});
