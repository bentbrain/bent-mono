import { getGuideAccess } from "@/lib/session";
import { sameOrigin } from "@/lib/request-guards";

const headers = { "Cache-Control": "private, no-store" };
function error(message: string, status: number) {
  return Response.json({ error: message }, { status, headers });
}

export async function GET() {
  const access = await getGuideAccess();
  if (!access) return error("Please sign in with your invited account.", 401);
  return error(
    "Use home controls while connected to the apartment Wi-Fi.",
    410,
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return error("Request not allowed.", 403);
  return GET();
}
