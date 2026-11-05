import { connection, NextResponse } from "next/server";

import { getForeverTeeProduct } from "@/lib/product-data";
import { getCachedProductRecord } from "@/lib/product-record-data";
import { BASE_PRODUCT_ID } from "@/lib/products";

const NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
};

export async function GET() {
  await connection();
  try {
    const productRecord = await getCachedProductRecord(BASE_PRODUCT_ID);
    if (
      productRecord?.designId !== null ||
      productRecord.id !== productRecord.baseProductId
    ) {
      return NextResponse.json(
        { available: false },
        { headers: NO_STORE_HEADERS },
      );
    }

    const product = await getForeverTeeProduct(
      {},
      productRecord.shopifyHandle,
    );
    const available =
      product?.adjacentVariants.some((variant) => variant.availableForSale) === true;
    return NextResponse.json({ available }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json(
      { available: false },
      { headers: NO_STORE_HEADERS, status: 503 },
    );
  }
}
