// @vitest-environment happy-dom

import type { BaseProductSlug } from "@forever-tee/contracts/product-projection";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConfiguredProductFamily,
  type ConfiguredProductFamilyEntry,
} from "@/components/configured-product-family";
import type { ProductData } from "@/lib/product-query";

vi.mock("@/client/use-product-purchase-readiness", () => ({
  useProductPurchaseReadiness: () => ({ ready: true, pending: false, error: false, retry: vi.fn() }),
}));

vi.mock("@/components/product-configurator", () => ({
  ProductConfigurator: ({
    baseProductSlug,
    onVariantUrlChange,
    optionQueryParamPrefix,
    productId,
  }: {
    baseProductSlug: BaseProductSlug;
    onVariantUrlChange?: (url: string) => void;
    optionQueryParamPrefix?: string;
    productId: string;
  }) => {
    useEffect(() => {
      onVariantUrlChange?.(
        baseProductSlug === "staple-tee"
          ? `/?${optionQueryParamPrefix ?? ""}Color=Black&${optionQueryParamPrefix ?? ""}Size=M`
          : `/?${optionQueryParamPrefix ?? ""}Color=Cream`,
      );
    }, [
      baseProductSlug,
      onVariantUrlChange,
      optionQueryParamPrefix,
    ]);
    return <div data-rendered-product={productId}>{productId}</div>;
  },
}));

const money = {
  amount: "45.00",
  currencyCode: "AUD",
} satisfies ProductData["priceRange"]["minVariantPrice"];

function entry(
  baseProductSlug: ConfiguredProductFamilyEntry["baseProductSlug"],
  productId: string,
): ConfiguredProductFamilyEntry {
  const product = {
    adjacentVariants: [],
    encodedVariantAvailability: null,
    encodedVariantExistence: null,
    handle: baseProductSlug === "staple-tee" ? "bent-shirt" : "cotton-tote",
    id: `gid://shopify/Product/${productId}`,
    options: [],
    priceRange: { minVariantPrice: money },
    requiresSellingPlan: false,
    selectedOrFirstAvailableVariant: null,
    title: baseProductSlug === "staple-tee" ? "Staple Tee" : "Cotton Tote",
    vendor: "AS Colour",
  } satisfies ProductData;
  return {
    baseProductSlug,
    designId: "design-1",
    designRevisionId: "revision-1",
    defaultColor: "White",
    product,
    productId,
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConfiguredProductFamily", () => {
  it("mounts both products and switches the shared layout without navigation", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const replaceState = vi.spyOn(window.history, "replaceState");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <ConfiguredProductFamily
          entries={[
            entry("cotton-tote", "tote-product"),
            entry("staple-tee", "shirt-product"),
          ]}
          initialProductId="shirt-product"
        />,
      );
    });

    expect(container.querySelectorAll("[data-rendered-product]")).toHaveLength(2);
    expect(
      [...container.querySelectorAll('[role="tab"]')].map(
        (tab) => tab.textContent,
      ),
    ).toEqual(["t-shirt", "tote"]);
    const tabList = container.querySelector('[role="tablist"]');
    expect(tabList?.parentElement?.className).not.toContain("border-b");
    expect(tabList?.textContent).toBe("t-shirttote");
    expect(tabList?.className).toContain("gap-2");
    const panelClasses = container.querySelector('[role="tabpanel"]')?.classList;
    expect(panelClasses?.contains("max-[900px]:border-t")).toBe(true);
    expect(panelClasses?.contains("border-t")).toBe(false);
    const shirtTab = container.querySelector<HTMLButtonElement>(
      "#configured-product-tab-staple-tee",
    );
    expect(shirtTab?.className).toContain("data-[active]:border-dotted");
    expect(shirtTab?.className).toContain("data-[active]:border-primary");
    const toteTab = container.querySelector<HTMLButtonElement>(
      "#configured-product-tab-cotton-tote",
    );
    expect(toteTab?.getAttribute("aria-selected")).toBe("false");

    await act(async () => {
      toteTab?.click();
      await Promise.resolve();
    });

    expect(toteTab?.getAttribute("aria-selected")).toBe("true");
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/product/tote-product",
    );

    await act(async () => {
      toteTab?.focus();
      toteTab?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" }),
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector("#configured-product-tab-staple-tee")
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      "",
      "/product/shirt-product",
    );
    act(() => {
      root.unmount();
    });
  });

  it("switches landing products without changing routes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const replaceState = vi.spyOn(window.history, "replaceState");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <ConfiguredProductFamily
          entries={[
            entry("cotton-tote", "tote-product"),
            entry("staple-tee", "shirt-product"),
          ]}
          initialProductId="shirt-product"
          syncUrl={false}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        "#configured-product-tab-cotton-tote",
      )?.click();
      await Promise.resolve();
    });

    expect(replaceState).not.toHaveBeenCalled();
    expect(
      container.querySelector("#configured-product-tab-cotton-tote")
        ?.getAttribute("aria-selected"),
    ).toBe("true");

    act(() => {
      root.unmount();
    });
  });

  it("keeps configured landing products and variants on the root URL", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onUrlUpdate = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <NuqsTestingAdapter
          hasMemory
          onUrlUpdate={onUrlUpdate}
          searchParams="?product=shirt&shirtColor=Black&shirtSize=M&toteColor=Cream"
        >
          <ConfiguredProductFamily
            entries={[
              entry("cotton-tote", "tote-product"),
              entry("staple-tee", "shirt-product"),
            ]}
            familyQueryParamName="product"
            initialProductId="shirt-product"
            syncUrl
            syncVariantUrl
            variantPathname="/"
          />
        </NuqsTestingAdapter>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        "#configured-product-tab-cotton-tote",
      )?.click();
      await Promise.resolve();
    });

    expect(onUrlUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queryString:
          "?product=tote&shirtColor=Black&shirtSize=M&toteColor=Cream",
      }),
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        "#configured-product-tab-staple-tee",
      )?.click();
      await Promise.resolve();
    });

    expect(onUrlUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queryString:
          "?product=shirt&shirtColor=Black&shirtSize=M&toteColor=Cream",
      }),
    );

    act(() => {
      root.unmount();
    });
  });
});
