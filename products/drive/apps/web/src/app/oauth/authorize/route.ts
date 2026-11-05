import { randomUUID } from "node:crypto";

import { auth } from "@clerk/nextjs/server";
import { Data, Effect, Either } from "effect";

import { AppConfigService } from "@/lib/config";
import { authorizeGithubIdentity, getOAuthClient } from "@/lib/db/store";
import { getClerkIdentity } from "@/lib/identity";
import {
  authorizationRequestSchema,
  buildTeslaAuthorizationUrl,
  hasDuplicateParameters,
  normalizeRequestedScopes,
  oauthErrorResponse,
  redirectWithOAuthResult,
} from "@/lib/oauth";
import { runAppResponse } from "@/lib/runtime";

export const runtime = "nodejs";

class ScopeValidationError extends Data.TaggedError("ScopeValidationError")<{
  message: string;
}> {}

export async function GET(request: Request): Promise<Response> {
  const protectedAuth = await auth.protect();
  const requestUrl = new URL(request.url);
  const program = Effect.gen(function* () {
    if (hasDuplicateParameters(requestUrl.searchParams, ["resource"])) {
      return oauthErrorResponse("invalid_request", "OAuth parameters must not be repeated.");
    }
    const parsed = authorizationRequestSchema.safeParse(Object.fromEntries(requestUrl.searchParams));
    if (!parsed.success) {
      return oauthErrorResponse("invalid_request", "The authorization request is incomplete or invalid.");
    }

    const client = yield* getOAuthClient(parsed.data.client_id);
    if (!client) {
      return oauthErrorResponse("unauthorized_client", "The OAuth client is not registered.");
    }
    if (!client.redirectUris.includes(parsed.data.redirect_uri)) {
      return oauthErrorResponse("invalid_request", "The redirect URI is not registered for this client.");
    }

    const config = yield* AppConfigService;
    if (parsed.data.resource !== config.mcpResource) {
      return oauthErrorResponse("invalid_target", "The requested resource does not match this MCP server.");
    }

    const scopeResult = yield* Effect.either(
      Effect.try({
        try: () => normalizeRequestedScopes(parsed.data.scope),
        catch: (error) =>
          new ScopeValidationError({
            message: error instanceof Error ? error.message : "The requested scopes are invalid.",
          }),
      })
    );
    if (Either.isLeft(scopeResult)) {
      return oauthErrorResponse("invalid_scope", scopeResult.left.message);
    }

    const identityResult = yield* Effect.either(getClerkIdentity(protectedAuth.userId));
    if (Either.isLeft(identityResult)) {
      yield* Effect.logWarning("oauth.authorization.identity_denied").pipe(
        Effect.annotateLogs({
          identityError: identityResult.left._tag,
          identityErrorMessage: identityResult.left.message,
        })
      );
      return redirectWithOAuthResult(parsed.data.redirect_uri, parsed.data.state, {
        error: "access_denied",
        description: "Sign in with an invited GitHub account to continue.",
      });
    }
    const identity = identityResult.right;
    const isAdmin = config.adminGithubUsers.includes(identity.githubUsername);
    const isAllowlisted = config.allowedGithubUsers.includes(identity.githubUsername);
    const userId = yield* Effect.sync(() => randomUUID()).pipe(
      Effect.withSpan("identity.user_id.generate")
    );
    const appUser = yield* authorizeGithubIdentity(
      userId,
      identity.clerkUserId,
      identity.githubUsername,
      identity.githubUserId,
      isAdmin,
      isAllowlisted
    );
    if (!appUser) {
      yield* Effect.logWarning("oauth.authorization.invite_required").pipe(
        Effect.annotateLogs({
          githubUsernameFingerprint: identity.githubUsernameFingerprint,
        })
      );
      return redirectWithOAuthResult(parsed.data.redirect_uri, parsed.data.state, {
        error: "access_denied",
        description: "This GitHub user has not been invited to Bent Drive Copilot.",
      });
    }

    const teslaUrl = buildTeslaAuthorizationUrl(
      {
        clientId: parsed.data.client_id,
        redirectUri: parsed.data.redirect_uri,
        clientState: parsed.data.state,
        codeChallenge: parsed.data.code_challenge,
        resource: parsed.data.resource,
        scopes: scopeResult.right,
        userId: appUser.id,
        expiresAtEpoch: Math.floor(Date.now() / 1000) + 10 * 60,
      },
      config
    );
    yield* Effect.logInfo("oauth.authorization.redirect_to_tesla").pipe(
      Effect.annotateLogs({
        clientId: parsed.data.client_id,
        scopes: scopeResult.right,
        userId: appUser.id,
      })
    );
    return Response.redirect(teslaUrl, 303);
  });

  return await runAppResponse("route.oauth.authorize", program, {
    "http.request.method": request.method,
  });
}
