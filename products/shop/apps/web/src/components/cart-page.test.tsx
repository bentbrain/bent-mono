// @vitest-environment happy-dom

import { createCartStore, type CartDataFromHandlers } from "@shopify/hydrogen";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CartContents, CartPage } from "@/components/cart-page";
import { CartProvider } from "@/lib/cart";
import type { cartHandlers } from "@/lib/cart-handlers";

type AppCartData = CartDataFromHandlers<typeof cartHandlers>;
type AppMoney = AppCartData["cost"]["subtotalAmount"];

const money: AppMoney = {
  amount: "70.00",
  currencyCode: "AUD",
};

const cart: AppCartData = {
  attributes: [],
  checkoutUrl: "https://checkout.example.com/cart",
  cost: {
    checkoutChargeAmount: money,
    subtotalAmount: money,
    totalAmount: money,
  },
  discountCodes: [],
  id: "gid://shopify/Cart/cart-id",
  lines: {
    nodes: [
      {
        attributes: [],
        cost: {
          amountPerQuantity: money,
          compareAtAmountPerQuantity: null,
          subtotalAmount: money,
          totalAmount: money,
        },
        id: "gid://shopify/CartLine/line-id",
        merchandise: {
          id: "gid://shopify/ProductVariant/variant-id",
          image: null,
          product: {
            handle: "forever-tee",
            id: "gid://shopify/Product/product-id",
            options: [
              {
                name: "Size",
                optionValues: [{ name: "M" }],
              },
            ],
            productType: "T-shirt",
            title: "bent.shop",
            vendor: "bent.shop",
            variants: {
              nodes: [
                {
                  availableForSale: true,
                  id: "gid://shopify/ProductVariant/variant-id",
                  selectedOptions: [{ name: "Size", value: "M" }],
                },
              ],
            },
          },
          selectedOptions: [{ name: "Size", value: "M" }],
          sku: null,
          title: "M",
        },
        quantity: 2,
      },
    ],
  },
  note: null,
  totalQuantity: 2,
};

describe("CartPage", () => {
  it("restores a pending artwork line and enables checkout only when preparation completes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let ready = false;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ ready }))));
    const pendingCart = structuredClone(cart);
    const line = pendingCart.lines.nodes[0];
    if (!line) throw new Error("Expected line");
    line.attributes = [{ key: "_productId", value: "saved-product" }, { key: "_lineCapability", value: "i1.persisted.signature" }];
    const client = new QueryClient();
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      // Seeded server state exercises refresh recovery, with no add request open.
      await act(async () => { root.render(<QueryClientProvider client={client}><CartProvider initialData={{ cart: pendingCart }}><CartContents layout="page" /></CartProvider></QueryClientProvider>); await Promise.resolve(); });
      expect(container.textContent).toContain("Preparing artwork");
      expect(container.querySelector('a[href="/checkout"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Increase quantity of bent.shop"]')?.hasAttribute("disabled")).toBe(false);
      ready = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
      expect(container.querySelector('a[href="/checkout"]')).not.toBeNull();
      expect(container.textContent).not.toContain("Preparing artwork");
    } finally {
      act(() => { root.unmount(); }); client.clear(); vi.useRealTimers(); vi.unstubAllGlobals();
    }
  });

  it("keeps a new design separate from the same variant while adding and on failure", async () => {
    const initial = structuredClone(cart);
    const existing = initial.lines.nodes[0];
    if (!existing) throw new Error("Expected cart fixture");
    existing.attributes = [{ key: "_productId", value: "existing-design-product" }];
    const store = createCartStore({ initialData: { cart: initial } });
    const completion = Promise.withResolvers<{ cart: null; userErrors: { message: string; field: string[] }[]; warnings: never[] }>();
    store.connect();
    try {
      document.dispatchEvent(Object.assign(new Event("shopify:cart:lines-update"), {
        action: "add",
        lines: [{ merchandiseId: existing.merchandise.id, quantity: 1,
          attributes: [{ key: "_productId", value: "new-design-product" }] }],
        detail: { products: [{ ...existing.merchandise, price: money }] },
        promise: completion.promise,
      }));
      const pending = store.getState().data.lines.nodes;
      expect.soft(pending).toHaveLength(2);
      expect.soft(pending[0]?.quantity).toBe(2);
      expect.soft(pending[1]).toMatchObject({ attributes: [{ key: "_productId", value: "new-design-product" }] });
    } finally {
      completion.resolve({ cart: null, userErrors: [{ message: "Artwork is still preparing", field: ["lines", "0"] }], warnings: [] });
      await completion.promise;
      await Promise.resolve();
      expect(store.getState().data.lines.nodes).toEqual(initial.lines.nodes);
      expect(store.getState().errors.lines.size).toBe(0);
      store.destroy();
    }
  });

  it("renders a recoverable native cart error", () => {
    const html = renderToStaticMarkup(
      <CartProvider initialData={{ cart }}>
        <CartPage initialError="That cart line is no longer available." />
      </CartProvider>,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("That cart line is no longer available.");
    expect(html).toContain("bent.shop");
  });

  it("server-renders resolved cart data and progressively enhanced line forms", () => {
    const html = renderToStaticMarkup(
      <CartProvider initialData={{ cart }}>
        <CartPage />
      </CartProvider>,
    );

    expect(html).toContain("bent.shop");
    expect(html).toContain("$70.00");
    expect(html).toContain("+ shipping");
    expect(html).toContain("$10.95");
    expect(html).toContain("(add $30.00 for free shipping)");
    expect(html).not.toMatch(/standard (delivery|shipping)/i);
    expect(html).not.toContain("Free when your discounted merchandise subtotal");
    expect(html).not.toContain("Shipping and taxes are calculated at checkout.");
    expect(html).toContain('<main class="flex-1 ');
    expect(html).not.toContain('<main class="min-h-dvh ');
    expect(html).toContain(
      '<h1 class="mt-2 text-[clamp(3rem,8vw,7rem)] leading-[0.9] tracking-[-0.07em]">Cart</h1>',
    );
    expect(html).toMatch(/<form[^>]*action="\/api\/cart"[^>]*method="post"/);
    expect(html).toMatch(
      /<input[^>]*type="number"[^>]*name="quantity"[^>]*value="2"/,
    );
    expect(html).toContain('aria-label="Quantity for bent.shop: 2"');
    expect(html).toMatch(
      /<button[^>]*value="set"[^>]*type="submit"[^>]*hidden=""[^>]*name="intent"/,
    );
    expect(html).toMatch(
      /<button[^>]*type="submit"[^>]*value="remove"[^>]*name="intent"/,
    );
    expect(html).toMatch(
      /<input[^>]*type="hidden"[^>]*name="lineId"[^>]*value="gid:\/\/shopify\/CartLine\/line-id"/,
    );
    expect(html).toMatch(
      /<button[^>]*type="submit"[^>]*value="decrease"[^>]*name="intent"/,
    );
    expect(html).toMatch(
      /<button[^>]*type="submit"[^>]*value="increase"[^>]*name="intent"/,
    );

    const container = document.createElement("div");
    container.innerHTML = html;
    const cartLine = container.querySelector("article");
    const lineDetails = cartLine?.querySelector('[data-cart-line-details]');
    const controls = cartLine?.querySelector("form");
    const optionRow = controls?.querySelector('[data-cart-line-options]');
    const summaryRow = controls?.querySelector('[data-cart-line-summary]');
    const quantity = optionRow?.querySelector('[role="group"]');
    const quantityInput = quantity?.querySelector<HTMLInputElement>(
      'input[name="quantity"]',
    );

    expect(cartLine?.querySelector("h2")).toBeNull();
    expect(lineDetails?.classList.contains("flex-col")).toBe(true);
    expect(controls?.classList.contains("flex-1")).toBe(true);
    expect(optionRow?.contains(quantity ?? null)).toBe(true);
    expect(summaryRow?.classList.contains("mt-auto")).toBe(true);
    expect(summaryRow?.classList.contains("items-end")).toBe(true);
    expect(summaryRow?.classList.contains("pt-3")).toBe(true);
    expect(summaryRow?.textContent).toContain("$70.00");
    expect(summaryRow?.textContent).toContain("Remove");
    expect(quantity?.textContent).toContain("2");
    expect(quantityInput?.classList.contains("sr-only")).toBe(true);
    expect(quantityInput?.getAttribute("aria-hidden")).toBe("true");
    expect(quantityInput?.tabIndex).toBe(-1);
  });

  it("uses the totals separator as the only border beneath the final overlay line", () => {
    const html = renderToStaticMarkup(
      <CartProvider initialData={{ cart }}>
        <CartContents layout="overlay" />
      </CartProvider>,
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    const lines = container.querySelector('[data-cart-lines]');

    expect(
      lines?.classList.contains("[&>article:last-child]:border-b-0"),
    ).toBe(true);
  });

  it("treats retained zero-quantity Shopify lines as an empty cart", () => {
    const invalidCart = structuredClone(cart);
    const line = invalidCart.lines.nodes[0];
    if (!line) throw new Error("Expected a cart line fixture.");
    line.quantity = 0;
    invalidCart.totalQuantity = 0;

    const html = renderToStaticMarkup(
      <CartProvider initialData={{ cart: invalidCart }}>
        <CartPage />
      </CartProvider>,
    );

    expect(html).toContain("Your cart is empty.");
    expect(html).not.toContain('name="quantity"');
    expect(html).not.toContain('href="/checkout"');
  });

  it("uses the canonical configured product image for tote lines", () => {
    const toteCart = structuredClone(cart);
    const line = toteCart.lines.nodes[0];
    if (!line) throw new Error("Expected a cart line fixture.");
    line.attributes = [
      { key: "_productId", value: "tote-product-id" },
      { key: "_designId", value: "design-id" },
      { key: "_artworkUrl", value: "https://api.example/artwork" },
    ];
    line.merchandise.product.handle = "cotton-tote";
    line.merchandise.product.title = "Cotton Tote";
    line.merchandise.selectedOptions = [
      { name: "Color", value: "Black" },
      { name: "Size", value: "One size" },
    ];
    const html = renderToStaticMarkup(
      <CartProvider initialData={{ cart: toteCart }}>
        <CartPage />
      </CartProvider>,
    );

    expect(html).toContain(
      "/api/configured-product-image/current/tote-product-id/black.webp",
    );
  });

  it("puts optimistic lines first with a directly loaded image in a square frame", () => {
    const optimisticCart = structuredClone(cart);
    const confirmedLine = optimisticCart.lines.nodes[0];
    if (!confirmedLine) throw new Error("Expected a cart line fixture.");
    const optimisticLine = structuredClone(confirmedLine);
    optimisticLine.id = "optimistic:gid://shopify/ProductVariant/tote-id";
    optimisticLine.merchandise.id = "gid://shopify/ProductVariant/tote-id";
    optimisticLine.merchandise.image = {
      altText: "Cream Cotton Tote with your artwork",
      height: 800,
      id: "optimistic-tote-image",
      url: "/api/configured-product-image/current/tote-product-id/cream.webp",
      width: 800,
    };
    optimisticLine.merchandise.product.title = "Cotton Tote";
    Reflect.deleteProperty(optimisticLine.merchandise.product, "variants");
    optimisticCart.lines.nodes.push(optimisticLine);

    const html = renderToStaticMarkup(
      <CartProvider initialData={{ cart: optimisticCart }}>
        <CartContents layout="overlay" />
      </CartProvider>,
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    const articles = [...container.querySelectorAll("article")];
    const optimisticImage = articles[0]?.querySelector("img");

    expect(articles[0]?.getAttribute("aria-label")).toBe("Cotton Tote");
    expect(optimisticImage?.getAttribute("src")).toBe(
      "/api/configured-product-image/current/tote-product-id/cream.webp",
    );
    expect(optimisticImage?.getAttribute("srcset")).toBeNull();
    expect(optimisticImage?.parentElement?.classList.contains("aspect-square"))
      .toBe(true);
    expect(
      articles.every((article) =>
        article.firstElementChild?.classList.contains("aspect-square") === true
      ),
    ).toBe(true);
  });

  it("shows free shipping once the discounted subtotal reaches the threshold", () => {
    const freeDeliveryCart = structuredClone(cart);
    freeDeliveryCart.cost.subtotalAmount.amount = "100.00";

    const html = renderToStaticMarkup(
      <CartProvider initialData={{ cart: freeDeliveryCart }}>
        <CartContents layout="overlay" />
      </CartProvider>,
    );

    expect(html).toContain("+ shipping");
    expect(html).toContain("Free");
    expect(html).not.toContain("(add ");
  });

  it("shows the exact remaining cents needed for free shipping", () => {
    const nearlyFreeDeliveryCart = structuredClone(cart);
    nearlyFreeDeliveryCart.cost.subtotalAmount.amount = "99.99";

    const html = renderToStaticMarkup(
      <CartProvider initialData={{ cart: nearlyFreeDeliveryCart }}>
        <CartContents layout="overlay" />
      </CartProvider>,
    );

    expect(html).toContain("(add $0.01 for free shipping)");
  });

  it("uses an in-app confirmation before submitting a line removal", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    try {
      act(() => {
        root.render(
          <CartProvider initialData={{ cart }}>
            <CartPage />
          </CartProvider>,
        );
      });

      const form = container.querySelector<HTMLFormElement>("form");
      const remove = container.querySelector<HTMLButtonElement>(
        'button[name="intent"][value="remove"]',
      );
      if (!form || !remove) throw new Error("Expected a cart removal form.");

      let submissions = 0;
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        submissions += 1;
      });

      act(() => { remove.click(); });
      expect(submissions).toBe(0);
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
      expect(document.body.textContent).toContain("Remove bent.shop?");
      expect(document.body.textContent).toContain(
        "This item will be removed from your cart.",
      );

      const confirmRemoval = document.querySelector<HTMLButtonElement>(
        '[data-slot="alert-dialog-action"]',
      );
      if (!confirmRemoval) {
        throw new Error("Expected the cart removal confirmation action.");
      }

      act(() => { confirmRemoval.click(); });
      expect(submissions).toBe(1);
    } finally {
      act(() => { root.unmount(); });
      vi.unstubAllGlobals();
      container.remove();
    }
  });

  it("blocks checkout until an optimistic line update is confirmed", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const line = cart.lines.nodes[0];
    if (!line) throw new Error("Expected a cart line fixture.");
    interface CartUpdateResult {
      cart: Omit<AppCartData, "lines"> & { lines: (typeof line)[] };
      userErrors: never[];
      warnings: never[];
    }
    let finishUpdate: ((value: CartUpdateResult) => void) | undefined;
    const completion = new Promise<CartUpdateResult>((resolve) => {
      finishUpdate = resolve;
    });

    try {
      act(() => {
        root.render(
          <CartProvider initialData={{ cart }}>
            <CartPage />
          </CartProvider>,
        );
      });

      expect(container.querySelector('a[href="/checkout"]')).not.toBeNull();

      await act(async () => {
        document.dispatchEvent(
          Object.assign(new Event("shopify:cart:lines-update"), {
            action: "update",
            lines: [{ id: line.id, quantity: 3 }],
            promise: completion,
          }),
        );
        await Promise.resolve();
      });

      const pendingCheckout = container.querySelector<HTMLButtonElement>(
        'button[aria-busy="true"]',
      );
      expect(container.querySelector('a[href="/checkout"]')).toBeNull();
      expect(pendingCheckout?.disabled).toBe(true);
      expect(pendingCheckout?.textContent).toContain("Updating cart");

      await act(async () => {
        finishUpdate?.({
          cart: {
            ...cart,
            lines: [{ ...line, quantity: 3 }],
            totalQuantity: 3,
          },
          userErrors: [],
          warnings: [],
        });
        await completion;
      });

      expect(container.querySelector('a[href="/checkout"]')).not.toBeNull();
      expect(container.querySelector('button[aria-busy="true"]')).toBeNull();
    } finally {
      act(() => { root.unmount(); });
      vi.unstubAllGlobals();
      container.remove();
    }
  });

  it("shows a final-form optimistic add while checkout remains blocked", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const existingLine = cart.lines.nodes[0];
    if (!existingLine) throw new Error("Expected a cart line fixture.");
    const confirmedLine = structuredClone(existingLine);
    confirmedLine.id = "gid://shopify/CartLine/new-line";
    confirmedLine.merchandise.id = "gid://shopify/ProductVariant/new-variant";
    confirmedLine.merchandise.selectedOptions = [{ name: "Size", value: "S" }];
    confirmedLine.merchandise.title = "S";
    confirmedLine.quantity = 1;

    interface CartAddResult {
      cart: Omit<AppCartData, "lines"> & { lines: (typeof confirmedLine)[] };
      userErrors: never[];
      warnings: never[];
    }
    let finishAdd: ((value: CartAddResult) => void) | undefined;
    const completion = new Promise<CartAddResult>((resolve) => {
      finishAdd = resolve;
    });

    try {
      act(() => {
        root.render(
          <CartProvider initialData={{ cart }}>
            <CartPage />
          </CartProvider>,
        );
      });

      await act(async () => {
        document.dispatchEvent(
          Object.assign(new Event("shopify:cart:lines-update"), {
            action: "add",
            detail: {
              products: [{
                id: confirmedLine.merchandise.id,
                image: null,
                price: money,
                product: {
                  handle: confirmedLine.merchandise.product.handle,
                  title: confirmedLine.merchandise.product.title,
                },
                selectedOptions: confirmedLine.merchandise.selectedOptions,
                title: confirmedLine.merchandise.title,
              }],
            },
            lines: [{
              merchandiseId: confirmedLine.merchandise.id,
              quantity: 1,
            }],
            promise: completion,
          }),
        );
        await Promise.resolve();
      });

      const optimisticLine = container.querySelector("article");
      const pendingCheckout = container.querySelector<HTMLButtonElement>(
        'button[aria-busy="true"]',
      );
      expect(optimisticLine?.querySelector('[aria-label="Size: S"]')).not
        .toBeNull();
      expect(optimisticLine?.querySelector('[role="status"]')?.textContent)
        .toContain("Adding item");
      expect(container.querySelector('a[href="/checkout"]')).toBeNull();
      expect(pendingCheckout?.disabled).toBe(true);

      await act(async () => {
        finishAdd?.({
          cart: {
            ...cart,
            lines: [confirmedLine, existingLine],
            totalQuantity: 3,
          },
          userErrors: [],
          warnings: [],
        });
        await completion;
      });

      expect(container.querySelector('a[href="/checkout"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Size: S"]')).toBeNull();
    } finally {
      act(() => { root.unmount(); });
      vi.unstubAllGlobals();
      container.remove();
    }
  });

  it("uses compact buttons and a non-editable quantity indicator", () => {
    const html = renderToStaticMarkup(
      <CartProvider initialData={{ cart }}>
        <CartPage />
      </CartProvider>,
    );

    expect(html.match(/type="number"/g)).toHaveLength(1);
    expect(html).toContain('class="sr-only"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-label="Decrease quantity of bent.shop"');
    expect(html).toContain('aria-label="Increase quantity of bent.shop"');
    expect(html).toContain('aria-label="Quantity for bent.shop: 2"');
  });

  it("renders a cart line when its runtime payload omits attributes", () => {
    const cartWithoutAttributes = structuredClone(cart);
    const line = cartWithoutAttributes.lines.nodes[0];
    if (!line) throw new Error("Expected a cart line fixture.");
    Reflect.deleteProperty(line, "attributes");

    const html = renderToStaticMarkup(
      <CartProvider initialData={{ cart: cartWithoutAttributes }}>
        <CartPage />
      </CartProvider>,
    );

    expect(html).toContain("bent.shop");
    expect(html).toContain("$70.00");
  });

  it("renders final-form selected options while an optimistic line is pending", () => {
    const optimisticCart = structuredClone(cart);
    const line = optimisticCart.lines.nodes[0];
    if (!line) throw new Error("Expected a cart line fixture.");
    line.id = `optimistic:${line.merchandise.id}`;
    Reflect.deleteProperty(line.merchandise.product, "variants");

    const html = renderToStaticMarkup(
      <CartProvider initialData={{ cart: optimisticCart }}>
        <CartPage />
      </CartProvider>,
    );

    expect(html).toContain("bent.shop");
    expect(html).toContain('aria-label="Size: M"');
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelector('[aria-label="Size: M"]')?.classList.contains("uppercase"))
      .toBe(true);
    expect(html).toContain("Adding item…");
    expect(html).not.toContain("Updating options…");
    expect(html).toContain('name="quantity"');
    expect(html).toContain("$70.00");
  });

  it("keeps the streamed chrome and resolved page stores synchronized", async () => {
    const chromeStore = createCartStore({ initialData: { cart } });
    const pageStore = createCartStore({ initialData: { cart } });
    chromeStore.connect();
    pageStore.connect();

    const line = cart.lines.nodes[0];
    if (!line) throw new Error("Expected a cart line fixture.");
    const completion = Promise.resolve({
      cart: {
        ...cart,
        lines: [{ ...line, quantity: 3 }],
        totalQuantity: 3,
      },
      userErrors: [],
      warnings: [],
    });
    const event = Object.assign(
      new Event("shopify:cart:lines-update"),
      {
        action: "update",
        lines: [{ id: line.id, quantity: 3 }],
        promise: completion,
      },
    );

    document.dispatchEvent(event);
    await completion;
    await Promise.resolve();

    expect(chromeStore.getState().data.lines.nodes[0]?.quantity).toBe(3);
    expect(pageStore.getState().data.lines.nodes[0]?.quantity).toBe(3);

    chromeStore.destroy();
    pageStore.destroy();
  });
});
