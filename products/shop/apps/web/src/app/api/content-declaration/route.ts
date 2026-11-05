import { NextResponse } from "next/server";

import { env } from "@/env";
import { anonymousOwner } from "@/server/anonymous-session";
import {
  CONTENT_DECLARATION_COOKIE,
  CONTENT_DECLARATION_FIELD,
  contentDeclarationCookieOptions,
  signContentDeclaration,
} from "@/server/content-declaration-core";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "A same-origin request is required." }, { status: 403 });
  }
  const form = await request.formData();
  if (form.get(CONTENT_DECLARATION_FIELD) !== "accepted") {
    if (acceptsJson(request)) {
      return Response.json(
        { error: "The content declaration is required." },
        { status: 400 },
      );
    }
    return NextResponse.redirect(new URL("/create", request.url), 303);
  }
  const { ownerId } = await anonymousOwner();
  const response = acceptsJson(request)
    ? new NextResponse(null, { status: 204 })
    : NextResponse.redirect(new URL("/create/camera", request.url), 303);
  response.cookies.set(
    CONTENT_DECLARATION_COOKIE,
    await signContentDeclaration(ownerId, env.FOREVER_TEE_API_SHARED_SECRET),
    contentDeclarationCookieOptions,
  );
  return response;
}

function acceptsJson(request: Request) {
  return request.headers.get("accept")?.includes("application/json") === true;
}

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin === new URL(request.url).origin;
}
