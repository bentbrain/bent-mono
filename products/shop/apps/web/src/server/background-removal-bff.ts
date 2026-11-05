import "server-only";

import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";

import { MAX_DESIGN_SOURCE_BYTES } from "@forever-tee/contracts/limits";

import { env } from "@/env";
import { anonymousOwner } from "@/server/anonymous-session";
import {
  acceptsSameOriginMutation,
  hasAbuseClearance,
  readMutationBody,
  workerHeaders,
} from "@/server/design-draft-bff-core";

const MAX_PREVIEW_SOURCE_BYTES = MAX_DESIGN_SOURCE_BYTES;

export async function backgroundRemovalBff(request: Request) {
  if (!acceptsSameOriginMutation(request)) return error(403, "BAD_REQUEST", "A same-origin request is required.");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "image/jpeg") return error(415, "UNSUPPORTED_MEDIA_TYPE", "Upload a JPEG image.");
  const declared = request.headers.get("content-length");
  if (!declared || !/^\d+$/.test(declared)) return error(411, "BAD_REQUEST", "A valid Content-Length is required.");
  const declaredLength = Number(declared);
  if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0 || declaredLength > MAX_PREVIEW_SOURCE_BYTES) {
    return error(413, "PAYLOAD_TOO_LARGE", "The preview image is too large.");
  }
  const { ownerId } = await anonymousOwner();
  if (!await hasAbuseClearance(request, ownerId, env.FOREVER_TEE_API_SHARED_SECRET)) {
    return error(403, "CHALLENGE_REQUIRED", "Restart the camera to complete the security check.");
  }
  const body = await readMutationBody(request, MAX_PREVIEW_SOURCE_BYTES);
  if (body?.byteLength !== declaredLength) {
    return error(400, "BAD_REQUEST", "The preview image length is invalid.");
  }
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  let upstream: Response;
  try {
    upstream = await fetch(
      new URL("/v2/background-removal?quality=preview", env.FOREVER_TEE_API_URL),
      {
        body,
        headers: workerHeaders(request, ownerId, env.FOREVER_TEE_API_SHARED_SECRET, requestId),
        method: "POST",
        redirect: "manual",
      },
    );
  } catch (cause) {
    console.error("[bent.shop BFF] upstream request failed", {
      requestId, operation: "background_removal", ...safeErrorDetails(cause),
      durationMs: Math.round(performance.now() - startedAt),
    });
    return Response.json({ error: { code: "UPSTREAM_UNAVAILABLE", message: "The design service is unavailable." } }, {
      status: 502, headers: { "Cache-Control": "private, no-store", "x-request-id": requestId },
    });
  }
  const durationMs = Math.round(performance.now() - startedAt);
  const log = upstream.status >= 500 ? console.error : upstream.status >= 400 ? console.warn : console.info;
  log("[bent.shop BFF] upstream request", { requestId, operation: "background_removal", durationMs, status: upstream.status });
  const headers = new Headers({ "Cache-Control": "private, no-store", "x-request-id": requestId });
  headers.set("server-timing", `${upstream.headers.get("server-timing") ?? ""}${upstream.headers.has("server-timing") ? ", " : ""}bff;dur=${durationMs.toString()}`);
  const upstreamType = upstream.headers.get("content-type");
  if (upstreamType) headers.set("content-type", upstreamType);
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(upstream.body, { headers, status: upstream.status });
}

function error(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}
