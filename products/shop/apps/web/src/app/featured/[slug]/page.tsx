import type { Metadata } from "next";
import { Suspense } from "react";
import { baseProductSlugForId } from "@forever-tee/contracts/product-projection";

import { notFound } from "next/navigation";
import { featuredProductPath } from "@/lib/featured-products";
import { ProductPageData } from "@/components/product-page-content";
import { ProductPageSkeleton } from "@/components/route-skeletons";
import {
  landingProductOptionPrefix,
  landingProductQuery,
  landingProductSlug,
  loadLandingProductParams,
  productDefaultColorValue,
} from "@/lib/product-params";
import { SAMPLE_PRODUCT_ID } from "@/lib/products";
import { getCachedProductFamilyRecords } from "@/lib/product-record-data";
import { featuredProductsForRequest } from "@/server/featured-product";
import {
  createSocialCardMetadata,
  featuredSocialCardPath,
  productSocialCardPath,
  requestedSocialCardColor,
  socialCardProductName,
} from "@/lib/social-card";

type HomeSearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: HomeSearchParams;
}): Promise<Metadata> {
  const query = await searchParams;
  const featured = await resolveFeaturedProduct(params);
  const landingParams = loadLandingProductParams(query);
  const baseProductSlug = landingProductSlug(landingParams.product);
  const prefix = landingProductOptionPrefix(baseProductSlug);
  const family = await getCachedProductFamilyRecords(featured.productId);
  const product = family?.find(
    (record) => baseProductSlugForId(record.baseProductId) === baseProductSlug,
  );
  const productId = product?.id ?? featured.productId;
  const defaultRecord = product ?? family?.find(record => record.id === featured.productId);
  const defaultColor = defaultRecord
    ? productDefaultColorValue(defaultRecord.defaultColor, baseProductSlug)
    : "Black";
  const color = requestedSocialCardColor(
    landingProductQuery(landingParams, baseProductSlug, query),
    "Color",
    defaultColor,
  );
  const shareParams = new URLSearchParams({
    [`${prefix}Color`]: color,
    product: landingParams.product,
  });

  return createSocialCardMetadata({
    alt: `${color} ${socialCardProductName(baseProductSlug)} with the featured bent.shop design`,
    canonicalPath: featuredProductPath(featured.productId),
    documentTitle: "bent.shop",
    imagePath: featured.productId === SAMPLE_PRODUCT_ID
      ? featuredSocialCardPath(baseProductSlug, color)
      : productSocialCardPath(productId, color),
    sharePath: `${featuredProductPath(featured.productId)}?${shareParams.toString()}`,
  });
}

export default function FeaturedPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: HomeSearchParams;
}) {
  return (
    <main className="flex-1 bg-background px-[clamp(1rem,4vw,4rem)] pt-14 pb-4 text-primary">
      <Suspense fallback={<ProductPageSkeleton />}>
        <FeaturedContent params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function resolveFeaturedProduct(params: Promise<{ slug: string }>) {
  const { slug } = await params;
  const products = await featuredProductsForRequest();
  const featured = products.find(product => product.productId === slug);
  if (!featured) notFound();
  return featured;
}

async function FeaturedContent({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: HomeSearchParams;
}) {
  const featured = await resolveFeaturedProduct(params);
  return ProductPageData({
    familyQueryParamName: "product",
    params: Promise.resolve({ id: featured.productId }),
    searchParams,
    syncUrl: true,
    syncVariantUrl: true,
    variantPathname: featuredProductPath(featured.productId),
  });
}
