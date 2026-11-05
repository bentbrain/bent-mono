import { getGuideAccess } from "@/lib/session";
import { getPrivateHomeControlsUrl } from "@/lib/home-controls-config";

export async function GET() {
  if (!(await getGuideAccess()))
    return new Response("Unauthorized", { status: 401 });
  let value: string | undefined;
  try {
    value = await getPrivateHomeControlsUrl();
  } catch {
    return new Response("Controls unavailable", { status: 503 });
  }
  if (!value) return new Response("Controls unavailable", { status: 503 });
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return new Response("Controls unavailable", { status: 503 });
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return new Response("Controls unavailable", { status: 503 });
  return new Response(null, {
    status: 302,
    headers: { Location: url.href, "Cache-Control": "private, no-store" },
  });
}
