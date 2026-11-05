import { Data, Effect, Either } from "effect";

import { AppConfigService } from "@/lib/config";
import { randomToken } from "@/lib/crypto";
import { registerOAuthClient } from "@/lib/db/store";
import {
  dynamicClientRegistrationSchema,
  isAllowedOAuthRedirect,
  oauthErrorResponse,
} from "@/lib/oauth";
import { runAppResponse } from "@/lib/runtime";

export const runtime = "nodejs";

class RequestJsonError extends Data.TaggedError("RequestJsonError")<{
  message: string;
}> {}

export function POST(request: Request): Promise<Response> {
  const program = Effect.gen(function* () {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > 16_384) {
      return oauthErrorResponse("invalid_client_metadata", "The client metadata is too large.", 413);
    }
    const bodyResult = yield* Effect.either(
      Effect.tryPromise({
        try: async () => {
          const bodyText = await request.text();
          if (bodyText.length > 16_384) {
            throw new Error("The client metadata is too large.");
          }
          const body: unknown = JSON.parse(bodyText);
          return body;
        },
        catch: (error) =>
          new RequestJsonError({
            message:
              error instanceof Error && error.message.includes("too large")
                ? error.message
                : "The request body must be valid JSON.",
          }),
      })
    );
    if (Either.isLeft(bodyResult)) {
      return oauthErrorResponse("invalid_client_metadata", bodyResult.left.message);
    }

    const parsed = dynamicClientRegistrationSchema.safeParse(bodyResult.right);
    if (!parsed.success) {
      return oauthErrorResponse("invalid_client_metadata", "The client metadata is invalid.");
    }

    const config = yield* AppConfigService;
    if (
      parsed.data.redirect_uris.some(
        (redirectUri) => !isAllowedOAuthRedirect(redirectUri, config.allowLocalOAuthRedirects)
      )
    ) {
      return oauthErrorResponse(
        "invalid_redirect_uri",
        "Redirect URIs must be ChatGPT connector callbacks or explicitly enabled local development callbacks."
      );
    }
    if (parsed.data.grant_types && !parsed.data.grant_types.includes("authorization_code")) {
      return oauthErrorResponse(
        "invalid_client_metadata",
        "The authorization_code grant type is required."
      );
    }
    if (parsed.data.response_types && !parsed.data.response_types.includes("code")) {
      return oauthErrorResponse("invalid_client_metadata", "The code response type is required.");
    }

    const clientId = randomToken("tbc_client_");
    yield* registerOAuthClient(clientId, parsed.data.redirect_uris, parsed.data.client_name ?? null);
    yield* Effect.logInfo("oauth.client.registered").pipe(
      Effect.annotateLogs({ clientId, redirectCount: parsed.data.redirect_uris.length })
    );
    return Response.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: parsed.data.client_name,
        redirect_uris: parsed.data.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      {
        status: 201,
        headers: { "cache-control": "no-store" },
      }
    );
  });

  return runAppResponse("route.oauth.register", program, {
    "http.request.method": request.method,
  });
}
