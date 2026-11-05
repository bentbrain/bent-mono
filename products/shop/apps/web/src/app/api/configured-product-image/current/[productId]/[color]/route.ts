import { productImageWidth } from "@/lib/product-image";
import { configuredProductImageResponse } from "@/server/configured-product-image-response";

export async function GET(
  request: Request,
  context: {
    params: Promise<{ color: string; productId: string }>;
  },
) {
  const width = productImageWidth(new URL(request.url).searchParams.get("width"));
  if (width === undefined) return new Response(null, { status: 400 });
  return configuredProductImageResponse({ ...await context.params, ...(request.method === "HEAD" ? {method:"HEAD"} : {}), ...(width === 1500 ? {} : { width }) });
}

export const HEAD = GET;
