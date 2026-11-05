import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import type { BaseProductSlug } from "@forever-tee/contracts/product-projection";
import { MobileOnlyGate } from "@/components/mobile-only-gate";
import { ProductProjectionPreview } from "@/components/product-projection-preview";
import { DesignPageSkeleton } from "@/components/route-skeletons";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
};

export default function ProductProjectionPage({
  params,
}: {
  params: Promise<{ baseProduct: string; id: string }>;
}) {
  return (
    <Suspense fallback={<DesignPageSkeleton />}>
      <ProductProjectionContent params={params} />
    </Suspense>
  );
}

async function ProductProjectionContent({
  params,
}: {
  params: Promise<{ baseProduct: string; id: string }>;
}) {
  const { baseProduct, id } = await params;
  if (!isBaseProductSlug(baseProduct)) notFound();
  return (
    <MobileOnlyGate draftHandoff>
      <ProductProjectionPreview designId={id} slug={baseProduct} />
    </MobileOnlyGate>
  );
}

function isBaseProductSlug(value: string): value is BaseProductSlug {
  return value === "staple-tee" || value === "cotton-tote";
}
