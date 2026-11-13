import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { renderProductDisplay, RENDERER_VERSION, } from "@forever-tee/product-image-renderer";
import { boundedImageTransfer, executeProductImage, parseProductImageEvent } from "@forever-tee/product-image-renderer/execution";
import { env } from "@/env";
// Cache Components uses the default Node runtime; Sharp cannot run at the edge.
export const preferredRegion = "syd1";
export const maxDuration = 30;
function authorized(request: Request) {
    const provided = request.headers.get("x-forever-tee-service-secret");
    return Boolean(provided &&
        timingSafeEqual(createHash("sha256").update(provided).digest(), createHash("sha256").update(env.FOREVER_TEE_API_SHARED_SECRET).digest()));
}
export function GET(request: Request) {
    return authorized(request)
        ? Response.json({ rendererVersion: RENDERER_VERSION }, { headers: { "cache-control": "no-store" } })
        : new Response(null, { status: 401 });
}
export async function POST(request: Request) {
    if (!authorized(request))
        return new Response(null, { status: 401 });
    const body = await boundedImageTransfer(new Response(request.body), 2048).catch(() => undefined);
    if (!body)
        return new Response(null, { status: 413 });
    let event: unknown;
    try {
        event = JSON.parse(body.toString("utf8"));
    }
    catch {
        return new Response(null, { status: 400 });
    }
    const job = parseProductImageEvent(event);
    if (!job)
        return new Response(null, { status: 400 });
    const result = await executeProductImage(job, {
        apiUrl: env.FOREVER_TEE_API_URL,
        assetDirectory: join(process.cwd(), "public/mockups/lifestyle-v4"),
        render: renderProductDisplay,
    });
    return Response.json(result.body, { status: result.status, headers: result.headers ?? {} });
}
