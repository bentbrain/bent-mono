import "server-only";

import { env } from "@/env";

export async function productPurchaseReadiness(request: Request) {
  const productId = /^\/api\/product-purchase-readiness\/([0-9a-f-]{36})$/.exec(new URL(request.url).pathname)?.[1];
  const noStore = { "Cache-Control": "private, no-store" };
  if (!productId) return new Response(null, { status: 404, headers: noStore });
  try {
    const response = await fetch(new URL(`/v2/internal/configured-products/${productId}/purchase-readiness`, env.FOREVER_TEE_API_URL), {
      cache: "no-store",
      headers: { "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET },
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]),
    });
    if (!response.ok) return new Response(null, { status: response.status === 404 ? 404 : 503, headers: noStore });
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !("ready" in payload) || typeof payload.ready !== "boolean") {
      return new Response(null, { status: 502, headers: noStore });
    }
    // This is public preparation state, never authorization to purchase.
    // Share pending status for one second to absorb viewers of a new design;
    // cache completed preparation longer. Cart writes still verify live identity.
    const retry = "retryArtwork" in payload ? payload.retryArtwork : undefined;
    const retryArtwork = typeof retry === "object" && retry !== null && "designId" in retry && "artworkJobId" in retry &&
      typeof retry.designId === "string" && typeof retry.artworkJobId === "string"
      ? { designId: retry.designId, artworkJobId: retry.artworkJobId } : undefined;
    return Response.json({ ready: payload.ready, ...(retryArtwork ? { retryArtwork } : {}) }, {
      headers: { "Cache-Control": payload.ready ? "public, max-age=0, s-maxage=300" : "public, max-age=0, s-maxage=1" },
    });
  } catch {
    return new Response(null, { status: 503, headers: noStore });
  }
}
