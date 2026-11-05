import { baseProductSlugForId } from "@forever-tee/contracts/product-projection";
import { Suspense } from "react";
import { redirect } from "next/navigation";

import { SavedDesigns } from "@/components/saved-designs";
import { productDefaultColorValue } from "@/lib/product-params";
import { productProjectionMockupPath } from "@/lib/product-projection";
import { legacyFeaturedProductPath } from "@/lib/featured-products";
import { getCachedProductRecord } from "@/lib/product-record-data";
import { featuredProductsForRequest } from "@/server/featured-product";

type HomeSearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function Home({ searchParams }: { searchParams: HomeSearchParams }) {
  return (
    <main className="flex-1 bg-background px-[clamp(1rem,4vw,4rem)] pt-16 pb-4 text-primary">
      <h1 className="sr-only">bent.shop products</h1>
      <Suspense fallback={<LandingGridSkeleton />}>
        <LandingProducts searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function LandingProducts({ searchParams }: { searchParams: HomeSearchParams }) {
  const [query, featured] = await Promise.all([searchParams, featuredProductsForRequest()]);
  const legacyPath = legacyFeaturedProductPath(featured, query);
  if (legacyPath) redirect(legacyPath);
  const products = await Promise.all(featured.map(async product => {
    const record = await getCachedProductRecord(product.productId);
    const slug = record ? baseProductSlugForId(record.baseProductId) : undefined;
    const color = record && slug ? productDefaultColorValue(record.defaultColor, slug) : "Black";
    return { ...product, color, ...(!record?.designId && slug
      ? { mockupPath: productProjectionMockupPath(slug, color) } : {}) };
  }));
  return <SavedDesigns featured={products} />;
}

function LandingGridSkeleton() {
  return (
    <div role="status" aria-label="Loading products" className="mx-auto grid max-w-6xl grid-cols-3 gap-3 sm:gap-5">
      {[1, 2, 3].map(slot => (
        <div key={slot} className="aspect-square animate-pulse border border-dotted border-primary bg-surface motion-reduce:animate-none" />
      ))}
    </div>
  );
}
