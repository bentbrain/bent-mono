import type { Metadata } from "next";
import { baseProductSlugForId } from "@forever-tee/contracts/product-projection";

import { ProductPageContent } from "@/components/product-page-content";
import { productDefaultColorValue } from "@/lib/product-params";
import { getCachedProductFamilyRecords } from "@/lib/product-record-data";
import {
  createSocialCardMetadata,
  productSocialCardPath,
  requestedSocialCardColor,
} from "@/lib/social-card";

type ProductSearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: ProductSearchParams;
}): Promise<Metadata> {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const family = await getCachedProductFamilyRecords(id);
  const product = family?.find((record) => record.id === id);
  const baseProductSlug = product
    ? baseProductSlugForId(product.baseProductId)
    : undefined;
  const defaultColor = product && baseProductSlug
    ? productDefaultColorValue(product.defaultColor, baseProductSlug)
    : "Black";
  const color = requestedSocialCardColor(query, "Color", defaultColor);
  const pathname = `/product/${encodeURIComponent(id)}`;
  const shareParams = new URLSearchParams({ Color: color });

  return createSocialCardMetadata({
    alt: `${color} product with a bent.shop design`,
    canonicalPath: pathname,
    documentTitle: "Custom product | bent.shop",
    imagePath: productSocialCardPath(id, color),
    sharePath: `${pathname}?${shareParams.toString()}`,
  });
}

export default function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: ProductSearchParams;
}) {
  return (
    <main className="flex-1 bg-background px-[clamp(1rem,4vw,4rem)] pt-14 pb-4 text-primary">
      <ProductPageContent params={params} searchParams={searchParams} />
    </main>
  );
}
