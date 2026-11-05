"use client";

import type {
  BaseProductSlug,
  ProductDefaultColor,
} from "@forever-tee/contracts";
import { useState, type ReactNode } from "react";

import {
  ProductFamily,
  type ProductFamilyEntry,
} from "@/components/product-family";
import { ProductConfigurator } from "@/components/product-configurator";
import {
  familyProductUrl,
  landingProductOptionPrefix,
} from "@/lib/product-params";
import type { ProductData } from "@/lib/product-query";
import type { FulfilmentEstimate } from "@/lib/fulfilment-estimate";
import { LAUNCH_BASE_PRODUCTS, productPath } from "@/lib/products";

export interface ConfiguredProductFamilyEntry {
  readonly baseProductSlug: BaseProductSlug;
  readonly designId: string;
  readonly designRevisionId: string;
  readonly defaultColor: ProductDefaultColor;
  readonly fulfilmentEstimate?: FulfilmentEstimate;
  readonly fulfilmentEstimateContent?: ReactNode;
  readonly product: ProductData;
  readonly productId: string;
}

export function ConfiguredProductFamily({
  entries,
  familyQueryParamName,
  initialProductId,
  syncUrl = true,
  syncVariantUrl = syncUrl,
  variantPathname,
}: {
  entries: readonly ConfiguredProductFamilyEntry[];
  familyQueryParamName?: string;
  initialProductId: string;
  syncUrl?: boolean;
  syncVariantUrl?: boolean;
  variantPathname?: string;
}) {
  const [variantUrls, setVariantUrls] = useState<Record<string, string>>({});
  const unavailableProduct = LAUNCH_BASE_PRODUCTS.find(
    (base) => !entries.some((entry) => entry.baseProductSlug === base.slug),
  );
  const panels: ProductFamilyEntry[] = entries.map((entry) => ({
    baseProductSlug: entry.baseProductSlug,
    href: variantUrls[entry.productId] ?? familyProductUrl(
      variantPathname ?? productPath(entry.productId),
      familyQueryParamName,
      entry.baseProductSlug,
    ),
    panel: (
      <ProductConfigurator
        baseProductSlug={entry.baseProductSlug}
        designId={entry.designId}
        defaultColor={entry.defaultColor}
        fulfilmentEstimateContent={entry.fulfilmentEstimateContent}
        {...(entry.fulfilmentEstimate
          ? { fulfilmentEstimate: entry.fulfilmentEstimate }
          : {})}
        imageRevision={entry.designRevisionId}
        {...(familyQueryParamName
          ? {
              onVariantUrlChange: (url: string) => {
                const nextUrl = familyProductUrl(
                  url,
                  familyQueryParamName,
                  entry.baseProductSlug,
                );
                setVariantUrls((current) =>
                  current[entry.productId] === nextUrl
                    ? current
                    : { ...current, [entry.productId]: nextUrl },
                );
              },
            }
          : {})}
        product={entry.product}
        productId={entry.productId}
        unavailableProductLabel={unavailableProduct
          ? unavailableProduct.slug === "staple-tee" ? "T-shirt" : "Tote"
          : undefined}
        {...(familyQueryParamName
          ? {
              optionQueryParamPrefix: landingProductOptionPrefix(
                entry.baseProductSlug,
              ),
            }
          : {})}
        productPathname={
          variantPathname ?? `/product/${encodeURIComponent(entry.productId)}`
        }
        syncUrl={syncVariantUrl}
      />
    ),
    panelId: entry.productId,
  }));

  return (
    <ProductFamily
      entries={panels}
      {...(familyQueryParamName ? { familyQueryParamName } : {})}
      initialPanelId={initialProductId}
      syncUrl={syncUrl}
    />
  );
}
