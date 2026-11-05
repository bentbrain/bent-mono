import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ graphql: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/storefront", () => ({
  getStorefrontClient: () => Promise.resolve({ graphql: mocks.graphql }),
}));

import { CHECKOUT_ARTWORK_NOTE } from "@/lib/checkout-artwork-note";
import { ensureCheckoutArtworkNote } from "@/server/checkout-artwork-note";

const originalAttributes = [
  { key: "_productId", value: "configured-product" },
  { key: "_designId", value: "saved-design" },
  { key: "_artworkUrl", value: "https://api.example/artwork" },
  { key: "_lineCapability", value: "signed-capability" },
  { key: "Gift note", value: "Keep this" },
];
const cart = {
  id: "cart-id",
  checkoutUrl: "https://checkout.example/original",
  lines: { nodes: [{ id: "line-id", quantity: 1, merchandise: { id: "variant-id" }, attributes: originalAttributes }] },
};
const updatedLine = {
  id: "line-id",
  quantity: 1, merchandise: { id: "variant-id" },
  attributes: [...originalAttributes, CHECKOUT_ARTWORK_NOTE],
};
const updatedCart = {
  ...cart,
  checkoutUrl: "https://checkout.example/refreshed",
  lines: { nodes: [updatedLine] },
};

function updateResult(
  returnedCart: typeof updatedCart | null = updatedCart,
  userErrors: { message: string }[] = [],
  warnings: { message: string }[] = [],
) {
  return { data: { cartLinesUpdate: { cart: returnedCart, userErrors, warnings } } };
}

describe("checkout artwork explanation", () => {
  beforeEach(() => {
    mocks.graphql.mockReset();
    mocks.graphql.mockResolvedValue(updateResult());
  });

  it("backfills existing lines without changing merchandise, quantities or signed attributes", async () => {
    expect(await ensureCheckoutArtworkNote(cart)).toBe(updatedCart.checkoutUrl);
    expect(mocks.graphql).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      variables: { cartId: cart.id, lines: [{ id: updatedLine.id, attributes: updatedLine.attributes }] },
    });
  });

  it("does not mutate carts that already have the explanation", async () => {
    expect(await ensureCheckoutArtworkNote(updatedCart)).toBe(updatedCart.checkoutUrl);
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it("replaces stale or duplicate notes while preserving every other attribute", async () => {
    await ensureCheckoutArtworkNote({
      ...cart,
      lines: { nodes: [{
        id: "line-id",
        quantity: 1, merchandise: { id: "variant-id" },
        attributes: [
          ...originalAttributes,
          { key: "Artwork", value: "Wrong explanation" },
          CHECKOUT_ARTWORK_NOTE,
        ],
      }] },
    });
    expect(mocks.graphql).toHaveBeenCalledWith(expect.anything(), {
      variables: { cartId: cart.id, lines: [{ id: updatedLine.id, attributes: updatedLine.attributes }] },
    });
  });

  it("replaces the pending intent and verifies that Shopify persisted the final proof", async () => {
    const attributes = [...originalAttributes.filter(({ key }) => key !== "_lineCapability"), CHECKOUT_ARTWORK_NOTE, { key: "_lineCapability", value: "v1.ready.signature" }];
    mocks.graphql.mockResolvedValue(updateResult({ ...updatedCart, lines: { nodes: [{ ...updatedLine, attributes }] } }));
    expect(await ensureCheckoutArtworkNote(updatedCart, new Map([["line-id", "v1.ready.signature"]]))).toBe(updatedCart.checkoutUrl);
    expect(mocks.graphql).toHaveBeenCalledWith(expect.anything(), { variables: { cartId: cart.id, lines: [{ id: "line-id", attributes }] } });
    mocks.graphql.mockResolvedValue(updateResult());
    await expect(ensureCheckoutArtworkNote(updatedCart, new Map([["line-id", "v1.ready.signature"]]))).rejects.toThrow();
  });

  it("blocks checkout if a concurrent cart edit changes quantity during finalization", async () => {
    mocks.graphql.mockResolvedValue(updateResult({ ...updatedCart, lines: { nodes: [{ ...updatedLine, quantity: 2 }] } }));
    await expect(ensureCheckoutArtworkNote(cart)).rejects.toThrow();
  });

  it.each([
    { errors: [{ message: "unavailable" }] },
    updateResult(null),
    updateResult(updatedCart, [{ message: "rejected" }]),
    updateResult(updatedCart, [], [{ message: "line adjusted" }]),
    updateResult({ ...updatedCart, id: "another-cart" }),
    updateResult({ ...updatedCart, lines: { nodes: [] } }),
    updateResult({ ...updatedCart, lines: { nodes: [{ ...updatedLine, attributes: [CHECKOUT_ARTWORK_NOTE] }] } }),
  ])("rejects an unsuccessful or incomplete Shopify update", async (result) => {
    mocks.graphql.mockResolvedValue(result);
    await expect(ensureCheckoutArtworkNote(cart)).rejects.toThrow("Checkout artwork note is unavailable");
  });
});
