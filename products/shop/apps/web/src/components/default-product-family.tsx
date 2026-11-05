"use client";

import type {
  BaseProductSlug,
  ProductDefaultColor,
} from "@forever-tee/contracts";
import { useState, type ReactNode } from "react";

import { ProductConfigurator } from "@/components/product-configurator";
import {
  familyProductUrl,
  landingProductOptionPrefix,
} from "@/lib/product-params";
import {
  ProductFamily,
  type ProductFamilyEntry,
} from "@/components/product-family";
import type { ProductData } from "@/lib/product-query";
import type { FulfilmentEstimate } from "@/lib/fulfilment-estimate";
import { productPath } from "@/lib/products";

export interface DefaultProductFamilyEntry {
  readonly baseProductId: string;
  readonly baseProductSlug: BaseProductSlug;
  readonly defaultColor: ProductDefaultColor;
  readonly fulfilmentEstimate?: FulfilmentEstimate;
  readonly fulfilmentEstimateContent?: ReactNode;
  readonly product: ProductData;
}

export function DefaultProductFamily({
  entries,
  familyQueryParamName,
  initialBaseProductId,
  syncUrl = true,
  syncVariantUrl = syncUrl,
  variantPathname,
}: {
  entries: readonly DefaultProductFamilyEntry[];
  familyQueryParamName?: string;
  initialBaseProductId: string;
  syncUrl?: boolean;
  syncVariantUrl?: boolean;
  variantPathname?: string;
}) {
  const [variantUrls, setVariantUrls] = useState<Record<string, string>>({});
  const panels: ProductFamilyEntry[] = entries.map((entry) => ({
    baseProductSlug: entry.baseProductSlug,
    href: variantUrls[entry.baseProductId] ?? familyProductUrl(
      variantPathname ?? productPath(entry.baseProductId),
      familyQueryParamName,
      entry.baseProductSlug,
    ),
    panel: (
      <ProductConfigurator
        baseProductSlug={entry.baseProductSlug}
        defaultColor={entry.defaultColor}
        fulfilmentEstimateContent={entry.fulfilmentEstimateContent}
        {...(entry.fulfilmentEstimate
          ? { fulfilmentEstimate: entry.fulfilmentEstimate }
          : {})}
        onVariantUrlChange={(url) => {
          const nextUrl = familyProductUrl(
            url,
            familyQueryParamName,
            entry.baseProductSlug,
          );
          setVariantUrls((current) =>
            current[entry.baseProductId] === nextUrl
              ? current
              : { ...current, [entry.baseProductId]: nextUrl },
          );
        }}
        product={entry.product}
        {...(familyQueryParamName
          ? {
              optionQueryParamPrefix: landingProductOptionPrefix(
                entry.baseProductSlug,
              ),
            }
          : {})}
        productPathname={variantPathname ?? productPath(entry.baseProductId)}
        syncUrl={syncVariantUrl}
      />
    ),
    panelId: entry.baseProductId,
  }));

  return (
    <ProductFamily
      entries={panels}
      {...(familyQueryParamName ? { familyQueryParamName } : {})}
      initialPanelId={initialBaseProductId}
      syncUrl={syncUrl}
    />
  );
}
