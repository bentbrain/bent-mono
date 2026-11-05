import { getGuideAccess } from "@/lib/session";
import { allowRequest, sameOrigin } from "@/lib/request-guards";
import { cmsUpdateSchema } from "@/lib/guide-cms-types";
import {
  getCmsSnapshot,
  GuideConflictError,
  saveGuideDocument,
} from "@/lib/guide-store";

const headers = { "Cache-Control": "private, no-store" };
export async function GET() {
  const access = await getGuideAccess();
  if (!access) return new Response("Please sign in.", { status: 401, headers });
  if (!access.isHost)
    return new Response("Host access required.", { status: 403, headers });
  try {
    return Response.json(await getCmsSnapshot(), { headers });
  } catch {
    return new Response("The editor is unavailable. Please try again.", {
      status: 503,
      headers,
    });
  }
}
export async function PUT(request: Request) {
  if (!sameOrigin(request))
    return new Response("Request not allowed.", { status: 403, headers });
  const access = await getGuideAccess();
  if (!access) return new Response("Please sign in.", { status: 401, headers });
  if (!access.isHost)
    return new Response("Host access required.", { status: 403, headers });
  if (!allowRequest(`guide-edit:${access.userId}`, 120, 60 * 60_000))
    return new Response("Please wait before saving again.", {
      status: 429,
      headers,
    });
  const body = await request.text();
  if (body.length > 256_000)
    return new Response("The guide is too large to save.", {
      status: 413,
      headers,
    });
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return new Response("Invalid content.", { status: 400, headers });
  }
  const parsed = cmsUpdateSchema.safeParse(json);
  if (!parsed.success)
    return new Response(
      parsed.error.issues[0]?.message || "Please check the content.",
      { status: 400, headers },
    );
  try {
    const result = await saveGuideDocument(
      parsed.data.document,
      parsed.data.action,
      parsed.data.etag,
    );
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof GuideConflictError)
      return new Response(
        "The guide changed in another tab. Reload the editor before saving.",
        { status: 409, headers },
      );
    return new Response(
      "Your changes could not be saved. They are still in this editor; please try again.",
      { status: 503, headers },
    );
  }
}
