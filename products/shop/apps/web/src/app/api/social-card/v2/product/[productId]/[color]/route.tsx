import { getCachedProductRecord } from "@/lib/product-record-data";
import { socialCardImageResponse } from "@/server/social-card-image";

export async function GET(
  request: Request,
  context: {
    params: Promise<{ color: string; productId: string }>;
  },
) {
  const { color, productId } = await context.params;
  const requestedColor = imageColor(color);
  if (!requestedColor || productId.length > 128) {
    return new Response(null, { status: 404 });
  }

  const product = await getCachedProductRecord(productId);
  if (!product) return new Response(null, { status: 404 });
  return await socialCardImageResponse(request, product, requestedColor) ??
    new Response(null, { status: 404 });
}

function imageColor(value: string) {
  return value.endsWith(".png") ? value.slice(0, -4) : undefined;
}
