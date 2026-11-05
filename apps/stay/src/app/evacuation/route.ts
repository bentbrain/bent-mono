import { getGuideAccess } from "@/lib/session";
import { getPrivateGuideAsset } from "@/lib/private-guide-assets";

export async function GET() {
  if (!(await getGuideAccess()))
    return new Response("Unauthorized", { status: 401 });
  return getPrivateGuideAsset("evacuation");
}
