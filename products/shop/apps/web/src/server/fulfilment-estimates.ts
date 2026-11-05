import "server-only";

import type { BaseProductSlug } from "@forever-tee/contracts/product-projection";
import { Schema } from "effect";
import { fetch } from "undici";

import { env } from "@/env";
import type {
  BusinessDayEstimate,
  FulfilmentEstimate,
} from "@/lib/fulfilment-estimate";

const PRINTIFY_NETWORK_STATUS_URL =
  "https://printify.com/wp-json/wp/v2/pages?slug=network-fulfillment-status";

const NetworkStatusPageSchema = Schema.Array(Schema.Struct({
  content: Schema.Struct({ rendered: Schema.String }),
}));

const CatalogueSchema = Schema.Struct({
  variants: Schema.Array(Schema.Struct({
    standardShippingToAustralia: Schema.Struct({
      handlingDaysFrom: Schema.NonNegativeInt,
      handlingDaysTo: Schema.NonNegativeInt,
    }),
  })),
});

export async function loadFulfilmentEstimate(
  baseProductSlug: BaseProductSlug,
  fetcher: typeof fetch = fetch,
): Promise<FulfilmentEstimate> {
  const [production, standardDelivery] = await Promise.all([
    loadProductionEstimate(fetcher),
    loadStandardDeliveryEstimate(baseProductSlug, fetcher),
  ]);

  return {
    ...(production ? { production } : {}),
    ...(standardDelivery ? { standardDelivery } : {}),
  };
}

export async function loadProductionEstimate(fetcher: typeof fetch = fetch) {
  try {
    const response = await fetcher(PRINTIFY_NETWORK_STATUS_URL, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const payload = Schema.decodeUnknownSync(NetworkStatusPageSchema)(
      await response.json(),
    );
    const page = payload[0];
    return page
      ? parsePrintProviderProductionEstimate(page.content.rendered)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function loadStandardDeliveryEstimate(
  baseProductSlug: BaseProductSlug,
  fetcher: typeof fetch = fetch,
) {
  const url = new URL(
    "/v2/internal/catalogue",
    `${env.FOREVER_TEE_API_URL.replace(/\/$/, "")}/`,
  );
  url.searchParams.set("baseProduct", baseProductSlug);
  try {
    const response = await fetcher(url, {
      headers: {
        "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET,
      },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const catalogue = Schema.decodeUnknownSync(CatalogueSchema)(
      await response.json(),
    );
    return catalogueDeliveryRange(catalogue.variants);
  } catch {
    return undefined;
  }
}

function catalogueDeliveryRange(
  variants: readonly {
    readonly standardShippingToAustralia: {
      readonly handlingDaysFrom: number;
      readonly handlingDaysTo: number;
    };
  }[],
): BusinessDayEstimate | undefined {
  if (variants.length === 0) return undefined;
  let minimumBusinessDays = Number.POSITIVE_INFINITY;
  let maximumBusinessDays = 0;
  for (const variant of variants) {
    const shipping = variant.standardShippingToAustralia;
    if (shipping.handlingDaysTo < shipping.handlingDaysFrom) return undefined;
    minimumBusinessDays = Math.min(
      minimumBusinessDays,
      shipping.handlingDaysFrom,
    );
    maximumBusinessDays = Math.max(
      maximumBusinessDays,
      shipping.handlingDaysTo,
    );
  }
  if (!Number.isFinite(minimumBusinessDays)) return undefined;
  return { maximumBusinessDays, minimumBusinessDays };
}

export function parsePrintProviderProductionEstimate(
  content: string,
): BusinessDayEstimate | undefined {
  const rows = content.match(/<tr\b[\s\S]*?<\/tr>/giu) ?? [];
  for (const row of rows) {
    if (!/<td\b[^>]*>\s*The Print Bar\s*<\/td>/iu.test(row)) continue;
    const range =
      /<td\b[^>]*data-title=["']Production time estimate["'][^>]*>\s*(\d+)\s*-\s*(\d+)\s+business days\s*<\/td>/iu.exec(
        row,
      );
    const minimumBusinessDays = range?.[1]
      ? Number.parseInt(range[1], 10)
      : Number.NaN;
    const maximumBusinessDays = range?.[2]
      ? Number.parseInt(range[2], 10)
      : Number.NaN;
    if (
      Number.isSafeInteger(minimumBusinessDays) &&
      Number.isSafeInteger(maximumBusinessDays) &&
      minimumBusinessDays >= 0 &&
      maximumBusinessDays >= minimumBusinessDays
    ) {
      return { maximumBusinessDays, minimumBusinessDays };
    }
  }
  return undefined;
}
