// @vitest-environment happy-dom

import type { BaseProductSlug } from "@forever-tee/contracts/product-projection";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DefaultProductFamily,
  type DefaultProductFamilyEntry,
} from "@/components/default-product-family";
import type { ProductData } from "@/lib/product-query";

vi.mock("@/components/product-configurator", () => ({
  ProductConfigurator({
    baseProductSlug,
    onVariantUrlChange,
    optionQueryParamPrefix,
  }: {
    baseProductSlug: BaseProductSlug;
    onVariantUrlChange?: (url: string) => void;
    optionQueryParamPrefix?: string;
  }) {
    useEffect(() => {
      onVariantUrlChange?.(
        baseProductSlug === "staple-tee"
          ? `/?${optionQueryParamPrefix ?? ""}Color=Black&${optionQueryParamPrefix ?? ""}Size=M`
          : `/?${optionQueryParamPrefix ?? ""}Color=Cream`,
      );
    }, [baseProductSlug, onVariantUrlChange, optionQueryParamPrefix]);
    return <div>{baseProductSlug}</div>;
  },
}));

vi.mock("@/components/product-family", () => ({
  ProductFamily({
    entries,
  }: {
    entries: readonly {
      href: string;
      panel: ReactNode;
      panelId: string;
    }[];
  }) {
    return entries.map((entry) => (
      <div key={entry.panelId}>
        <a data-product-id={entry.panelId} href={entry.href}>Product</a>
        {entry.panel}
      </div>
    ));
  },
}));

const money = { amount: "45.00", currencyCode: "AUD" } satisfies
  ProductData["priceRange"]["minVariantPrice"];

function entry(
  baseProductSlug: BaseProductSlug,
  baseProductId: string,
): DefaultProductFamilyEntry {
  return {
    baseProductId,
    baseProductSlug,
    defaultColor: "White",
    product: {
      adjacentVariants: [],
      encodedVariantAvailability: null,
      encodedVariantExistence: null,
      handle: baseProductSlug === "staple-tee" ? "bent-shirt" : "cotton-tote",
      id: `gid://shopify/Product/${baseProductId}`,
      options: [],
      priceRange: { minVariantPrice: money },
      requiresSellingPlan: false,
      selectedOrFirstAvailableVariant: null,
      title: "Product",
      vendor: "bent.shop",
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DefaultProductFamily", () => {
  it("keeps each landing product and its variants in a shareable URL", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <DefaultProductFamily
          entries={[
            entry("staple-tee", "shirt-product"),
            entry("cotton-tote", "tote-product"),
          ]}
          familyQueryParamName="product"
          initialBaseProductId="shirt-product"
          syncUrl={false}
          syncVariantUrl
          variantPathname="/"
        />,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-product-id="shirt-product"]')
        ?.getAttribute("href"),
    ).toBe("/?shirtColor=Black&shirtSize=M&product=shirt");
    expect(
      container.querySelector('[data-product-id="tote-product"]')
        ?.getAttribute("href"),
    ).toBe("/?toteColor=Cream&product=tote");

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
