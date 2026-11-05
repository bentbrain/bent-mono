import "server-only";

import type { BaseProductSlug } from "@forever-tee/contracts/product-projection";
import { cacheLife, cacheTag } from "next/cache";

import type {
  BusinessDayEstimate,
  FulfilmentEstimate,
} from "@/lib/fulfilment-estimate";
import { LAUNCH_BASE_PRODUCTS } from "@/lib/products";
import {
  loadProductionEstimate,
  loadStandardDeliveryEstimate,
} from "@/server/fulfilment-estimates";

export async function getCachedFulfilmentEstimate(
  baseProductSlug: BaseProductSlug,
): Promise<FulfilmentEstimate> {
  const [production, standardDelivery] = await Promise.all([
    getCachedProductionEstimate(),
    getCachedStandardDeliveryEstimate(baseProductSlug),
  ]);
  return {
    ...(production ? { production } : {}),
    ...(standardDelivery ? { standardDelivery } : {}),
  };
}

export async function getCachedStorefrontFulfilmentEstimate(): Promise<
  FulfilmentEstimate
> {
  const [production, standardDeliveryRanges] = await Promise.all([
    getCachedProductionEstimate(),
    Promise.all(
      LAUNCH_BASE_PRODUCTS.map(({ slug }) =>
        getCachedStandardDeliveryEstimate(slug)
      ),
    ),
  ]);
  const standardDelivery = combinedRange(standardDeliveryRanges);
  return {
    ...(production ? { production } : {}),
    ...(standardDelivery ? { standardDelivery } : {}),
  };
}

async function getCachedProductionEstimate() {
  "use cache: remote";
  cacheTag("fulfilment-estimates");
  const estimate = await loadProductionEstimate();
  cacheLife(estimate
    ? { stale: 300, revalidate: 3_600, expire: 7_200 }
    : { stale: 0, revalidate: 30, expire: 60 });
  return estimate;
}

async function getCachedStandardDeliveryEstimate(
  baseProductSlug: BaseProductSlug,
) {
  "use cache: remote";
  cacheTag("fulfilment-estimates");
  const estimate = await loadStandardDeliveryEstimate(baseProductSlug);
  cacheLife(estimate
    ? { stale: 300, revalidate: 3_600, expire: 7_200 }
    : { stale: 0, revalidate: 30, expire: 60 });
  return estimate;
}

function combinedRange(
  ranges: readonly (BusinessDayEstimate | undefined)[],
): BusinessDayEstimate | undefined {
  const availableRanges = ranges.filter((range) => range !== undefined);
  if (availableRanges.length === 0) return undefined;
  return {
    maximumBusinessDays: Math.max(
      ...availableRanges.map(({ maximumBusinessDays }) => maximumBusinessDays),
    ),
    minimumBusinessDays: Math.min(
      ...availableRanges.map(({ minimumBusinessDays }) => minimumBusinessDays),
    ),
  };
}
