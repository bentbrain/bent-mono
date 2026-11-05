import type { BaseProductSlug } from "@forever-tee/contracts/product-projection";
import { Suspense } from "react";

import { ProductFulfilmentEstimate } from "@/components/product-fulfilment-estimate";
import { getCachedFulfilmentEstimate } from "@/lib/fulfilment-estimate-data";

export function DeferredFulfilmentEstimate({ baseProductSlug }: {
  baseProductSlug: BaseProductSlug;
}) {
  return (
    // Reserve both existing estimate lines, including when a provider fails.
    <div className="min-h-10" data-fulfilment-slot>
      <Suspense fallback={null}>
        <FulfilmentEstimateData baseProductSlug={baseProductSlug} />
      </Suspense>
    </div>
  );
}

async function FulfilmentEstimateData({ baseProductSlug }: {
  baseProductSlug: BaseProductSlug;
}) {
  const estimate = await getCachedFulfilmentEstimate(baseProductSlug)
    .catch(() => undefined);
  return <ProductFulfilmentEstimate estimate={estimate} />;
}
