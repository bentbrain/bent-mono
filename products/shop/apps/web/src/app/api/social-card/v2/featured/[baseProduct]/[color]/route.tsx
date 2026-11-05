import {
  baseProductSlugForId,
  type BaseProductSlug,
} from "@forever-tee/contracts/product-projection";

import { getCachedProductFamilyRecords } from "@/lib/product-record-data";
import { SAMPLE_PRODUCT_ID } from "@/lib/products";
import { socialCardImageResponse } from "@/server/social-card-image";

export async function GET(
  request: Request,
  context: {
    params: Promise<{ baseProduct: string; color: string }>;
  },
) {
  const { baseProduct, color } = await context.params;
  const requestedColor = imageColor(color);
  if (!isBaseProductSlug(baseProduct) || !requestedColor) {
    return new Response(null, { status: 404 });
  }

  const family = await getCachedProductFamilyRecords(SAMPLE_PRODUCT_ID);
  const product = family?.find(
    (candidate) => baseProductSlugForId(candidate.baseProductId) === baseProduct,
  );
  if (!product) return new Response(null, { status: 404 });
  return await socialCardImageResponse(request, product, requestedColor) ??
    new Response(null, { status: 404 });
}

function imageColor(value: string) {
  return value.endsWith(".png") ? value.slice(0, -4) : undefined;
}

function isBaseProductSlug(value: string): value is BaseProductSlug {
  return value === "staple-tee" || value === "cotton-tote";
}
