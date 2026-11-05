import { Schema } from "effect";

import {
  ProductAvailabilitySchema,
  type ProductAvailability,
} from "@/lib/product-availability";

export async function getBaseProductAvailability(): Promise<ProductAvailability> {
  const response = await fetch("/api/product-availability", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Product availability could not be confirmed.");
  }
  return Schema.decodeUnknownSync(ProductAvailabilitySchema)(
    await response.json(),
  );
}
