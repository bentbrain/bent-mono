import "server-only";
import { get } from "@vercel/blob";

const privateGuideAssets = new Map([
  [
    "kitchen-cupboards",
    {
      pathname: "guide/assets/kitchen-cupboards.webp",
      contentType: "image/webp",
    },
  ],
  [
    "laundry",
    { pathname: "guide/assets/laundry.webp", contentType: "image/webp" },
  ],
  [
    "linen-cupboard",
    { pathname: "guide/assets/linen-cupboard.webp", contentType: "image/webp" },
  ],
  [
    "evacuation",
    { pathname: "guide/assets/evacuation.jpeg", contentType: "image/jpeg" },
  ],
]);

export async function getPrivateGuideAsset(name: string) {
  const asset = privateGuideAssets.get(name);
  if (!asset) return new Response("Not found", { status: 404 });
  try {
    const result = await get(asset.pathname, {
      access: "private",
      useCache: false,
    });
    if (!result || result.statusCode !== 200)
      return new Response("Asset unavailable", { status: 503 });
    return new Response(result.stream, {
      headers: {
        "Content-Type": asset.contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Asset unavailable", { status: 503 });
  }
}
