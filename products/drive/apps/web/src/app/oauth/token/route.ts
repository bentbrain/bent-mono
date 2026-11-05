import { Data, Effect } from "effect";
import { z } from "zod";

import { AppConfigService } from "@/lib/config";
import { hashToken, pkceChallenge } from "@/lib/crypto";
import { exchangeAuthorizationCodeForTokens, rotateRefreshToken } from "@/lib/db/store";
import { hasDuplicateParameters, oauthErrorResponse } from "@/lib/oauth";
import { runAppResponse } from "@/lib/runtime";
import type { IssuedOAuthTokens } from "@/lib/token-service";
import { logOAuthTokensIssued, prepareOAuthTokens } from "@/lib/token-service";

export const runtime = "nodejs";

const authorizationCodeGrantSchema = z.object({
  grant_type: z.literal("authorization_code"),
  client_id: z.string().min(1),
  code: z.string().min(1),
  redirect_uri: z.string().url(),
  code_verifier: z.string().min(43).max(128),
  resource: z.string().url(),
});

const refreshTokenGrantSchema = z.object({
  grant_type: z.literal("refresh_token"),
  client_id: z.string().min(1),
  refresh_token: z.string().min(1),
  resource: z.string().url(),
});

class TokenRequestReadError extends Data.TaggedError("TokenRequestReadError")<{
  message: string;
}> {}

export function POST(request: Request): Promise<Response> {
  const program = Effect.gen(function* () {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("application/x-www-form-urlencoded")) {
      return oauthErrorResponse("invalid_request", "The token endpoint requires form-encoded input.");
    }
    const requestText = yield* Effect.tryPromise({
      try: () => request.text(),
      catch: (error) =>
        new TokenRequestReadError({
          message: error instanceof Error ? error.message : "Could not read the token request.",
        }),
    });
    const parameters = new URLSearchParams(requestText);
    if (hasDuplicateParameters(parameters, ["resource"])) {
      return oauthErrorResponse("invalid_request", "OAuth parameters must not be repeated.");
    }
    const form = Object.fromEntries(parameters);
    const config = yield* AppConfigService;

    if (form.grant_type === "authorization_code") {
      const parsed = authorizationCodeGrantSchema.safeParse(form);
      if (!parsed.success || parsed.data.resource !== config.mcpResource) {
        return oauthErrorResponse("invalid_request", "The authorization-code request is invalid.");
      }
      const prepared = yield* prepareOAuthTokens("tesla.read");
      const record = yield* exchangeAuthorizationCodeForTokens(
        hashToken(parsed.data.code),
        parsed.data.client_id,
        parsed.data.redirect_uri,
        parsed.data.resource,
        pkceChallenge(parsed.data.code_verifier),
        prepared.material
      );
      if (!record) {
        return oauthErrorResponse("invalid_grant", "The authorization code is invalid or expired.");
      }
      yield* logOAuthTokensIssued(record);
      yield* Effect.logInfo("oauth.token.authorization_code_exchanged").pipe(
        Effect.annotateLogs({ clientId: record.clientId, connectionId: record.connectionId })
      );
      return tokenResponse(prepared.response);
    }

    if (form.grant_type === "refresh_token") {
      const parsed = refreshTokenGrantSchema.safeParse(form);
      if (!parsed.success || parsed.data.resource !== config.mcpResource) {
        return oauthErrorResponse("invalid_request", "The refresh-token request is invalid.");
      }
      const prepared = yield* prepareOAuthTokens("tesla.read");
      const rotation = yield* rotateRefreshToken(
        hashToken(parsed.data.refresh_token),
        parsed.data.client_id,
        parsed.data.resource,
        prepared.material
      );
      if (rotation.status === "replayed") {
        yield* Effect.logWarning("oauth.refresh_token.replay_detected").pipe(
          Effect.annotateLogs({ clientId: parsed.data.client_id })
        );
        return oauthErrorResponse(
          "invalid_grant",
          "Refresh-token reuse was detected and the token family was revoked. Reconnect Tesla."
        );
      }
      if (rotation.status === "invalid") {
        return oauthErrorResponse("invalid_grant", "The refresh token is invalid or expired.");
      }
      yield* logOAuthTokensIssued(rotation.record);
      yield* Effect.logInfo("oauth.token.refreshed").pipe(
        Effect.annotateLogs({
          clientId: rotation.record.clientId,
          connectionId: rotation.record.connectionId,
        })
      );
      return tokenResponse(prepared.response);
    }

    return oauthErrorResponse(
      "unsupported_grant_type",
      "Only authorization_code and refresh_token are supported."
    );
  });

  return runAppResponse("route.oauth.token", program, {
    "http.request.method": request.method,
  });
}

function tokenResponse(tokens: IssuedOAuthTokens): Response {
  return Response.json(tokens, {
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}
