import "@tanstack/react-start/server-only";
import { ProductFamilySchema } from "@forever-tee/contracts";
import { Schema } from "effect";
import { baseProductSlugForId } from "@forever-tee/contracts/product-projection";
import { productQueryWithDefaultColor } from "@/lib/product-params";
import { getForeverTeeProduct } from "@/lib/product-data";
import { env } from "./runtime-env";
import type { ConfiguredProductFamilyEntry } from "@/components/configured-product-family";

export async function loadProductFamily(
  id: string,
  query: Record<string, string>,
) {
  const response = await fetch(
    new URL(
      `/v1/products/${encodeURIComponent(id)}/family`,
      env.FOREVER_TEE_API_URL,
    ),
    { redirect: "manual", signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) throw new Error("The product could not be loaded.");
  const records = Schema.decodeUnknownSync(ProductFamilySchema)(
    await response.json(),
  );
  const entries: Omit<
    ConfiguredProductFamilyEntry,
    "fulfilmentEstimateContent"
  >[] = [];
  for (const record of records) {
    const baseProductSlug = baseProductSlugForId(record.baseProductId);
    const revision = record.designRevisionId ?? record.preparationId;
    if (!baseProductSlug || !record.designId || !revision)
      throw new Error("The configured product revision could not be loaded.");
    const product = await getForeverTeeProduct(
      productQueryWithDefaultColor(
        record.id === id ? query : {},
        record.defaultColor,
        baseProductSlug,
      ),
      record.shopifyHandle,
    );
    if (!product) throw new Error("The product could not be loaded.");
    entries.push({
      baseProductSlug,
      designId: record.designId,
      designRevisionId: revision,
      defaultColor: record.defaultColor,
      product,
      productId: record.id,
    });
  }
  if (
    !entries.some((entry) => entry.productId === id) ||
    entries.length !== records.length
  )
    throw new Error("The product family could not be loaded.");
  return { entries, initialProductId: id };
}
