// @vitest-environment happy-dom

import { act, useState, type ChangeEvent, type ComponentProps, type ReactNode } from "react";
import type { CartDataFromHandlers } from "@shopify/hydrogen";
import type { ProductDefaultColor } from "@forever-tee/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NuqsTestingAdapter,
  type UrlUpdateEvent,
} from "nuqs/adapters/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CreateDesignAction,
  ProductConfigurator,
  ProductPurchaseControls,
} from "@/components/product-configurator";
import { ProductFamily } from "@/components/product-family";
import { ConfiguredProductFamily } from "@/components/configured-product-family";
import { CartProvider as AppCartProvider } from "@/lib/cart";
import type { cartHandlers } from "@/lib/cart-handlers";
import type { ProductData } from "@/lib/product-query";

let queryClient: QueryClient;
type AppCartData = CartDataFromHandlers<typeof cartHandlers>;

function CartProvider({
  nuqs,
  ...props
}: ComponentProps<typeof AppCartProvider> & {
  nuqs?: Omit<ComponentProps<typeof NuqsTestingAdapter>, "children">;
}) {
  return (
    <NuqsTestingAdapter {...nuqs}>
      <QueryClientProvider client={queryClient}>
        <AppCartProvider {...props} />
      </QueryClientProvider>
    </NuqsTestingAdapter>
  );
}

interface CartUpdateInput {
  lines: readonly {
    attributes?: readonly { key: string; value: string }[];
    id?: string;
    merchandiseId?: string;
    quantity: number;
  }[];
}

interface CartUpdateResult {
  readonly userErrors?: readonly { readonly message: string }[];
}

type UpdateCart = (
  input: CartUpdateInput,
  options: unknown,
) => Promise<CartUpdateResult>;

const mocks = vi.hoisted(() => ({
  openCartDrawer: vi.fn(),
  updateCart: vi.fn<UpdateCart>(() => Promise.resolve({ userErrors: [] })),
}));

// These selection tests do not own the design. Mock the API boundary so its
// lazy client import cannot outlive a test and make requests after teardown.
vi.mock("@/client/design-api", () => ({
  getDesign: () => Promise.reject(new Error("Design not owned by this visitor.")),
  deleteDesign: vi.fn(),
}));

vi.mock("@/lib/cart-drawer", () => ({
  openCartDrawer: mocks.openCartDrawer,
}));

vi.mock("@/lib/cart-actions", () => ({
  waitForCartActions: () => Promise.resolve({ updateCart: mocks.updateCart }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/product/base-product",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/components/ui/select", () => ({
  Select({
    children,
    onValueChange,
    value = "",
  }: {
    children: ReactNode;
    onValueChange?: (value: string) => void;
    value?: string;
  }) {
    return (
      <select
        aria-label="Size"
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          onValueChange?.(event.currentTarget.value);
        }}
        value={value}
      >
        <option disabled value="">Choose size</option>
        {children}
      </select>
    );
  },
  SelectContent({ children }: { children: ReactNode }) {
    return children;
  },
  SelectItem({
    children,
    disabled,
    value,
    ...props
  }: {
    children: ReactNode;
    disabled?: boolean;
    value: string;
    "data-available"?: string;
  }) {
    return <option disabled={disabled} value={value} {...props}>{children}</option>;
  },
  SelectTrigger() {
    return null;
  },
  SelectValue() {
    return null;
  },
}));

const money = {
  amount: "45.00",
  currencyCode: "AUD",
} satisfies ProductData["priceRange"]["minVariantPrice"];
const productIdentity = { handle: "bent-shirt", title: "Box Tee" };

function variant(
  id: string,
  color: string,
  size: string,
): NonNullable<ProductData["selectedOrFirstAvailableVariant"]> {
  return {
    availableForSale: true,
    compareAtPrice: null,
    id,
    price: money,
    product: productIdentity,
    selectedOptions: [
      { name: "Color", value: color },
      { name: "Size", value: size },
    ],
    sku: null,
    title: `${color} / ${size}`,
  };
}

const whiteSmall = variant("white-small", "White", "S");
const whiteExtraSmall = variant("white-extra-small", "White", "XS");
const whiteMedium = variant("white-medium", "White", "M");
const whiteLarge = variant("white-large", "White", "L");
const blackSmall = variant("black-small", "Black", "S");
const blackExtraSmall = variant("black-extra-small", "Black", "XS");
const blackMedium = variant("black-medium", "Black", "M");
const blackLarge = variant("black-large", "Black", "L");
const toteIdentity = { handle: "cotton-tote", title: "Cotton Tote" };
const blackOneSize = {
  ...variant("black-one-size", "Black", "One size"),
  product: toteIdentity,
};
const creamOneSize = {
  ...variant("cream-one-size", "Cream", "One size"),
  product: toteIdentity,
};

beforeEach(() => {
  queryClient = new QueryClient();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));
  mocks.openCartDrawer.mockReset();
  mocks.updateCart.mockReset();
  mocks.updateCart.mockResolvedValue({ userErrors: [] });
  window.history.replaceState(null, "", "/product/base-product");
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

const availableWhiteProduct = {
  adjacentVariants: [whiteExtraSmall, whiteMedium, whiteLarge, blackSmall],
  encodedVariantAvailability: "v1_0:0-3,1:0-3",
  encodedVariantExistence: "v1_0:0-3,1:0-3",
  handle: "bent-shirt",
  id: "gid://shopify/Product/base-product",
  options: [
    {
      name: "Color",
      optionValues: [
        { firstSelectableVariant: whiteSmall, name: "White", swatch: null },
        { firstSelectableVariant: blackSmall, name: "Black", swatch: null },
      ],
    },
    {
      name: "Size",
      optionValues: [
        { firstSelectableVariant: whiteSmall, name: "S", swatch: null },
        { firstSelectableVariant: whiteExtraSmall, name: "XS", swatch: null },
        { firstSelectableVariant: whiteMedium, name: "M", swatch: null },
        { firstSelectableVariant: whiteLarge, name: "L", swatch: null },
      ],
    },
  ],
  priceRange: { minVariantPrice: money },
  requiresSellingPlan: false,
  selectedOrFirstAvailableVariant: whiteSmall,
  title: "Box Tee",
  vendor: "bent.shop",
} satisfies ProductData;

const staleWhiteProduct = {
  ...availableWhiteProduct,
  adjacentVariants: [
    { ...whiteMedium, availableForSale: false },
    { ...whiteLarge, availableForSale: false },
    blackSmall,
  ],
  encodedVariantAvailability: null,
} satisfies ProductData;

const availableWhiteProductWithoutEncodedAvailability = {
  ...availableWhiteProduct,
  encodedVariantAvailability: null,
} satisfies ProductData;

const fullyCachedBlackProduct = {
  ...availableWhiteProduct,
  adjacentVariants: [
    blackSmall,
    blackExtraSmall,
    blackMedium,
    blackLarge,
    whiteSmall,
    whiteExtraSmall,
    whiteMedium,
    whiteLarge,
  ],
  selectedOrFirstAvailableVariant: blackSmall,
} satisfies ProductData;

const oneSizeToteProduct = {
  ...availableWhiteProduct,
  adjacentVariants: [blackOneSize, creamOneSize],
  handle: "cotton-tote",
  options: [
    {
      name: "Color",
      optionValues: [
        { firstSelectableVariant: blackOneSize, name: "Black", swatch: null },
        { firstSelectableVariant: creamOneSize, name: "Cream", swatch: null },
      ],
    },
    {
      name: "Size",
      optionValues: [
        {
          firstSelectableVariant: blackOneSize,
          name: "One size",
          swatch: null,
        },
      ],
    },
  ],
  selectedOrFirstAvailableVariant: blackOneSize,
  title: "Cotton Tote",
} satisfies ProductData;

const existingToteCart: AppCartData = {
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
    nodes: [{
      attributes: [{ key: "_productId", value: "tote-product" }],
      cost: {
        amountPerQuantity: money,
        compareAtAmountPerQuantity: null,
        subtotalAmount: money,
        totalAmount: money,
      },
      id: "gid://shopify/CartLine/tote-line",
      merchandise: {
        id: blackOneSize.id,
        image: null,
        product: {
          handle: oneSizeToteProduct.handle,
          id: oneSizeToteProduct.id,
          options: [{
            name: "Color",
            optionValues: [{ name: "Black" }, { name: "White" }],
          }, {
            name: "Size",
            optionValues: [{ name: "One size" }],
          }],
          productType: "Tote",
          title: oneSizeToteProduct.title,
          vendor: oneSizeToteProduct.vendor,
          variants: {
            nodes: [{
              availableForSale: true,
              id: blackOneSize.id,
              selectedOptions: blackOneSize.selectedOptions,
            }],
          },
        },
        selectedOptions: blackOneSize.selectedOptions,
        sku: null,
        title: blackOneSize.title,
      },
      quantity: 1,
    }],
  },
  note: null,
  totalQuantity: 1,
};

function cartWithDuplicateTote(): AppCartData {
  const line = existingToteCart.lines.nodes[0];
  if (!line) throw new Error("Expected the tote cart line fixture.");
  return {
    ...existingToteCart,
    lines: {
      nodes: [line, {
        ...line,
        id: "gid://shopify/CartLine/duplicate-tote-line",
        quantity: 2,
      }],
    },
    totalQuantity: 3,
  };
}

describe("Product family URL reporting", () => {
  it("reports selection changes without feeding parent callback changes back into renders", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const report = vi.fn<(url: string) => void>();
    const nextReport = vi.fn<(url: string) => void>();
    function ReportingPair({ onReport }: { onReport: (url: string) => void }) {
      const [urls, setUrls] = useState<Record<string, string>>({});
      return <>
        {[availableWhiteProduct, oneSizeToteProduct].map((product) => (
          <ProductConfigurator key={product.handle} product={product}
            productPathname={`/product/${product.handle}`} showMockup={false} syncUrl={false}
            onVariantUrlChange={(url) => {
              onReport(url);
              setUrls((current) => current[product.handle] === url
                ? current : { ...current, [product.handle]: url });
            }} />
        ))}
        <output>{Object.keys(urls).length}</output>
      </>;
    }
    const renderPair = (onReport: (url: string) => void) => {
      root.render(<CartProvider initialData={{ cart: null }}>
        <ReportingPair onReport={onReport} />
      </CartProvider>);
    };
    try {
      await act(async () => { renderPair(report); await Promise.resolve(); });
      expect(container.querySelector("output")?.textContent).toBe("2");
      expect(report).toHaveBeenCalledTimes(2);
      await act(async () => { renderPair(nextReport); await Promise.resolve(); });
      expect(nextReport).not.toHaveBeenCalled();
      await act(async () => {
        container.querySelector<HTMLAnchorElement>('a[aria-label="Color: Black"]')?.click();
        await Promise.resolve();
      });
      expect(nextReport).toHaveBeenCalledOnce();
      expect(nextReport).toHaveBeenCalledWith("/product/bent-shirt?Color=Black&Size=S");
    } finally {
      act(() => { root.unmount(); });
      container.remove();
    }
  });
});

describe("CreateDesignAction", () => {
  it("links to a fresh create journey", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<CreateDesignAction />);

    const link = container.querySelector("a");
    expect(link?.textContent).toBe("Make your own");
    expect(link?.getAttribute("href")).toBe("/create");
  });
});

describe("ProductPurchaseControls", () => {
  it("renders Add to cart without a duplicate cart action", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <ProductPurchaseControls
        addable
        formattedPrice="$45"
        onRetryPurchase={undefined}
        onSubmit={() => undefined}
        purchaseError={false}
        purchasePending={false}
        purchaseReady
      />,
    );

    const controls = container.firstElementChild;
    expect(controls?.children).toHaveLength(1);
    expect(controls?.children[0]?.tagName).toBe("FORM");
    expect(container.querySelector('[data-product-action="cart"]')).toBeNull();

    const addToCart = container.querySelector("button[type='submit']");
    expect(addToCart?.textContent).toBe("$45 · Add to cart");
    expect(addToCart?.getAttribute("data-product-action")).toBe("add-to-cart");
    expect(addToCart?.hasAttribute("disabled")).toBe(false);
  });
});

describe("ProductConfigurator", () => {
  it("explains a missing shirt while keeping the prepared tote available", () => {
    const markup = renderToStaticMarkup(
      <CartProvider initialData={{ cart: null }}>
        <ConfiguredProductFamily
          entries={[{
            baseProductSlug: "cotton-tote",
            defaultColor: "Black",
            designId: "design-123",
            designRevisionId: "revision-456",
            productId: "tote-product",
            product: oneSizeToteProduct,
          }]}
          initialProductId="tote-product"
          syncUrl={false}
        />
      </CartProvider>,
    );
    const container = document.createElement("div");
    container.innerHTML = markup;
    expect(container.textContent).toContain("T-shirt couldn’t be prepared for this design.");
    expect(container.textContent).toContain("you can continue with this product.");
    expect(container.querySelector("#configured-product-tab-cotton-tote")).not.toBeNull();
    expect(container.querySelector("#configured-product-tab-staple-tee")).toBeNull();
  });

  const defaultColors: ProductDefaultColor[] = ["Black", "White"];
  it.each(defaultColors)(
    "uses the %s design default first for both products and preserves manual choices",
    async (defaultColor) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const otherColor = defaultColor === "Black" ? "White" : "Black";
      try {
        await act(async () => {
          root.render(
            <CartProvider initialData={{ cart: null }}>
              <ConfiguredProductFamily
                entries={[
                  {
                    baseProductSlug: "staple-tee",
                    defaultColor,
                    designId: "design-123",
                    designRevisionId: "revision-456",
                    productId: "shirt-product",
                    product: {
                      ...fullyCachedBlackProduct,
                      selectedOrFirstAvailableVariant: null,
                    },
                  },
                  {
                    baseProductSlug: "cotton-tote",
                    defaultColor,
                    designId: "design-123",
                    designRevisionId: "revision-456",
                    productId: "tote-product",
                    product: {
                      ...oneSizeToteProduct,
                      selectedOrFirstAvailableVariant: null,
                    },
                  },
                ]}
                initialProductId="shirt-product"
                syncUrl={false}
              />
            </CartProvider>,
          );
          await Promise.resolve();
        });
        const shirt = container.querySelector("#configured-product-panel-staple-tee");
        const tote = container.querySelector("#configured-product-panel-cotton-tote");
        if (!shirt || !tote) throw new Error("Expected both product panels.");
        const colors = (panel: Element) => [...panel.querySelectorAll<HTMLAnchorElement>(
          'a[aria-label^="Color:"]',
        )];
        const expectedColors = (panel: Element) => panel === shirt
          ? [defaultColor, otherColor]
          : defaultColor === "Black" ? ["Black", "Cream"] : ["Cream", "Black"];
        for (const panel of [shirt, tote]) {
          expect(colors(panel).map((color) => color.getAttribute("value")))
            .toEqual(expectedColors(panel));
          expect(colors(panel)[0]?.getAttribute("aria-current")).toBe("true");
        }
        expect(shirt.querySelector<HTMLSelectElement>('select[aria-label="Size"]')?.value)
          .toBe("");

        await act(async () => {
          colors(shirt)[1]?.click();
          await Promise.resolve();
        });
        await act(async () => {
          container.querySelector<HTMLButtonElement>("#configured-product-tab-cotton-tote")?.click();
          await Promise.resolve();
        });
        expect(colors(tote)[0]?.getAttribute("aria-current")).toBe("true");
        await act(async () => {
          colors(tote)[1]?.click();
          await Promise.resolve();
        });
        await act(async () => {
          container.querySelector<HTMLButtonElement>("#configured-product-tab-staple-tee")?.click();
          await Promise.resolve();
        });
        for (const panel of [shirt, tote]) {
          expect(colors(panel).map((color) => color.getAttribute("value")))
            .toEqual(expectedColors(panel));
          expect(colors(panel)[1]?.getAttribute("aria-current")).toBe("true");
        }
        // Shopify's encoded variant matrix still uses its original option order.
        expect(fullyCachedBlackProduct.options[0]?.optionValues.map((value) => value.name))
          .toEqual(["White", "Black"]);
        expect(oneSizeToteProduct.options[0]?.optionValues.map((value) => value.name))
          .toEqual(["Black", "Cream"]);
      } finally {
        act(() => { root.unmount(); });
        container.remove();
      }
    },
  );

  it("adds a configured tote through the shared cart form", async () => {
    let resolveUpdate: ((result: CartUpdateResult) => void) | undefined;
    mocks.updateCart.mockImplementation(() =>
      new Promise((resolve) => {
        resolveUpdate = resolve;
      })
    );
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <CartProvider initialData={{ cart: null }}>
          <ProductConfigurator
            baseProductSlug="cotton-tote"
            designId="design-123"
            imageRevision="revision-456"
            product={oneSizeToteProduct}
            productId="tote-product"
          />
        </CartProvider>,
      );
    });

    const form = container.querySelector<HTMLFormElement>("form");
    if (!form) throw new Error("Expected the tote cart form.");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(mocks.openCartDrawer).toHaveBeenCalledOnce();
    expect(mocks.updateCart).toHaveBeenCalledOnce();
    expect(mocks.updateCart.mock.calls[0]?.[0]).toEqual({
      lines: [{
        attributes: [{ key: "_productId", value: "tote-product" }],
        merchandiseId: "black-one-size",
        quantity: 1,
      }],
    });
    expect(mocks.updateCart.mock.calls[0]?.[1]).toMatchObject({
      event: {
        detail: {
          products: [{
            image: {
              altText: "Black Cotton Tote with your artwork",
              url: "/api/configured-product-image/current/tote-product/black.webp?geometry=physical-print-area-v1&access=revocable-v1&width=384",
            },
          }],
        },
      },
    });
    await act(async () => {
      resolveUpdate?.({ userErrors: [] });
      await Promise.resolve();
    });
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("optimistically increments an existing matching cart line", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <CartProvider initialData={{ cart: existingToteCart }}>
          <ProductConfigurator
            baseProductSlug="cotton-tote"
            designId="design-123"
            imageRevision="revision-456"
            product={oneSizeToteProduct}
            productId="tote-product"
          />
        </CartProvider>,
      );
    });

    const form = container.querySelector<HTMLFormElement>("form");
    if (!form) throw new Error("Expected the tote cart form.");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(mocks.updateCart.mock.calls[0]?.[0]).toEqual({
      lines: [{
        id: "gid://shopify/CartLine/tote-line",
        quantity: 2,
      }],
    });
    expect(mocks.openCartDrawer).toHaveBeenCalledOnce();
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("optimistically consolidates duplicate matching cart lines", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <CartProvider initialData={{ cart: cartWithDuplicateTote() }}>
          <ProductConfigurator
            baseProductSlug="cotton-tote"
            designId="design-123"
            imageRevision="revision-456"
            product={oneSizeToteProduct}
            productId="tote-product"
          />
        </CartProvider>,
      );
    });

    const form = container.querySelector<HTMLFormElement>("form");
    if (!form) throw new Error("Expected the tote cart form.");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(mocks.updateCart.mock.calls[0]?.[0]).toEqual({
      lines: [{
        id: "gid://shopify/CartLine/tote-line",
        quantity: 4,
      }, {
        id: "gid://shopify/CartLine/duplicate-tote-line",
        quantity: 0,
      }],
    });
    expect(mocks.openCartDrawer).toHaveBeenCalledOnce();
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows a resolved cart user error next to the product action", async () => {
    mocks.updateCart.mockResolvedValue({
      userErrors: [{
        message: "Orders are temporarily paused. Please check back soon.",
      }],
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <CartProvider initialData={{ cart: null }}>
          <ProductConfigurator
            baseProductSlug="cotton-tote"
            designId="design-123"
            imageRevision="revision-456"
            product={oneSizeToteProduct}
            productId="tote-product"
          />
        </CartProvider>,
      );
    });

    const form = container.querySelector<HTMLFormElement>("form");
    if (!form) throw new Error("Expected the tote cart form.");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Orders are temporarily paused. Please check back soon.",
    );
    expect(mocks.openCartDrawer).toHaveBeenCalledOnce();
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("keeps the stored product image alongside its browser display renderer", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <CartProvider>
        <ProductConfigurator
          designId="design-123"
          fulfilmentEstimate={{
            production: {
              maximumBusinessDays: 5,
              minimumBusinessDays: 3,
            },
            standardDelivery: {
              maximumBusinessDays: 6,
              minimumBusinessDays: 3,
            },
          }}
          imageRevision="design-revision-456"
          product={availableWhiteProduct}
          productId="base-product"
        />
      </CartProvider>,
    );

    expect(container.querySelectorAll('[data-variant-active="true"] canvas[data-browser-preview="flat"]')).toHaveLength(1);
    const productImage = container.querySelector('[data-variant-active="true"] img');
    expect(productImage?.getAttribute("src")).toContain(
      "/api/configured-product-image/current/base-product/white.webp?geometry=physical-print-area-v1&access=revocable-v1",
    );
    const alternateImage = container.querySelector('[data-variant-active="false"] img[src*="/black.webp"]');
    expect(alternateImage?.getAttribute("fetchpriority")).toBe("low");
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    const productPage = container.querySelector(
      '[aria-label="Box Tee purchase options"]',
    );
    expect(productPage?.className).not.toContain("100dvh-3.5rem");
    expect(productPage?.querySelector("[data-product-actions]")).not.toBeNull();
    expect(productPage?.firstElementChild?.className).not.toContain(
      "100dvh-6.5rem",
    );
    const commerce = productPage?.querySelector("[data-product-purchase]")
      ?.parentElement;
    expect(commerce?.className).not.toContain("absolute");
    expect(commerce?.className).not.toContain("bottom-0");
    expect(commerce?.className).not.toContain("safe-area-inset-bottom");
    expect(commerce?.querySelector("header")).toBeNull();
    expect(productPage?.querySelector("h1")?.className).toContain("sr-only");
    expect(container.querySelector("#product-options h2")?.className)
      .toContain("sr-only");
    expect(container.querySelector("#product-options")?.textContent)
      .not.toContain("Choose your options");
    expect(container.querySelectorAll("[data-option-label]")).toHaveLength(0);
    const variantRow = container.querySelector("[data-product-variant-row]");
    expect(variantRow?.textContent).not.toContain("$45");
    expect(container.querySelector('[data-product-action="add-to-cart"]')?.textContent)
      .toBe("$45 · Add to cart");
    const fulfilmentEstimate = container.querySelector(
      "[data-fulfilment-estimate]",
    );
    expect(
      [...(fulfilmentEstimate?.querySelectorAll("p") ?? [])].map(
        ({ textContent }) => textContent,
      ),
    ).toEqual([
      "- production: 3 to 5 business days",
      "- shipping: 3 to 6 business days",
    ]);
    expect(fulfilmentEstimate?.querySelector("ul, li")).toBeNull();
    const productDetails = container.querySelector("details");
    expect(productDetails?.querySelector("summary")?.textContent)
      .toContain("Product details");
    expect(productDetails?.querySelector("summary svg")).not.toBeNull();
    expect(productDetails?.querySelector("summary svg")?.parentElement?.className)
      .toContain("place-items-center");
    expect(productDetails?.hasAttribute("open")).toBe(false);

    const share = container.querySelector('[data-product-action="share"]');
    const makeYourOwn = container.querySelector(
      '[data-product-action="make-your-own"]',
    );
    const purchase = container.querySelector("[data-product-purchase]");
    const actions = container.querySelector("[data-product-actions]");
    const options = container.querySelector("#product-options");
    expect(purchase).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(options).not.toBeNull();
    expect(options?.parentElement).toBe(purchase);
    expect(actions?.parentElement).toBe(purchase);
    expect(
      actions && options
        ? Boolean(options.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING)
        : false,
    ).toBe(true);
    expect(share?.className).toContain("shrink-0");
    expect(makeYourOwn?.parentElement?.className).toContain("flex-1");
  });

  it("shows in-stock white sizes as available on the initial render", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <CartProvider>
        <ProductConfigurator
          product={availableWhiteProduct}
          productId="base-product"
          showMockup={false}
        />
      </CartProvider>,
    );

    const medium = [...container.querySelectorAll("option")].find(
      (option) => option.value === "M",
    );
    const large = [...container.querySelectorAll("option")].find(
      (option) => option.value === "L",
    );

    expect(medium?.dataset["available"]).toBe("true");
    expect(large?.dataset["available"]).toBe("true");
  });

  it("requires an explicit shirt size while choosing the image-based white default", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <CartProvider initialData={{ cart: null }}>
          <ProductConfigurator
            designId="design-123"
            product={{
              ...fullyCachedBlackProduct,
              selectedOrFirstAvailableVariant: null,
            }}
            productId="base-product"
            showMockup={false}
          />
        </CartProvider>,
      );
    });

    const colorOption = (value: string) =>
      [...container.querySelectorAll("a")].find(
        (link) => link.getAttribute("value") === value,
      );
    expect(colorOption("White")?.getAttribute("aria-current")).toBe("true");
    const size = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Size"]',
    );
    expect(size?.value).toBe("");
    expect((size ? [...size.options] : []).map((option) => option.value))
      .toEqual(["", "XS", "S", "M", "L"]);
    const addToCart = container.querySelector<HTMLButtonElement>(
      '[data-product-action="add-to-cart"]',
    );
    expect(addToCart?.textContent).toBe("$45 · Choose size");
    expect(addToCart?.disabled).toBe(true);

    act(() => { colorOption("Black")?.click(); });
    expect(colorOption("Black")?.getAttribute("aria-current")).toBe("true");
    expect(container.textContent).not.toContain("Colour · Black");
    expect(addToCart?.textContent).toBe("$45 · Choose size");

    act(() => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("restores the default colour without queuing navigation and still syncs user choices", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onUrlUpdate = vi.fn<(event: UrlUpdateEvent) => void>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <CartProvider
          initialData={{ cart: null }}
          nuqs={{ hasMemory: true, onUrlUpdate }}
        >
          <ProductConfigurator
            defaultColor="Black"
            product={{
              ...fullyCachedBlackProduct,
              selectedOrFirstAvailableVariant: null,
            }}
            productPathname="/product/base-product"
            showMockup={false}
          />
        </CartProvider>,
      );
      await Promise.resolve();
    });

    const color = (value: string) => [...container.querySelectorAll("a")].find(
      link => link.getAttribute("value") === value,
    );
    expect(color("Black")?.getAttribute("aria-current")).toBe("true");
    expect(onUrlUpdate).not.toHaveBeenCalled();

    for (const value of ["White", "Black"]) {
      await act(async () => {
        color(value)?.click();
        await Promise.resolve();
      });
      expect(onUrlUpdate.mock.lastCall?.[0].options.shallow).toBe(true);
      expect(onUrlUpdate.mock.lastCall?.[0].queryString).toBe(`?Color=${value}`);
      expect(color(value)?.getAttribute("aria-current")).toBe("true");
    }

    act(() => { root.unmount(); });
    container.remove();
  });

  it("uses a non-shallow nuqs update for a complete uncached variant", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onUrlUpdate = vi.fn<(event: UrlUpdateEvent) => void>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <CartProvider
          initialData={{ cart: null }}
          nuqs={{ hasMemory: true, onUrlUpdate }}
        >
          <ProductConfigurator
            product={availableWhiteProduct}
            productPathname="/product/base-product"
            showMockup={false}
          />
        </CartProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      [...container.querySelectorAll("a")].find(
        (link) => link.getAttribute("value") === "Black",
      )?.click();
      await Promise.resolve();
    });
    const size = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Size"]',
    );
    if (!size) throw new Error("Expected the size selector.");
    onUrlUpdate.mockClear();

    await act(async () => {
      size.value = "M";
      size.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(onUrlUpdate.mock.lastCall?.[0].options.shallow).toBe(false);
    expect(onUrlUpdate.mock.lastCall?.[0].queryString).toBe(
      "?Color=Black&Size=M",
    );

    act(() => { root.unmount(); });
    container.remove();
  });

  it("does not let a hidden product replace the active product URL", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onUrlUpdate = vi.fn<(event: UrlUpdateEvent) => void>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <CartProvider
          initialData={{ cart: null }}
          nuqs={{ hasMemory: true, onUrlUpdate }}
        >
          <ProductFamily
            entries={[
              {
                baseProductSlug: "staple-tee",
                href: "/product/shirt-product",
                panel: (
                  <ProductConfigurator
                    product={{
                      ...fullyCachedBlackProduct,
                      selectedOrFirstAvailableVariant: null,
                    }}
                    productPathname="/product/shirt-product"
                    showMockup={false}
                  />
                ),
                panelId: "shirt-product",
              },
              {
                baseProductSlug: "cotton-tote",
                href: "/product/tote-product?Color=Black&Size=One+size",
                panel: (
                  <ProductConfigurator
                    baseProductSlug="cotton-tote"
                    product={oneSizeToteProduct}
                    productPathname="/product/tote-product"
                    showMockup={false}
                  />
                ),
                panelId: "tote-product",
              },
            ]}
            initialPanelId="tote-product"
          />
        </CartProvider>,
      );
      await Promise.resolve();
    });

    expect(onUrlUpdate).not.toHaveBeenCalled();

    act(() => { root.unmount(); });
    container.remove();
  });

  it("does not surface a redundant one-size control", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <CartProvider>
        <ProductConfigurator
          baseProductSlug="cotton-tote"
          product={oneSizeToteProduct}
          productId="tote-product"
          showMockup={false}
        />
      </CartProvider>,
    );

    expect(container.querySelectorAll("#product-options fieldset"))
      .toHaveLength(1);
    expect(container.textContent).not.toContain("One size");
    expect(container.textContent).not.toContain("Size guide");
    expect(container.textContent).toContain("AS Colour Carrie Tote 1001");
    expect(container.textContent).toContain("320 GSM");
    expect(container.textContent).toContain("42 × 42 cm");
  });

  it("can add White M immediately after selecting it", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onUrlUpdate = vi.fn<(event: UrlUpdateEvent) => void>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <CartProvider
          initialData={{ cart: null }}
          nuqs={{
            hasMemory: true,
            onUrlUpdate,
            searchParams: "?ref=landing",
          }}
        >
          <ProductConfigurator
            designId="design-123"
            imageRevision="artwork-sha-456"
            optionQueryParamPrefix="shirt"
            product={fullyCachedBlackProduct}
            productId="base-product"
            productPathname="/"
          />
        </CartProvider>,
      );
    });
    const colorOption = (value: string) =>
      [...container.querySelectorAll("a")].find(
        (link) => link.getAttribute("value") === value,
      );
    const size = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Size"]',
    );
    if (!size) throw new Error("Expected the size selector.");

    await act(async () => {
      colorOption("White")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      size.value = "M";
      size.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(
      container.querySelector("button[type='submit']")?.textContent,
    ).toBe("$45 · Add to cart");
    expect(onUrlUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queryString: "?ref=landing&shirtColor=White&shirtSize=M",
      }),
    );
    expect(container.querySelector("#product-options")?.hasAttribute("hidden"))
      .toBe(false);
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("refreshes availability when inventory changes without changing the selected variant", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <CartProvider initialData={{ cart: null }}>
          <ProductConfigurator
            product={staleWhiteProduct}
            productId="base-product"
            showMockup={false}
          />
        </CartProvider>,
      );
    });
    const sizeAvailability = () =>
      [...container.querySelectorAll("option")]
        .filter((option) =>
          option.value === "M" ||
          option.value === "L"
        )
        .map((option) => option.getAttribute("data-available"));

    expect(sizeAvailability()).toEqual(["false", "false"]);

    act(() => {
      root.render(
        <CartProvider initialData={{ cart: null }}>
          <ProductConfigurator
            product={availableWhiteProductWithoutEncodedAvailability}
            productId="base-product"
            showMockup={false}
          />
        </CartProvider>,
      );
    });

    expect(sizeAvailability()).toEqual(["true", "true"]);
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });
});
