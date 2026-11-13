import {
  ANONYMOUS_SESSION_COOKIE,
  anonymousOwnerId,
  createAnonymousSessionToken,
} from "../../../web/src/server/anonymous-session-core";
import {
  CONTENT_DECLARATION_COOKIE,
  CONTENT_DECLARATION_FIELD,
  signContentDeclaration,
  verifyContentDeclaration,
} from "../../../web/src/server/content-declaration-core";
import {
  DEVELOPMENT_TURNSTILE_HOSTNAMES,
  PRODUCTION_TURNSTILE_HOSTNAMES,
  abuseClearanceCookie,
  acceptsSameOriginMutation,
  createAbuseClearance,
  forwardedWorkerHeaders,
  hasAbuseClearance,
  readMutationBody,
  validateMutationBody,
  verifyTurnstileToken,
  workerHeaders,
} from "../../../web/src/server/design-draft-bff-core";
import { MAX_DESIGN_SOURCE_BYTES } from "@forever-tee/contracts/limits";

export interface BffRuntime {
  readonly apiOrigin: string;
  readonly sharedSecret: string;
  readonly turnstileSecret: string;
  readonly fetcher: typeof fetch;
}
const UUID = "[a-f0-9-]{36}";

export function createBff(runtime: BffRuntime) {
  const apiOrigin = new URL(runtime.apiOrigin);
  return async function bff(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!acceptsSameOriginMutation(request))
      return error(403, "BAD_REQUEST", "A same-origin request is required.");
    const existing = cookie(request, ANONYMOUS_SESSION_COOKIE);
    const token =
      existing && /^[A-Za-z0-9_-]{43}$/.test(existing)
        ? existing
        : createAnonymousSessionToken();
    const owner = await anonymousOwnerId(token);
    const session =
      token !== existing
        ? `${ANONYMOUS_SESSION_COOKIE}=${token}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`
        : undefined;
    const finish = (response: Response) => {
      const headers = new Headers(response.headers);
      if (session) headers.append("set-cookie", session);
      headers.set("cache-control", "private, no-store");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };
    if (
      url.pathname === "/api/content-declaration" &&
      request.method === "POST"
    ) {
      const bytes = await readMutationBody(request, 16 * 1024);
      if (!bytes)
        return finish(
          error(413, "PAYLOAD_TOO_LARGE", "The declaration is too large."),
        );
      const form = await new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: bytes,
      }).formData();
      if (form.get(CONTENT_DECLARATION_FIELD) !== "accepted")
        return finish(
          error(400, "BAD_REQUEST", "The content declaration is required."),
        );
      const headers = new Headers();
      headers.append(
        "set-cookie",
        `${CONTENT_DECLARATION_COOKIE}=${await signContentDeclaration(owner, runtime.sharedSecret)}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax`,
      );
      if (request.headers.get("accept")?.includes("application/json"))
        return finish(new Response(null, { status: 204, headers }));
      headers.set("location", new URL("/create/camera", url).toString());
      return finish(new Response(null, { status: 303, headers }));
    }
    const prefixes = [
      ["/api/design-drafts", "/v2/design-drafts"],
      ["/api/configured-products", "/v2/configured-products"],
      ["/api/configured-product-families", "/v2/configured-product-families"],
    ];
    for (const [incoming, outgoing] of prefixes) {
      if (
        !incoming ||
        !outgoing ||
        !(url.pathname === incoming || url.pathname.startsWith(`${incoming}/`))
      )
        continue;
      const body = await validateMutationBody(request);
      if (!body.ok) return finish(error(body.status, body.code, body.message));
      const creation =
        incoming === "/api/design-drafts" &&
        url.pathname === incoming &&
        request.method === "POST";
      const uploadGrant =
        url.pathname.endsWith("/upload-grants") && request.method === "POST";
      if (creation || uploadGrant) {
        const declaration = cookie(request, CONTENT_DECLARATION_COOKIE);
        if (
          !declaration ||
          !(await verifyContentDeclaration(
            declaration,
            owner,
            runtime.sharedSecret,
          ))
        ) {
          return finish(
            error(
              403,
              "DECLARATION_REQUIRED",
              "Accept the content declaration before uploading an image.",
            ),
          );
        }
      }
      const freshProof =
        creation || (uploadGrant && request.headers.has("x-turnstile-token"));
      const challenged = freshProof
        ? await verifyTurnstileToken(
            request.headers.get("x-turnstile-token"),
            runtime.turnstileSecret,
            request.headers.get("cf-connecting-ip") ?? undefined,
            runtime.fetcher,
            DEVELOPMENT_TURNSTILE_HOSTNAMES.has(url.hostname)
              ? DEVELOPMENT_TURNSTILE_HOSTNAMES
              : PRODUCTION_TURNSTILE_HOSTNAMES,
            false,
          )
        : !uploadGrant ||
          (await hasAbuseClearance(request, owner, runtime.sharedSecret));
      if (!challenged)
        return finish(
          error(403, "CHALLENGE_REQUIRED", "Please retry the request."),
        );
      const upstream = await upstreamFetch(
        `${outgoing}${url.pathname.slice(incoming.length)}${url.search}`,
        request,
        workerHeaders(
          request,
          owner,
          runtime.sharedSecret,
          crypto.randomUUID(),
        ),
        body.body,
      );
      const headers = forwardedWorkerHeaders(upstream);
      if (freshProof && (upstream.ok || uploadGrant))
        headers.append(
          "set-cookie",
          abuseClearanceCookie(
            await createAbuseClearance(owner, runtime.sharedSecret),
          ),
        );
      if (uploadGrant && upstream.ok) {
        const payload: unknown = await upstream.json();
        if (!isRecord(payload) || typeof payload["uploadUrl"] !== "string")
          return finish(
            error(
              502,
              "UPSTREAM_INVALID",
              "The upload service returned an invalid grant.",
            ),
          );
        const grant = new URL(payload["uploadUrl"]);
        if (
          grant.origin !== apiOrigin.origin ||
          grant.pathname !== "/v2/design-upload-grants"
        )
          return finish(
            error(
              502,
              "UPSTREAM_INVALID",
              "The upload service returned an invalid grant.",
            ),
          );
        payload["uploadUrl"] = new URL(
          `/api/design-upload-grants${grant.search}`,
          url,
        ).toString();
        return finish(
          Response.json(payload, { status: upstream.status, headers }),
        );
      }
      return finish(
        new Response(upstream.body, { status: upstream.status, headers }),
      );
    }
    if (
      url.pathname === "/api/design-upload-grants" &&
      request.method === "PUT"
    ) {
      const contentType = request.headers.get("content-type");
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(contentType ?? "")
      )
        return finish(
          error(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "Upload a JPEG, PNG or WebP image.",
          ),
        );
      const body = await readMutationBody(request, MAX_DESIGN_SOURCE_BYTES);
      if (!body)
        return finish(
          error(
            413,
            "PAYLOAD_TOO_LARGE",
            "Print artwork must be no larger than 20 MB.",
          ),
        );
      const headers = new Headers({
        "content-type": contentType ?? "",
        "content-length": String(body.byteLength),
      });
      const upstream = await upstreamFetch(
        `/v2/design-upload-grants${url.search}`,
        request,
        headers,
        body,
      );
      return finish(
        new Response(upstream.body, {
          status: upstream.status,
          headers: forwardedWorkerHeaders(upstream),
        }),
      );
    }
    const image = new RegExp(
      `^/api/configured-product-(image|lifestyle)/(?:current/)?(${UUID})/(?:(${UUID})/)?(black|white|cream)\\.(png|webp)$`,
    ).exec(url.pathname);
    if (image?.[2] && image[4]) {
      const [, view, productId, revision, colour, format] = image;
      const width = url.searchParams.get("width") ?? "1500";
      if (!["192", "384", "768", "960", "1200", "1500"].includes(width))
        return finish(new Response(null, { status: 400 }));
      const query = new URLSearchParams({ width, format: format ?? "webp" });
      if (revision) query.set("revision", revision);
      return media(
        `/v2/internal/configured-products/${productId}/images/${view === "lifestyle" ? "lifestyle" : "flat"}/${colour}?${query}`,
        request,
        false,
      );
    }
    const events = new RegExp(
      `^/api/configured-product-video/(${UUID})/events$`,
    ).exec(url.pathname);
    if (events?.[1])
      return media(
        `/v2/internal/configured-products/${events[1]}/story-video-events`,
        request,
        true,
      );
    const video = new RegExp(
      `^/api/configured-product-video/(${UUID})/(black|white|cream)\\.mp4$`,
    ).exec(url.pathname);
    if (video?.[1] && video[2])
      return media(
        `/v2/internal/configured-products/${video[1]}/story-videos/${video[2]}`,
        request,
        false,
      );
    const readiness = new RegExp(
      `^/api/product-purchase-readiness/(${UUID})$`,
    ).exec(url.pathname);
    if (readiness?.[1])
      return media(
        `/v2/internal/configured-products/${readiness[1]}/purchase-readiness`,
        request,
        false,
      );
    return finish(new Response(null, { status: 404 }));

    async function media(path: string, incoming: Request, stream: boolean) {
      if (!["GET", "HEAD"].includes(incoming.method))
        return new Response(null, { status: 405 });
      const response = await upstreamFetch(
        path,
        incoming,
        new Headers({ "x-forever-tee-service-secret": runtime.sharedSecret }),
      );
      if (
        stream &&
        response.ok &&
        !response.headers.get("content-type")?.startsWith("text/event-stream")
      )
        return finish(new Response(null, { status: 502 }));
      const headers = new Headers({
        "cache-control": stream
          ? "private, no-store, no-transform"
          : "private, no-store",
        "cdn-cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      for (const key of [
        "content-type",
        "content-length",
        "etag",
        "retry-after",
        "server-timing",
      ]) {
        const value = response.headers.get(key);
        if (value) headers.set(key, value);
      }
      if (stream) headers.set("x-accel-buffering", "no");
      if (session) headers.append("set-cookie", session);
      return new Response(incoming.method === "HEAD" ? null : response.body, {
        status: response.status,
        headers,
      });
    }
    async function upstreamFetch(
      path: string,
      incoming: Request,
      headers: Headers,
      body?: Uint8Array,
    ) {
      try {
        return await runtime.fetcher(new URL(path, apiOrigin), {
          method: incoming.method,
          headers,
          redirect: "manual",
          signal: path.endsWith("story-video-events")
            ? incoming.signal
            : AbortSignal.any([incoming.signal, AbortSignal.timeout(180_000)]),
          ...(body && !["GET", "HEAD"].includes(incoming.method)
            ? { body: new Uint8Array(body).buffer }
            : {}),
        });
      } catch {
        return error(
          502,
          "UPSTREAM_UNAVAILABLE",
          "The design service is unavailable.",
        );
      }
    }
  };
}
function cookie(request: Request, name: string) {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function error(status: number, code: string, message: string) {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
