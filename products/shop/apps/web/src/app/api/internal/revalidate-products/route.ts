import { createHash, timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";
import { env } from "@/env";

export function POST(request: Request) {
  const provided = request.headers.get("x-forever-tee-service-secret");
  if (!provided || !timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(env.FOREVER_TEE_API_SHARED_SECRET).digest(),
  )) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  // Family caches may be indexed by any sibling product. Expire their shared
  // tag so a takedown cannot leave a cached public product/family page behind.
  revalidateTag("product-records", { expire: 0 });
  revalidateTag("fulfilment-estimates", { expire: 0 });
  return Response.json({ revalidated: true }, { headers: { "Cache-Control": "no-store" } });
}
