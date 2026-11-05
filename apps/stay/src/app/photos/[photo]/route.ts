import { getGuideAccess } from "@/lib/session";
import { getPrivateGuideAsset } from "@/lib/private-guide-assets";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ photo: string }> },
) {
  if (!(await getGuideAccess()))
    return new Response("Unauthorized", { status: 401 });
  const { photo } = await params;
  if (photo === "evacuation") return new Response("Not found", { status: 404 });
  return getPrivateGuideAsset(photo);
}
