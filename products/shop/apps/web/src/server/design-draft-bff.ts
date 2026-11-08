import "server-only";

import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";

import { DeleteDesignResponseSchema } from "@forever-tee/contracts";
import { Schema } from "effect";
import { revalidateTag } from "next/cache";

import { env } from "@/env";
import { anonymousOwner } from "@/server/anonymous-session";
import {
  abuseClearanceCookie,
  acceptsSameOriginMutation,
  createAbuseClearance,
  forwardedWorkerHeaders,
  hasAbuseClearance,
  requestClientIp,
  validateMutationBody,
  verifyTurnstileToken,
  workerHeaders,
} from "@/server/design-draft-bff-core";

export async function designDraftBff(request: Request) {
  return capabilityBff(request, "/api/design-drafts", "/v2/design-drafts");
}

export async function configuredProductBff(request: Request) {
  return capabilityBff(request, "/api/configured-products", "/v2/configured-products");
}

export async function configuredProductFamilyBff(request: Request) {
  return capabilityBff(request, "/api/configured-product-families", "/v2/configured-product-families");
}

async function capabilityBff(
  request: Request,
  incomingPrefix: string,
  workerPrefix: string,
) {
  if (!acceptsSameOriginMutation(request)) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "A same-origin request is required." } },
      { status: 403 },
    );
  }
  const bodyResult = await validateMutationBody(request);
  if (!bodyResult.ok) {
    return Response.json(
      { error: { code: bodyResult.code, message: bodyResult.message } },
      { status: bodyResult.status },
    );
  }
  const incomingUrl = new URL(request.url);
  const { ownerId, created } = await anonymousOwner();
  // A just-created ownership session cannot have any saved designs. Keep all
  // other list shapes, cursors and operations behind the Worker boundary.
  if (created && request.method === "GET" &&
    incomingPrefix === "/api/design-drafts" &&
    incomingUrl.pathname === incomingPrefix && incomingUrl.search === "?page=1") {
    return Response.json(
      { items: [], nextCursor: null },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const isDraftCreation = request.method === "POST" &&
    incomingPrefix === "/api/design-drafts" &&
    incomingUrl.pathname === incomingPrefix;
  const isUploadGrant = request.method === "POST" &&
    incomingUrl.pathname.endsWith("/upload-grants");
  const hasFreshProof = isDraftCreation || (isUploadGrant && request.headers.has("x-turnstile-token"));
  const challengePassed = hasFreshProof
    ? await verifyTurnstileToken(
        request.headers.get("x-turnstile-token"),
        env.TURNSTILE_SECRET,
        requestClientIp(request),
      )
    : !isUploadGrant || await hasAbuseClearance(
        request,
        ownerId,
        env.FOREVER_TEE_API_SHARED_SECRET,
      );
  if (!challengePassed) {
    return Response.json(
      { error: { code: "CHALLENGE_REQUIRED", message: "Please retry the request." } },
      { status: 403 },
    );
  }
  const suffix = incomingUrl.pathname.slice(incomingPrefix.length);
  const workerUrl = new URL(
    `${workerPrefix}${suffix}${incomingUrl.search}`,
    `${env.FOREVER_TEE_API_URL.replace(/\/$/, "")}/`,
  );
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();
  const requestInit: RequestInit = {
    cache: "no-store",
    method: request.method,
    headers: workerHeaders(
      request,
      ownerId,
      env.FOREVER_TEE_API_SHARED_SECRET,
      requestId,
    ),
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    requestInit.body = new Uint8Array(bodyResult.body).buffer;
  }
  let response: Response;
  try {
    response = await fetch(workerUrl, requestInit);
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    console.error("[bent.shop BFF] upstream request failed", {
      durationMs,
      ...safeErrorDetails(error),
      method: request.method,
      operation: capabilityOperation(request, incomingPrefix),
      requestId,
    });
    return Response.json(
      { error: { code: "UPSTREAM_UNAVAILABLE", message: "The design service is unavailable." } },
      {
        headers: {
          "Cache-Control": "private, no-store",
          "Server-Timing": `bff;dur=${durationMs.toString()}`,
          "x-request-id": requestId,
        },
        status: 502,
      },
    );
  }
  const durationMs = Math.round(performance.now() - startedAt);
  if (request.method === "DELETE" && response.ok && incomingPrefix === "/api/design-drafts") {
    const deleted = Schema.decodeUnknownSync(DeleteDesignResponseSchema)(await response.clone().json());
    revalidateTag(`design-record:${deleted.id}`, { expire: 0 });
    revalidateTag(`design-artwork:${deleted.id}`, { expire: 0 });
    for (const id of deleted.productIds) {
      revalidateTag(`product-record:${id}`, { expire: 0 });
      revalidateTag(`product-family:${id}`, { expire: 0 });
    }
  }
  const headers = forwardedWorkerHeaders(response);
  headers.append("Server-Timing", `bff;dur=${durationMs.toString()}`);
  if (!headers.has("x-request-id")) headers.set("x-request-id", requestId);
  const log = response.status >= 500 ? console.error : response.status >= 400 ? console.warn : console.info;
  log("[bent.shop BFF] upstream request", {
    durationMs,
    method: request.method,
    operation: capabilityOperation(request, incomingPrefix),
    requestId,
    status: response.status,
  });
  if ((isDraftCreation && response.ok) || (isUploadGrant && hasFreshProof)) {
    headers.append(
      "Set-Cookie",
      abuseClearanceCookie(await createAbuseClearance(
        ownerId,
        env.FOREVER_TEE_API_SHARED_SECRET,
      )),
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function capabilityOperation(request: Request, incomingPrefix: string) {
  if (incomingPrefix === "/api/configured-product-families") {
    return "configured_product_family_creation";
  }
  if (incomingPrefix === "/api/configured-products") {
    return "configured_product_creation";
  }
  const path = new URL(request.url).pathname;
  if (path === incomingPrefix) return request.method === "GET" ? "saved_designs_read" : "design_draft_creation";
  if (path.endsWith("/upload-grants")) return "design_upload_grant";
  if (path.endsWith("/claim")) return "design_claim";
  if (request.method === "PATCH") return "design_settings_update";
  if (request.method === "DELETE") return "design_deletion";
  return "design_draft_read";
}
