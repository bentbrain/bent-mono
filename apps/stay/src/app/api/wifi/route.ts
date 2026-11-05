import { getGuideAccess } from "@/lib/session";
import { allowRequest, sameOrigin } from "@/lib/request-guards";
import { wifiPasswordSchema } from "@/lib/wifi-types";
import { getWifiPassword, saveWifiPassword } from "@/lib/home-control-service";

const headers = { "Cache-Control": "private, no-store" };
export const maxDuration = 30;
function error(message: string, status: number) {
  return Response.json({ error: message }, { status, headers });
}

export async function GET() {
  const access = await getGuideAccess();
  if (!access) return error("Please sign in with your invited account.", 401);
  if (!allowRequest(`wifi-read:${access.userId}`, 120, 60_000))
    return error("Try again shortly.", 429);
  try {
    return Response.json(await getWifiPassword(), { headers });
  } catch {
    return error("Wi-Fi details are temporarily unavailable.", 503);
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return error("Request not allowed.", 403);
  const access = await getGuideAccess();
  if (!access) return error("Please sign in with your invited account.", 401);
  if (!access.isHost) return error("Host access required.", 403);
  if (!allowRequest(`wifi-write:${access.userId}`, 10, 60_000))
    return error("Try again shortly.", 429);
  if (Number(request.headers.get("content-length")) > 1024)
    return error("Invalid request.", 413);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return error("JSON required.", 415);
  const reader = request.body?.getReader();
  if (!reader) return error("Invalid request.", 400);
  let body: unknown;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) {
        await reader.cancel();
        return error("Invalid request.", 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return error("Invalid request.", 400);
  } finally {
    reader.releaseLock();
  }
  const parsed = wifiPasswordSchema.safeParse(body);
  if (!parsed.success)
    return error("Enter a password between 8 and 64 characters.", 400);
  try {
    await saveWifiPassword(parsed.data);
    return Response.json({ ok: true }, { headers });
  } catch {
    return error("The password couldn't be saved. Try again.", 503);
  }
}
