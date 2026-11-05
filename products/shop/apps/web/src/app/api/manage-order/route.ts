import { fetch } from "undici";
import { env } from "@/env";

const headers = {"Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer"};
export function GET(request: Request) { return proxy(request); }
export function POST(request: Request) { return proxy(request); }
export function HEAD() { return new Response(null, {status: 405, headers}); }
function sameOrigin(request: Request) {
  const url = new URL(request.url);
  // Next can normalize the internal URL to localhost. Host is the browser's
  // requested authority; never substitute an arbitrary forwarded host.
  const host = request.headers.get("host") ?? url.host;
  return request.headers.get("origin") === `${url.protocol}//${host}`;
}
async function proxy(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/u.test(authorization)) return Response.json({error: "ORDER_UNAVAILABLE"}, {status: 410, headers});
  if (request.method === "POST" && (!sameOrigin(request) || !request.headers.get("content-type")?.includes("application/json"))) return Response.json({error: "INVALID_REQUEST"}, {status: 403, headers});
  const body = request.method === "POST" ? await request.text() : undefined;
  if (body && body.length > 4000) return Response.json({error: "INVALID_REQUEST"}, {status: 400, headers});
  try {
    const result = await fetch(new URL("/v2/internal/manage-order", env.FOREVER_TEE_API_URL), {
      method: request.method, ...(body === undefined ? {} : {body}), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: {"content-type": "application/json", "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET, "x-order-management-capability": authorization.slice(7)},
    });
    return new Response(await result.text(), {status: result.status, headers: {...headers, "content-type": "application/json"}});
  } catch { return Response.json({error: "ORDER_UNAVAILABLE"}, {status: 503, headers}); }
}
