import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSalesIntakeOpen: vi.fn(),
  bindOrderManagementCapability: vi.fn(),
  getCartData: vi.fn(),
  ensureCheckoutArtworkNote: vi.fn(),
  revalidateCartLineCapability: vi.fn(),
}));

vi.mock("@/lib/cart-data", () => ({ getCartData: mocks.getCartData }));
vi.mock("@/server/checkout-artwork-note", () => ({
  ensureCheckoutArtworkNote: mocks.ensureCheckoutArtworkNote,
}));
vi.mock("@/server/sales-intake", () => ({
  assertSalesIntakeOpen: mocks.assertSalesIntakeOpen,
  SalesIntakeDependencyError: class SalesIntakeDependencyError extends Error {},
  SALES_PAUSE_MESSAGE: "Orders are temporarily paused. Please check back soon.",
}));
vi.mock("@/server/order-management-capability", () => ({
  bindOrderManagementCapability: mocks.bindOrderManagementCapability,
}));
vi.mock("@/server/variant-mapping", () => ({
  revalidateCartLineCapability: mocks.revalidateCartLineCapability,
  PrintAssetsPendingError: class PrintAssetsPendingError extends Error {},
}));

import { PrintAssetsPendingError } from "@/server/variant-mapping";

import { GET } from "@/app/checkout/route";

describe("checkout handoff", () => {
  beforeEach(() => {
    mocks.assertSalesIntakeOpen.mockReset();
    mocks.assertSalesIntakeOpen.mockResolvedValue(undefined);
    mocks.getCartData.mockReset();
    mocks.ensureCheckoutArtworkNote.mockReset();
    mocks.ensureCheckoutArtworkNote.mockResolvedValue("https://checkout.example.com/cart/one");
    mocks.bindOrderManagementCapability.mockReset();
    mocks.bindOrderManagementCapability.mockResolvedValue(undefined);
    mocks.revalidateCartLineCapability.mockReset();
    mocks.revalidateCartLineCapability.mockResolvedValue(undefined);
    mocks.getCartData.mockResolvedValue({
      cart: {
        attributes: [{ key: "campaign", value: "summer" }],
        checkoutUrl: "https://checkout.example.com/cart/one",
        id: "gid://shopify/Cart/one?key=secret",
        lines: {
          nodes: [{
            id: "gid://shopify/CartLine/one",
            attributes: [
              { key: "_productId", value: "configured-product" },
              { key: "_lineCapability", value: "signed-capability" },
            ],
            merchandise: { id: "gid://shopify/ProductVariant/one" },
            quantity: 2,
          }],
        },
        totalQuantity: 1,
      },
    });
  });

  it("redirects an open cart to Shopify checkout", async () => {
    const response = await GET(new Request("https://shop.example/checkout"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://checkout.example.com/cart/one",
    );
    expect(mocks.revalidateCartLineCapability).toHaveBeenCalledWith(
      "signed-capability",
      "configured-product",
      "gid://shopify/ProductVariant/one",
      2,
    );
    expect(mocks.bindOrderManagementCapability).toHaveBeenCalledWith(
      "gid://shopify/Cart/one?key=secret",
      [{ key: "campaign", value: "summer" }],
    );
    expect(mocks.revalidateCartLineCapability).toHaveBeenCalledBefore(mocks.ensureCheckoutArtworkNote);
    expect(mocks.ensureCheckoutArtworkNote).toHaveBeenCalledBefore(mocks.bindOrderManagementCapability);
  });

  it("blocks direct checkout while artwork is pending without losing the cart", async () => {
    mocks.revalidateCartLineCapability.mockRejectedValue(new PrintAssetsPendingError("Your artwork is still being prepared. Checkout will be available shortly."));
    const response = await GET(new Request("https://shop.example/checkout"));
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("cartError")).toContain("still being prepared");
    expect(mocks.ensureCheckoutArtworkNote).not.toHaveBeenCalled();
    expect(mocks.bindOrderManagementCapability).not.toHaveBeenCalled();
  });

  it("persists a verified final capability before handing the cart to Shopify", async () => {
    mocks.revalidateCartLineCapability.mockResolvedValue("v1.ready.signature");
    const response = await GET(new Request("https://shop.example/checkout"));
    expect(response.status).toBe(307);
    expect(mocks.ensureCheckoutArtworkNote).toHaveBeenCalledWith(expect.anything(), new Map([["gid://shopify/CartLine/one", "v1.ready.signature"]]));
    expect(mocks.ensureCheckoutArtworkNote).toHaveBeenCalledBefore(mocks.bindOrderManagementCapability);
  });

  it("returns to the cart with the pause message", async () => {
    mocks.assertSalesIntakeOpen.mockRejectedValue(new Error("paused"));
    const response = await GET(new Request("https://shop.example/checkout"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://shop.example/cart?cartError=Orders+are+temporarily+paused.+Please+check+back+soon.",
    );
    expect(mocks.getCartData).not.toHaveBeenCalled();
    expect(mocks.ensureCheckoutArtworkNote).not.toHaveBeenCalled();
  });

  it("returns to the cart when a signed line no longer matches", async () => {
    mocks.revalidateCartLineCapability.mockRejectedValue(new Error("invalid"));
    const response = await GET(new Request("https://shop.example/checkout"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://shop.example/cart?cartError=One+or+more+cart+items+changed.+Review+your+cart+and+try+again.",
    );
    expect(mocks.ensureCheckoutArtworkNote).not.toHaveBeenCalled();
  });

  it("uses the refreshed checkout URL after adding the artwork explanation", async () => {
    mocks.ensureCheckoutArtworkNote.mockResolvedValue("https://checkout.example.com/cart/refreshed");
    const response = await GET(new Request("https://shop.example/checkout"));
    expect(response.headers.get("location")).toBe("https://checkout.example.com/cart/refreshed");
  });

  it("keeps the customer in their cart if the artwork explanation cannot be saved", async () => {
    mocks.ensureCheckoutArtworkNote.mockRejectedValue(new Error("unavailable"));
    const response = await GET(new Request("https://shop.example/checkout"));
    expect(response.status).toBe(303);
    expect(mocks.bindOrderManagementCapability).not.toHaveBeenCalled();
  });

  it("returns to the cart when Shopify cannot bind the order capability", async () => {
    mocks.bindOrderManagementCapability.mockRejectedValue(new Error("down"));
    const response = await GET(new Request("https://shop.example/checkout"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://shop.example/cart?cartError=One+or+more+cart+items+changed.+Review+your+cart+and+try+again.",
    );
  });
});
