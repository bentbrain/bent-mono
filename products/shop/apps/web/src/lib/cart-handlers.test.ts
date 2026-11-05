import {
  createCartCookie,
  createShopifyRequestContext,
  createStorefrontClient,
} from "@shopify/hydrogen";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCartProductContext } from "@/server/cart-product-context";
import type * as CartProgram from "@/server/cart-program";
import { CHECKOUT_ARTWORK_NOTE } from "@/lib/checkout-artwork-note";

const mocks = vi.hoisted(() => ({
  assertMappedVariantAvailable: vi.fn(),
  assertSalesIntakeOpen: vi.fn(),
  issueCartLineCapability: vi.fn(),
  resolveProductLine: vi.fn(),
}));

vi.mock("@/server/cart-program", () => ({
  resolveVerifiedProductLine: mocks.resolveProductLine,
}));
vi.mock("@/env", () => ({ env: { FOREVER_TEE_API_URL: "https://api.example" } }));
vi.mock("@/server/cart-product-context", () => ({ getCartProductContext: vi.fn() }));
vi.mock("@/server/sales-intake", () => ({
  assertSalesIntakeOpen: mocks.assertSalesIntakeOpen,
  SalesIntakeDependencyError: class SalesIntakeDependencyError extends Error {},
}));
vi.mock("@/server/variant-mapping", () => ({
  assertMappedVariantAvailable: mocks.assertMappedVariantAvailable,
  issueCartLineCapability: mocks.issueCartLineCapability,
  VariantMappingDependencyError: class VariantMappingDependencyError extends Error {},
  VariantUnavailableError: class VariantUnavailableError extends Error {},
}));

import { cartHandlers } from "@/lib/cart-handlers";

const CART_ID = "gid://shopify/Cart/cart-one";
const LINE_ID = "gid://shopify/CartLine/line-one";
const LINE_TWO_ID = "gid://shopify/CartLine/line-two";
const PRODUCT_ID = "gid://shopify/Product/base-product";
const VARIANT_ID = "gid://shopify/ProductVariant/variant-one";
const PRODUCT_RECORD_ID = "configured-product-public-id";
const RESOLVED_ATTRIBUTES = [
  { key: "_productId", value: PRODUCT_RECORD_ID },
  { key: "_designId", value: "design-id" },
  { key: "_artworkUrl", value: "https://api.example/artwork" },
];
const VERIFIED_ATTRIBUTES = [
  ...RESOLVED_ATTRIBUTES,
  { key: "_lineCapability", value: "signed-line-capability" },
];

interface GraphqlCall {
  readonly query: string;
  readonly variables: Record<string, unknown>;
}

interface HarnessOptions {
  readonly delayMs?: number;
  readonly availableForSale?: boolean;
  readonly missingExistingCart?: boolean;
  readonly updateUserErrors?: readonly {
    readonly field?: readonly string[];
    readonly message: string;
  }[];
}

describe("cartHandlers.post", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.mocked(getCartProductContext).mockReset();
    mocks.assertMappedVariantAvailable.mockReset();
    mocks.assertMappedVariantAvailable.mockResolvedValue(undefined);
    mocks.issueCartLineCapability.mockReset();
    mocks.issueCartLineCapability.mockResolvedValue("signed-line-capability");
    mocks.assertSalesIntakeOpen.mockReset();
    mocks.assertSalesIntakeOpen.mockResolvedValue(undefined);
    mocks.resolveProductLine.mockReset();
    mocks.resolveProductLine.mockImplementation(() =>
      Effect.succeed({
        attributes: RESOLVED_ATTRIBUTES,
        baseShopifyHandle: "base-shirt",
        designId: "design-id",
      })
    );
  });

  it("returns a Hydrogen cart error for a mismatched client cart ID", async () => {
    const harness = createStorefrontHarness();
    const request = jsonCartRequest({
      cartId: "gid://shopify/Cart/other",
      lines: [{
        attributes: [{ key: "_productId", value: PRODUCT_RECORD_ID }],
        merchandiseId: VARIANT_ID,
        quantity: 1,
      }],
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result.type).toBe("json");
    if (result.type !== "json") throw new Error("Expected a JSON cart result.");
    expect(new Headers(result.headers).get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.data).toEqual({
      detail: { requestId: new Headers(result.headers).get("x-request-id") },
      cart: oneLineCart(),
      userErrors: [{
        code: "INVALID_CART_PRODUCT",
        message: "The requested cart does not match this browser.",
      }],
      warnings: [],
    });
    expect(harness.calls).toHaveLength(1);
  });

  it("returns a line-scoped Hydrogen error for a missing owned line", async () => {
    const harness = createStorefrontHarness();
    const request = jsonCartRequest({
      lines: [{
        id: "gid://shopify/CartLine/missing",
        quantity: 2,
      }],
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result.type).toBe("json");
    if (result.type !== "json") throw new Error("Expected a JSON cart result.");
    expect(new Headers(result.headers).get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.data).toEqual({
      detail: { requestId: new Headers(result.headers).get("x-request-id") },
      cart: oneLineCart(),
      userErrors: [{
        code: "INVALID_CART_PRODUCT",
        field: ["lines", "0"],
        message: "The requested cart line does not exist.",
      }],
      warnings: [],
    });
  });

  it("rebuilds variant-update variables and memoizes duplicate verification reads", async () => {
    const harness = createStorefrontHarness(twoLineCart());
    const request = jsonCartRequest({
      lines: [
        {
          attributes: [{ key: "_designId", value: "forged" }],
          id: LINE_ID,
          merchandiseId: VARIANT_ID,
          quantity: 2,
        },
        {
          attributes: [{ key: "_productId", value: "forged" }],
          id: LINE_TWO_ID,
          merchandiseId: VARIANT_ID,
          quantity: 3,
        },
      ],
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result.type).toBe("json");
    expect(mocks.resolveProductLine).toHaveBeenCalledOnce();
    expect(harness.calls.filter(({ query }) =>
      query.includes("ForeverTeeCartVariantIntegrity")
    )).toHaveLength(1);
    const update = harness.calls.find(({ query }) =>
      query.includes("ForeverTeeCartLineVariantUpdate")
    );
    expect(update?.variables).toEqual({
      cartId: CART_ID,
      country: "AU",
      language: "EN",
      lines: [
        {
          attributes: [
            { key: "Gift note", value: "Keep" },
            ...VERIFIED_ATTRIBUTES,
          ],
          id: LINE_ID,
          merchandiseId: VARIANT_ID,
          quantity: 2,
        },
        {
          attributes: VERIFIED_ATTRIBUTES,
          id: LINE_TWO_ID,
          merchandiseId: VARIANT_ID,
          quantity: 3,
        },
      ],
    });
    const headers = new Headers(result.headers);
    expect(headers.get("set-cookie")).toBe("upstream=kept");
    expect(headers.get("content-encoding")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("transfer-encoding")).toBeNull();
  });

  it("redirects a failed native form to a visible cart error", async () => {
    const harness = createStorefrontHarness();
    const request = nativeCartRequest({
      intent: "set",
      lineId: "gid://shopify/CartLine/missing",
      quantity: "2",
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result.type).toBe("redirect");
    if (result.type !== "redirect") {
      throw new Error("Expected a native redirect result.");
    }
    expect(result.location).toContain("/cart?cartError=");
    expect(decodeURIComponent(result.location)).toContain(
      "The requested cart line does not exist.",
    );
  });

  it("sanitizes native quantities and preserves redirect mutation headers", async () => {
    const harness = createStorefrontHarness();
    const request = nativeCartRequest({
      intent: "increase",
      lineId: LINE_ID,
      quantity: "99",
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result.type).toBe("redirect");
    if (result.type !== "redirect") {
      throw new Error("Expected a native redirect result.");
    }
    expect(result.location).toBe("/cart");
    const headers = new Headers(result.headers);
    expect(headers.get("set-cookie")).toBe("upstream=kept");
    expect(headers.get("content-encoding")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("transfer-encoding")).toBeNull();
    const update = harness.calls.find(({ query }) =>
      query.includes("ForeverTeeCartLineVariantUpdate")
    );
    expect(update?.variables).toEqual({
      cartId: CART_ID,
      country: "AU",
      language: "EN",
      lines: [{
        attributes: [
          { key: "Gift note", value: "Keep" },
          ...VERIFIED_ATTRIBUTES,
        ],
        id: LINE_ID,
        merchandiseId: VARIANT_ID,
        quantity: 2,
      }],
    });
  });

  it("removes an owned line when its configured product was deleted", async () => {
    mocks.resolveProductLine.mockImplementation(() =>
      Effect.fail(new Error("Configured product was deleted."))
    );
    const harness = createStorefrontHarness();
    const request = nativeCartRequest({
      intent: "remove",
      lineId: LINE_ID,
      quantity: "1",
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result.type).toBe("redirect");
    expect(mocks.resolveProductLine).not.toHaveBeenCalled();
    expect(harness.calls.some(({ query }) =>
      query.includes("ForeverTeeCartVariantIntegrity")
    )).toBe(false);
  });

  it("removes an owned line without checking unavailable merchandise", async () => {
    const harness = createStorefrontHarness(oneLineCart(), {
      availableForSale: false,
    });
    const request = nativeCartRequest({
      intent: "remove",
      lineId: LINE_ID,
      quantity: "1",
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result.type).toBe("redirect");
    expect(harness.calls.some(({ query }) =>
      query.includes("ForeverTeeCartVariantIntegrity")
    )).toBe(false);
  });

  it("turns native decrease from one into an immediate removal", async () => {
    const harness = createStorefrontHarness();
    const request = nativeCartRequest({
      intent: "decrease",
      lineId: LINE_ID,
      quantity: "99",
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result.type).toBe("redirect");
    const removal = harness.calls.find(({ query }) =>
      query.includes("mutation CartLinesRemove")
    );
    expect(removal?.variables).toEqual({
      cartId: CART_ID,
      country: "AU",
      language: "EN",
      lineIds: [LINE_ID],
    });
    expect(mocks.resolveProductLine).not.toHaveBeenCalled();
  });

  it("redirects native Shopify user errors visibly and preserves headers", async () => {
    const harness = createStorefrontHarness(oneLineCart(), {
      updateUserErrors: [{
        field: ["lines", "0"],
        message: "That variant can no longer be selected.",
      }],
    });
    const request = nativeCartRequest({
      intent: "increase",
      lineId: LINE_ID,
      quantity: "1",
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result.type).toBe("redirect");
    if (result.type !== "redirect") {
      throw new Error("Expected a native redirect result.");
    }
    expect(decodeURIComponent(result.location)).toContain(
      "That variant can no longer be selected.",
    );
    expect(new Headers(result.headers).get("set-cookie")).toBe("upstream=kept");
  });

  it("allows anonymous purchase of a public configured product and keeps new-cart cookies", async () => {
    const harness = createStorefrontHarness();
    const request = jsonCartRequest({
      lines: [{
        attributes: [{ key: "_productId", value: PRODUCT_RECORD_ID }],
        merchandiseId: VARIANT_ID,
        quantity: 1,
      }],
    });

    const result = await cartHandlers.post(harness.context(request));

    expect(result.type).toBe("json");
    expect(mocks.resolveProductLine).toHaveBeenCalledWith(PRODUCT_RECORD_ID);
    const create = harness.calls.find(({ query }) =>
      query.includes("mutation CartCreate")
    );
    expect(create?.variables).toEqual({
      country: "AU",
      input: {
        lines: [{
          attributes: VERIFIED_ATTRIBUTES,
          merchandiseId: VARIANT_ID,
          quantity: 1,
        }],
      },
      language: "EN",
    });
    const setCookie = new Headers(result.headers).get("set-cookie");
    expect(setCookie).toContain("upstream=kept");
    expect(setCookie).toContain("cart=cart-one");
    expect(new Headers(result.headers).get("content-encoding")).toBeNull();
    expect(new Headers(result.headers).get("content-length")).toBeNull();
  });

  it("confirms an add through the real resolver with equivalent provider delays", async () => {
    const actual = await vi.importActual<typeof CartProgram>("@/server/cart-program");
    const configuredId = "00000000-0000-4000-8000-000000000002";
    const designId = "00000000-0000-4000-8000-000000000003";
    vi.useFakeTimers();
    const delay = () => new Promise<void>(resolve => setTimeout(resolve, 100));
    vi.mocked(getCartProductContext).mockReturnValue(Effect.succeed({
      productId: configuredId, designId, baseShopifyHandle: "base-shirt",
    }).pipe(Effect.delay(100)));
    mocks.resolveProductLine.mockImplementation(actual.resolveVerifiedProductLine);
    mocks.assertSalesIntakeOpen.mockImplementation(delay);
    mocks.assertMappedVariantAvailable.mockImplementation(delay);
    mocks.issueCartLineCapability.mockImplementation(async () => { await delay(); return "signed-line-capability"; });
    const harness = createStorefrontHarness(oneLineCart(), { delayMs: 100 });
    const request = jsonCartRequest({ lines: [{
      attributes: [{ key: "_productId", value: configuredId }],
      merchandiseId: VARIANT_ID, quantity: 1,
    }] });
    const start = Date.now();
    const pending = cartHandlers.post(harness.context(request)).then(result => ({ result, elapsed: Date.now() - start }));
    await vi.runAllTimersAsync();
    const { result, elapsed } = await pending;
    expect(result.type).toBe("json");
    if (result.type !== "json") throw new Error("Expected a confirmed cart.");
    expect(result.data).toMatchObject({ cart: { id: CART_ID }, userErrors: [] });
    expect(new Headers(result.headers).get("set-cookie")).toContain("cart=cart-one");
    expect(getCartProductContext).toHaveBeenCalledOnce();
    expect(mocks.assertSalesIntakeOpen).toHaveBeenCalledOnce();
    expect(mocks.assertMappedVariantAvailable).toHaveBeenCalledWith(VARIANT_ID, "base-shirt");
    expect(mocks.issueCartLineCapability).toHaveBeenCalledWith(configuredId, VARIANT_ID, 1);
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0]?.query).toContain("ForeverTeeCartVariantIntegrity");
    expect(harness.calls[1]?.query).toContain("mutation CartCreate");
    expect(harness.calls[1]?.variables).toMatchObject({ input: { lines: [{
      attributes: [
        CHECKOUT_ARTWORK_NOTE,
        { key: "_productId", value: configuredId },
        { key: "_designId", value: designId },
        { key: "_artworkUrl", value: `https://api.example/v1/designs/${designId}/artwork` },
        { key: "_lineCapability", value: "signed-line-capability" },
      ],
    }] } });
    const providerCalls = vi.mocked(getCartProductContext).mock.calls.length +
      mocks.assertSalesIntakeOpen.mock.calls.length +
      mocks.assertMappedVariantAvailable.mock.calls.length +
      mocks.issueCartLineCapability.mock.calls.length + harness.calls.length;
    console.info("Cart confirmation fixture", JSON.stringify({ elapsed, providerCalls }));
    expect(providerCalls).toBe(6);
    expect(elapsed).toBe(600);
  });

  it("increments an existing matching configured product instead of adding a duplicate line", async () => {
    const harness = createStorefrontHarness();
    const request = jsonCartRequest({
      cartId: CART_ID,
      lines: [{
        attributes: [{ key: "_productId", value: PRODUCT_RECORD_ID }],
        merchandiseId: VARIANT_ID,
        quantity: 1,
      }],
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result.type).toBe("json");
    expect(harness.calls.some(({ query }) =>
      query.includes("mutation CartLinesAdd")
    )).toBe(false);
    const update = harness.calls.find(({ query }) =>
      query.includes("ForeverTeeCartLineVariantUpdate")
    );
    expect(update?.variables).toEqual({
      cartId: CART_ID,
      country: "AU",
      language: "EN",
      lines: [{
        attributes: [
          { key: "Gift note", value: "Keep" },
          ...VERIFIED_ATTRIBUTES,
        ],
        id: LINE_ID,
        merchandiseId: VARIANT_ID,
        quantity: 2,
      }],
    });
  });

  it("consolidates existing matching configured-product lines on add", async () => {
    const harness = createStorefrontHarness(twoLineCart());
    const request = jsonCartRequest({
      cartId: CART_ID,
      lines: [{
        attributes: [{ key: "_productId", value: PRODUCT_RECORD_ID }],
        merchandiseId: VARIANT_ID,
        quantity: 1,
      }],
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result.type).toBe("json");
    expect(harness.calls.some(({ query }) =>
      query.includes("mutation CartLinesAdd")
    )).toBe(false);
    const update = harness.calls.find(({ query }) =>
      query.includes("ForeverTeeCartLineVariantUpdate")
    );
    expect(update?.variables).toMatchObject({
      cartId: CART_ID,
      lines: [{
        id: LINE_ID,
        quantity: 3,
      }, { id: LINE_TWO_ID, quantity: 0 }],
    });
    expect(harness.calls.some(({ query }) =>
      query.includes("mutation CartLinesRemove")
    )).toBe(false);
  });

  it("consolidates a size change into the matching configured-product line", async () => {
    const cart = twoLineCart();
    const first = cart.lines.nodes[0];
    const second = cart.lines.nodes[1];
    if (!first || !second) throw new Error("Expected two cart lines.");
    first.attributes = VERIFIED_ATTRIBUTES;
    second.merchandise.id = "gid://shopify/ProductVariant/large";
    const harness = createStorefrontHarness(cart);
    const result = await cartHandlers.post(harness.context(jsonCartRequest({
      lines: [{ id: LINE_TWO_ID, merchandiseId: VARIANT_ID, quantity: 1 }],
    }, CART_ID)));

    expect(result.type).toBe("json");
    expect(harness.calls.find(({ query }) => query.includes("ForeverTeeCartLineVariantUpdate"))?.variables)
      .toMatchObject({ lines: [{ id: LINE_TWO_ID, quantity: 0 }, { id: LINE_ID, merchandiseId: VARIANT_ID, quantity: 2 }] });
    expect(mocks.issueCartLineCapability).toHaveBeenCalledWith(PRODUCT_RECORD_ID, VARIANT_ID, 2);
    expect(harness.calls.some(({ query }) => query.includes("mutation CartLinesRemove"))).toBe(false);
    expect(mocks.assertSalesIntakeOpen).not.toHaveBeenCalled();
  });

  it.each(["capability", "Shopify"])("does not remove a matching line when %s rejects consolidation", async (failure) => {
    const cart = twoLineCart();
    const first = cart.lines.nodes[0];
    const second = cart.lines.nodes[1];
    if (!first || !second) throw new Error("Expected two cart lines.");
    first.attributes = VERIFIED_ATTRIBUTES;
    second.merchandise.id = "gid://shopify/ProductVariant/large";
    if (failure === "capability") mocks.issueCartLineCapability.mockRejectedValue(new Error("Not available"));
    const harness = createStorefrontHarness(cart, failure === "Shopify"
      ? { updateUserErrors: [{ field: ["lines", "0"], message: "Not available" }] }
      : {});

    const result = await cartHandlers.post(harness.context(jsonCartRequest({
      lines: [{ id: LINE_TWO_ID, merchandiseId: VARIANT_ID, quantity: 1 }],
    }, CART_ID)));

    expect(result).toMatchObject({ type: "json", data: { userErrors: [{ message: "Not available" }] } });
    expect(harness.calls.some(({ query }) => query.includes("mutation CartLinesRemove"))).toBe(false);
  });

  it("replaces a cart that retained invalid zero-quantity lines", async () => {
    const harness = createStorefrontHarness(zeroLineCart());
    const request = jsonCartRequest({
      cartId: CART_ID,
      lines: [{
        attributes: [{ key: "_productId", value: PRODUCT_RECORD_ID }],
        merchandiseId: VARIANT_ID,
        quantity: 1,
      }],
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result.type).toBe("json");
    expect(harness.calls.some(({ query }) =>
      query.includes("mutation CartLinesAdd")
    )).toBe(false);
    expect(harness.calls.some(({ query }) =>
      query.includes("mutation CartCreate")
    )).toBe(true);
    expect(new Headers(result.headers).get("set-cookie")).toContain(
      "cart=cart-one",
    );
  });

  it("blocks new cart lines while sales are paused", async () => {
    mocks.assertSalesIntakeOpen.mockRejectedValue(
      new Error("Orders are temporarily paused. Please check back soon."),
    );
    const harness = createStorefrontHarness(emptyCart());
    const request = jsonCartRequest({
      lines: [{
        attributes: [{ key: "_productId", value: PRODUCT_RECORD_ID }],
        merchandiseId: VARIANT_ID,
        quantity: 1,
      }],
    });

    const result = await cartHandlers.post(harness.context(request));

    expect(result).toMatchObject({
      data: {
        cart: emptyCart(),
        userErrors: [{
          code: "INVALID_CART_PRODUCT",
          field: ["lines", "0"],
          message: "Orders are temporarily paused. Please check back soon.",
        }],
      },
      type: "json",
    });
    expect(harness.calls).toContainEqual(expect.objectContaining({
      variables: {
        country: "AU",
        input: {},
        language: "EN",
      },
    }));
  });

  it("replaces a missing cookie cart when an add request is rejected", async () => {
    mocks.assertSalesIntakeOpen.mockRejectedValue(
      new Error("Orders are temporarily paused. Please check back soon."),
    );
    const harness = createStorefrontHarness(oneLineCart(), {
      missingExistingCart: true,
    });
    const request = jsonCartRequest({
      cartId: CART_ID,
      lines: [{
        attributes: [{ key: "_productId", value: PRODUCT_RECORD_ID }],
        merchandiseId: VARIANT_ID,
        quantity: 1,
      }],
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result).toMatchObject({
      data: {
        cart: recoveryCart(),
        userErrors: [{
          code: "INVALID_CART_PRODUCT",
          field: ["lines", "0"],
          message: "Orders are temporarily paused. Please check back soon.",
        }],
      },
      type: "json",
    });
    expect(new Headers(result.headers).get("set-cookie")).toContain(
      "cart=recovery-cart",
    );
    expect(harness.calls.some(({ query }) =>
      query.includes("ForeverTeeEmptyCartCreate")
    )).toBe(true);
  });

  it("replaces a missing cookie cart during the same successful add", async () => {
    const harness = createStorefrontHarness(oneLineCart(), {
      missingExistingCart: true,
    });
    const request = jsonCartRequest({
      cartId: CART_ID,
      lines: [{
        attributes: [{ key: "_productId", value: PRODUCT_RECORD_ID }],
        merchandiseId: VARIANT_ID,
        quantity: 1,
      }],
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result).toMatchObject({
      data: {
        cart: oneLineCart(),
        userErrors: [],
      },
      type: "json",
    });
    expect(harness.calls.some(({ query }) =>
      query.includes("mutation CartCreate")
    )).toBe(true);
    expect(harness.calls.some(({ query }) =>
      query.includes("mutation CartLinesAdd")
    )).toBe(false);
  });

  it("blocks quantity increases while sales are paused", async () => {
    mocks.assertSalesIntakeOpen.mockRejectedValue(
      new Error("Orders are temporarily paused. Please check back soon."),
    );
    const harness = createStorefrontHarness();
    const request = jsonCartRequest({
      lines: [{ id: LINE_ID, quantity: 2 }],
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result).toMatchObject({
      data: {
        userErrors: [{
          message: "Orders are temporarily paused. Please check back soon.",
        }],
      },
      type: "json",
    });
    expect(harness.calls.some(({ query }) =>
      query.includes("ForeverTeeCartLineVariantUpdate")
    )).toBe(false);
  });

  it("still allows line removal while sales are paused", async () => {
    mocks.assertSalesIntakeOpen.mockRejectedValue(new Error("paused"));
    const harness = createStorefrontHarness();
    const request = jsonCartRequest({
      lines: [{ id: LINE_ID, quantity: 0 }],
    }, CART_ID);

    const result = await cartHandlers.post(harness.context(request));

    expect(result.type).toBe("json");
    expect(mocks.assertSalesIntakeOpen).not.toHaveBeenCalled();
    expect(harness.calls.some(({ query }) =>
      query.includes("mutation CartLinesRemove")
    )).toBe(true);
  });
});

function createStorefrontHarness(
  cart = oneLineCart(),
  options: HarnessOptions = {},
) {
  const calls: GraphqlCall[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const body = await graphqlBody(request);
    calls.push(body);
    if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
    return new Response(JSON.stringify({
      data: graphqlData(body.query, cart, options),
    }), {
      headers: {
        "content-encoding": "br",
        "content-length": "999",
        "content-type": "application/json",
        "set-cookie": "upstream=kept",
        "transfer-encoding": "chunked",
      },
    });
  });
  const requestContext = createShopifyRequestContext({
    request: new Request("https://shirt.example"),
    i18n: { country: "AU", language: "EN" },
  });
  const client = createStorefrontClient({
    type: "public",
    requestContext,
    config: {
      fetch: fetchMock,
      publicStorefrontToken: "public-token",
      storeDomain: "example.myshopify.com",
    },
  });
  const sessionItems = new Map<string, unknown>();
  return {
    calls,
    client,
    context(request: Request) {
      return {
        request,
        requestContext,
        sessionManager: {
          getSessionItem(key: string) {
            return sessionItems.get(key);
          },
          getSessionOrigin() {
            return "https://shirt.example";
          },
          removeSessionItem(key: string) {
            sessionItems.delete(key);
          },
          setSessionItem(key: string, value: unknown) {
            sessionItems.set(key, value);
          },
        },
        storefrontClient: client,
      };
    },
  };
}

async function graphqlBody(request: Request): Promise<GraphqlCall> {
  const parsed: unknown = JSON.parse(await request.text());
  if (!isRecord(parsed) || typeof parsed["query"] !== "string") {
    throw new Error("Expected a GraphQL request body.");
  }
  return {
    query: parsed["query"],
    variables: isRecord(parsed["variables"]) ? parsed["variables"] : {},
  };
}

function graphqlData(
  query: string,
  cart: ReturnType<typeof oneLineCart>,
  options: HarnessOptions,
) {
  if (query.includes("ForeverTeeCartIntegrity")) {
    return { cart: options.missingExistingCart ? null : cart };
  }
  if (query.includes("query Cart")) {
    return { cart: options.missingExistingCart ? null : cart };
  }
  if (query.includes("ForeverTeeCartVariantIntegrity")) {
    return {
      baseProduct: { id: PRODUCT_ID },
      merchandise: {
        __typename: "ProductVariant",
        availableForSale: options.availableForSale ?? true,
        id: VARIANT_ID,
        product: { id: PRODUCT_ID, requiresSellingPlan: false },
        sellingPlanAllocations: { nodes: [] },
      },
    };
  }
  if (query.includes("ForeverTeeCartLineVariantUpdate")) {
    return mutationData(
      "cartLinesUpdate",
      cart,
      options.updateUserErrors ?? [],
    );
  }
  if (query.includes("mutation CartLinesUpdate")) {
    return mutationData("cartLinesUpdate", cart);
  }
  if (query.includes("mutation CartLinesAdd")) {
    return mutationData("cartLinesAdd", cart);
  }
  if (query.includes("mutation CartLinesRemove")) {
    return mutationData("cartLinesRemove", cart);
  }
  if (query.includes("mutation CartCreate")) {
    return mutationData("cartCreate", cart);
  }
  if (query.includes("ForeverTeeEmptyCartCreate")) {
    return mutationData(
      "cartCreate",
      options.missingExistingCart ? recoveryCart() : cart,
    );
  }
  throw new Error("Unexpected GraphQL operation.");
}

function mutationData(
  key: string,
  cart: ReturnType<typeof oneLineCart>,
  userErrors: HarnessOptions["updateUserErrors"] = [],
) {
  return {
    [key]: { cart, userErrors, warnings: [] },
  };
}

function oneLineCart() {
  return {
    id: CART_ID,
    lines: {
      nodes: [{
        attributes: [
          { key: "Gift note", value: "Keep" },
          ...VERIFIED_ATTRIBUTES,
        ],
        id: LINE_ID,
        merchandise: { __typename: "ProductVariant", id: VARIANT_ID },
        quantity: 1,
        sellingPlanAllocation: null,
      }],
    },
    totalQuantity: 1,
  };
}

function twoLineCart() {
  const first = oneLineCart();
  return {
    ...first,
    lines: {
      nodes: [
        ...first.lines.nodes,
        {
          attributes: VERIFIED_ATTRIBUTES,
          id: LINE_TWO_ID,
          merchandise: { __typename: "ProductVariant", id: VARIANT_ID },
          quantity: 1,
          sellingPlanAllocation: null,
        },
      ],
    },
    totalQuantity: 2,
  };
}

function emptyCart() {
  return {
    id: CART_ID,
    lines: { nodes: [] },
    totalQuantity: 0,
  };
}

function recoveryCart() {
  return {
    ...emptyCart(),
    id: "gid://shopify/Cart/recovery-cart",
  };
}

function zeroLineCart() {
  const cart = oneLineCart();
  return {
    ...cart,
    lines: {
      nodes: cart.lines.nodes.map((line) => ({ ...line, quantity: 0 })),
    },
    totalQuantity: 0,
  };
}

function jsonCartRequest(payload: unknown, cartId?: string) {
  return new Request("https://shirt.example/api/cart", {
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
      ...(cartId ? { cookie: cartCookie(cartId) } : {}),
    },
    method: "POST",
  });
}

function nativeCartRequest(
  fields: Record<string, string>,
  cartId: string,
) {
  return new Request("https://shirt.example/api/cart", {
    body: new URLSearchParams(fields),
    headers: {
      cookie: cartCookie(cartId),
      referer: "https://shirt.example/cart?cartError=Previous%20failure",
    },
    method: "POST",
  });
}

function cartCookie(cartId: string) {
  return createCartCookie(cartId).split(";", 1)[0] ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
