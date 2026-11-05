import { baseProductSlugForId } from "@forever-tee/contracts/product-projection";
import { io } from "next/cache";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import {
  ConfiguredProductFamily,
  type ConfiguredProductFamilyEntry,
} from "@/components/configured-product-family";
import {
  DefaultProductFamily,
  type DefaultProductFamilyEntry,
} from "@/components/default-product-family";
import { ProductPageSkeleton } from "@/components/route-skeletons";
import { DeferredFulfilmentEstimate } from "@/components/deferred-fulfilment-estimate";
import {
  landingProductQuery,
  landingProductSlug,
  loadLandingProductParams,
  productQueryWithDefaultColor,
} from "@/lib/product-params";
import { getForeverTeeProduct } from "@/lib/product-data";
import {
  getCachedProductFamilyRecords,
} from "@/lib/product-record-data";
import { LAUNCH_BASE_PRODUCTS } from "@/lib/products";

type ProductSearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

export function ProductPageContent({
  familyQueryParamName,
  params,
  searchParams,
  syncUrl = true,
  syncVariantUrl = syncUrl,
  variantPathname,
}: {
  familyQueryParamName?: string;
  params: Promise<{ id: string }>;
  searchParams: ProductSearchParams;
  syncUrl?: boolean;
  syncVariantUrl?: boolean;
  variantPathname?: string;
}) {
  return (
    <>
      <Suspense fallback={<ProductPageSkeleton />}>
        <ProductPageData
          familyQueryParamName={familyQueryParamName}
          params={params}
          searchParams={searchParams}
          syncUrl={syncUrl}
          syncVariantUrl={syncVariantUrl}
          variantPathname={variantPathname}
        />
      </Suspense>
    </>
  );
}

export async function ProductPageData({
  familyQueryParamName,
  params,
  searchParams,
  syncUrl,
  syncVariantUrl,
  variantPathname,
}: {
  familyQueryParamName: string | undefined;
  params: Promise<{ id: string }>;
  searchParams: ProductSearchParams;
  syncUrl: boolean;
  syncVariantUrl: boolean;
  variantPathname: string | undefined;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  await io();
  const landingParams = familyQueryParamName === "product"
    ? loadLandingProductParams(query)
    : undefined;
  const initialBaseProductSlug = landingParams
    ? landingProductSlug(landingParams.product)
    : undefined;
  const productQuery = Object.fromEntries(
    Object.entries(query).filter(
      ([name]) => name !== familyQueryParamName && name !== "designRevision",
    ),
  );
  const familyRecords = await getCachedProductFamilyRecords(id);
  const productRecord = familyRecords?.find(record => record.id === id);
  if (!productRecord) notFound();

  if (!productRecord.designId) {
    const initialBaseProductId = LAUNCH_BASE_PRODUCTS.find(
      (baseProduct) => baseProduct.slug === initialBaseProductSlug,
    )?.id ?? productRecord.baseProductId;
    const resolvedEntries = await Promise.all(
      LAUNCH_BASE_PRODUCTS.map(async (baseProduct) => {
        const product = await getForeverTeeProduct(
          productQueryWithDefaultColor(
            landingParams
              ? landingProductQuery(landingParams, baseProduct.slug, query)
              : baseProduct.id === initialBaseProductId
                ? productQuery
                : {},
            productRecord.defaultColor,
            baseProduct.slug,
          ),
          baseProduct.shopifyHandle,
        );
        if (!product) return undefined;
        return {
          baseProductId: baseProduct.id,
          baseProductSlug: baseProduct.slug,
          defaultColor: productRecord.defaultColor,
          fulfilmentEstimateContent: (
            <DeferredFulfilmentEstimate baseProductSlug={baseProduct.slug} />
          ),
          product,
        } satisfies DefaultProductFamilyEntry;
      }),
    );
    const entries: DefaultProductFamilyEntry[] = [];
    for (const entry of resolvedEntries) {
      if (entry) entries.push(entry);
    }
    if (!entries.some((entry) => entry.baseProductId === initialBaseProductId)) {
      notFound();
    }
    return (
      <DefaultProductFamily
        entries={entries}
        {...(familyQueryParamName ? { familyQueryParamName } : {})}
        initialBaseProductId={initialBaseProductId}
        syncUrl={syncUrl}
        syncVariantUrl={syncVariantUrl}
        {...(variantPathname ? { variantPathname } : {})}
      />
    );
  }

  if (!familyRecords) notFound();
  const resolvedEntries = await Promise.all(
    familyRecords.map(async (record) => {
      const slug = baseProductSlugForId(record.baseProductId);
      const revision = record.designRevisionId ?? record.preparationId;
      if (!slug || !record.designId || !revision) return undefined;
      const product = await getForeverTeeProduct(
        productQueryWithDefaultColor(
          landingParams
            ? landingProductQuery(landingParams, slug, query)
            : record.id === id
              ? productQuery
              : {},
          record.defaultColor,
          slug,
        ),
        record.shopifyHandle,
      );
      if (!product) return undefined;
      return {
        baseProductSlug: slug,
        designId: record.designId,
        designRevisionId: revision,
        defaultColor: record.defaultColor,
        fulfilmentEstimateContent: <DeferredFulfilmentEstimate baseProductSlug={slug} />,
        product,
        productId: record.id,
      } satisfies ConfiguredProductFamilyEntry;
    }),
  );
  const entries: ConfiguredProductFamilyEntry[] = [];
  for (const entry of resolvedEntries) {
    if (entry) entries.push(entry);
  }
  if (!entries.some((entry) => entry.productId === id)) notFound();
  const initialConfiguredProductId = familyQueryParamName
    ? entries.find((entry) => entry.baseProductSlug === initialBaseProductSlug)
        ?.productId ?? id
    : id;

  return (
    <ConfiguredProductFamily
      entries={entries}
      {...(familyQueryParamName ? { familyQueryParamName } : {})}
      initialProductId={initialConfiguredProductId}
      syncUrl={syncUrl}
      syncVariantUrl={syncVariantUrl}
      {...(variantPathname ? { variantPathname } : {})}
    />
  );
}
